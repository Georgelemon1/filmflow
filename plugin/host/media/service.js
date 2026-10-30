/**
 * 媒体生成服务：资产库 + 任务队列。
 *
 * 分工：
 *   pippit.js  —— 只讲协议（提交/查询/下载）
 *   本文件     —— 排队、轮询、落盘、记资产、报状态
 *   index.js   —— 只做路由（读请求、调这里、回 JSON）
 *
 * 两条用户定的硬规矩（2026-10-22）：
 *   1. **程序不能自己发起生成** —— 只有画布上的按钮（带写令牌）能调 `startJob`；
 *      agent 只能改 `media.prompt`，碰不到这里。
 *   2. **所有产物进素材库**，画布节点只显示"该节点最新的一条"。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { createHash } from 'node:crypto';
import { openSync, readSync, closeSync } from 'node:fs';
import * as ark from './ark.js';

import {
  DEFAULT_BASE,
  IMAGE_MODELS,
  VIDEO_MODELS,
  submit,
  query,
  getThreadAssets,
  download,
  getCredit,
} from './pippit.js';

const ASSETS_FILE = '.film/assets.json';
const ASSETS_DIR = '.film/assets';

/** 运行中的任务（内存）。进程重启后这里会空，`assets.json` 里已完成的不会丢。 */
const jobs = new Map();

/**
 * 建一个媒体服务实例。
 * @param opts `{ readKey: () => string, trace: (m: string) => void, baseUrl?: string, concurrency?: number }`
 * @returns 服务对象
 */
export function createMediaService(opts) {
  const trace = (opts && opts.trace) || (() => {});
  const readKey = (opts && opts.readKey) || (() => '');
  /** 火山方舟的 key（与 pippit 分开读，互不影响） */
  const readArkKey = (opts && opts.readArkKey) || (() => '');
  /** 豆包语音的 key（音频生成用；和 Ark key 不是同一把） */
  const readSpeechKey = (opts && opts.readSpeechKey) || (() => '');
  const baseUrl = (opts && opts.baseUrl) || DEFAULT_BASE;
  const maxParallel = Number((opts && opts.concurrency) || 1);   // 默认串行，稳且省额度

  /* ── 资产库 ─────────────────────────────────────────────── */

  /** 读 assets.json（坏文件当空，不炸）。 */
  const readAssets = (root) => {
    const p = join(root, ASSETS_FILE);
    if (!existsSync(p)) return { version: 1, items: [] };
    try {
      const j = JSON.parse(readFileSync(p, 'utf8'));
      return { version: 1, items: Array.isArray(j.items) ? j.items : [] };
    } catch {
      return { version: 1, items: [] };
    }
  };

  /** 写 assets.json（**先写临时文件再改名**，避免半截文件）。 */
  const writeAssets = (root, data) => {
    const p = join(root, ASSETS_FILE);
    mkdirSync(dirname(p), { recursive: true });
    const tmp = p + '.tmp';
    writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
    writeFileSync(p, readFileSync(tmp));
    try { writeFileSync(tmp, ''); } catch { /* 忽略 */ }
  };

  /**
   * 某节点最新的一条素材。
   * @param items 资产数组
   * @param nodeKey 节点 key
   * @returns 最新一条或 null
   */
  const latestOf = (items, nodeKey) => {
    let best = null;
    for (const a of items) {
      if (String(a.node) !== String(nodeKey)) continue;
      if (!best || String(a.at) > String(best.at)) best = a;
    }
    return best;
  };

  /**
   * 给项目里所有媒体节点补上 `media.latest`（state 用）。
   * @param root 片子根
   * @param stages 工序树（会被就地改）
   */
  const attachLatest = (root, stages) => {
    const { items } = readAssets(root);
    const walk = (n) => {
      if (n && n.kind === 'media') {
        const last = latestOf(items, n.key);
        n.media = { ...(n.media || {}), latest: last || null, status: (jobs.get(jobId(root, n.key)) || {}).status || 'idle' };
        const job = jobs.get(jobId(root, n.key));
        if (job) n.media.status = job.status, n.media.progress = job.progress || '';
      }
      for (const c of n.children || []) walk(c);
    };
    for (const s of stages || []) walk(s);
  };

  /* ── 队列 ──────────────────────────────────────────────── */

  const jobId = (root, key) => String(root).toLowerCase() + '#' + String(key);

  /**
   * 当前**正在跑**的任务数。
   * ⚠ 只数 running，**不能数 queued** —— 第一版这里把 queued 也算了，
   * 于是新任务一进来就把并发占满、pump() 立刻 return，任务永远排队不动（实测死锁）。
   */
  const runningCount = () => {
    let n = 0;
    for (const j of jobs.values()) if (j.status === 'running') n += 1;
    return n;
  };

  /**
   * 执行一个任务（内部）：提交 → 轮询 → 下载 → 记资产。
   *
   * **两个 provider**（2026-10-26 起默认火山直连）：
   *   · `ark`    —— 火山方舟，参数精确、可关水印、返回 seed/usage
   *   · `pippit` —— 小云雀，保留但默认不再走（除非没有 ARK key 或显式指定）
   * @param job 任务对象
   * @param node 节点（含 media 配置）
   * @param root 片子根
   */
  const runJob = async (job, node, root) => {
    const media = node.media || {};
    const type = String(media.type || 'image');
    const arkKey = typeof readArkKey === 'function' ? readArkKey() : '';
    const pippitKey = readKey();
    /*
     * 用户 2026-10-28：「火山的 api 定死」——媒体生成只走火山方舟，
     * 没有 key 就明确报错，不再静默退回小云雀（模型选项也会对不上）。
     * `FILMFLOW_PROVIDER=pippit` 只留作开发逃生口。
     */
    const provider = process.env.FILMFLOW_PROVIDER === 'pippit' ? 'pippit' : 'ark';
    job.provider = provider;

    const prompt = String(media.prompt || '').trim() || String(node.promptFallback || '').trim();
    if (!prompt) throw new Error('这个节点还没有提示词：先在节点上填，或让 agent 填');

    if (provider === 'ark') {
      if (!arkKey) throw new Error('还没配置火山方舟 API Key（凭据文件里要有 ARK_API_KEY）');
      job.status = 'running';
      job.startedAt = new Date().toISOString();

      /*
       * 音频生成（豆包语音《音频生成》，2026-10-28 接入）。
       * 与图/视频不同：同步返回 base64（或 2 小时有效的 url），没有任务轮询。
       */
      if (type === 'audio') {
        const speechKey = readSpeechKey() || arkKey;
        if (!speechKey) throw new Error('还没配置豆包语音 API Key（凭据文件里要有 SPEECH_API_KEY）');
        const fmt = 'mp3';
        job.progress = '生成中…';
        const r = await ark.generateAudio({ ak: speechKey, model: media.model, prompt, format: fmt });
        const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
        const rel = join(ASSETS_DIR, String(node.key || 'misc'), stamp + '-1.' + fmt).replace(/\\/g, '/');
        const abs = join(root, ...rel.split('/'));
        mkdirSync(dirname(abs), { recursive: true });
        let bytes = 0;
        if (r.audioB64) {
          const buf = Buffer.from(r.audioB64, 'base64');
          writeFileSync(abs, buf);
          bytes = buf.length;
        } else if (r.url) {
          const dl = await ark.download(r.url, abs);
          bytes = dl.bytes;
        }
        const dataA = readAssets(root);
        const idA = 'a_' + createHash('sha1').update(rel).digest('hex').slice(0, 10);
        const itemA = {
          id: idA,
          node: String(node.key || ''),
          nodeTitle: String(node.title || ''),
          type: 'audio',
          src: rel,
          bytes,
          provider: 'ark',
          model: String(media.model || 'seed-audio-1.0'),
          params: {
            format: fmt,
            duration: r.duration || 0,
            originalDuration: r.originalDuration || 0,
          },
          prompt,
          at: new Date().toISOString(),
          star: false,
          taskId: '',
        };
        dataA.items.push(itemA);
        writeAssets(root, dataA);
        job.assets = [idA];
        job.status = 'done';
        job.finishedAt = new Date().toISOString();
        job.progress = '完成（1 个）';
        job.durationSec = r.duration || 0;
        trace('[媒体] 完成(ark/audio) ' + node.title + '：' + Math.round(bytes / 1024) + ' KB，'
          + (r.duration ? r.duration.toFixed(1) + 's' : '时长未知'));
        usage(root, {
          node: String(node.key || ''), title: String(node.title || ''), type: 'audio',
          model: String(media.model || 'seed-audio-1.0'), status: 'done', count: 1,
          provider: 'ark', tokens: null,
        });
        return;
      }

      let urls = [];
      if (type === 'video') {
        const sub = await ark.submitVideo({
          ak: arkKey,
          model: media.model,
          prompt,
          durationSec: media.durationSec,
          ratio: media.ratio,
          resolution: media.resolution,
          generateAudio: media.generateAudio,
          watermark: media.watermark === true,
        });
        job.taskId = sub.taskId;
        trace('[媒体] 已提交(ark) ' + node.title + ' task=' + sub.taskId);
        const deadline = Date.now() + 30 * 60 * 1000;
        while (Date.now() < deadline) {
          if (job.canceled) throw new Error('已取消');
          await new Promise((r) => setTimeout(r, 5000));
          const q = await ark.queryVideo({ ak: arkKey, taskId: job.taskId });
          job.progress = q.state === 'running' ? '生成中…' : q.state;
          if (q.state === 'failed') throw new Error(q.failReason || '生成失败');
          if (q.state === 'done') {
            urls = q.videoUrls;
            job.usage = q.usage || null;
            job.seed = q.seed;
            break;
          }
        }
      } else {
        const r = await ark.generateImage({
          ak: arkKey,
          model: media.model,
          prompt,
          tier: media.resolution,
          ratio: media.ratio,
          watermark: media.watermark === true,
        });
        urls = r.urls;
        job.usage = r.usage || null;
        job.progress = '已生成';
      }
      if (!urls.length) throw new Error('没等到产物（可点重试；视频最长 30 分钟）');

      /* 落盘 + 记资产 */
      const data = readAssets(root);
      const made = [];
      let i = 0;
      for (const url of urls) {
        i += 1;
        const guessExt = type === 'video' ? 'mp4' : 'png';
        const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
        const rel = join(ASSETS_DIR, String(node.key || 'misc'), stamp + '-' + i + '.' + guessExt).replace(/\\/g, '/');
        const abs = join(root, ...rel.split('/'));
        const dl = await ark.download(url, abs);
        const realRel = rel.slice(0, rel.length - guessExt.length - 1) + dl.path.slice(dl.path.lastIndexOf('.'));
        const id = 'a_' + createHash('sha1').update(realRel).digest('hex').slice(0, 10);
        const item = {
          id,
          node: String(node.key || ''),
          nodeTitle: String(node.title || ''),
          type,
          src: realRel,
          bytes: dl.bytes,
          provider: 'ark',
          model: String(media.model || ''),
          params: {
            resolution: media.resolution || '',
            durationSec: media.durationSec || 0,
            ratio: media.ratio || '',
            seed: Number.isFinite(Number(job.seed)) ? Number(job.seed) : null,
            tokens: job.usage && job.usage.total_tokens ? job.usage.total_tokens : null,
          },
          prompt,
          at: new Date().toISOString(),
          star: false,
          taskId: job.taskId || '',
        };
        data.items.push(item);
        made.push(item);
      }
      writeAssets(root, data);
      job.assets = made.map((x) => x.id);
      job.status = 'done';
      job.finishedAt = new Date().toISOString();
      job.progress = '完成（' + made.length + ' 个）';
      trace('[媒体] 完成(ark) ' + node.title + '：' + made.length + ' 个产物'
        + (job.usage && job.usage.total_tokens ? '，' + job.usage.total_tokens + ' tokens' : ''));
      usage(root, {
        node: String(node.key || ''), title: String(node.title || ''), type,
        model: String(media.model || ''), status: 'done', count: made.length,
        provider: 'ark', tokens: job.usage && job.usage.total_tokens ? job.usage.total_tokens : null,
      });
      return;
    }

    /* ── 小云雀（legacy）──────────────────────────────────────── */
    const ak = pippitKey;
    if (!ak) throw new Error('还没配置小云雀 AK（设置里填 PIPPIT_ACCESS_KEY）');
    job.status = 'running';
    job.startedAt = new Date().toISOString();
    const sub = await submit({
      base: baseUrl,
      ak,
      type,
      prompt,
      model: media.model,
      resolution: media.resolution,
      count: Number(media.count) || 1,
      durationSec: media.durationSec,
      ratio: media.ratio,
      seed: media.seed,
    });
    job.runId = sub.runId;
    job.threadId = sub.threadId;
    job.webThreadLink = sub.webThreadLink || '';
    trace('[媒体] 已提交 ' + node.title + ' run=' + sub.runId);

    const deadline = Date.now() + 15 * 60 * 1000;
    let urls = [];
    while (Date.now() < deadline) {
      if (job.canceled) throw new Error('已取消');
      await new Promise((r) => setTimeout(r, 3000));
      const q = await query({ base: baseUrl, ak, threadId: job.threadId, runId: job.runId });
      job.progress = q.state === 'running' ? '生成中…' : q.state;
      if (q.state === 'failed') throw new Error(q.failReason || '生成失败');
      if (q.state === 'done') {
        urls = q.imageUrls.concat(q.videoUrls);
        break;
      }
      if (q.runState >= 3 && !urls.length) {
        const extra = await getThreadAssets({ base: baseUrl, ak, threadId: job.threadId, runId: job.runId }).catch(() => []);
        if (extra.length) { urls = extra.map((x) => x.url); break; }
      }
    }
    if (!urls.length) throw new Error('等了 15 分钟还没产物（可以点重试）');

    const data2 = readAssets(root);
    const made2 = [];
    let i2 = 0;
    for (const url of urls) {
      i2 += 1;
      const guessExt2 = (() => {
        const m = /\.(png|jpe?g|webp|mp4|mov|webm|mp3|wav|m4a)(?:\?|$)/i.exec(url);
        if (m) return m[1].toLowerCase().replace('jpeg', 'jpg');
        return type === 'video' ? 'mp4' : (type === 'audio' ? 'mp3' : 'png');
      })();
      const stamp2 = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
      const rel2 = join(ASSETS_DIR, String(node.key || 'misc'), stamp2 + '-' + i2 + '.' + guessExt2).replace(/\\/g, '/');
      const abs2 = join(root, ...rel2.split('/'));
      const dl2 = await download(url, abs2);
      const realRel2 = rel2.slice(0, rel2.length - guessExt2.length - 1) + dl2.path.slice(dl2.path.lastIndexOf('.'));
      const id2 = 'a_' + createHash('sha1').update(realRel2).digest('hex').slice(0, 10);
      const item2 = {
        id: id2,
        node: String(node.key || ''),
        nodeTitle: String(node.title || ''),
        type,
        src: realRel2,
        bytes: dl2.bytes,
        provider: 'pippit',
        model: String(media.model || ''),
        params: {
          resolution: media.resolution || '',
          durationSec: media.durationSec || 0,
          ratio: media.ratio || '',
          seed: Number.isFinite(Number(media.seed)) ? Number(media.seed) : null,
        },
        prompt,
        at: new Date().toISOString(),
        star: false,
        runId: job.runId,
        threadId: job.threadId,
      };
      data2.items.push(item2);
      made2.push(item2);
    }
    writeAssets(root, data2);
    job.assets = made2.map((x) => x.id);
    job.status = 'done';
    job.finishedAt = new Date().toISOString();
    job.progress = '完成（' + made2.length + ' 个）';
    trace('[媒体] 完成 ' + node.title + '：' + made2.length + ' 个产物');
    usage(root, { node: String(node.key || ''), title: String(node.title || ''), type, model: String(media.model || ''), status: 'done', count: made2.length, runId: job.runId, provider: 'pippit' });
  };

  const pump = () => {
    if (runningCount() >= maxParallel) return;
    for (const job of jobs.values()) {
      if (job.status !== 'queued') continue;
      if (runningCount() >= maxParallel) break;
      job.status = 'running';
      runJob(job, job.node, job.root).catch((e) => {
        job.status = 'failed';
        job.error = String((e && e.message) || e);
        job.finishedAt = new Date().toISOString();
        job.progress = '失败';
        trace('[媒体] 失败 ' + String(job.node && job.node.title) + '：' + job.error);
        try {
          usage(job.root, { node: String(job.key || ''), title: String(job.node && job.node.title || ''), type: 'unknown', model: '', status: 'failed', count: 0, error: String(job.error).slice(0, 160) });
        } catch { /* 忽略 */ }
      });
      break;
    }
  };

  /**
   * 让用户点按钮后启动一次生成。**只有这条路**能真花钱。
   * @param root 片子根
   * @param stages 工序树（找节点用）
   * @param key 节点 key
   * @returns `{ok, jobId}`
   */
  const startJob = (root, stages, key) => {
    const node = findMediaNode(stages, key);
    if (!node) throw new Error('没有这个媒体节点：' + key);
    const id = jobId(root, key);
    const old = jobs.get(id);
    if (old && (old.status === 'running' || old.status === 'queued')) {
      throw new Error('这个节点正在生成，等它结束或先取消');
    }
    const job = {
      id,
      root,
      key: String(key),
      node,
      status: 'queued',
      progress: '排队中…',
      createdAt: new Date().toISOString(),
    };
    jobs.set(id, job);
    pump();
    return { ok: true, jobId: id };
  };

  /** 取消（本地立刻生效；上游任务通常会继续跑完，钱不退）。 */
  const cancelJob = (root, key) => {
    const job = jobs.get(jobId(root, key));
    if (!job) return { ok: false, error: '没有在跑的任务' };
    job.canceled = true;
    if (job.status === 'queued') job.status = 'failed', job.error = '已取消';
    return { ok: true };
  };

  /** 所有任务状态（给界面轮询）。 */
  const listJobs = (root) => {
    const out = [];
    for (const j of jobs.values()) {
      if (String(j.root).toLowerCase() !== String(root).toLowerCase()) continue;
      out.push({
        key: j.key, status: j.status, progress: j.progress || '',
        error: j.error || '', assets: j.assets || [],
        startedAt: j.startedAt || '', finishedAt: j.finishedAt || '',
      });
    }
    return out;
  };

  /** 从工序树里找媒体节点。 */
  const findMediaNode = (stages, key) => {
    let hit = null;
    const walk = (n) => {
      if (hit) return;
      if (n && String(n.key) === String(key)) { hit = n; return; }
      for (const c of n.children || []) walk(c);
    };
    for (const s of stages || []) walk(s);
    return hit;
  };

  /**
   * 记一条用量（`.film/media-usage.jsonl`，一行一条）。
   * 官方没有"用量明细"接口，所以只能自己记：谁在什么时候生成了什么、成功还是失败。
   * 余额是实时查的；这条只是**本地历史**，用来"积分使用记录"。
   */
  const usage = (root, rec) => {
    try {
      const p = join(root, '.film', 'media-usage.jsonl');
      mkdirSync(dirname(p), { recursive: true });
      const line = JSON.stringify({ at: new Date().toISOString(), ...rec }) + '\n';
      writeFileSync(p, line, { flag: 'a' });
    } catch (e) {
      trace('[媒体] 用量记录写不进去：' + String((e && e.message) || e));
    }
  };

  /** 最近 N 条用量（新的在前）。 */
  const readUsage = (root, limit = 30) => {
    try {
      const p = join(root, '.film', 'media-usage.jsonl');
      if (!existsSync(p)) return [];
      const lines = readFileSync(p, 'utf8').split(/\r?\n/).filter(Boolean);
      return lines.slice(-limit).reverse().map((x) => { try { return JSON.parse(x); } catch { return null; } }).filter(Boolean);
    } catch {
      return [];
    }
  };

  /** 查积分余额（只读）。 */
  /** 当前 provider 的那把 key 在不在（不返回内容）。 */
  const hasKey = () => (providerName() === 'ark' ? !!readArkKey() : !!readKey());

  /** 当前生效的 provider（定死 ark；`FILMFLOW_PROVIDER=pippit` 仅开发用）。 */
  const providerName = () => (process.env.FILMFLOW_PROVIDER === 'pippit' ? 'pippit' : 'ark');

  /** 查积分余额（只读）。 */
  const credit = async () => {
    try {
      return await getCredit({ base: baseUrl, ak: readKey() });
    } catch {
      return '';
    }
  };

  /** 素材库列表（带节点标题、按时间倒序）。 */
  const listAssets = (root) => {
    const { items } = readAssets(root);
    return [...items].sort((a, b) => String(b.at).localeCompare(String(a.at)));
  };

  /** 删一条素材（文件 + 记录）。 */
  const removeAsset = (root, id) => {
    const data = readAssets(root);
    const idx = data.items.findIndex((x) => x.id === id);
    if (idx < 0) throw new Error('没有这条素材：' + id);
    const [item] = data.items.splice(idx, 1);
    writeAssets(root, data);
    try {
      const abs = join(root, ...String(item.src).split('/'));
      if (existsSync(abs)) writeFileSync(abs, '');
    } catch { /* 忽略 */ }
    return { ok: true, removed: item.id };
  };

  /** 收藏 / 取消收藏。 */
  const starAsset = (root, id, star) => {
    const data = readAssets(root);
    const item = data.items.find((x) => x.id === id);
    if (!item) throw new Error('没有这条素材：' + id);
    item.star = !!star;
    writeAssets(root, data);
    return { ok: true, id, star: item.star };
  };

  /** 资产文件绝对路径（给路由伺服用，带越界检查）。 */
  const assetPath = (root, rel) => {
    const clean = String(rel || '').replace(/\\/g, '/');
    if (!clean.startsWith(ASSETS_DIR + '/') || clean.includes('..')) throw new Error('非法路径');
    const abs = join(root, ...clean.split('/'));
    if (!existsSync(abs) || !statSync(abs).isFile()) throw new Error('文件不存在');
    return abs;
  };

  return {
    IMAGE_MODELS,
    VIDEO_MODELS,
    attachLatest,
    credit,
    providerName,
    hasKey,
    ARK_VIDEO_MODELS: ark.VIDEO_MODELS,
    ARK_IMAGE_MODELS: ark.IMAGE_MODELS,
    ARK_AUDIO_MODELS: ark.AUDIO_MODELS,
    arkPixelSize: ark.pixelSize,
    usage,
    readUsage,
    startJob,
    cancelJob,
    listJobs,
    listAssets,
    removeAsset,
    starAsset,
    assetPath,
    readAssets,
  };
}

/** 按扩展名给 content-type（只认媒体，别的拒）。 */
export function contentTypeOf(p) {
  /*
   * ⚠ 不能只看扩展名：实测（2026-10-23）一个 .jpg 里装的是 PNG 字节，
   * 路由按原名发 image/jpeg，浏览器就**解码失败**（naturalWidth=0、图上空白）。
   * ⇒ 先读文件头判断真实格式，认不出来再退回扩展名。
   */
  const byMagic = (b) => {
    if (b[0] === 0x89 && b[1] === 0x50) return 'image/png';
    if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
    if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57) return 'image/webp';
    if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
    if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79) return 'video/mp4';
    if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'video/webm';
    if (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) return 'audio/mpeg';
    return '';
  };
  try {
    const fd = openSync(p, 'r');
    const head = Buffer.alloc(16);
    readSync(fd, head, 0, 16, 0);
    closeSync(fd);
    const m = byMagic(head);
    if (m) return m;
  } catch {
    /* 读不到就按扩展名兜底 */
  }
  const ext = extname(String(p)).toLowerCase();
  const map = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
    '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
    '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4',
  };
  return map[ext] || '';
}

/**
 * 小云雀（Pippit）媒体生成客户端。
 *
 * 依据（2026-10-22 实测 + 官方桥接库源码）：
 *   · base    https://xyq.jianying.com
 *   · 鉴权     Authorization: Bearer <AK>      （AK 形如 ak-xxxx）
 *   · 信封     { ret, data, errmsg }；ret 必须 0，否则 errmsg 是给人看的原因
 *   · 提交     POST /api/biz/v1/skill/submit_run
 *             图片 agent_name = pippit_nest_agent
 *             视频 agent_name = pippit_video_part_agent
 *   · 查询     POST /api/biz/v1/agent/query_generate_video_result {thread_id, run_id}
 *             → { run_state, image_urls[], video_urls[], fail_reason? }
 *   · 取产物   POST /api/biz/v1/skill/get_thread {thread_id, run_id, scopes:['run_list.entry_list']}
 *   · 上传     POST /api/biz/v1/skill/upload_file (multipart) → { pippit_asset_id }
 *
 * 注意：这里**只负责协议**，不碰文件、不排队、不记资产 —— 那些在 store/queue 里。
 */

const DEFAULT_BASE = 'https://xyq.jianying.com';

/*
 * 图片模型 —— **2026-10-22 实测**：
 *   · `seedream_5.0_pro` 接受（并支持 1K/2K/4K）
 *   · `seedream_5.0`   服务端回「不支持的生图模型枚举」✗
 * 所以默认用 pro，普通版不再往下发（发了必被拒）。
 */
const IMAGE_MODELS = {
  'seedream_5.0_pro': { label: 'Seedream 5.0 Pro', resolutions: ['1K', '2K', '4K'] },
};

/**
 * 视频模型 —— 取值来自官方桥接库的模型表（上游字符串区分大小写，别改）。
 * 时长/比例/分辨率是各自的能力，界面按这个渲染下拉。
 */
const VIDEO_MODELS = {
  /* ── 官方 v1.0.6 的清单，字符串区分大小写，别改 ── */
  'Seedance_2.5': { label: 'Seedance 2.5', vip: true, resolutions: ['480p', '720p'], durations: [5, 10], ratios: ['16:9', '9:16', '4:3', '3:4', '1:1'] },
  'seedance2.0_vision': { label: 'Seedance 2.0 Vision', vip: true, resolutions: ['480p', '720p', '1080p'], durations: [5, 10], ratios: ['16:9', '9:16', '4:3', '3:4', '1:1'] },
  'seedance2.0_fast_vision': { label: 'Seedance 2.0 Fast Vision', vip: true, resolutions: ['480p', '720p'], durations: [5, 10], ratios: ['16:9', '9:16', '4:3', '3:4', '1:1'] },
  'Seedance_2.0_mini': { label: 'Seedance 2.0 Mini', vip: true, resolutions: ['480p', '720p'], durations: [5, 10], ratios: ['16:9', '9:16', '4:3', '3:4', '1:1'] },
  'MiniMax-H3': { label: 'MiniMax H3', vip: true, resolutions: ['480p', '720p'], durations: [5, 10], ratios: ['16:9', '9:16', '4:3', '3:4', '1:1'] },
  'MiniMax-H3-Max': { label: 'MiniMax H3 Max', vip: true, resolutions: ['480p', '720p'], durations: [5, 10], ratios: ['16:9', '9:16', '4:3', '3:4', '1:1'] },
  'wan3.0': { label: '通义万相 3.0', vip: true, resolutions: ['480p', '720p'], durations: [5, 10], ratios: ['16:9', '9:16', '4:3', '3:4', '1:1'] },
  'happyhorse-1.1': { label: 'HappyHorse 1.1', vip: true, resolutions: ['480p', '720p'], durations: [5, 10], ratios: ['16:9', '9:16', '4:3', '3:4', '1:1'] },
  'Seedance_2.0_mini_lite': { label: 'Seedance 2.0 Mini Lite（非VIP）', vip: false, resolutions: ['480p', '720p'], durations: [5, 10], ratios: ['16:9', '9:16', '4:3', '3:4', '1:1'] },
};

class PippitError extends Error {
  constructor(message, extra) {
    super(message);
    this.name = 'PippitError';
    this.code = (extra && extra.code) || 'PIPPIT_ERROR';
    this.ret = extra && extra.ret;
    this.logId = extra && extra.logId;
    this.status = extra && extra.status;
  }
}

/**
 * 发一个 JSON 请求并把信封拆开。
 * @param base base URL
 * @param ak 访问密钥
 * @param path 接口路径
 * @param body 请求体
 * @param timeoutMs 超时
 * @returns `data` 字段
 */
async function postJson(base, ak, path, body, timeoutMs = 120000) {
  const url = String(base || DEFAULT_BASE).replace(/\/+$/, '') + path;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        authorization: 'Bearer ' + ak,
      },
      body: JSON.stringify(body || {}),
      signal: ctrl.signal,
    });
  } catch (e) {
    throw new PippitError(
      ctrl.signal.aborted ? '请求超时（' + Math.round(timeoutMs / 1000) + ' 秒）' : '网络错误：' + String((e && e.message) || e),
      { code: ctrl.signal.aborted ? 'TIMEOUT' : 'NETWORK' },
    );
  } finally {
    clearTimeout(timer);
  }
  const logId = res.headers.get('x-tt-logid') || '';
  const text = await res.text();
  if (!res.ok) {
    throw new PippitError('小云雀返回 HTTP ' + res.status + (logId ? '（logid ' + logId + '）' : ''), {
      code: 'HTTP', status: res.status, logId,
    });
  }
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    throw new PippitError('小云雀返回的不是 JSON：' + text.slice(0, 120), { code: 'BAD_JSON', logId });
  }
  if (j.ret !== 0 && j.ret !== '0') {
    throw new PippitError(String(j.errmsg || ('ret=' + j.ret)), { code: 'UPSTREAM', ret: j.ret, logId });
  }
  return j.data || {};
}

/**
 * 提交一次生成。
 *
 * @param opts `{ base, ak, type, prompt, model, resolution, count, durationSec, ratio, seed, imageAssets, threadId }`
 * @returns `{ runId, threadId }`
 */
async function submit(opts) {
  const type = String(opts.type || 'image');
  const base = opts.base || DEFAULT_BASE;
  const ak = opts.ak;
  if (!ak) throw new PippitError('没有配置小云雀 AK', { code: 'NO_KEY' });
  const prompt = String(opts.prompt || '').trim();
  if (!prompt) throw new PippitError('提示词是空的', { code: 'NO_PROMPT' });

  if (type === 'image') {
    const model = IMAGE_MODELS[opts.model] ? opts.model : 'seedream_5.0_pro';
    /*
     * ★ 画面比例：原生 Seedream 是 `size` 参数（1K:16:9 => 1280x720），
     *   但小云雀这层包装**没有把这个参数暴露出来**（官方体验指南里连图片接口都没写）。
     *   用户 2026-10-22 定的做法：比例由片场**注入到提示词末尾**，靠模型自己听。
     *   措辞尽量短、放句尾，别打断原来的描述。
     */
    const RATIO_HINT = {
      '16:9': '，16:9 横版宽画幅构图',
      '9:16': '，9:16 竖版构图',
      '4:3': '，4:3 横向构图',
      '3:4': '，3:4 竖向构图',
      '1:1': '，1:1 方形构图',
    };
    const hint = RATIO_HINT[String(opts.ratio || '')] || '';
    const finalPrompt = hint && !prompt.includes(hint.slice(1)) ? prompt + hint : prompt;
    const body = {
      agent_name: 'pippit_nest_agent',
      message: finalPrompt,
      general_agent_settings: { image_model: model },
    };
    /*
     * `resolution` 只有 pro 认（1K/2K/4K）；普通版传了会被服务端拒绝，
     * 所以这里按模型决定带不带 —— 由协议决定，不让调用方试错。
     */
    if (model === 'seedream_5.0_pro' && opts.resolution) {
      body.general_agent_settings.resolution = String(opts.resolution);
    }
    /*
     * 水印：原生 Ark 的 images/generations 支持 `watermark: false`，
     * 但小云雀这层**文档没写、桥接库也没传**。这里先试着带上（放在 general_agent_settings 里），
     * 如果服务端忽略或拒绝，再看下一手（换成 body 顶层 / 换 key 名）。
     */
    body.general_agent_settings.watermark = false;
    /*
     * 用户 2026-10-22：「限制死一次出一张图」——
     * 不传 generate_image_count，服务端默认 1；就算调用方传了也不理。
     */
    void opts.count;
    if (Array.isArray(opts.imageAssets) && opts.imageAssets.length) {
      body.asset_ids = opts.imageAssets.map((x) => String(x.pippit_asset_id || x)).slice(0, 9);
    }
    if (opts.threadId) body.thread_id = String(opts.threadId);
    /* `dryRun`：只把**将要发出去的请求体**返回，不真调（用来验证参数拼装，不花钱） */
    if (opts.dryRun) return { dryRun: true, path: '/api/biz/v1/skill/submit_run', body };
    const data = await postJson(base, ak, '/api/biz/v1/skill/submit_run', body);
    const run = data.run || {};
    if (!run.run_id || !run.thread_id) throw new PippitError('提交成功但没拿到 run_id', { code: 'BAD_RESPONSE' });
    return { runId: String(run.run_id), threadId: String(run.thread_id), state: run.state, webThreadLink: data.web_thread_link };
  }

  const model = VIDEO_MODELS[opts.model] ? opts.model : String(opts.model || 'Seedance_2.5');
  const body = {
    agent_name: 'pippit_video_part_agent',
    message: prompt,
    asset_ids: Array.isArray(opts.imageAssets) ? opts.imageAssets.map((x) => String(x.pippit_asset_id || x)) : [],
    video_part_tool_param: {
      model,
      prompt,
      duration_sec: Number(opts.durationSec) > 0 ? Number(opts.durationSec) : 5,
    },
  };
  if (opts.ratio) body.video_part_tool_param.ratio = String(opts.ratio);
  if (opts.resolution) {
    /*
     * 官方：**1080p 目前仅 seedance2.0_vision 支持**。
     * 别的模型传 1080p 会被服务端拒或静默降级 ⇒ 这里挡一道，给出人话。
     */
    const want = String(opts.resolution);
    if (want === '1080p' && model !== 'seedance2.0_vision') {
      throw new PippitError('只有 seedance2.0_vision 支持 1080p；' + model + ' 请用 480p / 720p', { code: 'BAD_PARAM' });
    }
    body.video_part_tool_param.resolution = want;
  }
  if (Number.isFinite(Number(opts.seed))) body.video_part_tool_param.seed = Number(opts.seed);
  if (Array.isArray(opts.imageAssets) && opts.imageAssets.length) {
    body.video_part_tool_param.images = opts.imageAssets.map((x) => ({ pippit_asset_id: String(x.pippit_asset_id || x) }));
  }
  if (opts.threadId) body.thread_id = String(opts.threadId);
  if (opts.dryRun) return { dryRun: true, path: '/api/biz/v1/skill/submit_run', body };
  const data = await postJson(base, ak, '/api/biz/v1/skill/submit_run', body);
  const run = data.run || {};
  if (!run.run_id || !run.thread_id) throw new PippitError('提交成功但没拿到 run_id', { code: 'BAD_RESPONSE' });
  return { runId: String(run.run_id), threadId: String(run.thread_id), state: run.state, webThreadLink: data.web_thread_link };
}

/**
 * 查一次任务状态。
 *
 * 判定不依赖 `run_state` 的数字语义（服务端没公开）：
 *   · 有产物 URL  ⇒ done
 *   · 有 fail_reason ⇒ failed
 *   · 否则 ⇒ running
 * 这样即使厂商改了状态码也不会误判。
 *
 * @param opts `{ base, ak, threadId, runId }`
 * @returns `{ state, imageUrls, videoUrls, failReason }`
 */
async function query(opts) {
  const base = opts.base || DEFAULT_BASE;
  const data = await postJson(base, opts.ak, '/api/biz/v1/agent/query_generate_video_result', {
    thread_id: String(opts.threadId),
    run_id: String(opts.runId),
  });
  const imageUrls = Array.isArray(data.image_urls) ? data.image_urls.map(String) : [];
  const videoUrls = Array.isArray(data.video_urls) ? data.video_urls.map(String) : [];
  const failReason = data.fail_reason
    ? (typeof data.fail_reason === 'string'
      ? data.fail_reason
      : String(data.fail_reason.message || JSON.stringify(data.fail_reason)))
    : '';
  /*
   * ★ run_state 用**官方文档的映射**（v1.0.x 体验指南 ·「结果查询」）：
   *   1=已创建　2=处理中　3=成功　4=失败　5=已取消
   * 之前我不猜状态码、只看有没有产物 —— 那对"失败但没带 fail_reason"的情况会一直转到超时。
   * 现在以状态码为主、URL 为辅：3 才算成功；4/5 直接失败。
   */
  const rs = Number(data.run_state);
  let state;
  if (imageUrls.length || videoUrls.length) state = 'done';
  else if (rs === 3) state = 'done';          // 成功但暂时没解析到 URL（极少数）
  else if (rs === 4) state = 'failed';
  else if (rs === 5) state = 'failed';
  else if (rs === 1 || rs === 2) state = 'running';
  else state = failReason ? 'failed' : 'running';
  return { state, imageUrls, videoUrls, failReason: failReason || (rs === 5 ? '任务已取消' : ''), runState: rs };
}

/**
 * 从 thread 里取这次 run 的产物（部分类型 query 不给 URL，要靠这个兜）。
 * @param opts `{ base, ak, threadId, runId }`
 * @returns `{ url, assetId }[]`
 */
async function getThreadAssets(opts) {
  const base = opts.base || DEFAULT_BASE;
  const data = await postJson(base, opts.ak, '/api/biz/v1/skill/get_thread', {
    limit: 1,
    run_id: String(opts.runId),
    scopes: ['run_list.entry_list'],
    thread_id: String(opts.threadId),
  });
  const out = [];
  const runs = (data.thread && Array.isArray(data.thread.run_list)) ? data.thread.run_list : [];
  for (const run of runs) {
    if (!run || String(run.run_id) !== String(opts.runId) || !Array.isArray(run.entry_list)) continue;
    for (const entry of run.entry_list) {
      const content = (entry && entry.artifact && Array.isArray(entry.artifact.content)) ? entry.artifact.content : [];
      for (const part of content) {
        if (!part || !part.data) continue;
        try {
          const payload = JSON.parse(part.data);
          const v = payload && (payload.video || payload.image);
          if (v && v.url) out.push({ url: String(v.url), assetId: String(v.asset_id || '') });
        } catch { /* 不是我们要的片段 */ }
      }
    }
  }
  return out;
}

/**
 * 把签名 URL 的产物下载到本地。
 * 签名 URL 会过期（实测带 x-expires），所以**拿到就得立刻存盘**。
 * @param url 签名地址
 * @param destPath 本地绝对路径
 * @returns 字节数
 */
async function download(url, destPath) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new PippitError('下载产物失败 HTTP ' + res.status, { code: 'DOWNLOAD', status: res.status });
  const buf = Buffer.from(await res.arrayBuffer());
  /*
   * ★ 按**文件头**纠正扩展名（实测踩坑）：
   *   小云雀的图片���址常带 `~tplv-xxx.image` 这种后缀，我原来按 URL 猜成 .png，
   *   但服务端实际返回 JPEG ⇒ 浏览器能显示，工具链（缩略图/尺寸/其它软件）会认错格式。
   */
  const sniff = (b) => {
    if (b[0] === 0xff && b[1] === 0xd8) return '.jpg';
    if (b[0] === 0x89 && b[1] === 0x50) return '.png';
    if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46) return '.webp';
    if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return '.gif';
    if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79) return '.mp4';
    if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return '.webm';
    if (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) return '.mp3';
    if (b[0] === 0x52 && b[1] === 0x49) return '.wav';
    return '';
  };
  const fs = await import('node:fs');
  const path = await import('node:path');
  let finalPath = destPath;
  const real = sniff(buf);
  const cur = path.extname(destPath).toLowerCase();
  if (real && real !== cur) {
    finalPath = destPath.slice(0, destPath.length - cur.length) + real;
  }
  fs.mkdirSync(path.dirname(finalPath), { recursive: true });
  fs.writeFileSync(finalPath, buf);
  return { bytes: buf.length, path: finalPath };
}

/**
 * 查积分余额（官方 v1.0.5 起的接口）。
 * 只读、不花钱，用来在界面上告诉用户"还剩多少"。
 * @param opts `{ base, ak }`
 * @returns 余额字符串（例如 "123"）；拿不到时返回空串
 */
async function getCredit(opts) {
  const base = opts.base || DEFAULT_BASE;
  const data = await postJson(base, opts.ak, '/api/biz/v1/skill/get_credit_balance', {});
  const v = data && data.total_remain_amount;
  return v === undefined || v === null ? '' : String(v);
}

/** 读出 key（从凭据文件）。永远不要把返回值打到日志里。 *//** 读出 key（从凭据文件）。永远不要把返回值打到日志里。 */
function readAccessKey(fs, file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const m = /PIPPIT_ACCESS_KEY:\s*(\S+)/.exec(raw);
    return m ? m[1] : '';
  } catch {
    return '';
  }
}

export {
  DEFAULT_BASE,
  IMAGE_MODELS,
  VIDEO_MODELS,
  PippitError,
  submit,
  query,
  getThreadAssets,
  download,
  getCredit,
  readAccessKey,
};

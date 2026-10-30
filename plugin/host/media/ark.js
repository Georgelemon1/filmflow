/**
 * 火山方舟（Ark）媒体 provider —— 直连模型，不经小云雀。
 *
 * 依据：官方《视频生成教程》＋ 用户提供的调用/查询示例（2026-10-26 实测通过图片）；
 * 完整契约见 `docs/火山Ark-视频生成API.md`。
 *
 * 与 pippit 那层的三个本质差异（也正是换过来的原因）：
 *   1. `watermark: false` 真的能关
 *   2. `size` / `ratio` 是精确参数，不靠提示词去猜
 *   3. 视频任务返回 `seed`、`usage`，可复现、可记账
 */

const DEFAULT_BASE = 'https://ark.cn-beijing.volces.com/api/v3';

/** 视频模型（Model ID 以官方 models.json 的 models[].primaryVersion 为准）。 */
export const VIDEO_MODELS = {
  'doubao-seedance-2-5-260628': {
    label: 'Seedance 2.5', durations: [4, 30], resolutions: ['480p', '720p', '1080p'],
    ratios: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'], audio: true,
  },
  'doubao-seedance-2-0-260128': {
    label: 'Seedance 2.0', durations: [4, 15], resolutions: ['480p', '720p', '1080p', '4k'],
    ratios: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'], audio: true,
  },
  'doubao-seedance-2-0-fast-260128': {
    label: 'Seedance 2.0 fast', durations: [4, 15], resolutions: ['480p', '720p', '1080p'],
    ratios: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'], audio: true,
  },
  'doubao-seedance-2-0-mini-260615': {
    label: 'Seedance 2.0 mini', durations: [4, 15], resolutions: ['480p', '720p', '1080p'],
    ratios: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'], audio: true,
  },
};

/** 图片模型 */
export const IMAGE_MODELS = {
  'doubao-seedream-5-0-pro-260628': { label: 'Seedream 5.0 pro', tiers: ['1K', '2K', '3K', '4K'] },
  'doubao-seedream-5-0-260128': { label: 'Seedream 5.0 lite', tiers: ['1K', '2K', '4K'] },
  'doubao-seedream-5-0-flash-260915': { label: 'Seedream 5.0 flash', tiers: ['1K', '2K', '4K'] },
  'doubao-seedream-4-5-251128': { label: 'Seedream 4.5', tiers: ['2K', '4K'] },
  'doubao-seedream-4-0-250828': { label: 'Seedream 4.0', tiers: ['1K', '2K', '4K'] },
};

/**
 * 音频生成模型（豆包语音《音频生成》接口）。
 *
 * ⚠ 它**不是** Ark 的 `/api/v3`：主机是 `openspeech.bytedance.com`，
 * 鉴权是单头 `X-Api-Key`，同步返回 base64 音频（或 2 小时有效的 url）。
 * 依据：桌面上的《豆包语音_音频生成》PDF（2026-10-28 用户提供）。
 */
export const AUDIO_MODELS = {
  'seed-audio-1.0': {
    label: 'Doubao-音频生成-1.0',
    maxSec: 120,
    formats: ['wav', 'mp3', 'pcm', 'ogg_opus'],
  },
};
const SPEECH_BASE = 'https://openspeech.bytedance.com';

/**
 * 分辨率 + 比例 → 精确像素（官方 size 表）。
 * 图片接口只认像素，不认"1K/16:9"这种说法。
 */
const SIZE_MAP = {
  '1K:1:1': '1024x1024', '1K:4:3': '1152x864', '1K:3:4': '864x1152',
  '1K:16:9': '1280x720', '1K:9:16': '720x1280', '1K:3:2': '1248x832', '1K:2:3': '832x1248',
  '2K:1:1': '2048x2048', '2K:4:3': '2304x1728', '2K:3:4': '1728x2304',
  '2K:16:9': '2848x1600', '2K:9:16': '1600x2848', '2K:21:9': '3136x1344',
  '3K:1:1': '3072x3072', '3K:4:3': '3456x2592', '3K:3:4': '2592x3456',
  '3K:16:9': '4096x2304', '3K:9:16': '2304x4096',
  '4K:1:1': '4096x4096', '4K:4:3': '4704x3520', '4K:3:4': '3520x4704',
  '4K:16:9': '5504x3040', '4K:9:16': '3040x5504', '4K:21:9': '6240x2656',
};

/** 算像素尺寸；给了 ratio 就用表，没给就按 1:1。 */
export function pixelSize(tier, ratio) {
  const t = String(tier || '1K').toUpperCase();
  const r = String(ratio || '1:1');
  return SIZE_MAP[t + ':' + r] || SIZE_MAP[t + ':1:1'] || '1024x1024';
}

export class ArkError extends Error {
  constructor(message, extra = {}) {
    super(message);
    this.name = 'ArkError';
    Object.assign(this, extra);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(base, ak, path, init = {}) {
  const url = (base || DEFAULT_BASE).replace(/\/+$/, '') + path;
  let res;
  try {
    res = await fetch(url, {
      ...init,
      headers: {
        authorization: 'Bearer ' + ak,
        'content-type': 'application/json',
        ...(init.headers || {}),
      },
    });
  } catch (e) {
    throw new ArkError('连不上方舟：' + String((e && e.message) || e), { code: 'NETWORK' });
  }
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  if (!res.ok) {
    const msg = json?.error?.message || json?.message || text.slice(0, 200) || ('HTTP ' + res.status);
    throw new ArkError('方舟返回 ' + res.status + '：' + msg, { code: String(res.status), body: json });
  }
  if (!json) throw new ArkError('方舟返回了非 JSON 内容', { code: 'BAD_BODY' });
  return json;
}

/**
 * 生成图片（同步：一次请求直接拿结果）。
 * @param opts `{ ak, base, model, prompt, tier, ratio, watermark }`
 * @returns `{ urls, size, usage }`
 */
export async function generateImage(opts) {
  const model = IMAGE_MODELS[opts.model] ? opts.model : 'doubao-seedream-5-0-pro-260628';
  const size = pixelSize(opts.tier, opts.ratio);
  const body = {
    model,
    prompt: String(opts.prompt || ''),
    size,
    watermark: opts.watermark === true,
    response_format: 'url',
  };
  const j = await call(opts.base, opts.ak, '/images/generations', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  const items = Array.isArray(j.data) ? j.data : [];
  const urls = items.map((d) => d && d.url).filter(Boolean);
  if (!urls.length) {
    const err = items.find((d) => d && d.error);
    throw new ArkError('图片生成没返回 URL' + (err ? '：' + JSON.stringify(err.error) : ''), { code: 'NO_URL' });
  }
  return { urls, size: items[0].size || size, usage: j.usage || null };
}

/**
 * 提交视频任务。
 * @param opts `{ ak, base, model, prompt, durationSec, ratio, watermark, generateAudio, imageUrls, returnLastFrame }`
 * @returns `{ taskId }`
 */
export async function submitVideo(opts) {
  const model = VIDEO_MODELS[opts.model] ? opts.model : 'doubao-seedance-2-5-260628';
  const cap = VIDEO_MODELS[model];
  const dur = Math.max(cap.durations[0], Math.min(cap.durations[1], Number(opts.durationSec) || 5));
  const content = [{ type: 'text', text: String(opts.prompt || '') }];
  for (const url of opts.imageUrls || []) {
    content.push({ type: 'image_url', image_url: { url: String(url) }, role: 'reference_image' });
  }
  const body = {
    model,
    content,
    generate_audio: opts.generateAudio !== false && cap.audio,
    ratio: String(opts.ratio || '16:9'),
    duration: dur,
    watermark: opts.watermark === true,
  };
  if (opts.resolution) body.resolution = String(opts.resolution);
  if (opts.returnLastFrame) body.return_last_frame = true;
  const j = await call(opts.base, opts.ak, '/contents/generations/tasks', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  if (!j.id) throw new ArkError('提交成功但没拿到任务 id', { code: 'BAD_RESPONSE' });
  return { taskId: String(j.id) };
}

/**
 * 查视频任务。
 * @returns `{ state: 'running'|'done'|'failed', videoUrls, lastFrameUrl, failReason, usage, seed, resolution }`
 */
export async function queryVideo(opts) {
  const j = await call(opts.base, opts.ak, '/contents/generations/tasks/' + encodeURIComponent(opts.taskId), {
    method: 'GET',
  });
  const status = String(j.status || '');
  const urls = j.content && j.content.video_url ? [String(j.content.video_url)] : [];
  const failReason = j.error ? String(j.error.message || j.error.code || '') : '';
  let state = 'running';
  if (status === 'succeeded' && urls.length) state = 'done';
  else if (status === 'failed' || status === 'expired') state = 'failed';
  return {
    state,
    videoUrls: urls,
    lastFrameUrl: j.content && j.content.last_frame_url ? String(j.content.last_frame_url) : '',
    failReason: failReason || (status === 'expired' ? '任务已过期' : ''),
    usage: j.usage || null,
    seed: j.seed,
    resolution: j.resolution,
    status,
  };
}

/**
 * 下载产物到本地（方舟 URL 只活 24 小时、最多下载 100 次，必须立刻落盘）。
 * @returns `{ bytes, path }`
 */
export async function download(url, destPath) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new ArkError('下载产物失败 HTTP ' + res.status, { code: 'DOWNLOAD' });
  const buf = Buffer.from(await res.arrayBuffer());
  const fs = await import('node:fs');
  const path = await import('node:path');
  const sniff = (b) => {
    if (b[0] === 0xff && b[1] === 0xd8) return '.jpg';
    if (b[0] === 0x89 && b[1] === 0x50) return '.png';
    if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46) return '.webp';
    if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79) return '.mp4';
    return '';
  };
  let finalPath = destPath;
  const real = sniff(buf);
  const cur = path.extname(destPath).toLowerCase();
  if (real && real !== cur) finalPath = destPath.slice(0, destPath.length - cur.length) + real;
  fs.mkdirSync(path.dirname(finalPath), { recursive: true });
  fs.writeFileSync(finalPath, buf);
  return { bytes: buf.length, path: finalPath };
}

/** 从凭据文件读 ARK_API_KEY。永远不要把返回值打到日志里。 */
export function readAccessKey(fs, file) {
  try {
    const m = /^ARK_API_KEY:\s*(\S+)/m.exec(fs.readFileSync(file, 'utf8'));
    return m ? m[1] : '';
  } catch {
    return '';
  }
}

/**
 * 音频生成（豆包语音 / 音频生成，非流式 HTTP）。
 *
 * 接口：`POST https://openspeech.bytedance.com/api/v3/tts/create`
 * 鉴权：`X-Api-Key`（新版控制台的 API Key；旧版是 X-Api-App-Id + X-Api-Access-Key）
 * 返回：`{ audio: base64, url: 2h有效地址, duration, original_duration, subtitle? }`
 *
 * @param opts `{ ak, model, prompt, format?, speaker?, sampleRate? }`
 * @returns `{ audioB64, url, duration, originalDuration }`
 */
export async function generateAudio(opts) {
  const model = AUDIO_MODELS[opts.model] ? opts.model : 'seed-audio-1.0';
  const format = String(opts.format || 'mp3');
  const body = {
    model,
    text_prompt: String(opts.prompt || '').slice(0, 3000),
    audio_config: { format },
  };
  if (opts.speaker) body.references = [{ speaker: String(opts.speaker) }];
  if (opts.sampleRate) body.audio_config.sample_rate = Number(opts.sampleRate);

  let reqId = '';
  try { reqId = globalThis.crypto && globalThis.crypto.randomUUID ? globalThis.crypto.randomUUID() : ''; } catch { /* 忽略 */ }
  const res = await fetch(SPEECH_BASE + '/api/v3/tts/create', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': String(opts.ak || ''),
      ...(reqId ? { 'X-Api-Request-Id': reqId } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let j = null;
  try { j = JSON.parse(text); } catch { /* 非 JSON 就当错误处理 */ }
  if (!res.ok) {
    throw new ArkError('音频生成 HTTP ' + res.status + '：' + ((j && (j.message || j.msg)) || text.slice(0, 200)), { code: 'AUDIO_HTTP' });
  }
  if (!j) throw new ArkError('音频生成返回不是 JSON：' + text.slice(0, 200), { code: 'AUDIO_BAD' });

  const audioB64 = String(j.audio || (j.data && j.data.audio) || '');
  const url = String(j.url || (j.data && j.data.url) || '');
  // code 的成功值文档没写死；只要带了音频数据/地址就当成功（失败时不会带）
  if (!audioB64 && !url) {
    throw new ArkError('音频生成失败 code=' + String(j.code) + '：' + String(j.message || j.msg || ''), { code: String(j.code || 'AUDIO_FAIL') });
  }
  return {
    audioB64,
    url,
    duration: Number(j.duration || (j.data && j.data.duration) || 0) || 0,
    originalDuration: Number(j.original_duration || (j.data && j.data.original_duration) || 0) || 0,
  };
}
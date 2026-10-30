# 火山 · 豆包语音「音频生成」接口（速查）

> 来源：用户提供的官方 PDF《豆包语音_音频生成_1790593987》（8 页，2026-10-28），此处为接入用摘要。
> 代码位置：`host/media/ark.js` → `generateAudio()`；任务分支在 `host/media/service.js` 的 `type === 'audio'`。

## 端点与鉴权

```
POST https://openspeech.bytedance.com/api/v3/tts/create
Content-Type: application/json
X-Api-Key: <豆包语音 API Key>
X-Api-Request-Id: <可选，TraceID>
```

- 新版控制台是**单头** `X-Api-Key`；旧版是 `X-Api-App-Id` + `X-Api-Access-Key`（旧版会下线）
- **方舟（Ark）的 `ark-…` key 不能用于这里** —— 实测 `401 Invalid X-Api-Key`
- API Key 在 **豆包语音控制台 → API Key 管理** 创建，不在方舟控制台；本机存 `refs.SPEECH_API_KEY`（和 `ARK_API_KEY` 分开）
- 光有 key 还不够：该账号要**开通「音频生成」服务**。未开通时返回
  `403 45000030 [resource_id=volc.service_type.10074] requested resource not granted`（鉴权已过，是权限/开通问题）

## 请求体（最小可用）

```json
{
  "model": "seed-audio-1.0",
  "text_prompt": "一声清脆的门铃声，很短",
  "audio_config": { "format": "mp3" }
}
```

字段：

| 字段 | 说明 |
|---|---|
| `model` | 目前只支持 `seed-audio-1.0`（Doubao-音频生成-1.0） |
| `text_prompt` | 提示词或待合成文本，≤3000 字；支持时间轴描述 |
| `references` | 参考资源列表：音频（≤3 条，单条 ≤30s/10MB，wav/mp3/pcm/ogg_opus）或图片（1 张，≤10MB，jpeg/png/webp）；音频与图片参考不能混用 |
| `references[].speaker` / `audio_data` / `audio_url` | 音色 ID / 参考音频 base64 / 参考音频 URL，三者互斥 |
| `audio_config.format` | wav / mp3 / pcm / ogg_opus（默认 wav） |
| `audio_config.sample_rate` | wav/pcm 默认 40000；mp3 默认 44100；ogg_opus 仅 48000 |
| `audio_config.speech_rate` / `loudness_rate` / `pitch_rate` | 语速/音量/音调，整数档位 |
| `audio_config.enable_subtitle` | 开启后返回字级时间戳（`subtitle`） |
| `audio_config.watermark` ≤ `aigc_watermark` | 显式水印（结尾音频节奏标识） |

## 响应

```json
{
  "code": 0,
  "message": "ok",
  "audio": "<base64>",
  "url": "<2 小时有效>",
  "duration": 1.8,
  "original_duration": 1.8,
  "subtitle": { "text": "...", "sentences": [ ... ], "words": [ ... ] }
}
```

- 计费按 `original_duration`，**单次上限 120 秒**
- `audio` 与 `url` 至少有一个；我们优先存 base64，没有再下载 url
- 失败时不会带 `audio/url`，`code/message` 给出原因（如 401 鉴权失败）

## 片厂实现

- 模型表：`ark.js` 的 `AUDIO_MODELS = { 'seed-audio-1.0': ... }`，`media?action=models` 的 `audio` 字段返回它
- 任务：`service.js` 的音频分支同步调用、落盘 `.film/assets/<节点key>/<时间戳>-1.mp3`、写 `assets.json`、记账
- 节点 UI：音频节点的模型下拉只列它（R43 的按类型过滤）；提示词就是 `text_prompt`
- key：`index.js` 的 `readSpeechKey()` 读 `SPEECH_API_KEY`（环境变量或凭据），音频任务优先用它、退回 `ARK_API_KEY`
- 未配 key：`音频生成 HTTP 401：Invalid X-Api-Key`；key 对但服务没开通：`403 … requested resource not granted`

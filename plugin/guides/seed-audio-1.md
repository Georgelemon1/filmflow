# 音频模型：Doubao-音频生成-1.0（Seed-Audio 1.0）

> 状态（2026-10-28）：**代码已接入**（`host/media/ark.js` 的 `generateAudio` + 音频任务分支），
> 语音 key 也已按 `SPEECH_API_KEY` 单独接好（豆包语音 key 通过鉴权）。
> 当前卡在**服务未开通**：`403 [resource_id=volc.service_type.10074] requested resource not granted`
> ⇒ 需要在**豆包语音控制台**开通「音频生成」这项服务（同一个 key 开通后即可用）。
> 方舟的 `ark-…` key 在豆包语音接口一律 401（两类产品，key 不通用）。

## 接口事实（来自官方《音频生成》PDF，E2）

- `POST https://openspeech.bytedance.com/api/v3/tts/create`（**不是** ark 的 `/api/v3`）
- 鉴权：`X-Api-Key: <豆包语音 API Key>`；可选 `X-Api-Request-Id`（TraceID）
- 请求体：
  - `model`: `seed-audio-1.0`
  - `text_prompt`: 提示词或待合成文本，≤3000 字
  - `references`: 可选参考资源（音频 ≤3 条、单条 ≤30s/10MB；或 1 张图片 ≤10MB）；
    音频可用 `speaker` / `audio_data`(base64) / `audio_url`，三者互斥；图片与音频参考不能混用
  - `audio_config`: `format`（wav/mp3/pcm/ogg_opus，默认 wav）、`sample_rate`、`speech_rate`、`loudness_rate`、`pitch_rate`、`enable_subtitle`
- 响应：`audio`（base64）、`url`（2 小时有效）、`duration` / `original_duration`（计费按后者，上限 120s）、`subtitle`（可选）
- 支持语种：中英日韩、西班牙、德法、葡、泰越马菲、意俄荷波土等；单次最长 120 秒
- 用法：纯文本生成 / 参考音频生成（`@音频N` 引用，按上传顺序编号）/ 参考图片生成

## 音频提示词怎么写（不是视频镜头语言）

按**声音设计**写，一条一条给：

```text
音色：<角色>，<年龄/性别/口音/情绪>。
台词："……"（<角色>，<情绪/语速>）
环境声：<地点/时间/天气/远近>。
音效：<动作点 + 时机 + 材质>（例：第 3 秒，木质门关上）
音乐：<有/无>，<风格/乐器/情绪>；不需要就写「无音乐」。
时长：约 N 秒（也可以让模型按文本自然决定）
```

- 要精确控制时间段：在 `text_prompt` 里写「第 0–3 秒…，第 3–6 秒…」（支持时间轴控制）
- 一句一情绪，别在一句里塞两种语气
- 参考音频给“音色参考”时，`text_prompt` 里用 `@音频1` 指明对应关系
- 画面比例/分辨率跟音频无关，别写进音频提示词

## 片场里的用法

- 音频节点（媒体节点 `mediaType: audio`）→ 模型下拉选「Doubao-音频生成-1.0」→ 写提示词 → 点生成
- 没有可用的音频 key 时会明确报 401；这不是模型问题，是鉴权类型不对
- 视频节点（Seedance 2.0/2.5）本身带音轨：需要「视频里直接有声音」优先用它；独立音频轨才用本节点

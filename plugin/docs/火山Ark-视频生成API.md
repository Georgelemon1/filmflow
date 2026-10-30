# 火山方舟 · 视频生成 REST API 契约（Seedance 2.5 / 2.0）

> 来源：官方 [视频生成教程](https://ark.volcengine.com/region:cn-beijing/docs/video-generation-tutorial.md)
> ＋ 用户提供的调用/查询示例（2026-10-26）＋ 官方 quickstart 包（`demo_standard.py`）。
> 这份是**直连 Ark** 的施工图；小云雀那层的能力边界见 `docs/小云雀API体验指南.md`。

## 鉴权与基址

```
Base   https://ark.cn-beijing.volces.com/api/v3
Auth   Authorization: Bearer $ARK_API_KEY
```

注意：这是**火山 API Key**（控制台拿），不是小云雀的 `ak-…`，两者不能混用。

## 一、创建任务（POST）

```
POST /contents/generations/tasks
```

```json
{
  "model": "doubao-seedance-2-5-260628",
  "content": [
    { "type": "text", "text": "……提示词……" },
    { "type": "image_url", "image_url": { "url": "https://…" }, "role": "reference_image" },
    { "type": "video_url", "video_url": { "url": "https://…" }, "role": "reference_video" },
    { "type": "audio_url", "audio_url": { "url": "https://…" }, "role": "reference_audio" }
  ],
  "generate_audio": true,
  "ratio": "16:9",
  "duration": 11,
  "watermark": false
}
```

| 参数 | 说明 |
|---|---|
| `content[]` | 至少一条 `text`；图/视频/音频条目用 `role` 标明用途（`reference_image` / `reference_video` / `reference_audio`；首尾帧用 `first_frame` / `last_frame`） |
| `generate_audio` | 是否生成音频 |
| `ratio` | `21:9 / 16:9 / 4:3 / 1:1 / 3:4 / 9:16`；**`adaptive`** = 跟随输入素材（编辑/首尾帧/延长必须用 adaptive） |
| `duration` | 整数秒。**2.5：4–30s；2.0：4–15s**（1.0 是 2–12s） |
| `frames` | 与 `duration` 二选一，**优先级更高**（`4n+1` 整数） |
| `watermark` | `true`=右下角加「AI生成」；`false`=不加。**直连可控，这就是和小云雀的关键差别** |
| `service_tier` | `default` / `flex`（离线推理半价，但 2.5/2.0 **不支持**） |
| `execution_expires_after` | 任务超时秒数（如 172800） |
| `return_last_frame` | 返回尾帧图 `last_frame_url`，可用来串接下一个镜头 |
| `callback_url` | Webhook：状态变化时 POST 到你指定的公网地址 |

**响应**：`{ "id": "<TASK_ID>" }`

## 二、查询任务（GET）

```
GET /contents/generations/tasks/{id}
```

```json
{
  "id": "<TASK_ID>",
  "model": "doubao-seedance-2-5-260628",
  "status": "succeeded",
  "content": { "video_url": "<VIDEO_URL>" },
  "usage": { "completion_tokens": 246840, "total_tokens": 246840 },
  "created_at": 1765510475,
  "updated_at": 1765510559,
  "seed": 58944,
  "resolution": "1080p",
  "ratio": "16:9",
  "duration": 5,
  "framespersecond": 24,
  "service_tier": "default",
  "execution_expires_after": 172800
}
```

**`status` 五个值**：`queued` / `running` / `succeeded` / `failed` / **`expired`**
失败时带 `error: { code, message }`。

### 三条必须记住的
1. **`seed` 会返回** —— 想要可复现/微调，记下它
2. **`video_url` 只活 24 小时，下载次数上限 100 次** → 拿到就落盘（我们已经是这么做的）
3. **任务记录保留 7 天**（查询区间 [T-7天, T)）

## 三、输入限制（2.5 vs 2.0）

| 项 | Seedance 2.5 | Seedance 2.0 系列 |
|---|---|---|
| 参考图 | **1–30 张** | 1–9 张 |
| 参考视频 | 最多 10 段，总时长 ≤30s，单段 [2,30]s | 最多 3 段，总 ≤15s，单段 [2,15]s |
| 参考音频 | 最多 10 段，总 ≤30s，单段 [2,30]s | 最多 3 段，总 ≤15s |
| 输出时长 | **4–30s** | 4–15s |
| 输出分辨率 | 480p / 720p / 1080p(10bit) | 480p / 720p / 1080p / **4K** |
| 输出帧率 | 24 fps | 24 fps |
| 单图/单视频宽高比 | [0.4, 2.5]，边长 [300, 6000] px | 同 |

其它：图片 ≤30MB、视频 ≤200MB、**请求体 ≤64MB**（大文件别用 Base64）；
视频容器 mp4/mov（H.264/H.265，音频 AAC/MP3），FPS [24,60]。

## 四、几个会咬人的规则

- **不支持真人脸参考图/视频** —— 要真人就得上平台的肖像素材方案
- **ratio 与图片比例不一致时会居中裁剪** → 指定 ratio 要尽量贴近素材比例
- **限流**：查询 QPS 20、列表 QPS 1、取消 20；创建受模型 RPM 与最大并发限制（超了 429）
- **样片模式（draft）只有 2.5 支持**：先出低分辨率预览，确认后再出成片
- **Webhook** 与查询返回同构，可省掉轮询

## 五、与小云雀那层的对照（为什么该直连）

| 能力 | 小云雀 agent API | 直连 Ark |
|---|---|---|
| 水印 | 关不掉（实测被忽略） | `watermark: false` |
| 模型版本 | 别名 `seedream_5.0_pro` | 版本化 ID `doubao-seedance-2-5-260628` |
| 比例/尺寸 | "偏好"，可能不照做 | `ratio` / `size` 精确 |
| seed | 无 | 返回且可复现 |
| 时长 | 文档没给范围 | 4–30s 明确 |
| 状态 | `run_state` 1–5 | `queued/running/succeeded/failed/expired` |
| 计费 | 平台积分，无明细 | token 数随响应返回 |
---

# 附：Model ID 与图片 API（2026-10-26 从官方 models.json 核实）

## 已核实的 Model ID（`模型名 + primaryVersion`）

| 我们要的 | 模型名 | primaryVersion | **完整 Model ID** |
|---|---|---|---|
| Seedance 2.5 | `doubao-seedance-2-5` | 260628 | `doubao-seedance-2-5-260628` |
| Seedance 2.0 | `doubao-seedance-2-0` | 260128 | `doubao-seedance-2-0-260128` |
| Seedance 2.0 fast | `doubao-seedance-2-0-fast` | 260128 | `doubao-seedance-2-0-fast-260128` |
| Seedance 2.0 mini | `doubao-seedance-2-0-mini` | 260615 | `doubao-seedance-2-0-mini-260615` |
| **Seedream 5.0 pro** | `doubao-seedream-5-0-pro` | 260628 | `doubao-seedream-5-0-pro-260628` |
| Seedream 5.0 lite | `doubao-seedream-5-0` | 260128 | `doubao-seedream-5-0-260128` |
| Seedream 5.0 flash | `doubao-seedream-5-0-flash` | 260915 | `doubao-seedream-5-0-flash-260915` |
| Seedream 4.5 / 4.0 | — | 251128 / 250828 | `doubao-seedream-4-5-251128` / `doubao-seedream-4-0-250828` |

数据来源：`https://ark.volcengine.com/models.json`（全站模型目录，含 primaryVersion）。

## 图片生成 API（Seedream 5）

```
POST /api/v3/images/generations
```

```json
{
  "model": "doubao-seedream-5-0-pro-260628",
  "prompt": "……",
  "size": "2048x1152",          // 精确像素；分辨率×比例查表得到
  "watermark": false,
  "response_format": "url",     // 或 b64_json
  "sequential_image_generation": "disabled"   // "auto" 出组图
}
```

返回：`data[].url` / `data[].b64_json`，`data[].size`。
size 对照（1K）：1:1=1024x1024，4:3=1152x864，16:9=1280x720，9:16=720x1280；
2K：16:9=2848x1600；4K：16:9=5504x3040 等。
Seedream 5 支持 2K/3K；5.0 pro 支持编辑/图层/交互编辑（`<point>`/`<bbox>` 归一化坐标 0–999）。

## 直连后**立刻能做、现在做不到**的三件事

1. **seed 复现**：响应里带 `seed`，同 seed 可重跑
2. **尾帧接龙**：`return_last_frame: true` → 拿 `last_frame_url` 当下一镜头的首帧，串成一条长片
3. **样片模式（draft，仅 2.5）**：先出低分辨率预览，确认后再出成片，省钱
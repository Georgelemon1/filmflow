/**
 * entry-v71.mjs —— 版本化入口壳。「为什么必须换文件名」写在 entry-v4.mjs 文件头。
 *
 * ══ 收口版：独立版片场做完了 ══
 *
 * 用户 2026-10-20 的三个决定，本版全部落实：
 *   ① 「做成运行上完全独立于dsh的agent，要装在其他没dsh的机器上」
 *   ② 「每台机器填自己的 DeepSeek API key」
 *   ③ 「能从dsh上拿/改的东西就不要自己重头写」
 *
 * ── 独立版 = 自己的进程 + DSH 的 headless 当大脑 ──
 *   `standalone/main.mjs`：
 *     · HTTP + 画布 + 数据层（**全部 import 自本插件，没重写**）
 *     · 用户说话时 spawn `dsh --profile headless --json`，读它的事件流
 *     · 对话存 `.film/chat.json`，页面轮询就能看到
 *   实测：工具调用 filmflow_board + filmflow_node ✓
 *         回复「我是这部《测试2》的制作助手。1.1 人物下面共有 2 个角色：周衍、苏晚」✓
 *
 * ── 本插件为支持独立版做的四处改动 ──
 *   1. `inject` 去掉 `webServer`（headless 没有它会永远 pending）
 *      ⇒ 改为 `ctx.webServer` → `ctx.get('webServer')` → **空壳** 三级回退
 *      ⚠️ 顺序不能反：自测的假 ctx 没有 `get`，反了路由一条都不注册
 *   2. 空壳让代码继续往下走 ⇒ **四个工具在 headless 里照常注册** ✓
 *   3. `isAgentScope`（没有 webServer 就是 agent 作用域）⇒ 调
 *      `restrict({allow:[四把]})` 把核心工具（read/write/pwsh/glob/…）全挡掉 ✓
 *   4. `pickProjects` 兜底读 `FILMFLOW_PROJECT` 环境变量 ——
 *      否则 headless 下它一次看到全部项目、会张冠李戴（实测答成"新片…陈默、江屹、医生"，
 *      那是《测试》的人物 ✗）
 *   5. 导出数据层与页面函数，给 `standalone/main.mjs` 复用
 *
 * ── 顺手修的 ──
 *   · selftest 里那条 `inject 含大驼峰 webServer` 的断言已过期 ⇒ 改成"不含"+"含三件套"
 *   · web 侧写操作令牌闸门（v67）：7 个写路由要 `x-filmflow-token` + Origin 校验
 *   · 页面属性：肘形连线 / 条目字段框 / `Object.assign` 整对象回填
 */

export { name, inject, apply } from './index.js?v=71';

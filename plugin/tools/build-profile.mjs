#!/usr/bin/env node
/**
 * build-profile.mjs —— 生成片场的**组合叠加层**（`filmflow.patch.yml`）
 *
 * ══ 为什么是"叠加层"，不是 profile 那个文件 ════════════════════════════
 *
 * 实测发现：`$DSH_HOME/profiles/filmflow/cordis.patch.yml` **不是我一个人的文件** ——
 * DSH 自己会往里写用户层设置。证据（2026-10-20 两次读同一个文件）：
 *
 *     生成出来时 6131 字符；关掉"预览版说明"之后再读，6268 字符，
 *     多出来的是 DSH 自己写的一行：
 *         - id: ui-settings-general
 *           config: { welcomeNoticeVersion: 2026-09-28.1 }
 *
 * ⇒ 生成器直接覆盖那个文件，就会**把用户/DSH 存的设置冲掉**（预览提示又冒出来；
 *   以后可能还有更重要的设置）。
 *
 * ⇒ 分成两层，各归各的：
 *   · `$DSH_HOME/profiles/filmflow/`            —— DSH 的用户层，**我不写**
 *   · `plugins/dsh-filmflow/filmflow.patch.yml` —— 我生成的组合层，启动时 `--patch` 叠加
 *
 * 依据（`dsh --help` 原文）：
 *   `--patch <path>  extra patch-list overlay applied after the profile layer`
 *
 * ══ 为什么要生成，而不是手写 ══════════════════════════════════════════
 *
 * 片场 agent 的人格（导演 / 编剧助手，只管这张工序图）写在 `../CONSTITUTION.md`。
 * DSH 的 agent preset 要求把人格**内联进 Cordis 配置**（`@deepseek-ai/dsh-persona`
 * 的 `prefix` 就是一段字符串）—— 没有"文件路径"这种形态。
 *
 * ⇒ 手抄一份进 YAML 就有**两份真值**：改 CONSTITUTION.md 忘了改 YAML，
 *   agent 的行为就跟文档对不上，而且**看不出来**。
 * ⇒ 所以：**CONSTITUTION.md 是唯一真源**，这一层由脚本生成。
 *   改完人格 → 重跑本脚本 → 重启片场（`--check` 能查漂移）。
 *
 * ══ 生成的层干了什么 ═════════════════════════════════════════════════
 *
 * 一个**普通 DSH + 加了点东西 - 去掉了点东西**：
 *   加：filmflow（宿主：路由 + 八把工序工具）、filmflow-ui（浏览器：工序画布 + 提案卡）
 *   加：preset-filmflow（agent 人格 = CONSTITUTION.md；工具 = 八把工序 + 文件读写 + 上网）
 *   减：见 PRUNE 表 —— 与拍片无关的官方分区（shell / 技能 / 记忆 / 派生）
 *
 * 用法：node tools/build-profile.mjs [--check]
 *   --check 只比较、不写；不一致时退出码 1（给回归用）
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN = resolve(HERE, '..');
const OUT = join(PLUGIN, 'filmflow.patch.yml');

/** agent 的人格文本 —— **唯一真源**。 */
const CONSTITUTION = readFileSync(join(PLUGIN, 'CONSTITUTION.md'), 'utf8').replace(/\r\n/g, '\n').trimEnd();

/**
 * 「去掉的东西」—— 与拍片无关的官方分区。
 *
 * 每一项都写清**为什么去掉**，别攒成一张没有理由的名单：
 * 半年后有人问"为什么没有终端"，答案应该就在这一行旁边。
 */
const PRUNE = [
  [
    'ui-sidebar',
    '官方左边栏整列（新会话、工作区树、会话列表、按时间分组）—— 片场由自己的 56px 控制条占这个槽：'
    + '一个项目只绑一个会话，不需要会话列表（用户 2026-10-20：不要会话框旁边的项目选择侧边栏）',
  ],
  ['ui-plugin-manager', '插件市场/管理页 —— 片场不面向"给用户装插件"，装上就能拍片'],
  ['ui-settings-plugins', '设置里的「内置插件」分区（同上）'],
  ['ui-settings-plugin-inventory', '设置里的「插件清单」（同上）'],
  ['ui-schedule', '「自动化任务」—— 定时提醒对拍片是噪音'],
  ['schedule', '上一条的宿主服务（侧栏入口由 UI 半边注册，两个一起去掉）'],
  ['ui-jobs', '后台作业列表 —— 片场 agent 没有作业类工具，这个入口永远空着'],
  ['ui-trajectory', '「轨迹」页 —— 那是给调试 agent 的人看的，导演不需要'],
  ['ui-subagent', '子 agent 控制 —— 片场不派子 agent'],
  ['ui-workflow-run', '工作流运行卡 —— 片场不用 workflow'],
  ['ui-cordis', 'Cordis 检查面板 —— 给写插件的人看的'],
  ['ui-plan', '计划模式入口 —— 片场的"先问再做"由提案卡承担，不用另一套计划模式'],
  ['plan-mode', '上一条的宿主插件'],
  ['ui-goal', '目标条 —— 片场一次只推一道工序，不需要长期目标机制'],
  ['command-goal', '上一条的 /goal 指令'],
  ['tool-goal', '上一条的 goal 工具'],
  ['ui-open-in-app', '「用其他应用打开」—— 片场里没有要外部打开的文件'],
  ['ui-message-feedback', '点赞/点踩+反馈弹窗 —— 内部模板，不收集反馈'],
  [
    'ui-agent-preset',
    '新会话空白页上的「片场 ⌄」预设切换 chip —— 片场只有一个人格（CONSTITUTION.md），'
    + '没有可切的东西，留着只会让人以为能换（用户 2026-10-21：会话框不要预设切换功能）',
  ],
  ['ui-sidebar-terminal', '右侧栏的终端页 —— 片场不碰命令行'],
  ['ui-sidebar-files', '右侧栏的文件树 —— 不碰素材（用户 2026-10-20 明确定位）'],
  ['ui-sidebar-browser', '右侧栏的内嵌浏览器 —— 同上'],
  ['ui-sidebar-documentpreview', '右侧栏的文档预览 —— 同上，片场不看素材'],

  // ── 2026-10-21 提速：砍掉"片场根本不会走到"的一大片 ──────────────────
  //
  // 起因：用户问"为什么启动那么慢"。实测（CPU profile）启动 15s 里
  // 三分之一是 Node ESM 的 stat/lstat，按条目数线性放大
  // ⇒ 每个用不到的条目都在白付这份钱。下面这批一律是"片场界面上没有入口、
  //    agent 也没有对应工具"的东西。
  //
  // 判据（2026-10-28 更新）：片场 agent 的可见工具 = 11 把 filmflow_*：
  //   8 把工序 + read / write / web（文件读写与上网做成片场自己的工具，
  //   因为官方 fs/web 工具进不了 agent 的可见表 —— 详见 index.js 里三把工具的注释）。
  //   其余 tool-* 都是死重量。逐把白名单在 index.js 的 AGENT_ALLOWED_TOOLS。

  // 非片场的工具（agent 收不到，纯白加载）
  //
  // ★ 2026-10-28 用户改口：要**保留上网 + 文件读写**，挡掉 shell。
  //   「不要跨任务的知识库检索/历史会话搜索；但保留网络能力和文件读写能力，
  //     很多知识需要学习/总结成文件；也一定不要有完整的 shell 能力，容易给自己搞坏」
  //   ⇒ 文件读写与上网改成片场自己的三把工具（filmflow_read / write / web），
  //     官方的 tool-fs / tool-fs-search / tool-web 关掉（见下面三条）；
  //     web 服务（ctx.web）本身保留，filmflow_web 要用。
  ['tool-bash', '命令行 shell —— 用户 2026-10-28：完整 shell 会把片厂搞坏'],
  ['tool-pwsh', '同上（pwsh 版）；有它就能绕过提案闸门直接改任何文件'],
  ['tool-fs', '官方 fs 工具 —— 换成片场自己的 filmflow_read / filmflow_write'],
  ['tool-fs-search', '官方检索工具 —— 同上（读用 filmflow_read，查用 filmflow_board）'],
  ['tool-web', '官方 web 工具 —— 换成片场自己的 filmflow_web（ctx.web 服务保留）'],
  ['tool-workflow', '工作流工具 —— 片场不用 workflow'],
  ['tool-skill', '技能工具 —— 技能跨会话/跨项目加载，属"跨任务"，用户明确不要'],
  ['tool-schedule', '定时任务工具 —— 同上（配 ui-schedule/schedule 一起砍）'],
  ['tool-jobs', '后台作业工具 —— 片场没有作业'],
  ['tool-todo', '待办工具 —— 工序图就是待办，不需要第二套'],
  ['tool-presentation', 'present 工具 —— 片场不出文件，产物是片子里的文档'],
  ['tool-ask-user', 'ask_user 工具 —— 问问题走普通对话'],
  ['tool-cordis', 'Cordis 自检工具 —— 给插件作者用的'],
  ['tool-plugin-manager', '插件管理工具 —— 同上'],
  ['tool-plugin-market', '插件市场工具 —— 同上'],
  ['tool-working-directory', '切工作目录工具 —— agent 的 cwd 必须钉在这部片，否则文件读写飘走'],
  ['tool-subagent', '子 agent 工具 —— 片场不派子 agent'],
  ['tool-subagent-control', '同上'],
  ['tool-subagent-fork', '同上'],
  ['tool-subagent-list-agents', '同上'],

  // 子 agent / 工作流 / 其它预设
  // subagent 宿主服务保留（session-controller inject remote.subagents）；
  // 但子 agent 的**工具**照砍 —— 片场 agent 只有 4 个 filmflow_* 工具。
  ['subagent-fork-in-process', '同上'],
  ['subagent-spawn-in-process', '同上'],
  ['subagent-model-selection-settings', '同上'],
  ['delegation', '委派机制 —— 同上'],
  ['workflow-ptc', '工作流运行时 —— 片场不用'],
  ['ptc', 'PTC 运行时 —— 片场不用'],
  ['ptc-runtime', '同上'],
  ['preset-ptc', 'PTC 预设 —— 片场只有 filmflow 一个人格'],
  ['preset-cordis', 'Cordis 预设 —— 同上'],
  ['preset-standard', '标准预设 —— 同上（filmflow 是唯一默认）'],
  ['preset-minimal', '最小预设 —— 同上'],
  ['minimal', '最小基础设施组合 —— filmflow 预设自带'],
  ['standard', '标准组合 —— 同上'],
  ['planning', '计划机制 —— 片场的"先问再做"由提案卡承担'],
  ['goal', '目标机制 —— 片场一次只推一道工序'],
  ['goal-round-driver', '同上'],
  ['schedule', '定时任务服务 —— 片场不需要'],
  ['jobs', '作业服务 —— 同上'],
  ['job-controller', '同上'],
  ['skill', '技能服务 —— 片场没有技能库'],
  ['skill-filesystem', '同上'],
  ['ui-skill', '技能侧栏 —— 同上'],
  ['ui-user-questions', '提问卡 —— ask_user 工具已砍，永远不出现'],
  ['user-questions', '同上（宿主半边）'],

  // 遥测 / 反馈 / 分析（内部模板，不上报）
  ['product-analytics', '产品分析 —— 内部模板，不上报数据'],
  ['desktop-product-telemetry', '桌面端遥测 —— 同上'],
  ['otel', 'OpenTelemetry —— 同上'],
  ['session-telemetry-otel', '会话遥测 —— 同上'],
  ['message-feedback', '消息反馈上报 —— 同上'],
  ['command-feedback', '反馈指令 —— 同上'],

  // 终端 / shell（片场不给命令行）
  // terminal-controller / pty **保留**：它们是 `shell` 服务的另一半，
  // 全砍掉 permission-presets 拿不到 shell（表现为输入框的权限 chip 消失）。
  ['terminal-bash', 'bash 终端 —— 同上'],
  ['terminal-pwsh', 'pwsh 终端 —— 同上'],
  // persistent-pwsh 保留：它是 shell 服务的**后端**，砍了 persistent-shell
  // 就起不来 ⇒ permission-presets 拿不到 shell ⇒ 输入框的权限 chip 消失。
  ['persistent-bash', '常驻 bash —— 片上不需要，pwsh 那个留着就够了'],
  // persistent-shell / shell-env **保留**：它们提供 `shell` 服务，
  // permission-presets 依赖它（砍了输入框那个"工作区内修改"权限 chip 会消失）。
  // pty 保留（terminal-controller 的底层依赖，见上）
  ['bash-sandbox', 'bash 沙箱 —— 没有 bash 就没有它'],
  ['pwsh-sandbox', 'pwsh 沙箱 —— 同上'],
  // shell-env 同理保留（shell 服务链的一部分）。

  // 插件管理 / 开发者功能
  ['plugin-manager', '插件管理器 —— 片场不面向"装插件"'],
  ['plugin-inventory', '插件清单 —— 同上'],
  ['plugin-package-inventory-deepseek', '同上'],
  // shortcuts 服务保留（ui-layout / ui-conversation / ui-approval 都 inject 它）；
  // 只砍它的**界面**（快捷键表本身）。
  ['ui-shortcuts', '快捷键表界面 —— 片场只有两个页面，用不上'],
  ['hmr', '热更新 —— 开发期功能，交付版不需要'],
  ['client-hmr', '客户端热更新 —— 同上'],
  ['ui-open-in-app', '「用其他应用打开」—— 片场里没有要外部打开的文件'],
  ['open-in-app', '上一条的宿主半边'],

  // 片场不用的能力
  ['office-to-pdf', 'Office 转 PDF —— 片场不产出这类文件'],
  ['image-offload', '图片卸载 —— 片场不管素材'],
  // attachment-local / file-upload 保留：ui-conversation 与 api-session-controller
  // inject fileUpload，砍了整条对话链 pending。
  // 只砍「+ 附件」那个按钮（ui-attachment）。
  ['ui-attachment', '输入框的 + 附件按钮 —— agent 没有附件工具，传了也用不上'],
  // file-reference-local / ui-reference / ui-input-trigger **保留**：
  //   ui-input-trigger 提供 `inputTriggers` 服务（ui-commands inject 它），
  //   ui-reference 是 @ 的面板 —— 砍了 UI 链又要断一次（实测 13 条 pending）。
  // remote-access **保留**（提供 remoteAccess 服务）。
  ['workspace-files', '工作区文件视图 —— 片场不翻文件'],
  ['workspace-changes', '改动审阅 —— 同上'],
  ['mcp-resources', 'MCP 资源 —— 片场不接 MCP'],
  // ⚠️ 实测教训（2026-10-21）：下面这几个**看着像功能、其实是服务提供者**，砍了就断链：
  //   api-remotes    → 所有 remote.* 服务的提供者（客户端网关），砍它整条 UI 链全 pending
  //   resources      → ui-sidebar-right 等 inject 它
  //   shortcuts      → ui-layout / ui-conversation / ui-approval 都 inject 它
  //   file-upload    → ui-conversation 与 session-controller inject 它
  //   subagent       → session-controller inject remote.subagents
  // 判据：**凡是被别人 inject 的服务名，就不能按"功能"判断能不能砍。**
  //   remote-access  → 提供 remoteAccess（ui-session / ui-workspace 都 inject）→ 保留
  //   ui-input-trigger → 提供 inputTriggers（ui-commands inject）→ 保留
  // web-search-deepseek / web-fetch-http / web-deepseek-api 保留：
  // 用户 2026-10-21 明确「上网能力不要砍」
  // llm-pi-ai 不砍：用户 2026-10-27 要求「改成和主 DSH 一样，可 A 可 O」
  ['llm-pi-ai', '另一个模型供应商（pi-ai）—— A/O 两条路都留，和主 DSH 一致'],
  ['session-stats', '会话统计页 —— 导演不看这个'],
  ['session-log-download', '会话日志下载 —— 片场不出日志文件'],
  ['ui-deliverables', '交付物侧栏 —— 片场右手边永远是官方会话，没有侧栏'],
  ['ui-brand-official', '空会话页的品牌标 —— 片场第一页是自己的项目菜单，用不到'],
];

/**
 * 把一段多行文本缩进成 YAML 块标量的内容。
 * @param text 原文
 * @param pad 缩进空格数
 * @returns 每行都带 pad 个空格、行尾无多余空白的文本
 */
function block(text, pad) {
  const spaces = ' '.repeat(pad);
  return text
    .split('\n')
    .map((line) => (line.trim() === '' ? '' : spaces + line))
    .join('\n');
}

/** 组装整份 YAML。 */
function build() {
  /*
   * llm-pi-ai 是**保留并配置**的那一条（不 disabled）：
   *   · llm-deepseek → Anthropic Messages（默认 https://api.deepseek.com/anthropic）
   *   · llm-pi-ai    → OpenAI 兼容（openai-completions）
   * 用户 2026-10-27：「改成和你现在一样，可 a 可 o」。
   * 它的位置仍在原来的 PRUNE 次序里（输出字节与旧版只差这一块）。
   */
  const PI_AI = `# 另一个模型供应商（pi-ai）—— A/O 两条路都留，和主 DSH 一致
- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      deepseek:
        apiKeyEnv: DEEPSEEK_API_KEY
`;
  const prune = PRUNE.map(
    ([id, why]) => (id === 'llm-pi-ai' ? PI_AI : `# ${why}\n- id: ${id}\n  disabled: true\n`),
  ).join('\n');

  return `# ⚠️ 这个文件是**生成**的，不要手改 —— 改 tools/build-profile.mjs 后重跑。
#
# 生成器：plugins/dsh-filmflow/tools/build-profile.mjs
# 人格源：plugins/dsh-filmflow/CONSTITUTION.md
#
# 片场 = **一个普通 DSH**
#        + 工序画布（客户端插件）
#        + 八把工序工具（宿主插件）
#        + agent 的「上网 + 文件读写」（片场自己的 filmflow_read / write / web）
#        - 与拍片无关的官方分区（含 shell / 技能 / 记忆 / 派生）
#
# 用户 2026-10-20 定的开发逻辑（原话）：
#   「给一个普通的 dsh 加上一些特定的功能，然后再去掉一些特定的功能，
#     如片厂中用户与 agent 的交互框就应该是 dsh 原有的，
#     甚至还去掉了一些如侧边栏之类的功能，
#     而不是在某个程序上『再加上一个类似于 dsh 的会话框』。」
#
# ⇒ 对话、输入框、工具卡、思考链、流式、模型设置、API Key、深色主题 ——
#   **全部是 DSH 官方那一套**，这里只是把它们组合起来、剪掉不需要的。

# ─── 加：宿主半边（/filmflow/* 路由 + 八把工序工具）───────────────────
#
# ⚠️ __FF_ENTRY__ / __FF_CLIENT__ 是**占位符**，不是真实路径（含引号，替换时整体替掉）。
#    这个文件只做模板；启动器（standalone/server.mjs）在运行时把它们换成
#    "片场插件目录在这台机器上的绝对路径"，另写到 dsh-home/runtime.patch.yml 再交给 dsh。
#    理由：插件目录在开发机和工作机上不同（甚至不在一个盘符），
#    写死绝对路径的包**一拷到别的机器就跑不起来** —— 这是自己给自己挖的坑。
- insert:
    - id: filmflow
      name: __FF_ENTRY__
      config:
        roots: !!js (process.env.FILMFLOW_ROOTS || ((process.env.USERPROFILE || process.env.HOME || '.') + '/films')).split(';')

    # 加：浏览器半边（官方 main 槽里的「工序」画布 + filmflow_propose 的提案卡）
    # 它的宿主半边还负责把片子目录登记成 DSH 的工作区（否则左边栏会显示一个
    # 叫「默认工作区」的空目录 —— 见 client-plugin/index.js 的注释）。
    - id: filmflow-ui
      name: __FF_CLIENT__
      config:
        workspace: !!js (process.env.FILMFLOW_ROOTS || ((process.env.USERPROFILE || process.env.HOME || '.') + '/films')).split(';')[0]
        # 左边栏显示的名字。目录名常常是英文的，界面上要是中文
        title: 片库

# ─── 加：agent 的人格（官方 preset 机制）──────────────────────────────
#
# 为什么是 preset 而不是往系统提示里拼字符串：
#   官方在 0.2 把 agent 的能力收进了 preset（每个会话按 preset 装配工具与人格）。
#   用它意味着**片场没有自己的一套装配代码**，人格、工具、上下文都走官方渠道。
#
# 这个 preset 只挂时间上下文（人格由插件 setup 注册）。
#   ⇒ **没有** bash / pwsh（命令行）、skill（技能库）、kb（知识库）、
#      session（历史会话）、subagent / workflow（派生）
#   ⇒ 文件读写与上网**不靠官方工具**（实测进不了 agent 的可见表），
#      改成片场自己的 filmflow_read / filmflow_write / filmflow_web：
#      写被宿主限制在本片目录、不许碰 .film/；shell 一律不给。
#   ⇒ 节点正文的改动仍只走 propose（语义约束，见 CONSTITUTION §一 / §六）
- insert:
    - id: preset-filmflow
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: filmflow
        name: 片场
        description: 片场里的制作助手：按工序图干活，改内容必须先提案
        order: 0
        plugins:
          # 人格不放在 preset 里 —— 由插件在 setup(agentCtx) 里注册
          # （deployment:persona-prefix, complete）。preset 只留时间上下文。
          # 文件读写 / 上网**不挂这里**：实测 preset 子插件在 setup 之后才到，
          # 不可靠；改挂 profile 级（见 PRUNE 注释）。
          - id: time-context
            name: '@deepseek-ai/dsh-time-context'


# 默认用它，并且不给用户切回「标准模式」——片场里只有一种 agent。
- id: agent-preset-registry
  config:
    default: filmflow

- id: preset-standard
  disabled: true

# 钉住界面语言 = 中文。
#
# 官方默认是「跟随浏览器」（locale 插件的 config.preference 留空就是这样），
# 于是同一份片场装到一台英文系统上，整个界面就变成英文。
# 片场是给中文剧组用的，不跟随系统 —— 直接钉死。
# （LOCALE_IDS 只有 'zh' / 'en' 两个内置值，见 dsh-client-locale 的类型声明。）
- id: locale
  config:
    preference: zh

# ─── 减：与拍片无关的官方分区 ─────────────────────────────────────────
#
${prune}`;
}

const want = build();
const check = process.argv.includes('--check');

if (check) {
  const have = existsSync(OUT) ? readFileSync(OUT, 'utf8').replace(/\r\n/g, '\n') : '';
  if (have === want) {
    console.log('✓ 叠加层与 CONSTITUTION.md 一致（' + want.length + ' 字符）');
    process.exit(0);
  }
  console.error('✗ 叠加层与生成结果不一致 —— 跑 node tools/build-profile.mjs 重新生成');
  process.exit(1);
}

writeFileSync(OUT, want, 'utf8');
console.log('✓ 已生成 ' + OUT + '（' + want.length + ' 字符，人格 ' + CONSTITUTION.length + ' 字符）');

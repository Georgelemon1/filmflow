// 片场 · 浏览器半边
//
// ══ 这是什么 ══════════════════════════════════════════════════════════
//
// 一个**普通 DSH Web UI 的客户端插件**。它不是自建页面：DSH 官方的
// AppFrame（三栏框架）、Conversation（对话）、Composer（输入框）、
// Tool 卡片、思考链、流式输出 —— 全部照旧由官方包渲染，本插件只往槽位里加东西：
//
//   1. `sidebar` 槽放一条 **56px 控制条**（项目菜单 / 工序）—— **不是侧边栏**：
//      没有"新会话"、没有会话列表（一个项目只绑一个会话）
//   2. `main`/`projects` = **项目菜单**（第一个页面）
//   3. `main`/`canvas`   = **工作台**：左工序画布、右官方会话框
//   4. `tool.call.toolview`/`filmflow_propose` = 提案卡（确认/驳回长在工具调用处）
//
// 用户 2026-10-20 定的页面流（原话）：
//   「第一个页面是项目菜单，点进项目之后是画布，右边栏是 Agent 会话框。
//     一个项目绑定一个会话，因此项目里的 Agent 只要图一的这个会话框，
//     不要图 2 会话框旁边的项目选择侧边栏。」
//
// 右边那个会话框**不是重写的**：一句
//   renderSlot('main', {}, { entryKey: 'conversation' })
// 就是官方渲染对话的方式（ui-layout 的 MainPanel 干的正是这一句）。
//
// 另一条用户定的开发逻辑（2026-10-20）：
//   「给一个普通的 dsh 加上一些特定的功能，然后再去掉一些特定的功能」
//   —— 而不是「在某个程序上再加一个类似 dsh 的会话框」。
//
// ══ 为什么能不用构建 ══════════════════════════════════════════════════
//
// DSH 的客户端模块系统是 lazy-CJS：`window.__ModuleLoader__.load({id,factory})`
// 只登记工厂，`require(...)` 走平台种子表
// （react / react-dom / @deepseek-ai/cordis / dsh-client-ui-slots /
//   dsh-client-ui-primitives / dsh-client-store / dsh-client-ui-dockkit / zod …）。
// ⇒ 手写这个文件即可，不需要 tsdown / 不需要 node_modules。
//   （机制见 @deepseek-ai/dsh-client-modules 的 README「Lazy-CJS model」）

/*
 * 品牌（R60，2026-10-30）：窗口/标签页标题不出现「DeepSeek Harness」。
 *
 * 页面标题由官方 web app 写成「会话名 — DeepSeek Harness」；Electron 主进程另外
 * 拦了 page-title-updated（见 desktop/main.js），这里是**浏览器直开时的兜底**：
 * 把后缀换成「片场」，并在标题被改写时持续纠正。
 */
(function fixFilmflowTitle() {
  const clean = () => {
    const t = String(document.title || "");
    let next = t;
    if (/^DeepSeek\s*Harness\s*$/i.test(t.trim())) next = "片场";
    else next = t
      .replace(/\s*[—\-|·]\s*DeepSeek\s*Harness\s*$/i, " — 片场")
      .replace(/\s*[—\-|·]\s*Harness\s*$/i, " — 片场");
    if (next !== t) document.title = next;
  };
  try {
    clean();
    const titleEl = document.querySelector("title");
    if (titleEl) new MutationObserver(clean).observe(titleEl, { childList: true, characterData: true, subtree: true });
    new MutationObserver(clean).observe(document.head, { childList: true, subtree: true });
  } catch { /* 忽略 */ }
})();

window.__ModuleLoader__.load({
	id: "dsh-filmflow-ui",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const react = require("react");
		const h = react.createElement;

		const NS = "filmflow";
		/** 工作台面板 key（画布 + 会话）。 */
		const PANEL_ID = "canvas";
		/** 项目菜单面板 key（第一个页面）。 */
		const PANEL_PROJECTS = "projects";
		/** 上次看的是哪部片 —— 只存一个 id，不存路径（片子挪了也不会坏）。 */
		const PICK_KEY = "filmflow.canvas.pick";

		// ══════════════════════════════════════════════════════════════
		// 样式
		// ══════════════════════════════════════════════════════════════
		//
		// ★ 全部前缀 `ff-` 并挂在 `.ff-root` 下面 —— **绝不能污染官方 UI**：
		//   之前那份页面样式用的是 `.node` / `.tree` / `.md` 这种通用选择器，
		//   放进官方界面会直接改掉对话面板的排版 ✗
		//
		// 颜色一律取官方主题别名（`--dsw-alias-*`，由 ui-theme 的 presenter
		// 写到 body 上），所以**深色/浅色主题都自动跟着变** —— 不是我写死的浅色。
		const CSS = `
.ff-root{position:relative;height:100%;min-height:0;display:flex;flex-direction:column;
  background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);
  font-size:var(--dsh-content-font-size,14px);overflow:hidden;
  padding-top:var(--dsh-frame-top-clearance,0px)}
.ff-bar{flex:none;display:flex;align-items:center;gap:10px;flex-wrap:wrap;
  padding:10px 16px 8px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.ff-sel{font:inherit;font-size:13px;font-weight:600;padding:3px 6px;border-radius:6px;
  border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-primary);
  cursor:pointer;max-width:46vw}
.ff-sel:hover{border-color:var(--dsw-alias-border-l2)}
.ff-focus-sel{font:inherit;font-size:11.5px;padding:3px 6px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);max-width:180px}\n.ff-focus-sel:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}\n.ff-meta{font-size:11.5px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.ff-chips{display:flex;gap:6px;align-items:center}
.ff-sp{flex:1 1 auto}
.ff-btn{font-size:11.5px;line-height:1.5;padding:2px 9px;border-radius:6px;cursor:pointer;
  border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);
  background:transparent;user-select:none;white-space:nowrap}
.ff-btn:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l3,var(--dsw-alias-border-l2))}
.ff-btn.p{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}
.ff-btn.w{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}
.ff-btn.off{opacity:.35;cursor:default;pointer-events:none}
.ff-stage{flex:1 1 auto;position:relative;overflow:hidden;cursor:grab;min-height:0}
.ff-stage.drag{cursor:grabbing}
.ff-world{position:absolute;left:0;top:0;transform-origin:0 0;padding:32px}

/* ── 树 + 导线 ────────────────────────────────────────────────────────
 *
 * 横向树：父节点在左，子列在右。
 *
 * ★ 导线按用户 2026-10-21 给的参照图改成**花括号式**：
 *   父节点右边缘直接接上括号的尖，括号向上弯进第一个子节点、向下弯进最后一个，
 *   中间的子节点从括号的竖直段伸一小截横线出来。
 *   （注释里不要写反引号：这一段在模板字符串里，一个反引号就把 CSS 截断了。）
 *
 *   实现（不画 SVG，纯边框 + 圆角）：
 *     上半括号 = 一个盒子：border-left（竖）+ border-top（横）+ 左上圆角
 *     下半括号 = 同一个盒子翻过来：border-left + border-bottom + 左下圆角
 *   两个盒子的左边缘都在 x=0（贴着父节点右边缘），横边末端落在子节点左边缘（x=34）。
 *
 * ⚠️ 括号两臂的**纵向位置必须量**（--ff-b1 / --ff-b2，由 layoutBraces() 写）：
 *   原来写死 top:9px / bottom:9px，假设"首个子节点就在容器顶上"——
 *   错得很明显：每道工序的子树很高（1 设计故事下面还挂着一串），
 *   那个盒子的中心远在下面 ⇒ 括号整个偏上、跟节点对不上 ✗（用户 2026-10-21 截图报的就是这个）
 *   ⇒ 现在按「首/末子节点的 offsetTop + 高度/2」（布局像素，不含缩放）算出来再写进去。
 *
 *   节点本身**不加框不加底**（用户明确说：只参考导线样式，节点别模仿）。
 */
/*
 * 父节点**垂直居中**于子列（2026-10-30 用户改回来，并给出理由）：
 *   「横线要连接在下游竖线的垂直中心，下游的树枝不要只朝下长，要上下均匀」
 * ⇒ 父节点居中 ⇒ 它的出线正好落在子列竖线的中点，各分支向上向下均匀分布。
 *
 * 为什么 10-29 曾经改成顶部对齐：那时导线画在节点**底边**，居中会让
 * 人物看起来"压在身份/性格下面"。底边导线已经废掉（现在接在垂直中心），
 * 居中不再产生那种错觉 —— 所以恢复居中。
 */
.ff-tree{display:flex;align-items:center;gap:0;position:relative}
.ff-kids{position:relative;display:flex;flex-direction:column;gap:9px;padding-left:34px}
/*
 * 导线层：SVG 绝对定位铺在 world 里，**不占布局空间**（否则会把整棵树挤下去）。
 * z-index 0 / 节点 1：线在节点底下穿过。
 */
.ff-lines{position:absolute;left:0;top:0;pointer-events:none;z-index:0;overflow:visible}
.ff-world > .ff-tree{position:relative;z-index:1}
/* 导线由 drawConnectors() 用 SVG 画（见 layoutBraces），下面这些伪元素规则已废弃 */
.ff-kids > .ff-tree{position:relative}

/*
 * 节点 = 标题 + 正文，都摊在画布上（用户 2026-10-21：不要二级卡片）。
 * 正文按内容折行，最长 9 行，超出裁掉（点进去编辑时 textarea 会自己长高）。
 */
.ff-node{border-radius:6px;padding:2px 4px;max-width:360px;cursor:text;
  color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:2px}
.ff-node-hd{display:flex;align-items:baseline;gap:5px;white-space:nowrap}
.ff-node-no{font-size:11px;color:var(--dsw-alias-label-secondary)}
.ff-node-t{font-size:13.5px;font-weight:600}
.ff-node-bd{font-size:12px;line-height:1.55;color:var(--dsw-alias-label-secondary);
  white-space:pre-wrap;cursor:text;box-sizing:border-box;
  /*
   * 用户 2026-10-22：「节点内容要全展开，不要埋一半」——
   * ⇒ 去掉 max-height / overflow / 渐隐遮罩，正文有多少显示多少。
   *   只保留限宽（270px）让长句自动折行。
   */
  max-width:270px;
  border-left:2px solid transparent;padding-left:6px}
.ff-node-bd:hover{border-left-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary)}
.ff-node-bd.empty{color:var(--dsw-alias-label-secondary);opacity:.7;font-style:italic}
/* 紧凑档：正文限高，超出滚动（滚动条细一点，不抢视线） */
.ff-node-bd.compact{max-height:140px;overflow:auto;scrollbar-width:thin}
.ff-node-bd.compact::-webkit-scrollbar{width:5px}
.ff-node-bd.compact::-webkit-scrollbar-thumb{background:var(--dsw-alias-border-l2);border-radius:3px}
/* 模型选择节点（shape.kind === "select"）：正文位置就是一个下拉 */
.ff-node-bd.sel{padding:4px 6px}
.ff-node-sel{font:inherit;font-size:12.5px;width:100%;box-sizing:border-box;padding:3px 6px;
  border-radius:6px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);
  color:var(--dsw-alias-label-primary);cursor:pointer}
.ff-node-sel:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}
.ff-node-sel-warn{font-size:11px;color:var(--dsw-alias-state-warning-primary);margin-top:4px}
/* 伪节点：布局上像子节点，功能上不独立（无 ＋/✕，改它=改上游文件那一段） */
.ff-node.pseudo .ff-node-t{font-weight:500;font-size:13px}
.ff-node.pseudo .ff-node-bd{/* 同样全展开（用户：不要埋一半） */}
.ff-node-bd.count{font-size:11px;font-style:italic;opacity:.65;max-height:none;
  -webkit-mask-image:none;mask-image:none;border-left-color:transparent}
.ff-node-bd.err{color:var(--dsw-alias-state-error-primary)}
.ff-inline-edit,.ff-inline-rename{width:280px;max-width:100%;box-sizing:border-box;font:inherit;font-size:12px;
  line-height:1.55;padding:2px 4px;border-radius:5px;resize:none;overflow:hidden;
  border:1px solid var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-base);
  color:var(--dsw-alias-label-primary)}
.ff-inline-rename{font-size:13.5px;font-weight:600;padding:1px 4px}
.ff-node:hover{background:var(--dsw-alias-bg-layer-1)}
.ff-node.leaf,.ff-node.content{font-size:12.5px;color:var(--dsw-alias-label-secondary)}
.ff-node.stage{font-weight:600;font-size:13.5px}
.ff-node.root{font-size:15px;font-weight:700}
.ff-node.sel{background:var(--dsw-alias-bg-layer-2);box-shadow:inset 0 0 0 1px var(--dsw-alias-brand-primary)}
.ff-node.warn{color:var(--dsw-alias-state-warn-primary)}
.ff-node .ff-sub{font-size:10px;color:var(--dsw-alias-label-secondary);font-weight:400}

/* ── 节点卡片 ──────────────────────────────────────────────────────── */
.ff-card{display:none !important;position:absolute;right:12px;top:12px;width:390px;max-height:calc(100% - 24px);
  display:none;flex-direction:column;gap:7px;overflow:auto;padding:12px;
  border:1px solid var(--dsw-alias-brand-primary);border-radius:10px;
  background:var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-base));
  box-shadow:0 10px 30px rgba(0,0,0,.16);z-index:5}
.ff-card.on{display:flex}
.ff-card h3{margin:0;font-size:13.5px;font-weight:600}

/* ── 节点上的结构操作按钮（2026-10-21 P2）─────────────────────────────
 * 悬停才出现；按钮本身很小，不抢节点的视觉重心。
 */
.ff-node{position:relative}
.ff-node-ops{position:absolute;right:-46px;top:50%;transform:translateY(-50%);
  display:none;gap:2px;align-items:center;z-index:3}
.ff-node:hover .ff-node-ops{display:flex}
button.ff-op{font:11px/1 inherit;padding:2px 5px;border-radius:5px;cursor:pointer;
  border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);
  color:var(--dsw-alias-label-secondary)}
button.ff-op:hover{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}

/* 「N 个子节点（点开）」折叠开关 —— 子节点太多时的默认形态 */
.ff-more{font-size:12px;color:var(--dsw-alias-brand-primary);cursor:pointer;white-space:nowrap;
  padding:2px 6px;border-radius:6px;border:1px dashed var(--dsw-alias-border-l2)}
.ff-more:hover{background:var(--dsw-alias-bg-layer-2)}

/* 模板菜单（点 ＋ 弹出来） */
.ff-tpl{position:fixed;z-index:40;min-width:210px;max-height:60vh;overflow:auto;
  display:flex;flex-direction:column;gap:2px;padding:8px;
  border:1px solid var(--dsw-alias-border-l2);border-radius:10px;
  background:var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-base));
  box-shadow:0 12px 32px rgba(0,0,0,.18)}
.ff-tpl-hd{font-size:11px;color:var(--dsw-alias-label-secondary);padding:2px 6px 6px}
button.ff-tpl-it{text-align:left;font:inherit;font-size:12.5px;padding:6px 8px;border-radius:7px;
  border:0;background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer}
button.ff-tpl-it:hover{background:var(--dsw-alias-bg-layer-2)}
/* 模板菜单：搜索框 + 分组标题（B5） */
.ff-tpl-search{font:inherit;font-size:12.5px;margin:0 0 6px;padding:5px 8px;border-radius:7px;
  border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}
.ff-tpl-search:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}
.ff-tpl-list{display:flex;flex-direction:column;gap:2px;max-height:46vh;overflow:auto}
.ff-tpl-group{font-size:10.5px;color:var(--dsw-alias-label-secondary);padding:6px 6px 2px}
.ff-tpl-empty{font-size:12px;color:var(--dsw-alias-label-secondary);padding:8px 6px}
.ff-tpl-custom{margin:0 0 6px;border:1px dashed var(--dsw-alias-border-secondary,rgba(0,0,0,.18))!important;color:var(--dsw-alias-brand-primary,#2563c4)}

/* 删除确认条（替掉原生 confirm） */
.ff-confirm{position:fixed;z-index:41;width:280px;display:flex;flex-direction:column;gap:10px;
  padding:12px 14px;border:1px solid var(--dsw-alias-state-warn-primary);border-radius:10px;
  background:var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-base));
  box-shadow:0 14px 36px rgba(0,0,0,.22);font-size:13px;color:var(--dsw-alias-label-primary)}
.ff-confirm-row{display:flex;gap:8px;justify-content:flex-end}
.ff-card .ff-mono{font:10.5px/1.5 ui-monospace,Consolas,monospace;color:var(--dsw-alias-label-secondary);
  word-break:break-all}
.ff-card label{font-size:10.5px;color:var(--dsw-alias-label-secondary);margin-top:4px}
.ff-card input,.ff-card textarea{width:100%;box-sizing:border-box;font:inherit;font-size:12.5px;
  padding:6px 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2);
  background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);resize:vertical}
.ff-card input:focus,.ff-card textarea:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}
.ff-card textarea{min-height:200px}
.ff-card .ff-row{display:flex;gap:8px;align-items:center;margin-top:4px}
.ff-msg{font-size:11px;line-height:1.6;color:var(--dsw-alias-label-secondary);white-space:pre-wrap}
.ff-msg.err{color:var(--dsw-alias-state-error-primary)}
.ff-msg.ok{color:var(--dsw-alias-state-success-primary)}
.ff-empty{padding:28px 16px;font-size:12.5px;line-height:1.9;color:var(--dsw-alias-label-secondary)}

/* 导线颜色：参照图那种石板蓝灰；深色主题提亮一档，否则看不见 */
.ff-root{--ff-line:rgba(96,124,148,.85)}
body[data-ds-dark-theme] .ff-root{--ff-line:rgba(158,184,204,.7)}

/* ── 提案卡：长在 agent 调 filmflow_propose 的那张工具卡上 ─────────────
 * 位置由官方工具树决定 —— 就在 agent 说出"我想这么改"的那一刻，
 * 不在画布上抢地方，也不是我在对话流里另塞的一行。
 */
.ff-tool{border:1px solid var(--dsw-alias-state-warn-primary);border-radius:10px;
  background:var(--dsw-alias-bg-layer-1);padding:10px 12px;display:flex;flex-direction:column;gap:7px;
  font-size:13px;color:var(--dsw-alias-label-primary);max-width:100%}
.ff-tool.done{border-color:var(--dsw-alias-border-l2);background:transparent}
.ff-tool-hd{display:flex;align-items:baseline;gap:7px;flex-wrap:wrap;font-size:12px;
  color:var(--dsw-alias-state-warn-primary);font-weight:600}
.ff-tool.done .ff-tool-hd{color:var(--dsw-alias-label-secondary)}
.ff-tool-hd b{color:var(--dsw-alias-label-primary);font-weight:600}
.ff-tool-why{font-size:13px;line-height:1.65;color:var(--dsw-alias-label-primary);white-space:pre-wrap;word-break:break-word}
.ff-tool-btns{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.ff-tool-pre{margin:0;font:11.5px/1.6 ui-monospace,Consolas,monospace;white-space:pre-wrap;
  word-break:break-word;max-height:260px;overflow:auto;padding:8px 10px;border-radius:8px;
  background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);
  color:var(--dsw-alias-label-secondary)}
.ff-tool-note{font-size:11.5px;line-height:1.6;color:var(--dsw-alias-label-secondary)}
.ff-tool-note.err{color:var(--dsw-alias-state-error-primary)}
.ff-tool-note.ok{color:var(--dsw-alias-state-success-primary)}
button.ff-btn{background:transparent;font-family:inherit}

/* ── 布局：56px 控制条 / 项目菜单 / 工作台（画布 + 会话）─────────────────
 *
 * 用户 2026-10-20 定的页面流：
 *   第一个页面 = **项目菜单**（这部片库里有哪几部片）
 *   点进项目 = **画布**，右边是 **Agent 会话框**
 *   一个项目绑一个会话 ⇒ 项目里不要"项目选择侧边栏"
 *
 * 所以左边那条不是侧边栏，是 56px 的**控制条**（官方框架折叠后就是 56px，
 * 它自己的文档也要求 occupant 在折叠时画一条控制轨）。
 */
.ff-rail{height:100%;display:flex;flex-direction:column;align-items:center;gap:4px;
  padding:10px 0 8px;background:var(--dsw-specific-sidebar-fill,transparent);overflow:hidden}
.ff-rail-btn{flex:none;width:38px;height:34px;display:flex;align-items:center;justify-content:center;
  border-radius:8px;cursor:pointer;color:var(--dsw-alias-label-secondary);border:none;background:transparent}
.ff-rail-btn:hover{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}
.ff-rail-btn.on{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.ff-rail-btn[disabled]{opacity:.35;cursor:default}
.ff-rail-sp{flex:1 1 auto}
.ff-rail-list{width:100%;overflow:auto;padding:0 6px;display:flex;flex-direction:column;gap:2px}
.ff-rail-item{font-size:12.5px;line-height:1.5;padding:5px 8px;border-radius:6px;cursor:pointer;
  color:var(--dsw-alias-label-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ff-rail-item:hover{background:var(--dsw-alias-bg-layer-1)}
.ff-rail-head{font-size:11px;color:var(--dsw-alias-label-secondary);padding:6px 8px 2px;width:100%;
  box-sizing:border-box;text-align:left}

/* ── 项目菜单（第一个页面）───────────────────────────────────────────── */
/* 媒体节点的提示词输入框与调节器（用户 2026-10-22 定的位置：预览与提示词下面） */
.ff-media-prompt-edit{width:100%;max-width:300px;box-sizing:border-box;font:inherit;font-size:11.5px;line-height:1.5;
  color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-base);
  border:1px solid var(--dsw-alias-border-l2);border-radius:7px;padding:6px 8px;resize:vertical;min-height:52px}
.ff-media-prompt-edit:focus{outline:none;border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary)}
.ff-media-ctrls{display:flex;flex-wrap:wrap;gap:6px 8px;width:100%;max-width:300px;margin-top:2px}
.ff-media-sel{display:flex;flex-direction:column;gap:2px}
.ff-media-sel-lb{font-size:10px;color:var(--dsw-alias-label-secondary)}
.ff-media-sel-in{font:inherit;font-size:11px;padding:2px 4px;border-radius:5px;min-width:112px;max-width:150px;
  border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);
  color:var(--dsw-alias-label-primary)}
.ff-media-sel-in:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}

/* 宽度：不限（试验档）—— 解除 360px 上限，长段落少折几行 */
/*
 * 宽模式要点：光把 max-width 设成 none 不够 —— flex 列会把节点**压到最窄**（实测节点只剩 27px，
 * 文字反而更多行）。必须 width:max-content 让它按内容撑开，再用 max-width 兜一个上限，
 * 否则一段两千字会把画布撑成一条横线。
 */
.ff-root.wide .ff-node{width:max-content;max-width:min(1100px, 92vw)}
.ff-root.wide .ff-node-bd{width:max-content;max-width:100%;min-width:0}
.ff-root.wide .ff-node-t{white-space:normal}
.ff-root.wide .ff-node.media{width:auto;max-width:320px}

/* 顶级工序横向并排（版式：横向）
.ff-kids.row{display:flex;flex-direction:row;align-items:flex-start;gap:22px;padding-left:34px;width:max-content;flex:0 0 auto}
.ff-kids.row::before,.ff-kids.row::after{display:none}
.ff-kids.row > .ff-tree{align-items:flex-start;flex:0 0 auto;width:320px}
/* 横向版式里子列不能被压扁：flex 会按可用空间收缩，节点就挤成一团了 */
.ff-kids.row .ff-node{flex-shrink:0}
.ff-kids.row .ff-node-bd{min-width:200px}

/* 画布右上角：积分与生成记录（只读）
.ff-hud{position:absolute;right:12px;top:8px;z-index:6;pointer-events:auto;
  background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);
  border-radius:9px;padding:5px 9px;font-size:11.5px;color:var(--dsw-alias-label-secondary);
  max-width:260px}
.ff-hud-sum{cursor:pointer;font-weight:600;color:var(--dsw-alias-label-primary)}
.ff-hud-list{display:none;flex-direction:column;gap:3px;margin-top:6px;max-height:40vh;overflow:auto}
.ff-hud.open .ff-hud-list{display:flex}
.ff-hud-row{display:flex;gap:6px;align-items:baseline;white-space:nowrap}
.ff-hud-when{opacity:.65;font-variant-numeric:tabular-nums}
.ff-hud-name{flex:1;overflow:hidden;text-overflow:ellipsis}
.ff-hud-st{color:var(--dsw-alias-brand-primary)}
.ff-hud-st.err{color:var(--dsw-alias-state-error-primary)}
.ff-hud-empty{opacity:.6}

/* ── 媒体节点（图片/视频/音频）──────────────────────────────── */
.ff-node.media{max-width:320px;min-width:120px;gap:6px;cursor:default}
/* 缩略框：宽固定，高由 padding-top（比例）决定；图片绝对定位铺满 */
.ff-media-thumb{position:relative;width:300px;border-radius:8px;overflow:hidden;
  background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2)}
.ff-media-thumb img,.ff-media-thumb video{position:absolute;inset:0;display:block;width:100%;height:100%;object-fit:contain;background:var(--dsw-alias-bg-base)}
.ff-media-thumb.audio{height:64px;display:flex;align-items:center;justify-content:center}
.ff-media-thumb .ff-media-play{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
  background:rgba(0,0,0,.28);color:#fff;font-size:22px;cursor:pointer;opacity:0;transition:opacity .12s}
.ff-media-thumb:hover .ff-media-play{opacity:1}
.ff-media-empty{width:300px;height:120px;border-radius:8px;border:1px dashed var(--dsw-alias-border-l2);
  display:flex;align-items:center;justify-content:center;font-size:12px;
  color:var(--dsw-alias-label-secondary)}
.ff-media-meta{display:flex;align-items:center;gap:8px;font-size:11.5px;
  color:var(--dsw-alias-label-secondary);flex-wrap:wrap}
.ff-media-prompt{font-size:11.5px;line-height:1.5;color:var(--dsw-alias-label-secondary);
  max-width:300px;white-space:pre-wrap;word-break:break-word}
.ff-media-bar{display:flex;align-items:center;gap:6px;margin-top:2px}
.ff-media-prog{font-size:11.5px;color:var(--dsw-alias-brand-primary)}
.ff-media-err{font-size:11.5px;color:var(--dsw-alias-state-error-primary);max-width:300px}

/* 素材库 / 查看器 */
.ff-assets{position:fixed;top:0;right:0;bottom:0;left:var(--ff-rail-w,56px);z-index:62;display:flex;flex-direction:column;
  background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}
.ff-assets-bar{display:flex;align-items:center;gap:8px;padding:10px 16px;
  border-bottom:1px solid var(--dsw-alias-border-l2);flex-wrap:wrap}
.ff-assets-grid{flex:1;overflow:auto;padding:14px 16px 60px;
  display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:12px;align-content:start}
.ff-asset-card{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;overflow:hidden;
  background:var(--dsw-alias-bg-layer-1);display:flex;flex-direction:column;cursor:pointer}
.ff-asset-card:hover{border-color:var(--dsw-alias-brand-primary)}
.ff-asset-card .im{width:100%;height:140px;object-fit:cover;display:block;background:#000}
.ff-asset-card .info{padding:7px 9px;display:flex;flex-direction:column;gap:3px}
.ff-asset-card .t{font-size:12px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ff-asset-card .m{font-size:11px;color:var(--dsw-alias-label-secondary)}
.ff-viewer{position:fixed;inset:0;z-index:64;background:rgba(0,0,0,.86);
  display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px}
.ff-viewer img,.ff-viewer video{max-width:86vw;max-height:78vh;border-radius:8px;background:#000}
.ff-viewer .bar{display:flex;gap:8px;align-items:center;color:#ddd;font-size:12px}
/* 待确认提案面板：钉在会话框底部（不是画布上） */
.ff-dock{position:fixed;left:64px;bottom:96px;width:400px;max-height:42vh;overflow:auto;z-index:55;
  pointer-events:auto;   /* shell.overlay 是 click-through 的，这一层必须自己收事件 */
  display:flex;flex-direction:column;gap:8px;padding:10px 12px;border-radius:12px;
  background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);
  box-shadow:0 8px 28px rgba(0,0,0,.28)}
.ff-dock-hd{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary)}
.ff-dock-list{display:flex;flex-direction:column;gap:8px}
.ff-dock-item{border:1px solid var(--dsw-alias-border-l2);border-radius:9px;padding:8px 10px;
  display:flex;flex-direction:column;gap:5px;background:var(--dsw-alias-bg-base)}
.ff-dock-t{font-size:12.5px;font-weight:600}
.ff-dock-why{font-size:12px;color:var(--dsw-alias-label-secondary);line-height:1.5}
.ff-dock-btns{display:flex;gap:6px}
/* 项目文件阅读器（侧边栏「文档」） */
.ff-docs{position:fixed;top:0;right:0;bottom:0;left:var(--ff-rail-w,56px);z-index:60;display:flex;flex-direction:column;
  background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}
.ff-docs-bar{display:flex;align-items:center;gap:8px;padding:10px 16px;
  border-bottom:1px solid var(--dsw-alias-border-l2);flex-wrap:wrap}
.ff-docs-hd{font-size:14px;font-weight:600;margin-right:6px}
.ff-docs-tabs{display:flex;gap:6px}
.ff-docs-meta{font-size:11.5px;color:var(--dsw-alias-label-secondary);font-family:ui-monospace,monospace}
.ff-docs-body{flex:1;overflow:auto;padding:18px 22px 60px;font-size:13px;line-height:1.75;
  white-space:pre-wrap;font-family:ui-sans-serif,system-ui;max-width:1000px}
.ff-docs-line.h{font-weight:700;font-size:14px;margin-top:10px}
.ff-docs-line.q{color:var(--dsw-alias-label-secondary);border-left:3px solid var(--dsw-alias-border-l2);padding-left:8px}
.ff-docs-body{scroll-behavior:smooth}.ff-projects{height:100%;overflow:auto;box-sizing:border-box;
  padding:calc(var(--dsh-frame-top-clearance,0px) + 18px) 28px 28px;
  background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}
.ff-projects h2{margin:0 0 4px;font-size:17px;font-weight:600}
.ff-projects .ff-hint{font-size:12.5px;color:var(--dsw-alias-label-secondary);margin:0 0 20px}
/* 新建片子：片名 + 骨架包 */
.ff-new{margin:0 0 18px;padding:12px 14px;border:1px dashed var(--dsw-alias-border-l2);border-radius:12px;
  display:flex;flex-direction:column;gap:8px}
.ff-new-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.ff-new-name{flex:0 0 200px;box-sizing:border-box;font:inherit;font-size:13px;padding:6px 9px;border-radius:7px;
  border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}
.ff-new-name:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}
.ff-new-pack{font:inherit;font-size:13px;padding:6px 8px;border-radius:7px;
  border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}
button.ff-btn:disabled{opacity:.55;cursor:default}
.ff-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px}
.ff-proj{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:14px 16px;cursor:pointer;
  display:flex;flex-direction:column;gap:8px;background:var(--dsw-alias-bg-base);
  transition:border-color .12s,background .12s}
.ff-proj:hover{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-1)}
.ff-proj .t{font-size:14.5px;font-weight:600;line-height:1.4;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ff-proj .m{font-size:11.5px;color:var(--dsw-alias-label-secondary);display:flex;gap:10px;flex-wrap:wrap}
.ff-proj .m .warn{color:var(--dsw-alias-state-warn-primary)}
.ff-proj .p{font-size:10.5px;font-family:ui-monospace,Consolas,monospace;
  color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ff-proj-empty{border:1px dashed var(--dsw-alias-border-l2);border-radius:12px;padding:28px;
  font-size:12.5px;line-height:1.9;color:var(--dsw-alias-label-secondary)}

/* ── 浮层：项目菜单（盖满）／画布（右，让出左边官方会话的宽度）─────────────
 *
 * shell.overlay 那层本身是 click-through 的（官方的契约），
 * 所以每个浮层自己把 pointer-events 打开，并且自己定位。
 * --ff-chat-right 是**实测**出来的官方中心列右边缘 —— 画布从那里开始。
 */
.ff-layer{position:fixed;pointer-events:auto;box-sizing:border-box;
  background:var(--dsw-alias-bg-base);z-index:20;display:flex;flex-direction:column;
  top:var(--dsh-frame-top-clearance,0px);bottom:0}
.ff-layer-menu{left:56px;right:0;z-index:21}
/* 会话在左、画布在右（用户 2026-10-21）；left 用实测值，别猜 486 */
.ff-layer-work{left:var(--ff-chat-right,486px);right:0;border-left:1px solid var(--dsw-alias-border-l1)}
.ff-pane-canvas{flex:1 1 auto;min-width:0;min-height:0;position:relative;display:flex;flex-direction:column}

/* ── 会话框里两个多余的下拉：一个项目绑一条会话、一个人格，没什么可切的 ──
 *
 * 用户 2026-10-21：「一个 Agent 会话是跟他旁边的项目绑定的，所以 Agent 会话框
 * 不能有如参考图中的文件切换功能和预设切换功能。」
 *
 * · 预设 chip（「片场 ⌄」）→ 直接在叠加层里 disable 掉 ui-agent-preset，没有 DOM
 * · 工作区 chip（「新片 ⌄」）→ 它是 ui-workspace 注册进 conversation.hero.workspace 的，
 *   那个插件**不能 disable**（工作区/会话全靠它），所以只能从样式上收起。
 *   钩子用它的 **aria-label**（"选择工作区"，官方 i18n 串；界面语言已钉死 zh）——
 *   比 class 稳（class 是 hash，升级就变）。
 *   ⚠️ 万一哪天官方改了这句文案，最坏结果就是这个 chip 重新露出来，不影响功能。
 */
/* ── 品牌：把「探索未至之境 / 预览版 / 鲸鱼」从片场去掉 ──────────────
 *
 * 用户 2026-10-28：「把片厂的所有深度求索元素（如参考图）去掉」。
 * 那两个文案是官方 conversation 空态 hero 里**硬编码**的 i18n 串，没有槽位；
 * 鲸鱼logo 有槽位（conversation.hero.brand.mark）。所以：
 *   · 文案整组（headline + previewBadge）用样式收起
 *   · logo 槽位换成片场自己的字标（见 HeroMark）
 * ⚠️ class 是 hash（pXSMma_titleGroup），换 DSH 版本可能变；用「包含」匹配，
 *    最坏结果只是文案重新露出来，不影响功能。
 */
[class*="pXSMma_titleGroup"],[class*="HeroShell"][class*="titleGroup"]{display:none !important}
/* 兜底：万一槽位没占上、官方鲸鱼又露出来，也只露它一个 —— 直接连 svg 一起收掉 */
[class*="pXSMma_fishHitbox"] > svg{display:none !important}
.ff-hero-mark{font-weight:800;letter-spacing:.08em;color:var(--dsw-alias-label-primary);
  display:inline-flex;align-items:center;justify-content:center;user-select:none;line-height:1}

/* ── 节点库（全屏页）────────────────────────────────────────────── */
.ff-lib{position:fixed;top:0;right:0;bottom:0;left:var(--ff-rail-w,56px);z-index:60;display:flex;flex-direction:column;
  background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}
.ff-lib-bar{display:flex;align-items:center;gap:10px;padding:10px 16px;
  border-bottom:1px solid var(--dsw-alias-border-l2);flex-wrap:wrap}
.ff-lib-body{flex:1;overflow:auto;padding:12px 16px 70px}
.ff-lib-search{font:inherit;font-size:13px;padding:5px 10px;border-radius:7px;min-width:220px;
  border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}
.ff-lib-search:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}
.ff-lib-cats{display:flex;gap:6px;flex-wrap:wrap;margin:2px 0 10px}
.ff-lib-cats .ff-btn{font-size:11.5px}
.ff-lib-h{font-size:12.5px;font-weight:700;margin:16px 0 8px;color:var(--dsw-alias-label-secondary)}
.ff-lib-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:10px}
.ff-lib-card{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:10px 12px;
  background:var(--dsw-alias-bg-layer-1);display:flex;flex-direction:column;gap:5px}
.ff-lib-card:hover{border-color:var(--dsw-alias-brand-primary)}
.ff-lib-t{font-weight:600;font-size:13.5px;display:flex;align-items:baseline;gap:6px;flex-wrap:wrap}
.ff-lib-id{font-family:ui-monospace,monospace;font-size:10.5px;color:var(--dsw-alias-label-secondary)}
.ff-lib-tags{display:flex;gap:6px;flex-wrap:wrap}
.ff-lib-tag{font-size:10.5px;padding:1px 7px;border-radius:999px;
  border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}
.ff-lib-note{font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary)}
.ff-lib-more{font-size:11.5px;color:var(--dsw-alias-brand-primary);cursor:pointer;user-select:none}
.ff-lib-doc{margin-top:6px;white-space:pre-wrap;font-size:12px;line-height:1.7;
  border-top:1px dashed var(--dsw-alias-border-l1);padding-top:8px}
.ff-lib-packs{font-size:11px;color:var(--dsw-alias-label-secondary);line-height:1.5}

/* ── 素材库：按项目分文件夹 ─────────────────────────────────────── */
.ff-folder-grid{flex:1;overflow:auto;padding:16px;display:grid;
  grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:12px;align-content:start}
.ff-folder{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:14px;
  background:var(--dsw-alias-bg-layer-1);cursor:pointer;display:flex;flex-direction:column;gap:8px}
.ff-folder:hover{border-color:var(--dsw-alias-brand-primary)}
.ff-folder-ic{font-size:22px;line-height:1}
.ff-folder-t{font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ff-folder-m{font-size:11.5px;color:var(--dsw-alias-label-secondary)}
.ff-crumb{font-size:12px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:none;border:none;font:inherit}
.ff-crumb:hover{color:var(--dsw-alias-brand-primary)}

/* ── API 设置（只配 Agent 的 key / url / model）──────────────────── */
.ff-set-body{flex:1;overflow:auto;padding:22px 26px 70px;max-width:780px}
.ff-set-hd{font-size:14px;font-weight:700;margin:2px 0 2px}
.ff-set-sub{font-size:11.5px;color:var(--dsw-alias-label-secondary);margin:2px 0 4px;max-width:600px;line-height:1.65}
.ff-set-row{display:flex;flex-direction:column;gap:7px;margin:16px 0 4px}
.ff-set-label{font-size:12.5px;color:var(--dsw-alias-label-secondary);display:flex;align-items:center;gap:8px}
.ff-set-line{display:flex;gap:8px}
.ff-set-input{font:inherit;font-size:13px;padding:8px 11px;border-radius:8px;flex:1;min-width:0;max-width:600px;
  border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}
.ff-set-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}
.ff-set-badge{font-size:10.5px;padding:1px 8px;border-radius:999px;
  border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}
.ff-set-badge.ok{color:var(--dsw-alias-state-success-primary,#3fb950);border-color:currentColor}
.ff-set-hint{font-size:11.5px;color:var(--dsw-alias-label-secondary);margin:7px 0;line-height:1.65;max-width:600px}
.ff-set-actions{display:flex;gap:8px;margin:12px 0 18px}
.ff-set-msg{font-size:12px;color:var(--dsw-alias-brand-primary);margin-top:8px}
.ff-set-hr{height:1px;background:var(--dsw-alias-border-l1);margin:20px 0}

[aria-label="选择工作区"]{display:none !important}
`;

		// ══════════════════════════════════════════════════════════════
		// 小工具
		// ══════════════════════════════════════════════════════════════

		/** 建元素。 */
		function el(tag, cls, txt) {
			const e = document.createElement(tag);
			if (cls) e.className = cls;
			if (txt !== undefined) e.textContent = txt;
			return e;
		}

		/**
		 * 写操作令牌。
		 *
		 * 宿主（../index.js）在启动时随机生成，通过 GET /filmflow/token 发给**同源页面**。
		 * 写接口要求请求头带它 —— 这是防 CSRF 的第二道闸（第一道是同源检查）。
		 * @returns {Promise<string>} 令牌；拿不到就空串（写操作会得到明确的 403）。
		 */
		async function fetchToken() {
			const cached = globalThis.__FILMFLOW_TOKEN__;
			if (typeof cached === "string" && cached) return cached;
			try {
				const res = await fetch("/filmflow/token", { headers: { accept: "application/json" } });
				if (!res.ok) return "";
				const j = await res.json();
				globalThis.__FILMFLOW_TOKEN__ = String(j.token || "");
				return globalThis.__FILMFLOW_TOKEN__;
			} catch {
				return "";
			}
		}

		/** 发一个写请求（自动带令牌）。 */
		async function post(url, body) {
			const token = await fetchToken();
			const res = await fetch(url, {
				method: "POST",
				headers: { "Content-Type": "application/json", "x-filmflow-token": token },
				body: JSON.stringify(body),
			});
			let j = null;
			try { j = await res.json(); } catch { /* 空响应 */ }
			if (!res.ok || !j || !j.ok) throw new Error((j && j.error) || "HTTP " + res.status);
			return j;
		}

		/** 读一次全量状态。 */
		async function fetchState() {
			const res = await fetch("/filmflow/state", { headers: { accept: "application/json" } });
			if (!res.ok) throw new Error("HTTP " + res.status);
			return res.json();
		}

		/**
		 * 页面心跳。
		 *
		 * 宿主的「空闲自退」靠它判断还有没有人在看：关掉窗口之后不再有心跳，
		 * 20 分钟后进程自己退出（也就是"关掉前端 = 关掉服务"）。
		 *
		 * 为什么 20 秒一次：Chrome 会把后台标签页的定时器压到约 1 分钟一次，
		 * 这个频率在被压缩后仍然远小于 20 分钟的超时窗口。
		 * 切回前台时补打一次，避免"刚从长睡眠回来就被判死"。
		 */
		function startHeartbeat() {
			const beat = () => { fetch("/filmflow/keepalive", { method: "POST" }).catch(() => { /* 忽略 */ }); };
			beat();
			const timer = setInterval(beat, 20000);
			const onVisible = () => { if (document.visibilityState === "visible") beat(); };
			document.addEventListener("visibilitychange", onVisible);
			return () => {
				clearInterval(timer);
				document.removeEventListener("visibilitychange", onVisible);
			};
		}

		// ══════════════════════════════════════════════════════════════
		// 画布（命令式 DOM）
		// ══════════════════════════════════════════════════════════════
		// 为什么是命令式而不是 React 组件树：
		//   画布是一大棵会**平移缩放**的树，React 每帧重排反而更糟；
		//   而且这套渲染逻辑（连线、肘、适应窗口）是用户已经认可的成品，
		//   搬进来只改配色、不重写。
		//   React 只负责"把这个画布挂进官方框架，并在卸载时拆掉"。

		/**
		 * 「第一次画完自动适应窗口」只做一次。
		 *
		 * 不放进程级、也不每次挂载都做 —— 那样用户把画布放大看某一支之后，
		 * 切走再切回来会被强行缩回全景，很难用。
		 * @type {boolean}
		 */
		let fittedOnce = false;

		/**
		 * 把画布挂到一个容器里。
		 * @param host - 容器元素。
		 * @param opts - `{ root }`：要显示哪一部片（由项目菜单点进来时给定）；
			 *   `{ onBack }`：点「← 项目菜单」时回调外层。
		 * @returns 卸载函数（清定时器、移出 DOM）。
		 */
		function mountCanvas(host, opts) {
			const wantRoot = String((opts && opts.root) || "");
			const onBack = (opts && opts.onBack) || null;
			/** 全量状态。 */
			let S = null;
			/** 子节点超过这个数就默认折叠（58 个镜头堆一列没法看） */
			const COLLAPSE_AT = 12;
			/** 已经点开过的节点 key（折叠状态只存在内存里，刷新回到折叠） */
			const EXPANDED = new Set();

			/** 模板清单缓存（一次会话只拉一次；宿主改了模板要刷新页面） */
			let TPL_CACHE = null;
			/**
			 * 节点层级规则（宿主下发，R47）：角色 → 能挂哪些子角色。
			 * `menu` 比服务端校验更聚焦：卡片上的 ＋ 只列这一步该用的节点。
			 */
			let ROLE_RULES = null;
			/** 叶子角色（模型 / 生成节点）不再显示 ＋。 */
			const TERMINAL_ROLE = new Set([
				"model-video", "model-image", "model-audio",
				"gen-video", "gen-image", "gen-audio",
			]);
			/** 当前片子 id。 */
			let PICK = "";
			/** 当前选中节点。 */
			let SEL = null;
			/** 视图（平移 + 缩放）。 */
			const VIEW = { x: 32, y: 32, s: 1 };
			/** 上一次渲染的指纹 —— 内容没变就不重建 DOM（否则每 1.5 秒闪一次）。 */
			const SIG = { tree: "", bar: "", chips: "" };
			/** 已经试过告诉宿主的片（别每轮轮询都重试）。 */
			const selectTried = new Set();
			let pollTimer = null;
			let disposed = false;

			/*
			 * ⚠ 这个声明必须在 mountCanvas 的**最前面**：
			 * 工具栏（btnDensity）在函数上半段就要读它，放晚了就是 TDZ 报错
			 * 「Cannot access 'COMPACT' before initialization」——整块画布直接不渲染。
			 * 我 2026-10-23 就是这么栽的，错误只在浏览器 console 里看得见。
			 */
			/**
			 * 左侧竖条的真实宽度写进 CSS 变量 —— 素材库/文档页要"让出竖条"，否则一进去侧栏就没了。
			 * 用户 2026-10-23：「点进素材库后侧边栏怎么就没了」。
			 */
			function syncRailWidth() {
				try {
					const rail = document.querySelector(".ff-rail");
					if (!rail) return;
					const w = Math.ceil(rail.getBoundingClientRect().right);
					document.documentElement.style.setProperty("--ff-rail-w", w + "px");
				} catch { /* 忽略 */ }
			}

			let COMPACT = true;
			/*
			 * 聚焦哪一道工序（'' = 全图）。用户 2026-10-23：
			 * 「一个真实工程节点经常会非常多，但级不会无限多」——
			 * 全部展开时 164 行，fit 完就是一根竖线；一次只看一道工序，尺寸天然接近一屏。
			 */
			/*
			 * 媒体兄弟网格（试验档）。用户 2026-10-23：
			 *   「1.生成节点还是按照之前的版型。2.试一下媒体兄弟网格化」
			 * ⇒ **默认关**（= 之前的单列版型不变），工具栏可切换成网格试。
			 */
			/*
			 * 顶级工序版式：'v' = 之前那样竖着堆（默认）；'h' = 6 道工序横向并排。
			 * 用户 2026-10-23：「没区别啊」—— 说明真正该动的是**一级工序的排布**，
			 * 而不是媒体节点（他那几部片一个媒体节点都没有）。
			 */
			/*
			 * 文字节点宽度：true = 不限（按内容自己撑开，长段落一行少折几次 → 卡片更矮）；
			 * false = 之前那样限 360px。用户 2026-10-23：「不限文字节点宽度试试」。
			 */
			let WIDE = false;
			let LAYOUT = "v";
			let GRID = false;
			/** 网格里点「编辑」时，当前在编辑哪个媒体节点的参数。 */
			let MEDIA_EDIT = null;

			let FOCUS = "";

			host.className = "ff-root" + (WIDE ? " wide" : "");
			host.innerHTML = "";

			// ── 骨架 ──────────────────────────────────────────────────
			//
			// 工具栏第一项是「← 项目菜单」而不是片子下拉：导航由项目菜单负责
			// （用户 2026-10-20：第一个页面是项目菜单，点进去才是这一部片的画布）。
			const bar = el("div", "ff-bar");
			const btnBack = el("div", "ff-btn", "← 项目菜单");
			const meta = el("div", "ff-meta");
			const chips = el("div", "ff-chips");
			const sp = el("div", "ff-sp");
			const btnFit = el("div", "ff-btn", "适应窗口");
			/* 紧凑 / 全文：画布利用率不够时的总开关（用户 2026-10-23） */
			/* 节点宽度：限 360 / 不限（不限时正文折行少、卡片矮，但整图更宽） */
			const btnWide = el("div", "ff-btn", WIDE ? "宽度：不限" : "宽度：限360");
			btnWide.title = "不限=每个节点按内容自己撑开；限360=之前那样固定最大宽度";
			btnWide.addEventListener("click", () => {
				WIDE = !WIDE;
				try { localStorage.setItem("ff.wide", WIDE ? "1" : "0"); } catch { /* 忽略 */ }
				btnWide.textContent = WIDE ? "宽度：不限" : "宽度：限360";
				host.className = "ff-root" + (WIDE ? " wide" : "");
				SIG.tree = "";
				load();
			});

			/* 版式：纵向（默认，和之前一样）/ 横向（工序并排，治超长竖条） */
			const btnLayout = el("div", "ff-btn", LAYOUT === "h" ? "版式：横向" : "版式：纵向");
			btnLayout.title = "横向=把各道工序并排成一列一列（适合工序多、每道不长的片）";
			btnLayout.addEventListener("click", () => {
				LAYOUT = LAYOUT === "h" ? "v" : "h";
				try { localStorage.setItem("ff.layout", LAYOUT); } catch { /* 忽略 */ }
				btnLayout.textContent = LAYOUT === "h" ? "版式：横向" : "版式：纵向";
				SIG.tree = "";
				load();
				setTimeout(() => { try { fit(); } catch { /* 忽略 */ } }, 80);
			});

			/* 资产布局：单列（旧版型，默认）/ 网格（试验档） */
			const btnGrid = el("div", "ff-btn", GRID ? "资产：网格" : "资产：单列");
			btnGrid.title = "网格=同一父节点下的媒体节点横向并排；单列=之前的版型";
			btnGrid.addEventListener("click", () => {
				GRID = !GRID;
				try { localStorage.setItem("ff.grid", GRID ? "1" : "0"); } catch { /* 忽略 */ }
				btnGrid.textContent = GRID ? "资产：网格" : "资产：单列";
				SIG.tree = "";
				load();
			});
			const btnDensity = el("div", "ff-btn", COMPACT ? "显示：紧凑" : "显示：全文");
			btnDensity.title = "紧凑=正文限高、缩略图 150px；全文=全部展开";
			btnDensity.addEventListener("click", () => {
				COMPACT = !COMPACT;
				try { localStorage.setItem("ff.compact", COMPACT ? "1" : "0"); } catch { /* 忽略 */ }
				btnDensity.textContent = COMPACT ? "显示：紧凑" : "显示：全文";
				SIG.tree = "";
				load();
			});
			/*
			 * 聚焦工序（用户 2026-10-23）：一次只画一道工序的子树，画布利用率才够。
			 * 选「全图」= 原来的完整导图。
			 */
			const focusSel = el("select", "ff-focus-sel");
			focusSel.title = "只看某一道工序（节点多的时候用）";
			focusSel.addEventListener("change", () => {
				FOCUS = String(focusSel.value || "");
				try {
					if (FOCUS) localStorage.setItem("ff.focus", FOCUS);
					else localStorage.removeItem("ff.focus");
				} catch { /* 忽略 */ }
				SIG.tree = "";
				load();
				setTimeout(() => { try { fit(); } catch { /* 忽略 */ } }, 60);
			});
			const btnReload = el("div", "ff-btn", "刷新");
			/*
			 * 撤销 / 重做（用户 2026-10-27：要「两个按钮」，像主流软件那样）。
			 * 宿主维护 undo/redo 两个栈；这里只管按钮状态（栈空 = 灰掉）。
			 */
			const btnUndo = el("div", "ff-btn off", "撤销");
			const btnRedo = el("div", "ff-btn off", "重做");
			/*
			 * 顶层新建（R57）：叶子模板（场景/道具/项目总纲…）在子节点里不再出现，
			 * 必须有一个"在项目顶层加一道工序"的入口，否则这些模板在已有片子里无处可放。
			 */
			const btnAddStage = el("div", "ff-btn", "＋ 工序");
			btnAddStage.title = "在项目顶层新建一道工序";
			bar.append(btnBack, chips, sp, meta, btnAddStage, btnFit, btnReload, btnUndo, btnRedo);

			btnAddStage.addEventListener("click", () => {
				openTplMenu(btnAddStage, { title: "项目顶层", nodeRole: "root", key: "", canAdd: null });
			});

			btnUndo.addEventListener("click", () => { void structure({ type: "undo" }); });
			btnRedo.addEventListener("click", () => { void structure({ type: "redo" }); });
			/** 问宿主 undo/redo 各有几步；空就灰掉。 */
			async function refreshHist() {
				if (!S || !S.current) return;
				try {
					const j = await post("/filmflow/structure", { root: S.current, op: { type: "history" } });
					btnUndo.className = "ff-btn" + (j.undo ? "" : " off");
					btnRedo.className = "ff-btn" + (j.redo ? "" : " off");
				} catch { /* 忽略 */ }
			}
			window.addEventListener("keydown", (ev) => {
				if (!(ev.ctrlKey || ev.metaKey)) return;
				const tag = String((ev.target && ev.target.tagName) || "").toLowerCase();
				if (tag === "input" || tag === "textarea" || (ev.target && ev.target.isContentEditable)) return;
				const k = String(ev.key || "").toLowerCase();
				if (k === "z" && !ev.shiftKey) { ev.preventDefault(); void structure({ type: "undo" }); }
				else if ((k === "z" && ev.shiftKey) || k === "y") { ev.preventDefault(); void structure({ type: "redo" }); }
			});

			const stage = el("div", "ff-stage");
			const world = el("div", "ff-world");
			stage.append(world);

			/*
			 * 节点高度会变（正文变长、折叠/展开、字体加载完）—— 导线必须跟着重画，
			 * 否则线停在旧位置。只观察 world 的尺寸变化，帧级 debounce。
			 */
			let linesRaf = 0;
			const redrawLines = () => {
				if (linesRaf) return;
				linesRaf = requestAnimationFrame(() => {
					linesRaf = 0;
					try {
						if (world.querySelector(":scope > .ff-tree")) drawConnectors(world);
					} catch { /* 画失败不该影响别的 */ }
				});
			};
			let linesRO = null;
			try {
				linesRO = new ResizeObserver(redrawLines);
				linesRO.observe(world);
				window.addEventListener("resize", redrawLines, { passive: true });
			} catch { /* 没有 ResizeObserver 就算了 */ }
			/*
			 * 几何哨兵（2026-10-30）：ResizeObserver 只在 world 自身尺寸变时触发；
			 * 树内部某一段变高、而 world 总尺寸没变（比如同时有别的分支变矮）时，
			 * 线就会停在旧位置。每 2 秒比一次「SVG 尺寸 vs 内容尺寸」，不一致就重画。
			 * 另加：窗口重新获得焦点时补画一次（从别的程序切回来最常见）。
			 */
			try {
				setInterval(() => {
					const svg = world.querySelector("svg.ff-lines");
					if (!svg) return;
					const w = Number(svg.getAttribute("width")) || 0;
					const h = Number(svg.getAttribute("height")) || 0;
					if (Math.abs(w - world.scrollWidth) > 1 || Math.abs(h - world.scrollHeight) > 1) redrawLines();
				}, 2000);
				window.addEventListener("focus", redrawLines);
			} catch { /* 忽略 */ }

			const card = el("div", "ff-card");
			/*
			 * 画布右上角的「积分 HUD」（用户 2026-10-22）：
			 * 实时余额 + 最近生成记录（点一下展开）。只读，不花钱。
			 */
			const hud = el("div", "ff-hud");
			const hudSum = el("div", "ff-hud-sum", "积分 …");
			const hudList = el("div", "ff-hud-list");
			hud.append(hudSum, hudList);
			hudSum.addEventListener("click", (ev) => {
				ev.stopPropagation();
				hud.className = hud.className.indexOf("open") >= 0 ? "ff-hud" : "ff-hud open";
			});
			host.append(bar, stage, hud);

			/*
			 * 媒体「参数」浮层（网格档用）：格子太小放不下表单，
			 * 点格子的「✎ 编辑」→ 在这里改提示词、模型、比例、清晰度。
			 */
			const editPanel = el("div", "ff-media-edit");
			editPanel.style.display = "none";
			host.append(editPanel);
			const closeMediaEdit = () => {
				MEDIA_EDIT = null;
				editPanel.style.display = "none";
				editPanel.innerHTML = "";
			};
			stage.append(card);

			/** 刷新 HUD（余额 + 最近记录）。 */
			const refreshHud = async () => {
				try {
					const root0 = current() && current().root;
					const j = await (await fetch("/filmflow/media?action=usage&root=" + encodeURIComponent(root0 || ""), { headers: { accept: "application/json" } })).json();
					const credit = j && j.credit ? String(j.credit) : "";
					const list = (j && j.usage) || [];
					const today = new Date().toISOString().slice(0, 10);
					const todayItems = list.filter((u) => String(u.at || "").slice(0, 10) === today);
					const tokens = todayItems.reduce((s2, u) => s2 + (Number(u.tokens) || 0), 0);
					/* 火山直连没有"积分"这回事（credit 为空）→ 显示今日条数与 token */
					hudSum.textContent = credit
						? "积分 " + credit
						: ("今日 " + todayItems.length + " 条" + (tokens ? " · " + tokens + " tok" : ""));
					const frag = document.createDocumentFragment();
					for (const u of list.slice(0, 8)) {
						const when = String(u.at || "").slice(5, 16).replace("T", " ");
						frag.append(el("div", "ff-hud-row",
							el("span", "ff-hud-when", when),
							el("span", "ff-hud-name", String(u.title || u.node || "")),
							el("span", "ff-hud-st" + (u.status === 'failed' ? " err" : ""), u.status === 'failed' ? "失败" : "+" + (u.count || 1))));
					}
					hudList.replaceChildren(frag);
				} catch { /* 拿不到就不更新 */ }
			};
			/**
			 * 打开「参数」浮层（网格档的格子用）。
			 * @param key 媒体节点 key
			 */
			const showMediaEdit = (key) => {
				const p = current();
				const n = p ? findNodeByKey(p.stages || [], key) : null;
				if (!n) { MEDIA_EDIT = null; return; }
				const media = n.media || {};
				editPanel.innerHTML = "";
				const hd = el("div", "ff-media-edit-hd", "编辑「" + String(n.title || key) + "」");
				const x = el("button", "ff-media-foldbtn", "关闭");
				x.addEventListener("click", closeMediaEdit);
				hd.append(x);
				const ta = el("textarea", "ff-media-prompt-edit");
				ta.value = String(media.prompt || "");
				ta.rows = 4;
				const box = el("div", "ff-media-ctrls");
				const M = MEDIA_MODELS || { image: {}, video: {}, audio: {} };
				const mtype = String(media.type || "image");
				const isVideo = mtype === "video";
				const mk = (label, fk, options, cur) => {
					const w = el("label", "ff-media-sel");
					w.append(el("span", "ff-media-sel-lb", label));
					const sel = el("select", "ff-media-sel-in");
					for (const o of options) {
						const op = el("option", undefined, String(o.label !== undefined ? o.label : o));
						op.value = String(o.value !== undefined ? o.value : o);
						if (String(op.value) === String(cur || "")) op.selected = true;
						sel.append(op);
					}
					sel.addEventListener("change", async () => {
						try {
							await post("/filmflow/media", { action: "set", root: p.root, key: String(key), fields: { [fk]: fk === "durationSec" ? Number(sel.value) : sel.value } });
						} catch (e) {
							hd.append(el("span", "ff-media-err", String((e && e.message) || e)));
						}
					});
					w.append(sel);
					return w;
				};
				/*
				 * 模型只列**本节点类型**的那一类（用户 2026-10-28：
				 * 「视频生成节点里就只展示视频生成模型选项，音频生成节点图片生成节点等以此类推」）。
				 * 音频还没接生成能力 → 给空表 + 明说，不要拿图片模型去配音。
				 */
				const capList = (M && M[mtype]) || {};
				box.append(mk("模型", "model", Object.entries(capList).map(([id, d2]) => ({ value: id, label: d2.label || id })), media.model));
				if (!Object.keys(capList).length) {
					box.append(el("div", "ff-media-err", mtype === "audio" ? "音频生成暂未接入" : "这个类型没有可用模型"));
				}
				if (isVideo) {
					const durs = [];
					for (let s2 = 1; s2 <= 30; s2 += 1) durs.push({ value: s2, label: s2 + " 秒" });
					box.append(mk("时长", "durationSec", durs, media.durationSec || 10));
					box.append(mk("比例", "ratio", ["16:9", "9:16", "4:3", "3:4", "1:1"], media.ratio || "16:9"));
					const cap = capList[String(media.model || "")] || {};
					const ro = (cap.resolutions || ["480p", "720p"]).map((r) => ({ value: r, label: r }));
					box.append(mk("清晰度", "resolution", ro, media.resolution || ro[0].value));
				} else if (mtype === "image") {
					box.append(mk("清晰度", "resolution", ["1K", "2K", "4K"], media.resolution || "1K"));
					box.append(mk("比例", "ratio", ["16:9", "9:16", "4:3", "3:4", "1:1"], media.ratio || "1:1"));
				}
				const ok = el("button", "ff-btn p", "保存提示词");
				ok.addEventListener("click", async () => {
					try {
						await post("/filmflow/media", { action: "set", root: p.root, key: String(key), fields: { prompt: String(ta.value || "") } });
						closeMediaEdit();
						SIG.tree = "";
						load();
					} catch (e) {
						hd.append(el("span", "ff-media-err", String((e && e.message) || e)));
					}
				});
				editPanel.append(hd, ta, box, ok);
				editPanel.style.display = "flex";
			};

			// 卡片里的固定部件
			const cardTitle = el("h3");
			const cardMeta = el("div", "ff-mono");
			/* 结构操作行：改名 / 上移 / 下移 / 删除（2026-10-21 用户报"画布功能没实现"） */
			const cardOps = el("div", "ff-row");
			const cardRenameInput = el("input");
			cardRenameInput.className = "ff-rename";
			cardRenameInput.placeholder = "节点名";
			const btnRename = el("div", "ff-btn", "改名");
			const btnUp = el("div", "ff-btn", "↑ 上移");
			const btnDown = el("div", "ff-btn", "↓ 下移");
			const btnDelete = el("div", "ff-btn w", "删除节点");
			cardOps.append(cardRenameInput, btnRename, btnUp, btnDown, btnDelete);
			/*
			 * 用户 2026-10-21：「这种非常简单的东西就直接像 wps 一样在画布上改，
			 * 不要二级标签，描述和标注也都不用，agent 自己明白什么是什么就行了」。
			 *
			 * ⇒ 卡片里**不再有「作用」这一行**，也不再给每个字段加一行标签。
			 *   字段名降级成输入框的 placeholder（空的时候才看得见，有内容就只剩正文）。
			 *   结构化字段本身**保留** —— 它是"写回文件时怎么排版"的契约，agent 要用；
			 *   只是不再挡在人眼前。
			 */
			const cardFields = el("div");
			const cardTextLabel = el("label", undefined, "正文（原始 markdown）");
			const cardText = el("textarea");
			const cardRow = el("div", "ff-row");
			const btnSave = el("div", "ff-btn p", "保存到文件");
			const btnExpand = el("div", "ff-btn", "按文件展开");
			const btnClose = el("div", "ff-btn", "关闭");
			const cardMsg = el("div", "ff-msg");
			cardRow.append(btnSave, btnExpand, btnClose);
			card.append(cardTitle, cardMeta, cardOps, cardFields, cardTextLabel, cardText, cardRow, cardMsg);

			/** 视图落地。 */
			function applyView() {
				world.style.transform = "translate(" + VIEW.x + "px," + VIEW.y + "px) scale(" + VIEW.s + ")";
			}

			/** 适应窗口：整棵树缩进可视区。 */
			function fit() {
				const r = world.getBoundingClientRect();
				const bw = r.width / VIEW.s;
				const bh = r.height / VIEW.s;
				if (!bw || !bh) return;
				VIEW.s = Math.max(0.2, Math.min((stage.clientWidth - 50) / bw, (stage.clientHeight - 50) / bh, 1.15));
				VIEW.x = 25;
				VIEW.y = 25;
				applyView();
			}

			/** 关掉某类临时浮层（目前只有模板菜单）。 */
			function closeLayer(sel) {
				for (const n of [...document.querySelectorAll(sel)]) n.remove();
			}

			/**
			 * 一个节点 —— **标题 + 正文直接摊在画布上**，点正文原地改。
			 *
			 * 用户 2026-10-21：「所有节点都不要二级卡片，直接在画布上显示正文，
			 * 其他的什么作用描述通通不要（活人会懂得看上游的"人物""世界观"几个字）」
			 *
			 * ⇒ 一屏上看到的就是内容本身，别再点开一层浮卡才看得见。
			 *   改：点正文 → 变成 textarea（原地长高）→ 失焦/⌘Enter 保存、Esc 取消。
			 *   改名：双击标题 → 标题变输入框 → 失焦即保存。
			 *   结构：悬停出现 ＋ ✕ ↑ ↓。
			 */
			/**
			 * 正文的**显示版**：去掉 markdown 记号，只留人读的字。
			 *
			 * 用户 2026-10-21：「活人会懂得看上游的"人物""世界观"几个字」——
			 * 他不要标签、也不要满地符号。但**编辑时仍给原文**（保存的是原文），
			 * 只把"看"和"改"分开：看的时候干净，改的时候完整。
			 * @param text - 原文
			 * @returns 干净的预览文本
			 */
			function plainPreview(text) {
				let s = String(text || "");
				// 表格分隔行（|---|:--:|）整行去掉
				s = s.split(/\r?\n/).filter((l) => !/^\s*\|?[\s:|-]+\|?\s*$/.test(l) || !l.includes("-")).join("\n");
				s = s
					.replace(/^#{1,6}\s*/gm, "")      // 标题号
					.replace(/^\s*>\s?/gm, "")        // 引用
					.replace(/\*\*([^*]+)\*\*/g, "$1") // 粗体
					.replace(/`([^`]+)`/g, "$1")       // 行内代码
					.replace(/^\s*[-*+]\s+/gm, "· ")   // 列表
					.replace(/\|/g, " ")               // 表格竖线
					.replace(/[ \t]{2,}/g, " ")
					.replace(/\n{3,}/g, "\n\n")
					.trim();
				return s;
			}
			function nodeEl(n) {
				const d = el("div", "ff-node " + (n.kind || ""));
				if (n.stale === "stale") d.className += " warn";

				// —— 标题行：编号 + 标题（双击可改） ——
				const hd = el("div", "ff-node-hd");
				const noEl = el("span", "ff-node-no", n.no ? String(n.no) : "");
				const tEl = el("span", "ff-node-t", String(n.title || ""));
				hd.append(noEl, tEl);
				if (n.stale === "stale") hd.append(el("span", "ff-sub", "⚠"));
				else if (n.stale === "unknown") hd.append(el("span", "ff-sub", "·"));
				tEl.addEventListener("dblclick", (ev) => {
					ev.stopPropagation();
					startRename(n, tEl);
				});

				/*
				 * —— 正文 ——
				 *
				 * 真节点：正文 = 自己的文件内容；**如果这个文件里的内容已经被拆成下游伪节点，
				 *         标题下面就不再重复显示**（用户：内容不要显示在节点标题下面）。
				 * 伪节点：正文 = 它那一段（也就是文件里对应小节的内容），点一下原地改。
				 */
				const bd = el("div", "ff-node-bd" + (COMPACT ? " compact" : ""));
				/* 「人物」这类下游节点：条目**只列名字**（用户 2026-10-22），不显示描述 */
				if (n.pseudo && n.onlyTitle) {
					/* 名字节点：只显示名字（无描述、无 ＋/✕），但仍然是伪节点 */
					d.className += " pseudo name-only";
					d.title = "这一段属于上游节点声明的内容（不是独立节点）";
					d.append(hd);
					return d;
				}
				const hasSections = !n.pseudo && String(n.kind || "") !== "aggregate" && Array.isArray(n.content) && n.content.length > 0;
				/*
				 * ⚠ 正文开头那行常常就是**节点标题自己**（文件里 `## 周衍` 之后切出来的段落
				 * 是从标题那行开始的）—— 标题已经显示在上一行了，正文再写一遍就是重复。
				 * 实测（测试2/设定/人物.md）：title=[周衍] text=[周衍\n记忆校验所的高级校准师…] ✗
				 */
				let rawText = n.pseudo ? String(n.text || "") : String(n.fileText || n.text || "");
				{
					const title = String(n.title || "").trim();
					const lines = rawText.split(/\r?\n/);
					while (lines.length) {
						const first = lines[0].trim().replace(/^#{1,6}\s*/, "").trim();
						if (!first) { lines.shift(); continue; }
						if (title && (first === title)) { lines.shift(); continue; }
						break;
					}
					rawText = lines.join("\n");
				}
				bd.dataset.raw = rawText;   // 编辑器用这份（已经去掉了与标题重复的那行）
				/*
				 * 2026-10-28：`select` 形态（模型选择节点）——正文位置画一个下拉。
				 * 值存进节点自己的 md（一行），改完 POST /filmflow/edit 再 load()。
				 */
				const isSelect = !n.pseudo && n.src && n.shape && n.shape.kind === "select";
				if (isSelect) {
					const doc = (n.doc && n.doc.kind === "select") ? n.doc : null;
					const opts = (doc && doc.options) || n.shape.options || [];
					const cur = String((doc && doc.value) || "");
					bd.className += " sel";
					const sel = el("select", "ff-node-sel");
					const ph = el("option");
					ph.value = "";
					ph.textContent = "（选一个）";
					ph.disabled = true;
					ph.selected = !cur;
					sel.append(ph);
					for (const o of opts) {
						const value = String((o && o.value) || o || "");
						const label = String((o && o.label) || value);
						const op = el("option");
						op.value = value;
						op.textContent = label;
						if (value === cur) op.selected = true;
						sel.append(op);
					}
					sel.addEventListener("mousedown", (ev) => ev.stopPropagation());
					sel.addEventListener("click", (ev) => ev.stopPropagation());
					sel.addEventListener("change", async () => {
						const v = String(sel.value || "");
						if (!v) return;
						sel.disabled = true;
						try {
							await post("/filmflow/edit", {
								root: current() && current().root,
								src: n.src,
								line: n.line,
								whole: true,
								title: n.title,
								kind: n.kind,
								via: "md",
								text: v,
							});
							SIG.tree = "";
							await load();
						} catch (e) {
							sel.disabled = false;
							sel.title = "没存成：" + String((e && e.message) || e);
						}
					});
					bd.append(sel);
					if (doc && doc.valid === false) {
						const warn = el("div", "ff-node-sel-warn", "存的值不在选项里：" + cur);
						bd.append(warn);
					}
				} else {
					const body = hasSections ? "" : plainPreview(rawText);
					if (hasSections) {
						/*
						 * 有下游伪节点时，标题下面只留一行极简提示 —— 内容都在下游那一列。
						 * 用户：「内容不要显示在节点标题下面，要像子节点一样展开在下游」。
						 */
						bd.className += " count";
						bd.textContent = "（" + n.content.length + " 条，见下游）";
					} else if (body) {
						bd.textContent = body;
					} else {
						bd.className += " empty";
						bd.textContent = n.src ? "（空 · 点我写）" : "";
					}
					if (n.src && !hasSections) {
						bd.title = "点一下直接在画布上改";
						bd.addEventListener("click", (ev) => {
							ev.stopPropagation();
							startEdit(n, bd);
						});
					}
				}
				d.append(hd, bd);

				/*
				 * 伪节点没有结构操作 —— 它不独立：增删改都归上游文件。
				 * 真节点才有 ＋（新建子节点）↑ ↓（同层移动）✕（删除，宿主查依赖）。
				 */
				if (!n.pseudo) {
					const ops = el("span", "ff-node-ops");
					/*
					 * 叶子节点（模型 / 生成）没有 ＋：它们下面本来就不能挂东西（R47）。
					 * 菜单过滤只解决"能挂什么"，这一条解决"根本不该出现加号"。
					 */
					if (!TERMINAL_ROLE.has(String(n.nodeRole || ""))) {
						/*
						 * 叶子模板没有 ＋（R57）：宿主把下位白名单算在 `canAdd` 里，
						 * 空数组 = 这个模板不收任何子节点。身份/模型/生成/剧本这类节点
						 * 从此连加号都不出现，不用点开才发现"一个都没有"。
						 */
						const showAdd = !Array.isArray(n.canAdd) || n.canAdd.length > 0;
						if (showAdd) {
							const add = el("button", "ff-op", "＋");
							add.title = "在这下面新建节点";
							add.addEventListener("click", (ev) => { ev.stopPropagation(); openTplMenu(add, n); });
							ops.append(add);
						}
					}
					const up = el("button", "ff-op", "↑");
					up.title = "同层上移";
					up.addEventListener("click", (ev) => { ev.stopPropagation(); structure({ type: "move", key: n.key, dir: "up" }); });
					const down = el("button", "ff-op", "↓");
					down.title = "同层下移";
					down.addEventListener("click", (ev) => { ev.stopPropagation(); structure({ type: "move", key: n.key, dir: "down" }); });
					const del = el("button", "ff-op", "✕");
					del.title = "删除这个节点（有下游依赖会被拒绝）";
					del.addEventListener("click", (ev) => { ev.stopPropagation(); structure({ type: "delete", key: n.key }); });
					ops.append(up, down, del);
					d.append(ops);
				} else {
					d.className += " pseudo";
					d.title = "这一段属于上游节点声明的内容（不是独立节点）";
				}
				return d;
			}

			/**
			 * 原地编辑正文。
			 * @param n - 节点
			 * @param box - 承载正文的那个 div（编辑时临时换成 textarea）
			 */
			/**
			 * 媒体节点（kind='media'）：缩略图 + 元信息 + 「生成」按钮。
			 *
			 * 用户 2026-10-22 定的三条：
			 *   · 生成**只能人点**（这个按钮带写令牌；agent 拿不到）
			 *   · 画布上只显示该节点**最新**的一条（历史都在素材库）
			 *   · 节点沿用导图样式派生，不做自由拖拽
			 * @param n 节点
			 * @returns 节点元素
			 */
			/*
			 * 媒体模型表（宿主 /filmflow/media?action=models 下发）。
			 * 节点里的下拉直接用它渲染——能力（分辨率集合、可用时长）由服务端给，
			 * 前端不硬编码，免得厂商加了模型还要改两份。
			 */

			let MEDIA_MODELS = null;
			async function ensureMediaModels() {
				if (MEDIA_MODELS) return MEDIA_MODELS;
				try {
					const j = await (await fetch("/filmflow/media?action=models", { headers: { accept: "application/json" } })).json();
					MEDIA_MODELS = { image: j.image || {}, video: j.video || {}, credit: j.credit || "" };
				} catch {
					MEDIA_MODELS = { image: {}, video: {}, credit: "" };
				}
				return MEDIA_MODELS;
			}

			/**
			 * 在节点树里按 key 找节点（含 children）。
			 * @param list 工序数组
			 * @param key 节点 key
			 * @returns 节点或 null
			 */
			function findNodeByKey(list, key) {
				const stack = [...(list || [])];
				while (stack.length) {
					const n = stack.pop();
					if (String(n.key || "") === String(key || "")) return n;
					for (const c of n.children || []) stack.push(c);
				}
				return null;
			}

			/** 媒体节点里的一个下拉（变更即保存到节点配置，不触发生成）。 */
			function mediaSelect(n, label, key, options, cur) {
				const wrap = el("label", "ff-media-sel");
				wrap.append(el("span", "ff-media-sel-lb", label));
				const sel = el("select", "ff-media-sel-in");
				for (const o of options) {
					const opt = el("option", undefined, String(o.label || o));
					opt.value = String(o.value !== undefined ? o.value : o);
					if (String(opt.value) === String(cur || "")) opt.selected = true;
					sel.append(opt);
				}
				sel.addEventListener("change", async () => {
					try {
						await post("/filmflow/media", {
							action: "set",
							root: n.root || current()?.root || "",
							key: n.key,
							fields: { [key]: key === "durationSec" ? Number(sel.value) : sel.value },
						});
						SIG.tree = "";
						await load();
					} catch (e) {
						/* 保存失败就别装成功 */
						wrap.append(el("span", "ff-media-err", String((e && e.message) || e)));
					}
				});
				wrap.append(sel);
				return wrap;
			}

			/**
			 * 媒体节点（kind='media'）——**照参考图那种"生成器卡片"布局**：
			 *
			 *   ┌───────────────────────────────┐
			 *   │ 标题                       ＋↑↓✕ │
			 *   │ [预览图（真实比例、不裁切）]        │
			 *   │ 描述你想生成的画面…（textarea）      │
			 *   │ [图片生成▾][模型▾][9:16 / 1K▾]  (●) │
			 *   └───────────────────────────────┘
			 *
			 * 用户 2026-10-26 定的三条：
			 *   · 大布局改成生成器卡片（提示词在上、参数一行、圆形按钮）
			 *   · **去掉数量选择**（一次一张/一条，不让选）
			 *   · **去掉生成按钮旁的额度标识**（不显示积分/消耗）
			 * 生成仍然只能人点（按钮带写令牌，agent 拿不到）。
			 */
			function mediaNodeEl(n, opts) {
				const inGrid = !!(opts && opts.grid);
				const d = el("div", "ff-node media" + (inGrid ? " grid-cell" : ""));
				const media = n.media || {};
				const model = MEDIA_MODELS || { image: {}, video: {}, audio: {} };

				/* 标题行：编号 + 标题 + 结构操作 */
				const hd = el("div", "ff-node-hd");
				hd.append(el("span", "ff-node-no", n.no ? String(n.no) : ""), el("span", "ff-node-t", String(n.title || "")));
				if (!inGrid) {
					const ops = el("span", "ff-node-ops");
					/* 媒体节点是叶子（生成完就是产物），下面不能再挂节点 —— 不给 ＋（R47）。 */
					const upM = el("button", "ff-op", "↑");
					upM.title = "同层上移";
					upM.addEventListener("click", (ev) => { ev.stopPropagation(); structure({ type: "move", key: n.key, dir: "up" }); });
					const downM = el("button", "ff-op", "↓");
					downM.title = "同层下移";
					downM.addEventListener("click", (ev) => { ev.stopPropagation(); structure({ type: "move", key: n.key, dir: "down" }); });
					const delM = el("button", "ff-op", "✕");
					delM.title = "删除这个节点（有下游依赖会被拒绝）";
					delM.addEventListener("click", (ev) => { ev.stopPropagation(); structure({ type: "delete", key: n.key }); });
					ops.append(upM, downM, delM);
					d.append(ops);
				}
				d.append(hd);

				const type = String(media.type || "image");
				const isVideo = type === "video";
				const last = media.latest || null;
				const job = media.status || "idle";
				const busy = job === "running" || job === "queued";

				/* 预览：真实比例、不裁切（用户 2026-10-23 的要求，保留） */
				const RATIO = { "21:9": [21, 9], "16:9": [16, 9], "9:16": [9, 16], "4:3": [4, 3], "3:4": [3, 4], "1:1": [1, 1] };
				const ratio = RATIO[String(media.ratio || "1:1")] || [1, 1];
				const maxH = inGrid ? 110 : (COMPACT ? 200 : 320);
				const boxW = Math.max(88, Math.min(inGrid ? 150 : 300, Math.round((maxH * ratio[0]) / ratio[1])));
				const src = last
					? "/filmflow/assets?action=file&root=" + encodeURIComponent(n.root || current()?.root || "") + "&p=" + encodeURIComponent(last.src)
					: "";
				const box = el("div", "ff-media-thumb " + (type === "audio" ? "audio" : ""));
				if (type !== "audio") {
					box.style.width = boxW + "px";
					box.style.height = Math.round((boxW * ratio[1]) / ratio[0]) + "px";
				}
				if (last && type === "image") {
					const img = el("img");
					img.src = src;
					img.loading = "lazy";
					box.append(img);
				} else if (last && type === "video") {
					const v = el("video");
					v.src = src;
					v.muted = true;
					v.playsInline = true;
					v.preload = "metadata";
					box.append(v);
				} else if (last && type === "audio") {
					box.append(el("div", undefined, "🔊 " + (last.bytes ? Math.round(last.bytes / 1024) + " KB" : "音频")));
				} else {
					box.className = "ff-media-empty";
					box.style.width = boxW + "px";
					box.style.height = Math.round((boxW * ratio[1]) / ratio[0]) + "px";
					box.style.boxSizing = "border-box";
					box.textContent = busy ? "生成中…" : "还没有生成过";
				}
				if (last) {
					const play = el("div", "ff-media-play", type === "video" ? "▶" : "⤢");
					play.addEventListener("click", (ev) => {
						ev.stopPropagation();
						openViewer({ root: n.root || current()?.root || "", item: last });
					});
					box.append(play);
				}
				d.append(box);

				/* 提示词：卡片主体（和参考图一样，提示词占最上面的大块） */
				const promptBox = el("textarea", "ff-media-prompt-edit");
				promptBox.value = String(media.prompt || "");
				promptBox.placeholder = "描述你想生成的画面…";
				promptBox.rows = inGrid ? 2 : 4;
				let saved = promptBox.value;
				const savePrompt = async () => {
					const v = String(promptBox.value || "").trim();
					if (v === saved) return;
					try {
						await post("/filmflow/media", { action: "set", root: n.root || current()?.root || "", key: n.key, fields: { prompt: v } });
						saved = v;
					} catch (e) {
						errLine.textContent = "提示词没保存成：" + String((e && e.message) || e);
					}
				};
				promptBox.addEventListener("blur", () => { savePrompt(); });
				promptBox.addEventListener("keydown", (ev) => {
					if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); savePrompt(); promptBox.blur(); }
				});
				if (!inGrid) d.append(promptBox);

				/* 底部一行：类型 / 模型 / 比例+清晰度  |  圆形按钮 */
				const errLine = el("div", "ff-media-err");
				if (!inGrid) {
					const row = el("div", "ff-media-row");

					/* ① 类型：图片生成 / 视频生成（音频节点保留它自己的类型） */
					const typeSel = el("select", "ff-media-pick");
					const typeOpts = [{ v: "image", t: "图片生成" }, { v: "video", t: "视频生成" }];
					if (type === "audio") typeOpts.push({ v: "audio", t: "音频生成" });
					for (const o of typeOpts) {
						const op = el("option", undefined, o.t);
						op.value = o.v;
						if (o.v === type) op.selected = true;
						typeSel.append(op);
					}
					typeSel.addEventListener("change", async (ev) => {
						ev.stopPropagation();
						const next = typeSel.value;
						try {
							await post("/filmflow/media", {
								action: "set", root: n.root || current()?.root || "", key: n.key,
								fields: { type: next, model: Object.keys((model && model[next]) || {})[0] || "" },
							});
							SIG.tree = "";
							await load();
						} catch (e) { errLine.textContent = String((e && e.message) || e); }
					});
					row.append(typeSel);

					/* ② 模型：只列本类型那一类（视频节点只给视频模型，音频/图片同理） */
					const cap = (model && model[type]) || {};
					const modelSel = el("select", "ff-media-pick");
					for (const [id, info] of Object.entries(cap)) {
						const op = el("option", undefined, String(info.label || id));
						op.value = id;
						if (id === String(media.model || "")) op.selected = true;
						modelSel.append(op);
					}
					if (!Object.keys(cap).length) {
						const op = el("option", undefined, type === "audio" ? "音频生成暂未接入" : "暂无可用模型");
						op.value = "";
						op.selected = true;
						modelSel.append(op);
						modelSel.disabled = true;
					}
					modelSel.addEventListener("change", async (ev) => {
						ev.stopPropagation();
						try {
							await post("/filmflow/media", { action: "set", root: n.root || current()?.root || "", key: n.key, fields: { model: modelSel.value } });
							SIG.tree = "";
							await load();
						} catch (e) { errLine.textContent = String((e && e.message) || e); }
					});
					row.append(modelSel);

					/* ③ 比例 / 清晰度（合并成一个下拉；音频没有这两个） */
					const capNow = cap[String(media.model || "")] || {};
					if (type !== "audio") {
						const rOpts = Array.isArray(capNow.ratios) && capNow.ratios.length ? capNow.ratios : ["16:9", "9:16", "4:3", "3:4", "1:1"];
						const resOpts = isVideo
							? (capNow.resolutions || ["480p", "720p"])
							: (Array.isArray(capNow.tiers) && capNow.tiers.length ? capNow.tiers : ["1K", "2K", "4K"]);
						const combo = el("select", "ff-media-pick");
						for (const r0 of rOpts) {
							for (const s0 of resOpts) {
								const op = el("option", undefined, r0 + " / " + s0);
								op.value = r0 + "|" + s0;
								if (r0 === String(media.ratio || "") && s0 === String(media.resolution || "")) op.selected = true;
								combo.append(op);
							}
						}
						if (!combo.querySelector("option[selected]") && combo.options.length) combo.options[0].selected = true;
						combo.addEventListener("change", async (ev) => {
							ev.stopPropagation();
							const [r1, s1] = String(combo.value || "").split("|");
							try {
								await post("/filmflow/media", { action: "set", root: n.root || current()?.root || "", key: n.key, fields: { ratio: r1, resolution: s1 } });
								SIG.tree = "";
								await load();
							} catch (e) { errLine.textContent = String((e && e.message) || e); }
						});
						row.append(combo);
					}

					/* ④ 视频额外给时长（2.5 支持 4–30，2.0 支持 4–15） */
					if (isVideo) {
						const dRange = Array.isArray(capNow.durations) && capNow.durations.length === 2 ? capNow.durations : [4, 10];
						const durSel = el("select", "ff-media-pick");
						for (let s2 = dRange[0]; s2 <= dRange[1]; s2 += 1) {
							const op = el("option", undefined, s2 + "s");
							op.value = String(s2);
							if (s2 === Number(media.durationSec || dRange[0])) op.selected = true;
							durSel.append(op);
						}
						durSel.addEventListener("change", async (ev) => {
							ev.stopPropagation();
							try {
								await post("/filmflow/media", { action: "set", root: n.root || current()?.root || "", key: n.key, fields: { durationSec: Number(durSel.value) } });
								SIG.tree = "";
								await load();
							} catch (e) { errLine.textContent = String((e && e.message) || e); }
						});
						row.append(durSel);
					}

					/* ⑤ 圆形生成按钮（**不带任何额度标识**） */
					const go = el("button", "ff-media-go", busy ? "…" : "↑");
					const canGen = Object.keys(cap).length > 0;
					go.title = busy ? "正在生成（点了取消）" : (canGen ? "生成" : (type === "audio" ? "音频生成暂未接入" : "没有可用模型"));
					go.disabled = !canGen && !busy;
					go.addEventListener("click", async (ev) => {
						ev.stopPropagation();
						go.disabled = true;
						try {
							if (busy) {
								await post("/filmflow/media", { action: "cancel", root: n.root || current()?.root || "", key: n.key });
							} else {
								await savePrompt();
								await post("/filmflow/media", { action: "gen", root: n.root || current()?.root || "", key: n.key });
							}
							SIG.tree = "";
							await load();
						} catch (e) {
							errLine.textContent = String((e && e.message) || e);
						} finally {
							go.disabled = false;
						}
					});
					row.append(go);
					d.append(row);
					if (busy) d.append(el("div", "ff-media-prog", String(media.progress || "生成中…")));
					if (job === "failed" && media.error) d.append(el("div", "ff-media-err", String(media.error)));
					d.append(errLine);
				} else {
					/* 网格格子：只留标题 + 缩略图 + 圆形按钮 */
					const go2 = el("button", "ff-media-go small", busy ? "…" : "↑");
					if (!Object.keys(cap).length && !busy) { go2.disabled = true; go2.title = type === "audio" ? "音频生成暂未接入" : "没有可用模型"; }
					go2.addEventListener("click", async (ev) => {
						ev.stopPropagation();
						await post("/filmflow/media", { action: busy ? "cancel" : "gen", root: n.root || current()?.root || "", key: n.key }).catch(() => {});
						SIG.tree = "";
						await load();
					});
					d.append(go2);
				}
				return d;
			}
			function startEdit(n, box) {
				if (box.dataset.editing === "1") return;
				box.dataset.editing = "1";
				const ta = el("textarea", "ff-inline-edit");
				ta.value = String(box.dataset.raw || n.fileText || n.text || "");
				// 高度先按内容估，再在输入时跟着长
				const fitH = () => {
					ta.style.height = "auto";
					ta.style.height = Math.max(40, ta.scrollHeight + 4) + "px";
				};
				box.textContent = "";
				box.append(ta);
				fitH();
				ta.focus();
				ta.setSelectionRange(ta.value.length, ta.value.length);
				ta.addEventListener("input", fitH);

				let done = false;
				const finish = async (save) => {
					if (done) return;
					done = true;
					document.removeEventListener("mousedown", outside, true);
					delete box.dataset.editing;
					const text = ta.value;
					box.textContent = "";
					if (!save || text === String(n.fileText || n.text || "")) {
						box.textContent = plainPreview(n.text) || (n.src ? "（空 · 点我写）" : "");
						if (!String(n.text || "").trim()) box.className += " empty";
						return;
					}
					box.textContent = "保存中…";
					try {
						await post("/filmflow/edit", {
							root: current() && current().root,
							src: n.src, line: n.line, whole: !!n.whole || /* 有整份原文就必须整份写回 */ !!n.fileText,
							title: n.title, kind: n.kind, via: n.via,
							/*
							 * ⚠ 这里**不能**带 itemTitle。
							 * 带了就会走宿主那条"按 `## 标题` 找小节"的分支 ——
							 * 而事实层这种节点的标题是 `# 事实层`（一级），永远找不到 ⇒
							 * 报「文件里找不到 ## 事实层 这一段」（用户 2026-10-22 截图）。
							 * 内联编辑已经有 src/line/whole 三个坐标，够定位了。
							 */
							text,
						});
						box.className = "ff-node-bd";
						box.textContent = plainPreview(text) || "（空 · 点我写）";
						SIG.tree = "";   // 让指纹失效，下一次 load() 会重画
						await load();
					} catch (e) {
						box.className = "ff-node-bd err";
						box.textContent = "没保存成：" + String((e && e.message) || e);
					}
				};
				ta.addEventListener("blur", () => { finish(true); });
				/*
				 * 双保险：canvas 的 pointerdown 会 preventDefault（拖动平移），
				 * 个别情况下 blur 仍可能不触发 —— 直接在 document 上抓"点外面"。
				 */
				const outside = (ev) => { if (!box.contains(ev.target)) { finish(true); } };
				document.addEventListener("mousedown", outside, true);

				ta.addEventListener("keydown", (ev) => {
					if (ev.key === "Escape") { ev.preventDefault(); finish(false); }
					else if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); finish(true); }
				});
			}

			/**
			 * 原地改名（双击标题）。
			 * @param n - 节点
			 * @param tEl - 标题那个 span
			 */
			function startRename(n, tEl) {
				if (tEl.dataset.editing === "1") return;
				tEl.dataset.editing = "1";
				const inp = el("input", "ff-inline-rename");
				inp.value = String(n.title || "");
				const keep = tEl.textContent;
				tEl.textContent = "";
				tEl.append(inp);
				inp.focus();
				inp.select();
				let done = false;
				const finish = async (save) => {
					if (done) return;
					done = true;
					document.removeEventListener("mousedown", outside2, true);
					delete tEl.dataset.editing;
					const title = String(inp.value || "").trim();
					tEl.textContent = keep;
					if (!save || !title || title === String(n.title || "")) return;
					/*
					 * ⚠ 伪节点没有 key（它不是 decl 里的节点）——
					 * 原来这里一律发 `rename`，key 是 undefined ⇒ 宿主报「没有这个节点」
					 * ⇒ load() 一刷新就**变回原名**（用户 2026-10-22 报的现象）。
					 * ⇒ 伪节点走 `renameSection`：改的是文件里那一行 `## 标题`。
					 */
					if (n.pseudo) {
						if (!n.src) return;
						const r = await runStructure({
							type: "renameSection",
							src: n.src,
							title: String(n.title || ""),
							newTitle: title,
						});
						/*
						 * 用户 2026-10-22：「以后也都可以自动同步了吧？」
						 * 宿主会回报**还有哪些文件留着旧名**（leftOld）——
						 * 这里直接问一句"一起换掉吗"，点了就全片替换。
						 *
						 * 为什么不无声自动替换：名字可能只有一两个字（比如「林」），
						 * 无脑替换会误伤「丛林 / 树林」这类词 ⇒ 让人看一眼再点。
						 */
						/*
						 * 宿主**已经自动统一**了（`autoUnified`）——这里只把结果说给人听，
						 * 不再问"要不要替换"（用户 2026-10-22：「我要的是程序自己具备自动统一的功能」）。
						 * 内容是内容、改名是改名：后者确定性替换，不问；前者仍走提案+确认。
						 */
						const au = (r && r.autoUnified) || { total: 0, files: [] };
						if (au.total > 0) {
							meta.textContent = "已改名并自动统一：" + String(n.title || "") + " → " + title
								+ "（其它 " + au.files.length + " 个文件共 " + au.total + " 处）";
							meta.style.color = "";
						}
						return;
					}
					await runStructure({ type: "rename", key: n.key, title });
				};
				inp.addEventListener("blur", () => { finish(true); });
				const outside2 = (ev) => { if (!tEl.contains(ev.target)) { finish(true); } };
				document.addEventListener("mousedown", outside2, true);
				inp.addEventListener("keydown", (ev) => {
					if (ev.key === "Escape") { ev.preventDefault(); finish(false); }
					else if (ev.key === "Enter") { ev.preventDefault(); finish(true); }
				});
			}


			/**
			 * 模板选择菜单：点 ＋ 之后弹出来，列出模板库里的零件。
			 * @param anchor - 贴哪个按钮弹
			 * @param parent - 父节点（新节点挂在它下面）
			 */
			async function openTplMenu(anchor, parent) {
				closeLayer(".ff-tpl");
				let list = TPL_CACHE;
				if (!list || !ROLE_RULES) {
					try {
						const j = await (await fetch("/filmflow/templates")).json();
						list = (j && j.templates) || [];
						ROLE_RULES = (j && j.roles) || ROLE_RULES;
					} catch { list = list || []; }
					TPL_CACHE = list;
				}
				/*
				 * ★ 下位白名单（R57）：宿主在 state 里给每个节点算好了 `canAdd`
				 * （= 模板 children ∩ 角色法定 ∩ 身份法定），菜单只按它过滤。
				 *
				 * 为什么不在浏览器里再算一遍：算一遍就有第二种口径。现在
				 * 菜单 = 落盘校验 = agent 提案校验，读的是 node-rules 的同一张表。
				 * 顶层（nodeRole=root）没有节点对象，用宿主下发的 roles.rootCanAdd。
				 */
				const parentRole = String(parent.nodeRole || "root");
				const allowed = ROLE_RULES && ROLE_RULES.menu && ROLE_RULES.menu[parentRole];
				const legalRole = Array.isArray(allowed)
					? list.filter((t) => allowed.includes(String(t.role || "other")))
					: list;
				const canAdd = Array.isArray(parent.canAdd)
					? parent.canAdd
					: (parentRole === "root" && ROLE_RULES && Array.isArray(ROLE_RULES.rootCanAdd)
						? ROLE_RULES.rootCanAdd
						: null);
				const legal = Array.isArray(canAdd)
					? list.filter((t) => canAdd.includes(String(t.id)))
					: legalRole;
				const menu = el("div", "ff-tpl");
				menu.append(el("div", "ff-tpl-hd",
					parentRole === "root" ? "在项目顶层新建一道工序" : "在「" + (parent.title || parent.key) + "」下面新建"));

				/*
				 * 搜索 + 平铺（2026-10-29 story/board 分组撤掉）。
				 * 不再按 group 分「故事组/分镜组」；用搜索 + 角色过滤即可。
				 */
				const search = el("input");
				search.className = "ff-tpl-search";
				search.placeholder = "搜索模板…";
				menu.append(search);

				/*
				 * ★ 自定义节点（R58，用户 2026-10-30 定的流程）：
				 *   点它 → 把"在这个父节点下要建新节点"的上下文送进对话 →
				 *   agent 主动问「想建什么节点？」→ 用户描述 → agent 设计并调
				 *   filmflow_template_save 存进模板库（并挂到这一步下面）。
				 * 这里不弹表单：节点由 agent 写，人只负责说需求。
				 */
				const custom = el("button", "ff-tpl-it ff-tpl-custom", "✎ 自定义节点…");
				custom.title = "让 agent 帮你设计一个新节点（会存进模板库）";
				custom.addEventListener("click", (ev) => {
					ev.stopPropagation();
					closeLayer(".ff-tpl");
					const where = parentRole === "root" ? "项目顶层" : "「" + (parent.title || parent.key) + "」";
					const text = [
						"（片厂）我在 " + where + " 点了「自定义节点」，想在这里加一个新节点。",
						"项目：" + String((S && S.current) || ""),
						"父节点 key：" + (parent.key || "（顶层）"),
						"请先只回一句「想建什么节点？」，然后按宪法 §九 一步一步问清楚；现有节点能干的活先建议复用，别硬造。",
						"定下来后用 filmflow_template_save 存进模板库，并挂在这一步下面。",
					].join("\n");
					post("/filmflow/say", { root: S.current, text }).catch(() => { /* 叫不醒就算了，别弹错 */ });
				});
				menu.append(custom);

				const listBox = el("div", "ff-tpl-list");
				menu.append(listBox);

				const renderList = (kw) => {
					listBox.innerHTML = "";
					const q = String(kw || "").trim().toLowerCase();
					const hit = legal.filter((t) => !q
						|| String(t.title || "").toLowerCase().includes(q)
						|| String(t.note || "").toLowerCase().includes(q));
					if (!hit.length) {
						listBox.append(el("div", "ff-tpl-empty", legal.length ? "没有匹配的模板" : "这个节点下面不能再挂别的节点"));
						return;
					}
					for (const t of hit) {
						const b = el("button", "ff-tpl-it", (t.kind === "media" ? (t.mediaType === "video" ? "🎬 " : t.mediaType === "audio" ? "🔊 " : "🖼 ") : "") + (t.title || t.id));
						if (t.note) b.title = t.note;
						b.addEventListener("click", (ev) => {
							ev.stopPropagation();
							closeLayer(".ff-tpl");
							structure({ type: "add", at: parent.key || "", template: t.id });
						});
						listBox.append(b);
					}
				};
				renderList("");
				search.addEventListener("input", () => renderList(search.value));
				/*
				 * 菜单贴在按钮旁边。但按钮是"悬停才显示"的元素 —— 取不到尺寸时
				 * （display:none、或被合成事件触发）退回**父节点**的矩形，别把它甩到屏幕左上角。
				 */
				let r = anchor.getBoundingClientRect();
				if (!r.width || !r.height) {
					const host = anchor.closest(".ff-node");
					if (host) r = host.getBoundingClientRect();
				}
				menu.style.left = Math.max(8, Math.min(r.right + 6, window.innerWidth - 250)) + "px";
				menu.style.top = Math.max(8, Math.min(r.top, window.innerHeight - 120)) + "px";
				document.body.append(menu);
				setTimeout(() => {
					/*
					 * ★ 点菜单外面关掉 —— 但**点在菜单里面不能关**。
					 *
					 * 原来的写法对任何 mousedown 都关，于是真实鼠标点击的顺序是
					 *   mousedown（菜单被移除）→ mouseup → click（已经没这个按钮了）
					 * ⇒ 用户点菜单项**永远没反应**（我之前的自动化测试直接派发 click，绕过了 mousedown，
					 *   所以一直测不出来 —— 这是这轮的教训：测点击必须发完整事件序列）。
					 */
					const close = (ev) => {
						if (ev && ev.target && ev.target.closest && ev.target.closest(".ff-tpl")) return;
						closeLayer(".ff-tpl");
						document.removeEventListener("mousedown", close, true);
					};
					document.addEventListener("mousedown", close, true);
				}, 0);
			}

			/**
			 * 发一次结构操作，成功就重拉状态（画布自己会重画）。
			 *
			 * 失败时把宿主的话**原样**贴出来 —— 比如"有 2 个节点依赖它，不能直接删"，
			 * 那句话是给人看的，别翻译成"删除失败"。
			 * @param op - 结构操作
			 */
			async function structure(op) {
				if (!S || !S.current) return;
				/*
				 * 删除不可逆，先确认一次。
				 *
				 * 用**自己的确认条**而不是 `confirm()`：原生弹窗在无头浏览器里
				 * 根本关不掉（我自己的验证脚本会卡死），而且风格跟这套界面不搭。
				 */
				if (op.type === "delete") {
					const n = findIn(S, op.key);
					const label = n ? (n.no ? n.no + " " : "") + n.title : op.key;
					/*
					 * 删除的二次机会（用户 2026-10-22：「删除节点不成功」）。
					 *
					 * 宿主有护栏：**被别的节点依赖时不许删**（删了下游的依据就悬空了）。
					 * 但护栏拒绝时，界面原来只在顶栏挤一行小字，用户只会觉得"删不掉"。
					 * ⇒ 第一次删被拒 → 再弹一次"强制删除（同时断开依赖）"，让人明确选择。
					 */
					askConfirm("删掉「" + label + "」？有下游依赖时会被拒绝。", async () => {
						const r = await runStructure({ type: "delete", key: op.key });
						if (r && r.ok) return;
						askConfirm(
							"「" + label + "」被别的节点依赖，不能直接删。要**强制删除**吗？（会同时断开那些节点对它的依赖）",
							() => runStructure({ type: "delete", key: op.key, force: true }),
							"强制删除",
						);
					});
					return;
				}
				await runStructure(op);
			}

			/** 真的发请求（删除的确认之后走这里）。返回宿主结果，失败返回 undefined。 */
			async function runStructure(op) {
				if (!S || !S.current) return undefined;
				let r;
				try {
					r = await post("/filmflow/structure", { root: S.current, op });
				} catch (e) {
					meta.textContent = "结构没改成：" + String((e && e.message) || e);
					meta.style.color = "var(--dsw-alias-state-error-primary)";
					return undefined;
				}
				if (r && r.ok === false) {
					meta.textContent = "结构没改成：" + r.error;
					meta.style.color = "var(--dsw-alias-state-error-primary)";
					return undefined;
				}
				meta.style.color = "";
				try { SIG.tree = ""; } catch { /* 忽略 */ }
				await load();
				return r;
			}

			/**
			 * 一句确认 + 两个按钮（替掉原生 confirm）。
			 * @param text - 问什么
			 * @param onYes - 点「确定」之后做什么
			 */
			function askConfirm(text, onYes, yesText) {
				closeLayer(".ff-confirm");
				const box = el("div", "ff-confirm");
				box.append(el("div", "ff-confirm-tx", text));
				const row = el("div", "ff-confirm-row");
				const no = el("button", "ff-btn", "取消");
				const yes = el("button", "ff-btn w", String(yesText || "删除"));
				no.addEventListener("click", (ev) => { ev.stopPropagation(); closeLayer(".ff-confirm"); });
				yes.addEventListener("click", (ev) => {
					ev.stopPropagation();
					closeLayer(".ff-confirm");
					onYes();
				});
				row.append(no, yes);
				box.append(row);
				box.style.left = Math.round(window.innerWidth / 2 - 140) + "px";
				box.style.top = "96px";
				document.body.append(box);
			}

			/** 在状态树里按 key / 编号找一个节点。 */
			function findIn(state, key) {
				const p = (state.projects || []).find((x) => x.root === state.current);
				if (!p) return null;
				let hit = null;
				const walk = (n) => {
					if (hit) return;
					if (String(n.key) === String(key) || String(n.no) === String(key)) { hit = n; return; }
					for (const c of n.children || []) walk(c);
				};
				for (const s of p.stages || []) walk(s);
				return hit;
			}

			/** 一个子树（节点 + 它的子列）。 */
			function branch(n) {
				const wrap = el("div", "ff-tree");
				// 媒体节点走自己的渲染（缩略图 + 生成按钮）；其余照旧
				wrap.append(String(n.kind || "") === "media" ? mediaNodeEl(n) : nodeEl(n));
				/*
				 * ★ 文件里的小节 = **伪节点**（用户 2026-10-21 的定稿）：
				 *   「内容不要显示在节点标题下面，要像子节点一样展开在下游
				 *     （只是说布局上像独立的子节点，但从功能上并不是完全独立的，
				 *      都是依赖它们上游的"人物"来声明节点里面的内容是人物的名称）」
				 *
				 * ⇒ 布局上照子节点画（所以它们在下游单独成一列）；
				 *   功能上不独立：没有 ＋/✕、不能单独增删，改它等于改**上游那份文件**的对应小节。
				 */
				/*
				 * ★ 三种节点（用户 2026-10-22 定的）：
				 *   · 成品节点 aggregate  —— 它是**写完的成品**，内容整段显示在它自己身上；
				 *     从它这里剥离出来的东西才是它的下游（真节点，走 children）。
				 *     例：「事实层」是成品；从事实层拆出去的分析才挂在它下游。
				 *   · 下游节点 downstream —— 它的内容天然是一条条的（人名、每条设定、每段提示词），
				 *     这些条目在画布上摊成**伪节点**。
				 *   · 伪节点 pseudo —— 下游节点内容的一条，看着像节点，实际属于上游那份文件。
				 */
				const isAggregate = String(n.kind || '') === 'aggregate';
				/*
				 * 「只列名字」的节点（人物）—— 条目卡片只显示名字，不显示空壳。
				 *
				 * 原来只认 project.json 上的 `items:"title"`，但 10-28 之前建的片子没写这个字段，
				 * 于是「人物」下每人一张空卡「（空 · 点我写）」（用户 2026-10-29 截图里那一片空白）。
				 * 这里加一条兜底：形态只声明了一个 title 字段 = 这个节点本来就只装名字。
				 */
				const nameOnly = String(n.items || '') === 'title'
					|| (!!n.shape && Array.isArray(n.shape.fields)
						&& n.shape.fields.length === 1
						&& String((n.shape.fields[0] || {}).key || '') === 'title');
				/*
				 * ★ 顺序（2026-10-29 修）：**自己的条目排在真子节点前面**。
				 *
				 * 原来是 `[...children, ...自己的条目]`。容器节点（人物、服装、事实层）两样都有，
				 * 于是它自己的条目被排到所有子分支的**后面** —— 子分支很高，条目就被挤到
				 * 整列的最低端，看起来像挂在最后一个子节点（鞋）下面（用户 2026-10-29 截图：
				 * 「逻辑还是乱的啊」）。
				 * ⇒ 条目先排，跟父节点贴着；再排真子节点。
				 */
				const kids = [
					...(isAggregate ? [] : (n.content || []).map((c) => ({ ...c, pseudo: true, onlyTitle: nameOnly }))),
					...(n.children || []),
				];
				if (!kids.length) return wrap;

				/**
				 * 把子节点放进一列。
				 *
				 * 网格档（GRID，默认关）下：**连续的 2 个以上媒体节点**合成一个横向网格行，
				 * 其余节点照旧一人一行 —— 不改它们的手感，只给资产腾地方。
				 * @param col 目标列
				 * @param list 子节点数组
				 */
				const appendKids = (col, list) => {
					if (!GRID) {
						for (const kk of list) col.append(branch(kk));
						return;
					}
					let run = [];
					const flush = () => {
						if (run.length >= 2) {
							const row = el("div", "ff-tree");
							const grid = el("div", "ff-media-grid");
							for (const m of run) grid.append(mediaNodeEl(m, { grid: true }));
							row.append(grid);
							col.append(row);
						} else {
							for (const m of run) col.append(branch(m));
						}
						run = [];
					};
					for (const kk of list) {
						if (String(kk.kind || "") === "media") run.push(kk);
						else { flush(); col.append(branch(kk)); }
					}
					flush();
				};

				/*
				 * ★ 子节点太多时**默认折叠**（2026-10-21 实测教训）。
				 *
				 * 「一段提示词一个节点」把 ⑤ 展开成 58 个之后，画布上是**一列 58 行**，
				 * fit() 一缩，整张图变成一根 1px 宽的竖线 —— 技术上对，视觉上废 ✗
				 * ⇒ 超过 COLLAPSE_AT 就只画一个开关节点，点开才展开。
				 *   折叠状态按 key 记在内存里（刷新页面回到默认折叠）。
				 */
				const expanded = EXPANDED.has(String(n.key));
				if (kids.length > COLLAPSE_AT && !expanded) {
					const col = el("div", "ff-kids");
					const more = el("div", "ff-more");
					more.textContent = "▶ " + kids.length + " 个下级（点开）";
					more.title = "节点太多，先折叠 —— 点一下展开";
					more.addEventListener("click", (ev) => {
						ev.stopPropagation();
						EXPANDED.add(String(n.key));
						SIG.tree = "";
						draw();
					});
					// ⚠️ `append()` 返回 undefined，不能链式接着 append（踩过：整块画布不渲染）
					const row = el("div", "ff-tree");
					row.append(more);
					col.append(row);
					wrap.append(col);
					return wrap;
				}
				if (kids.length > COLLAPSE_AT && expanded) {
					const less = el("div", "ff-more");
					less.textContent = "▼ 收起这 " + kids.length + " 个下级";
					const col0 = el("div", "ff-kids");
					const row = el("div", "ff-tree");
					row.append(less);
					col0.append(row);
					const col = el("div", "ff-kids");
					appendKids(col, kids);
					less.addEventListener("click", (ev) => {
						ev.stopPropagation();
						EXPANDED.delete(String(n.key));
						SIG.tree = "";
						draw();
					});
					wrap.append(col0, col);
					return wrap;
				}
				const col = el("div", "ff-kids");
				appendKids(col, kids);
				wrap.append(col);
				return wrap;
			}

			/**
			 * 量出每个子列"花括号两臂该落在哪儿"，写进 CSS 变量。
			 *
			 * 为什么必须量：括号两臂要落在**首/末子节点的中心**。
			 * 而每个子节点是一个 `.ff-tree`，它的高度 = max(自己的节点, 自己的子树) ——
			 * 子树高的那个（比如「1 设计故事」下面挂着 1.1~1.5），
			 * 盒子中心远低于顶部。写死 `top:9px` 会让括号整体偏上、跟节点对不上 ✗
			 *
			 * 用 `offsetTop / offsetHeight`（布局像素，不受画布缩放影响），
			 * 父节点自己的中心正好是子列的 50%（`.ff-tree` 是 `align-items:center`）。
			 * @param scope - 树所在的容器
			 */
			/*
			 * 画导线（SVG，不是 CSS 伪元素）。
			 *
			 * 参考图（用户 2026-10-23 给的 WPS 脑图）：**只有一种线，而且所有线都连着**：
			 *   父节点右侧出线 ── 竖直主干 ─┬── 短横线 → 子节点1
			 *                                ├── 短横线 → 子节点2
			 *                                └── 短横线 → 子节点3
			 *   主干两端在首/尾子节点处**圆角收口**，中间每个子节点都从主干分一条短横线出去。
			 *
			 * 为什么不用 CSS 伪元素：位置要靠百分比猜，节点一胖一瘦就接不上（我踩过：
			 * 线断了、还有孤立短线）。这里全部用**量出来的真实坐标**画一条 path，
			 * 数学上不可能错位。缩放画布时用 non-scaling-stroke 保持线宽不变。
			 */
			function drawConnectors(world) {
				const NS = "http://www.w3.org/2000/svg";
				const old = world.querySelector("svg.ff-lines");
				if (old) old.remove();

				const wr = world.getBoundingClientRect();
				const W = world.scrollWidth;
				const H = world.scrollHeight;
				if (!W || !H) return;
				const svg = document.createElementNS(NS, "svg");
				svg.setAttribute("class", "ff-lines");
				svg.setAttribute("width", String(W));
				svg.setAttribute("height", String(H));
				svg.setAttribute("viewBox", "0 0 " + W + " " + H);
				svg.setAttribute("aria-hidden", "true");

				/*
				 * ★ 坐标要换算回 **world 的布局坐标**（2026-10-28 修的渲染 bug）。
				 *
				 * world 上有 `transform: translate(...) scale(VIEW.s)`；getBoundingClientRect()
				 * 返回的是**缩放后**的屏幕像素，而 SVG 画在 world 里面、坐标系是缩放前的布局像素。
				 * 直接把屏幕坐标塞进去 ⇒ 等于把缩放算了两次，倍数越小线越往左上缩，
				 * 看起来就是"导线飘在左边、跟节点对不上"（用户截图那个样子）。
				 * ⇒ 所有相对坐标统一除以当前缩放。
				 */
				const s = VIEW.s || 1;
				const rel = (el) => {
					const r = el.getBoundingClientRect();
					return { l: (r.left - wr.left) / s, r: (r.right - wr.left) / s, t: (r.top - wr.top) / s, b: (r.bottom - wr.top) / s };
				};

				/*
				 * 导线 = 一棵**完整的树**，节点坐在线上（用户 2026-10-23 定的最终形态）：
				 *
				 *   每个节点：底边一条横线，从「喂它的那根竖线」一直延伸到「喂它孩子的那根竖线」；
				 *   叶子节点：横线到自己右边缘为止；
				 *   有孩子的节点：横线延伸到右侧 GAP 处的竖线，竖线跨它的第一个到最后一个孩子的底边；
				 *   递归下去 —— 所有横线竖线首尾相接，整张图是一棵连通的树。
				 */
				const GAP = 10;
				const RAD = 6;                     // 括号转角半径（参考图那种圆角）
				const d = [];

				/*
				 * ★ 2026-10-30 按用户参考图重画（思维导图标准形态）：
				 *
				 *   父节点 ──横线──┐ ← 接在竖线**中间**
				 *                  │
				 *        ┌─────────┘（圆角）
				 *        ├── 子 1（各自从**垂直中心**接一小段，竖线止于最后一个孩子的中心）
				 *        ├── 子 2
				 *        └─────────┐（圆角）
				 *                  │
				 *
				 * 用户：「参考图2是正确示范」；「横线不要穿过节点」→ 每段横线**在节点边界外
				 * 2px 处收住**，不进节点；「尽头竖线不要多最后一条横线」→ 竖线正好止于
				 * 最后一个孩子的中心，用圆角收口。
				 */
				const walk = (tree, inX) => {
					const node = tree.querySelector(":scope > .ff-node");
					if (!node) return;
					const nr = rel(node);
					/*
					 * ★ 接线高度 = **标题那一行的垂直中心**（2026-10-30 第 4 版）。
					 *
					 * 用户反复说「线不要从节点中心穿过」：多行节点按整块中心接线时，
					 * 线正好插在正文中间（像穿过去）。参考图里每个节点都是单行，
					 * 线接在那一行的中间 —— 多行节点照着做，就是接**第一行（标题）**的中间。
					 */
					const tEl = node.querySelector(".ff-node-t") || node.querySelector(".ff-node-hd") || node;
					const tr = rel(tEl);
					const cy = (tr.t + tr.b) / 2;
					const kids = tree.querySelector(":scope > .ff-kids");
					if (!kids) return;
					const childTrees = [...kids.children].filter((c) => c.tagName === "DIV");
					if (!childTrees.length) return;
					const bx = nr.r + GAP;             // 竖线（括号主轴）的 x
					/*
					 * ★ 2026-10-30 第 6 版：**每个孩子一条连续折线**，而不是"父一根 + 竖线 + 子一根"。
					 *
					 * 为什么：之前父节点出线、竖线、孩子横线是三条独立线段，三者的 y 必须恰好对上，
					 * 一旦父节点锚点与"首/末孩子锚点中点"有偏差（实测 9 个父节点、9 处断头），
					 * 就出现"线断在节点旁边"。
					 * 现在每个孩子一条：父右边缘 →(圆角) 竖线 →(圆角) 孩子左边缘，
					 * **一条 path 首尾贯通，物理上不可能断**；多个孩子的竖线段重叠成一根括号。
					 * 父节点由 CSS 居中于子列 ⇒ 有的孩子在它上方、有的在下方，括号自然上下均匀。
					 */
					const R = RAD;
					for (const ct of childTrees) {
						const cn = ct.querySelector(":scope > .ff-node") || ct;
						const cT = cn.querySelector(".ff-node-t") || cn;
						const ctr = rel(cT);
						const ccy = (ctr.t + ctr.b) / 2;
						const cl = rel(cn).l - 2;
						const sgn = ccy >= cy ? 1 : -1;
						const near = Math.abs(ccy - cy) <= R * 2.2;
						if (near) {
							/* 高低差太小：直角走，别画畸形圆角 */
							d.push("M " + nr.r.toFixed(1) + " " + cy.toFixed(1)
								+ " H " + bx.toFixed(1) + " V " + ccy.toFixed(1) + " H " + cl.toFixed(1));
						} else {
							d.push("M " + nr.r.toFixed(1) + " " + cy.toFixed(1)
								+ " H " + (bx - R).toFixed(1)
								+ " Q " + bx.toFixed(1) + " " + cy.toFixed(1) + " " + bx.toFixed(1) + " " + (cy + sgn * R).toFixed(1)
								+ " V " + (ccy - sgn * R).toFixed(1)
								+ " Q " + bx.toFixed(1) + " " + ccy.toFixed(1) + " " + (bx + R).toFixed(1) + " " + ccy.toFixed(1)
								+ " H " + cl.toFixed(1));
						}
					}
					for (const ct of childTrees) walk(ct, bx);
				};

				const top = world.querySelector(":scope > .ff-tree");
				if (top) {
					const rootNode = top.querySelector(":scope > .ff-node");
					if (rootNode) walk(top, rel(rootNode).l);
				}

				if (!d.length) return;
				const path = document.createElementNS(NS, "path");
				path.setAttribute("d", d.join(" "));
				path.setAttribute("fill", "none");
				path.style.stroke = "var(--ff-line)";
				path.setAttribute("stroke-width", "1.5");
				path.setAttribute("stroke-linecap", "round");
				path.setAttribute("stroke-linejoin", "round");
				path.setAttribute("vector-effect", "non-scaling-stroke");
				svg.append(path);
				world.insertBefore(svg, world.firstChild);
			}

			function layoutBraces(scope) {
				for (const kids of scope.querySelectorAll(".ff-kids")) {
					const first = kids.firstElementChild;
					const last = kids.lastElementChild;
					if (!first || !last) continue;
					const half = kids.offsetHeight / 2;
					// 子节点的中心：它的 .ff-tree 盒子里节点是垂直居中的，取盒子中点即可
					let top = first.offsetTop + first.offsetHeight / 2;
					let bottom = last.offsetTop + last.offsetHeight / 2;
					if (top >= bottom || top > half) {
						top = half;
						bottom = half;
					}
					kids.style.setProperty("--ff-b1", top.toFixed(1) + "px");
					kids.style.setProperty("--ff-b2", bottom.toFixed(1) + "px");
				}
				/* CSS 伪元素那套已废弃；导线统一由 SVG 按真实坐标画（保证全部相连） */
				const root = scope.closest(".ff-world") || scope;
				if (root && root.querySelectorAll) drawConnectors(root);
			}

			/** 当前片子。 */
			function current() {
				if (!S) return null;
				const list = S.projects || [];
				/*
				 * ① **项目菜单点进来的那一部**（按路径认，最可靠 —— 片名可能重名）
				 * ② 上次看的（localStorage）
				 * ③ 宿主记着的当前片
				 * ④ 第一部（兜底，别白屏）
				 */
				if (wantRoot) {
					const hit = list.find((p) => p.root === wantRoot);
					if (hit) return hit;
				}
				return list.find((p) => p.id === PICK)
					|| list.find((p) => p.root && S.current && p.root === S.current)
					|| list[0] || null;
			}

			/** 重画工具条。 */
			function drawBar(p) {
				if (!p) { meta.textContent = ""; chips.innerHTML = ""; return; }
				/* 2026-10-29：story/board 授权锁已撤，工具条不再有锁 chip。 */
				/* 顶栏不再显示「待对齐」计数（用户 2026-10-27：这几项都不必显示）；
				   这里只留作出错时的提示行。 */
				meta.textContent = "";
				meta.style.color = "";
				refreshHist();
			}

			/*
			 * 原来的 countStale（数「N 处待对齐」）2026-10-29 撤了：
			 * 对齐是 agent 自己的活，界面不该拿它当"需要人处理的事"。
			 * 但「⚠ 过期」这个**节点上**的标记保留 —— 那是提醒 agent 该改哪一步。
			 */

			/** 重画整块。 */
			function draw() {
				const p = current();
				if (!p) {
					world.innerHTML = "";
					const z = el("div", "ff-empty", "还没有片子。\n在 " + (S && S.roots || []).join("、") + " 下建一部，再点刷新。");
					z.style.whiteSpace = "pre-wrap";
					world.append(z);
					meta.textContent = "";
					return;
				}
				const sig = JSON.stringify([p.id, p.title, p.stages, FOCUS, LAYOUT]);
				if (sig !== SIG.tree) {
					SIG.tree = sig;
					world.innerHTML = "";
					const top = el("div", "ff-tree");
					top.append(nodeEl({ kind: "root", title: p.title }));
					const col = el("div", "ff-kids" + (LAYOUT === "h" ? " row" : ""));
					const stagesAll = p.stages || [];
					const shown = FOCUS ? stagesAll.filter((s) => String(s.key) === FOCUS) : stagesAll;
					/*
					 * ⚠ 一棵节点渲染失败会让**整块画布空白**（innerHTML 已经先清了），浏览器里什么都看不到。
					 * 这里兜住并把原因画在画布上 —— 空白画布是最糟的失败方式。
					 */
					const bad = [];
					for (const s of shown) {
						try {
							col.append(branch(s));
						} catch (e) {
							bad.push(String(s.title || s.key) + "：" + String((e && e.message) || e));
							console.error("[filmflow] 节点渲染失败", s && s.title, e);
						}
					}
					if (bad.length) {
						const box2 = el("div", "ff-empty", "渲染失败（" + bad.length + " 处）：\n" + bad.join("\n"));
						box2.style.whiteSpace = "pre-wrap";
						box2.style.maxWidth = "900px";
						top.append(box2);
					}
					if (FOCUS && shown.length === 0) {
						/* 聚焦的工序被删了：自动回全图，不留空白 */
						FOCUS = "";
						try { localStorage.removeItem("ff.focus"); } catch { /* 忽略 */ }
						SIG.tree = "";
					}
					top.append(col);
					world.append(top);
					layoutBraces(world);
					applyView();
					/*
					 * ★ 兜底重画（2026-10-30 用户报「节点/线段飘在空中」）。
					 *
					 * 当场量过：每个节点底边都对得上自己那根线（35 个节点 0 错位），
					 * 所以不是算法错，是**画的时机**错 —— 这一帧量到的位置可能是
					 * 内容还没铺开、字体还没加载、或窗口刚从隐藏变可见的中间态。
					 * ⇒ 画完再补三次：下一帧、字体就绪、刚切回画布的那一下。
					 */
					const again = () => { try { drawConnectors(world); } catch { /* 画失败不影响别处 */ } };
					requestAnimationFrame(again);
					requestAnimationFrame(() => requestAnimationFrame(again));
					try { if (document.fonts && document.fonts.ready) document.fonts.ready.then(again); } catch { /* 忽略 */ }
					/*
					 * ⚠ 2026-10-21 起**不再自动"适应窗口"**。
					 *
					 * 节点现在直接显示正文（用户要求），整张树很高很宽；
					 * 一进来就 fit() 会把正文缩成看不清的小字（实测截图）。
					 * ⇒ 默认 100%、从左上角看起；要总览就点顶栏「适应窗口」。
					 */
				}
				/*
				 * ★ **第一次画出来时，把"正在看的是这部"告诉宿主一次。**
				 *
				 * 用户双击快捷方式进来，画布默认显示第一部片；如果不同步，
				 * agent 的工具就没有默认项目（要么报"没指明项目"，要么串台）。
				 * 只在本页第一次、且宿主那边的当前片跟画面对不上时发一次 ——
				 * 用 Set 记住试过的片，失败也不每 2 秒重试一轮。
				 */
				if (S && S.current !== p.root && !selectTried.has(p.root)) {
					selectTried.add(p.root);
					post("/filmflow/select", { root: p.root }).catch(() => { /* 忽略 */ });
				}
				drawBar(p);
			}

			/** 打开节点卡片。 */
			function openCard(n) {
				SEL = n;
				const c = Object.assign({}, n.ref || {}, n);
				cardTitle.textContent = (n.no ? n.no + " " : "") + (n.title || "");
				cardRenameInput.value = String(n.title || "");
				cardMeta.textContent = c.src
					? c.src + (c.line ? "　第 " + c.line + " 行" : "")
					: "（无源文件 · 这个节点没有正文可写）";
				// 卡片里不再有「作用」输入框（用户要求：不要二级标签）
				cardFields.innerHTML = "";
				const isItem = !!(c.doc && c.doc.kind === "item" && Array.isArray(c.doc.fields));
				cardTextLabel.style.display = isItem ? "none" : "";
				cardText.style.display = isItem ? "none" : "";
				if (isItem) {
					for (const f of c.doc.fields) {
						const w = el("div");
						// 字段名只当占位提示，不再单独占一行（用户要求：不要二级标签）
						const val = String((c.doc.values && c.doc.values[f.key]) || "");
						const inp = String(f.type) === "line" ? el("input") : el("textarea");
						inp.value = val;
						if (inp.tagName === "TEXTAREA") inp.rows = 3;
						inp.placeholder = String(f.label || f.key);
						inp.setAttribute("data-field", String(f.key));
						inp.setAttribute("data-quote", f.quote ? "1" : "");
						inp.setAttribute("data-type", String(f.type || "text"));
						inp.setAttribute("data-label", String(f.label || f.key));
						w.append(inp);
						cardFields.append(w);
					}
				}
				cardText.value = c.text || "";
				cardMsg.textContent = "";
				cardMsg.className = "ff-msg";

				/*
				 * 「按文件展开」只在**这一步的产物是多个文件**时才显示。
				 *
				 * 用户 2026-10-21：「一段提示词一个单独的节点」。
				 * ⑤ 的产物是 `视频提示词/v*.txt`（31 个）+ `b*.txt`（27 个）——
				 * 点一下就把每个文件变成一个可单独编辑/过期的子节点。
				 * 只在能展开的时候出现，避免卡片上堆按钮。
				 */
				const globs = (n.outputs || []).filter((o) => o.count > 1).map((o) => o.glob);
				const expandable = globs.length > 0;
				btnExpand.style.display = expandable ? "" : "none";
				btnExpand.textContent = expandable
					? "按文件展开（" + (n.outTotal || 0) + " 个文件）"
					: "按文件展开";
				btnExpand.title = expandable ? "把 " + globs.join(' / ') + " 的每个文件变成子节点" : "";

				card.className = "ff-card on";
				for (const x of world.querySelectorAll(".ff-node.sel")) x.classList.remove("sel");
			}

			/** 保存当前卡片。 */
			async function save() {
				const n = SEL;
				if (!n) return;
				const c = Object.assign({}, n.ref || {}, n);
				let text = cardText.value;
				let itemTitle = "";
				if (c.doc && c.doc.kind === "item" && cardFields.children.length) {
					const lines = [];
					for (const w of cardFields.children) {
						const inp = w.lastElementChild;
						const v = String((inp && inp.value) || "").trim();
						if (!v) continue;
						const lb = String((inp && inp.getAttribute("data-label")) || "").trim();
						const isQuote = !!(inp && inp.getAttribute("data-quote"));
						const ftype = String((inp && inp.getAttribute("data-type")) || "text");
						lines.push(ftype === "line" && isQuote && lb ? "> " + lb + "：" + v : v);
						lines.push("");
					}
					text = lines.join("\n").trim();
					itemTitle = String((c.doc.values && c.doc.values.title) || c.title || n.title || "").trim();
				}
				cardMsg.className = "ff-msg";
				cardMsg.textContent = "保存中…";
				try {
					await post("/filmflow/edit", {
						root: current() && current().root,
						src: c.src, line: c.line, whole: !!c.whole,
						title: c.title, kind: n.kind, via: c.via, itemTitle,
						text,
					});
					cardMsg.className = "ff-msg ok";
					cardMsg.textContent = "已写回 " + c.src;
					await load();
				} catch (err) {
					cardMsg.className = "ff-msg err";
					cardMsg.textContent = "写回失败：" + String((err && err.message) || err);
				}
			}

			/** 读一次并重画。 */
			let hudAt = 0;
			async function load() {
				// 媒体模型表：第一次渲染前拉一次（拉到就缓存，失败不阻塞画布）
				ensureMediaModels();
				// HUD 余额不用每次都查（接口开销小但也别每 2 秒一次）：15 秒刷一次
				if (Date.now() - hudAt > 15000) { hudAt = Date.now(); refreshHud(); }
				// 网格格子点了「✎ 编辑」→ 重画完就把浮层打开
				if (MEDIA_EDIT) { try { showMediaEdit(MEDIA_EDIT); } catch { /* 忽略 */ } }
				try {
					S = await fetchState();
					draw();
				} catch (err) {
					meta.textContent = "读不到状态：" + String((err && err.message) || err);
					meta.style.color = "var(--dsw-alias-state-error-primary)";
				}
			}

			// ── 交互 ──────────────────────────────────────────────────
			// 回项目菜单：这边的画布只是"里层"，导航交给外层的菜单面板
			btnBack.addEventListener("click", () => { if (onBack) onBack(); });
			btnFit.addEventListener("click", () => fit());
			btnReload.addEventListener("click", () => { SIG.tree = ""; load(); });
			btnUndo.addEventListener("click", () => { runStructure({ type: "undo" }); });
			btnClose.addEventListener("click", () => { card.className = "ff-card"; SEL = null; });
			btnSave.addEventListener("click", () => { save(); });
			/*
			 * 卡片上的结构操作（改名 / 移动 / 删除）。
			 *
			 * 用户 2026-10-21 报"画布功能重构完全没实现"，核查发现：
			 * 宿主早就有 rename / move 接口，**但画布上一直没有按钮** —— 用户找不到。
			 * agent 也只能说"我手里没有删节点这个动作，你在卡片菜单里点"，
			 * 所以卡片上必须有这几个动作，否则那句话就是空头支票。
			 */
			btnRename.addEventListener("click", () => {
				const n = SEL;
				if (!n) return;
				const title = String(cardRenameInput.value || "").trim();
				if (!title) { cardMsg.className = "ff-msg err"; cardMsg.textContent = "名字不能为空"; return; }
				if (title === String(n.title || "")) { cardMsg.className = "ff-msg"; cardMsg.textContent = "名字没变"; return; }
				runStructure({ type: "rename", key: n.key, title }).then((r) => {
					if (r) { cardMsg.className = "ff-msg ok"; cardMsg.textContent = "已改名：" + title; }
				});
			});
			btnUp.addEventListener("click", () => {
				const n = SEL;
				if (!n) return;
				runStructure({ type: "move", key: n.key, dir: "up" });
			});
			btnDown.addEventListener("click", () => {
				const n = SEL;
				if (!n) return;
				runStructure({ type: "move", key: n.key, dir: "down" });
			});
			btnDelete.addEventListener("click", (ev) => {
				ev.stopPropagation();
				const n = SEL;
				if (!n) return;
				structure({ type: "delete", key: n.key });
			});
			/*
			 * 按文件展开：一个节点可能声明多个 glob（⑤ 有 v*.txt 和 b*.txt 两组），
			 * 逐个发 expand —— 宿主对"已经展开过"的 glob 是幂等的，不会重复建。
			 */
			btnExpand.addEventListener("click", async () => {
				const n = SEL;
				if (!n) return;
				const globs = (n.outputs || []).filter((o) => o.count > 1).map((o) => o.glob);
				if (!globs.length) return;
				btnExpand.textContent = "展开中…";
				let total = 0;
				for (const glob of globs) {
					const r = await structure({ type: "expand", key: n.key, glob });
					if (r && typeof r.count === "number") total += r.count;
				}
				cardMsg.className = "ff-msg ok";
				cardMsg.textContent = total
					? "已展开 " + total + " 个子节点（每个文件一个节点）"
					: "这些文件已经是子节点了，没有新建";
				card.className = "ff-card";
			});

			// 拖动 + 滚轮缩放
			let drag = null;
			/*
			 * ★ 点击空白 = 保存（用户 2026-10-22：「对节点的更改要有点击空白处保存功能」）。
			 *
			 * 之前这里对任何 mousedown 都 `preventDefault()` —— 后果是**输入框永远拿不到 blur**，
			 * 于是原地改完标题/正文，点别处什么也不会发生，改动就挂在那儿（实测就是"没法用"）。
			 * ⇒ 有编辑器在时：点别处先 commit（blur 触发保存），并且不当成拖动。
			 */
			const onDown = (e) => {
				if (e.target.closest(".ff-card")) return;
				/*
				 * ★ 任何**表单控件**上的按压都不算拖动、也不 preventDefault。
				 *
				 * `preventDefault()` 会阻止焦点转移 ⇒ 输入框里的光标放不进去、下拉打不开。
				 * 上次只放行了 `.ff-inline-edit/.ff-inline-rename`，结果新增的
				 * 媒体提示词框（textarea）和参数下拉（select）又被同一个坑绊住
				 * —— 用户 2026-10-22：「生成节点输入框内无法编辑」。
				 * ⇒ 干脆按**控件类型**放行，以后再加输入框不会再犯。
				 */
				if (e.target.closest("input, textarea, select, button, [contenteditable='true']")) {
					drag = null;
					return;
				}
				const editing = document.querySelector(".ff-inline-edit, .ff-inline-rename");
				if (editing) {
					if (!editing.contains(e.target)) {
						try { editing.blur(); } catch { /* 忽略 */ }
					} else {
						e.stopPropagation();   // 点在编辑器里：让它自己定位光标
					}
					drag = null;
					return;
				}
				drag = { x: e.clientX - VIEW.x, y: e.clientY - VIEW.y };
				stage.className = "ff-stage drag";
				if (e.target === stage) card.className = "ff-card";
				e.preventDefault();
			};
			const onMove = (e) => {
				if (!drag) return;
				VIEW.x = e.clientX - drag.x;
				VIEW.y = e.clientY - drag.y;
				applyView();
			};
			const onUp = () => { drag = null; stage.className = "ff-stage"; };
			const onWheel = (e) => {
				if (e.target.closest(".ff-card")) return;
				if (e.target.closest("input, textarea, select, button, [contenteditable='true']")) return;
				if (document.querySelector(".ff-inline-edit, .ff-inline-rename")) return;   // 编辑时不缩放
				e.preventDefault();
				const k = e.deltaY < 0 ? 1.1 : 1 / 1.1;
				const ns = Math.max(0.25, Math.min(2.5, VIEW.s * k));
				const r = stage.getBoundingClientRect();
				const mx = e.clientX - r.left;
				const my = e.clientY - r.top;
				VIEW.x = mx - (mx - VIEW.x) * (ns / VIEW.s);
				VIEW.y = my - (my - VIEW.y) * (ns / VIEW.s);
				VIEW.s = ns;
				applyView();
			};
			stage.addEventListener("mousedown", onDown);
			stage.addEventListener("wheel", onWheel, { passive: false });
			window.addEventListener("mousemove", onMove);
			window.addEventListener("mouseup", onUp);

			// ── 轮询 ──────────────────────────────────────────────────
			try { PICK = localStorage.getItem(PICK_KEY) || ""; } catch { PICK = ""; }

			const tick = async () => {
				if (disposed) return;
				await load();
				if (disposed) return;
				pollTimer = setTimeout(tick, 2000);
			};
			tick();

			// ── 拆 ────────────────────────────────────────────────────
			return () => {
				disposed = true;
				if (pollTimer) clearTimeout(pollTimer);
				if (linesRaf) cancelAnimationFrame(linesRaf);
				try { if (linesRO) linesRO.disconnect(); } catch { /* 忽略 */ }
				window.removeEventListener("resize", redrawLines);
				stage.removeEventListener("mousedown", onDown);
				stage.removeEventListener("wheel", onWheel);
				window.removeEventListener("mousemove", onMove);
				window.removeEventListener("mouseup", onUp);
				host.innerHTML = "";
			};
		}

		// ══════════════════════════════════════════════════════════════
		// 提案卡：官方工具树里的一个 keyed 视图
		// ══════════════════════════════════════════════════════════════
		//
		// 用户 2026-10-16 定过规矩：「确认内容直接在与 Agent 的交互框中输出，
		// 在交互框中确认，**不要占用画布空间**。」
		//
		// 现在这句话有了官方的实现方式：`tool.call.toolview` 槽按**工具名**分发，
		// 业务包给自己的工具注册一个视图即可 —— 于是提案卡就长在 agent 调
		// `filmflow_propose` 的那一刻，位置精确，既不占画布、也不用我在对话流里
		// 另塞一行。机制见 @deepseek-ai/dsh-client-ui-tool 的 README
		// 「Registering a business tool view」。

		/**
		 * 把工具结果压成纯文本（照 ui-skill / ui-tool 的 resultText 契约）。
		 * @param block - 工具块：未结算时没有 `kind`，结算后带 `content` 数组。
		 * @returns {string|null} 文本，或 null。
		 */
		function resultText(block) {
			if (!block || !("kind" in block)) return null;
			const parts = [];
			for (const item of block.content || []) {
				parts.push(item.type === "text" ? item.text : JSON.stringify(item, null, 2));
			}
			if (parts.length === 0 && block.error !== undefined) {
				parts.push(String((block.error && block.error.name) || "") + ": " + String((block.error && block.error.code) || ""));
			}
			return parts.join("\n") || null;
		}

		/**
		 * 从提案工具的回执里取提案 id。
		 *
		 * 回执形如「提案已提交（id p1abc2def），**现在等用户在图上确认**。」
		 * —— 这段文字由宿主 ../index.js 的 filmflow_propose 写死，格式稳定。
		 * @param text - 工具结果文本。
		 * @returns {string|null} 提案 id。
		 */
		function proposalIdOf(text) {
			const m = /（id (p[0-9a-z]+)）/.exec(String(text || ""));
			return m ? m[1] : null;
		}

		/**
		 * `filmflow_propose` 的工具卡：一句为什么 + 两个按钮 + 可选对照。
		 * @param props - 官方工具树给的 props：`phase` 与 `block`。
		 * @returns 卡片；信息不全时退化成一行文本（绝不吞内容）。
		 */
		function ProposeToolRow(props) {
			const phase = props && props.phase;
			const block = props && props.block;
			const settled = phase === "result";
			const output = settled ? resultText(block) : null;
			const id = settled ? proposalIdOf(output) : null;

			const [record, setRecord] = react.useState(null);
			const [state, setState] = react.useState("pending");
			const [note, setNote] = react.useState("");
			const [showDiff, setShowDiff] = react.useState(false);

			react.useEffect(() => {
				if (!id) return undefined;
				let alive = true;
				fetch("/filmflow/proposals", { headers: { accept: "application/json" } })
					.then((r) => r.json())
					.then((j) => {
						if (!alive) return;
						const rec = (j.proposals || []).find((x) => x.id === id);
						if (!rec) return;
						setRecord(rec);
						if (rec.status === "approved") setState("done");
						else if (rec.status === "rejected") setState("rejected");
					})
					.catch(() => { /* 读不到就只显示回执文字 */ });
				return () => { alive = false; };
			}, [id]);

			/** 确认 / 驳回。 */
			const decide = async (action) => {
				if (!record) return;
				setState("working");
				setNote("");
				try {
					await post("/filmflow/approve", { root: record.root, id: record.id, action });
					setState(action === "approve" ? "done" : "rejected");
					setNote(action === "approve" ? "已写进画布 ✓" : "已驳回，什么都没改");
				} catch (err) {
					setState("error");
					setNote(String((err && err.message) || err));
				}
			};

			// 还在准备/执行中：一行小字，别抢戏。
			if (!settled) {
				return h("div", { className: "ff-tool-note" }, "✎ 正在提交修改建议…");
			}
			// 没有提案 id（工具报错之类）：原样把回执显示出来，绝不吞。
			if (!id) {
				return h("pre", { className: "ff-tool-pre" }, String(output || "（没有回执）"));
			}
			// 有 id 但读不到记录（可能刚被清理）：也给一行。
			if (!record) {
				return h("div", { className: "ff-tool-note" }, "✎ 提案 " + id + "（读不到详情，可能已被处理）");
			}

			const finished = state === "done" || state === "rejected";
			/*
			 * 结构提案（kind='struct'）：agent 提议增/删/移节点。
			 * 它没有"改前/改后正文"可对比，改成显示「要做什么」+ 「理由」，
			 * 确认按钮语义也换成「确认，改结构」（用户 2026-10-21 的要求：
			 * agent 也能提结构改动，但必须由人点一下才生效）。
			 */
			const isStruct = String(record.kind || "") === "struct";
			const structLabel = (() => {
				const s = record.struct || {};
				const op = String(s.op || "");
				if (op === "add") return "新建节点（挂在 " + String(s.at || "") + " 下" + (s.template ? "，模板 " + s.template : "") + "）";
				if (op === "delete") return "删除节点 " + String(s.key || "");
				if (op === "move") return (s.dir === "up" ? "上移 " : "下移 ") + String(s.key || "");
				if (op === "rename") return "改名 " + String(s.key || "") + " → " + String(s.title || "");
				if (op === "expand") return "按文件展开 " + String(s.key || "");
				return JSON.stringify(s);
			})();
			return h("div", { className: "ff-tool" + (finished ? " done" : "") },
				h("div", { className: "ff-tool-hd" },
					h("span", undefined, finished ? (isStruct ? "✎ 结构改动" : "✎ 修改建议") : (isStruct ? "✎ 等你确认的结构改动" : "✎ 等你确认的修改")),
					h("b", undefined, isStruct ? structLabel : (record.node ? record.node + " " : "") + (record.nodeTitle || record.src || "")),
					h("span", { style: { fontWeight: 400, color: "var(--dsw-alias-label-secondary)" } }, record.src || "")),
				h("div", { className: "ff-tool-why" }, record.why || "（它没写理由）"),
				finished ? null : h("div", { className: "ff-tool-btns" },
					h("button", {
						className: "ff-btn p",
						disabled: state === "working",
						onClick: () => decide("approve"),
					}, state === "working" ? "处理中…" : (isStruct ? "确认，改结构" : "确认，写进画布")),
					h("button", {
						className: "ff-btn",
						disabled: state === "working",
						onClick: () => decide("reject"),
					}, "驳回"),
					isStruct ? null : h("button", {
						className: "ff-btn",
						onClick: () => setShowDiff(!showDiff),
					}, showDiff ? "收起改动" : "看改动")),
				!isStruct && showDiff ? h("div", { style: { display: "flex", flexDirection: "column", gap: 6 } },
					h("div", { className: "ff-tool-note" }, "现在的内容"),
					h("pre", { className: "ff-tool-pre" }, String(record.before || "（空）")),
					h("div", { className: "ff-tool-note" }, "改成"),
					h("pre", { className: "ff-tool-pre" }, String(record.after || "（空）"))) : null,
				note ? h("div", { className: "ff-tool-note " + (state === "error" ? "err" : "ok") }, note) : null);
		}

		// ══════════════════════════════════════════════════════════════
		// 三个界面件：控制条 / 项目菜单 / 工作台
		// ══════════════════════════════════════════════════════════════
		//
		// 用户 2026-10-20 定的页面流（原话）：
		//   「第一个页面是项目菜单，点进项目之后是画布，右边栏是 Agent 会话框。
		//     一个项目绑定一个会话，因此项目里的 Agent 只要图一的这个会话框，
		//     不要图 2 会话框旁边的项目选择侧边栏。」
		//
		// 于是：
		//   · 左边那条 56px 不是侧边栏，是**控制条**（官方折叠后的宽度，只放回菜单/切屏幕的按钮）
		//   · **`main` 中心列永远留给官方对话**（原因见下面 SCREEN 那段注释）
		//   · `shell.overlay` 上挂两块浮层：项目菜单（盖满）／画布（让出右侧会话宽度）

		/** 当前进到哪一部片（按 root 认）。项目菜单与画布共用。 */
		let ENTERED = "";

		/*
		 * ══ SCREEN：为什么不走 `ctx.layout.selectPanel` ══════════════════════
		 *
		 * `selectPanel` 切的是**官方 main 槽**里注册的面板。而实测（2026-10-20）：
		 *
		 *   ① 官方对话（main/conversation）**只能由框架自己渲染** ——
		 *      在别处调 `renderSlot('main', {}, {entryKey:'conversation'})` 一律返回 null。
		 *      试了三个位置：自己 main occupant 里、`rightbar` 槽、`shell.overlay` 槽，
		 *      前两个/第三个全是 null（`rightbar` 那条还会把官方 ui-sidebar-right 挤崩）。
		 *
		 *   ② 官方 `rightbar` 槽是独占的，而且占用者 ui-sidebar-right **不能关**：
		 *      它提供 sidebarRight / sidebarRightTabs 服务，ui-chat / ui-skill /
		 *      ui-reference / ui-deliverables 全都 inject —— 一关，前端 7 个插件不激活。
		 *
		 * ⇒ 结论：**对话必须留在中心列**，它是"长在框架上的"，搬不走。
		 *   所以要让"画布在中间、会话在右边"，只能反过来做：
		 *   · 对话照旧在中心列，但把中心列**压成右侧一条**（430px，靠右）
		 *   · 画布挂在浮层上，占左边剩下的区域
		 *   · 项目菜单是另一块全屏浮层
		 *
		 * 代价：中心列的宽度是我给**官方中心列元素**加的 inline style（`maxWidth` +
		 *      `marginLeft:auto`），不是官方 API。所以：只在"进到片子里"时加，
		 *      回菜单页立刻还原（见 CanvasOverlay 的 effect）。
		 */
		let SCREEN = "menu";
		const screenSubs = new Set();
		/** 当前屏幕：`menu`（项目菜单）｜`work`（画布 + 对话）。 */
		const useScreen = () => {
			const [v, setV] = react.useState(SCREEN);
			react.useEffect(() => {
				const fn = (n) => setV(n);
				screenSubs.add(fn);
				fn(SCREEN);
				return () => { screenSubs.delete(fn); };
			}, []);
			return v;
		};
		/**
		 * 切屏幕。
		 * @param next - `menu` 或 `work`
		 */
		function setScreen(next) {
			if (SCREEN === next) return;
			SCREEN = next;
			for (const fn of [...screenSubs]) {
				try { fn(next); } catch { /* 单个订阅出错不影响别人 */ }
			}
		}

		// ── 控制条（sidebar 槽）───────────────────────────────────────────
		/** 「本次页面已经自动收过侧栏了吗」——只收一次，别跟用户的手动展开对着干。 */
		let railAutoCollapsed = false;

		/**
		 * 折叠时是一条 56px 图标条；展开时列出片库里的片子。
		 *
		 * 官方框架给 occupant 的契约就是这样：`{collapsed, width}` 传进来，
		 * 「折叠时应当画出紧凑的控制轨」。
		 * @param props - `{ collapsed, width }`
		 * @returns 控制条。
		 */
		function Rail(props) {
			const collapsed = !!(props && props.collapsed);
			const renderSlot = props && props.renderSlot;
			const [state, setState] = react.useState(null);
			const [panel, setPanel] = react.useState("projects");

			/*
			 * ★ 默认折叠成 56px。
			 *
			 * 为什么不靠"初始就是 0"：AppFrame 的初始偏好是 280（SIDEBAR_DEFAULT），
			 * `sidebarCollapsed` 只在偏好被设成 0 之后才为真 —— 于是第一次打开
			 * 左边会横着一条 280px 的片子列表，正是用户说的"不要项目选择侧边栏" ✗
			 *
			 * ⇒ 挂载时看一眼真实状态：展开的就去 toggle 一次（官方的收起动作）。
			 *   只做一次，之后用户想展开就展开，不再抢他的选择。
			 */
			react.useEffect(() => {
				if (railAutoCollapsed || collapsed) return;
				railAutoCollapsed = true;
				try { props.layout.toggleSidebar(); } catch { /* 忽略 */ }
			}, [collapsed]);

			react.useEffect(() => {
				let alive = true;
				const tick = () => {
					fetchState().then((s) => { if (alive) setState(s); }, () => { /* 忽略 */ });
				};
				tick();
				const t = setInterval(tick, 3000);
				return () => { alive = false; clearInterval(t); };
			}, []);

			const go = (next, root) => {
				if (root !== undefined) {
					ENTERED = root;
					try { localStorage.setItem("filmflow.entered", root); } catch { /* 忽略 */ }
					// 宿主那边的"当前项目"决定 agent 的四把工具认哪一部
					post("/filmflow/select", { root }).catch(() => { /* 忽略了也先让用户看图 */ });
				}
				setScreen(next);
			};

			const hasFilm = !!(ENTERED || (state && state.current));
			const list = (state && state.projects) || [];
			const screen = useScreen();

			/*
			 * 底部不再渲染官方 `sidebar.settings`（用户 2026-10-28：
			 * 「设置/意见反馈/登录这三个可以都不要，设置都固化，只留个 API 更改项」）。
			 * 换成自己的「API 设置」入口 —— 打开 SettingsOverlay（Agent 的 key / url / model）。
			 */
			const apiBtn = (wide) => (wide
				? h("div", { className: "ff-rail-item", onClick: () => setScreen("settings") }, "API 设置")
				: h("button", {
					className: "ff-rail-btn" + (screen === "settings" ? " on" : ""),
					title: "API 设置",
					onClick: () => setScreen("settings"),
				}, h(KeyIcon)));

			if (collapsed) {
				return h("div", { className: "ff-rail" },
					h("button", {
						className: "ff-rail-btn" + (screen === "menu" ? " on" : ""),
						title: "项目菜单",
						onClick: () => go("menu"),
					}, h(BooksIcon)),
					h("button", {
						className: "ff-rail-btn" + (screen === "work" ? " on" : ""),
						title: hasFilm ? "工序画布" : "先从项目菜单选一部片",
						disabled: !hasFilm,
						onClick: () => { if (hasFilm) go("work"); },
					}, h(TreeIcon)),
					h("button", {
						className: "ff-rail-btn" + (screen === "assets" ? " on" : ""),
						title: "素材库（按项目分文件夹）",
						onClick: () => setScreen("assets"),
					}, h(GalleryIcon)),
					h("button", {
						className: "ff-rail-btn" + (screen === "library" ? " on" : ""),
						title: "节点库（所有节点模板 + 用法）",
						onClick: () => setScreen("library"),
					}, h(GridIcon)),
					h("div", { className: "ff-rail-sp" }),
					apiBtn(false));
			}

			return h("div", { className: "ff-rail", style: { alignItems: "stretch" } },
				h("div", { className: "ff-rail-head" }, "片库"),
				h("div", { className: "ff-rail-list" },
					list.map((p) => h("div", {
						key: p.root,
						className: "ff-rail-item",
						title: p.title + "　" + p.root,
						onClick: () => go("work", p.root),
					}, p.title || p.id))),
				h("div", { className: "ff-rail-sp" }),
				h("div", { className: "ff-rail-list" },
					h("div", { className: "ff-rail-item", onClick: () => go("menu") }, "项目菜单"),
					h("div", { className: "ff-rail-item", onClick: () => setScreen("assets") }, "素材库"),
					h("div", { className: "ff-rail-item", onClick: () => setScreen("library") }, "节点库"),
					apiBtn(true)));
		}

		// ── 项目菜单（第一个页面）──────────────────────────────────────────
		/**
		 * 片库里有哪些片，点一张卡片进这一部。
		 * @returns 项目列表页。
		 */
		function ProjectsPanel() {
			const [state, setState] = react.useState(null);
			const [err, setErr] = react.useState("");
			/* 新建片子的表单（骨架包 = 起手节点，用户 2026-10-21 定的） */
			const [newName, setNewName] = react.useState("");
			const [newPack, setNewPack] = react.useState("suspense");
			const [packs, setPacks] = react.useState(null);
			const [busy, setBusy] = react.useState(false);
			const [msg, setMsg] = react.useState("");

			react.useEffect(() => {
				let alive = true;
				const load = () => {
					fetchState().then(
						(s) => { if (alive) { setState(s); setErr(""); } },
						(e) => { if (alive) setErr(String((e && e.message) || e)); },
					);
				};
				load();
				const t = setInterval(load, 4000);
				return () => { alive = false; clearInterval(t); };
			}, []);

			const projects = (state && state.projects) || [];

			/* 骨架包清单（一次会话拉一次） */
			react.useEffect(() => {
				if (packs) return;
				fetch("/filmflow/templates")
					.then((r) => r.json())
					.then((j) => setPacks((j && j.packs) || []))
					.catch(() => setPacks([]));
			}, [packs]);

			/** 建一部新片：片名 + 骨架包。 */
			const createProject = () => {
				const name = String(newName || "").trim();
				if (!name) { setMsg("片名不能为空"); return; }
				setBusy(true);
				setMsg("正在建…");
				post("/filmflow/newproject", { title: name, pack: newPack })
					.then((r) => {
						if (r && r.ok === false) { setMsg("没建成：" + r.error); setBusy(false); return; }
						const added = r && r.pack && r.pack.added ? r.pack.added.length : 0;
						setMsg("建好了：" + name + (added ? "（骨架包加了 " + added + " 个节点）" : ""));
						setNewName("");
						setBusy(false);
						// 让列表立刻刷新
						fetchState().then((s) => setState(s), () => { /* 忽略 */ });
					})
					.catch((e) => { setMsg("没建成：" + String((e && e.message) || e)); setBusy(false); });
			};

			return h("div", { className: "ff-projects" },
				h("h2", undefined, "片库"),
				/*
				 * 新建片子：片名 + 骨架包。
				 * 用户 2026-10-21：「一切皆可拆为模板」→ 新建时选一套起手节点，
				 * 选完照样能在画布上增删（包只是起点，不是锁）。
				 */
				h("div", { className: "ff-new" },
					h("div", { className: "ff-new-row" },
						h("input", {
							className: "ff-new-name",
							placeholder: "新片名",
							value: newName,
							disabled: busy,
							onChange: (e) => setNewName(e.target.value),
							onKeyDown: (e) => { if (e.key === "Enter") createProject(); },
						}),
						h("select", {
							className: "ff-new-pack",
							value: newPack,
							disabled: busy,
							onChange: (e) => setNewPack(e.target.value),
						}, (packs || []).map((p) => h("option", { key: p.id, value: p.id },
							p.title + (p.count ? "（+" + p.count + " 节点）" : "")))),
						h("button", {
							className: "ff-btn p",
							disabled: busy,
							onClick: createProject,
						}, busy ? "建立中…" : "新建片子")),
					msg ? h("div", { className: "ff-msg" }, msg) : null),
				h("div", { className: "ff-hint" },
					err ? "读不到片子：" + err
						: state ? "共 " + projects.length + " 部。点一部进入它的工序画布（右边是它的制作助手）。"
							: "读取中…"),
				h("div", { className: "ff-grid" },
					projects.map((p) => h("div", {
						key: p.root,
						className: "ff-proj",
						onClick: () => enterProject(p),
					},
						h("div", { className: "t" }, p.title || p.id),
						/*
						 * 用户 2026-10-29：「出现人为改动 agent 就去自动对齐；没有要改的就什么都不显示；
						 * 规划出要改的就显示待确认。」
						 * ⇒ 卡片上**不再显示「N 处待对齐 / 已对齐」**：
						 *   对齐是 agent 自己的活，没活可干时界面就该是空的；
						 *   真正需要人看的只有「待确认提案」，那个在对话里的提案卡上。
						 */
						h("div", { className: "m" },
							h("span", undefined, ((p.stages || []).length) + " 道工序"),
							p.pendingProposals
								? h("span", { className: "warn" }, p.pendingProposals + " 条待确认")
								: null),
						h("div", { className: "p" }, p.root)))),
				projects.length ? null : h("div", { className: "ff-proj-empty" },
					"片库里还没有片子。\n在 " + String((state && state.roots) || []).replace(/,/g, "、")
					+ " 下面建一部（带 .film/project.json），这里就会出现。"));
		}

		/**
		 * 进入一部片：告诉宿主"现在做这部"、记住、切到工作台，
		 * 并把**这部片自己的会话**接上（一个项目绑一个会话）。
		 * @param p - /filmflow/state 里的项目
		 */
		function enterProject(p) {
			ENTERED = p.root;
			try { localStorage.setItem("filmflow.entered", p.root); } catch { /* 忽略 */ }
			// 宿主那边的"当前项目"决定 agent 的四把工具认哪一部
			post("/filmflow/select", { root: p.root }).catch(() => { /* 失败也让用户先看得到图 */ });
			setScreen("work");
			bindSession(p).catch((e) => {
				// 会话接不上不该拦住看画布，但必须在控制台留下原因（不然就是"黑箱不工作"）
				diag("绑定会话失败：" + String((e && e.message) || e));
			});
		}

		/**
		 * 把一条诊断写回宿主日志（`/filmflow/diag` → `filmflow-trace.log`）。
		 *
		 * 为什么不用 `console.error`：这条链路只有**真浏览器**能跑，
		 * 而看浏览器控制台要么开着窗口看，要么起 headless Chrome 去抓 ——
		 * 一个来回一分钟。写进宿主日志就能直接读文件，排查快一个数量级。
		 * （这一条是踩出来的：一个"绑不上会话"的问题查了十几轮。）
		 * @param msg - 一句话诊断
		 */
		function diag(msg) {
			try { console.error("[filmflow] " + msg); } catch { /* 忽略 */ }
			try {
				fetch("/filmflow/diag", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ msg: "[客户端] " + msg, src: "client-plugin" }),
				}).catch(() => { /* 记不上就算了 */ });
			} catch { /* 忽略 */ }
		}

		/**
		 * 把右栏的官方会话切到"这部片自己的那一会话"。
		 *
		 * 为什么需要它：`main` 中心列现在永远是官方对话，而对话显示的是
		 * **当前选中的那个 Session**。不切的话，换片子还是同一个会话 ——
		 * 用户明确要求"一个项目绑定一个会话"。
		 *
		 * 做法（全走官方客户端能力，不碰宿主内部）：
		 *   ① 每部片在它自己的目录登记成一个 Workspace（`remote.workspace.create({path})`，
		 *      幂等 —— 同一个路径返回已有记录）。这样会话的 cwd 就是这部片的目录。
		 *   ② `uiWorkspace.connectWorkspace(id)`：复用该 Workspace 里第一个空白会话，
		 *      没有就新建一个 —— 正好是"这部片一条会话"。
		 *   ③ 把 sessionId 记到片子的 `.film/session.json`（宿主那边），
		 *      下次进来直接 `openSession` 复用，不新建。
		 * @param p - 项目
		 * @returns {Promise<void>}
		 */
		async function bindSession(p) {
			const api = ACTIVE_CTX;
			/*
			 * 前置条件缺了就**报出来**，不要安静 return ——
			 * 静默跳过等于"看起来什么都没发生"，排查时完全没线索（踩过一次）。
			 */
			if (!api) throw new Error("没有 ctx");
			if (!api.uiWorkspace) throw new Error("没有 uiWorkspace 服务");
			if (!api.remote) throw new Error("没有 remote 服务");
			if (!api.remote.workspace) throw new Error("没有 remote.workspace");

			// 上次记下的会话（只用于判断"要不要回写"，不再拿它直接 openSession —— 见下）
			let bound = "";
			try {
				const r = await fetch("/filmflow/session?root=" + encodeURIComponent(p.root), { headers: { accept: "application/json" } });
				if (r.ok) bound = String((await r.json()).sessionId || "");
			} catch { /* 读不到就当没有 */ }

			// ① 先把这部片自己的 Workspace 拿到（幂等：同路径返回已有记录）
			const created = await api.remote.workspace.create({ path: p.root });
			const ws = created && created.ok ? created.value && created.value.workspace : null;
			if (!ws) throw new Error("建工作区失败：" + JSON.stringify((created && created.error) || {}));

			/*
			 * ② 回到这部片原来那条会话。
			 *
			 * ⚠️⚠️ **`openSession` 的参数是裸 sessionId 字符串，不是 `{ sessionId }`。**
			 *   类型定义：`SessionTarget = SessionId | SubagentAddress`
			 *   （dsh-api-session-controller 的 contract/sessions.d.ts）。
			 *
			 *   我之前一直传对象，结果是：**不报错、什么也不发生** ——
			 *   页面就一直停在「选择一个工作区开始」。
			 *   为了这个"静默无效"，绕了 openWorkspace / connectWorkspace /
			 *   archiveSession / 延迟一拍 四条弯路（全记在上面被删掉的注释里）。
			 *   教训：官方 API 的参数形状要**从类型定义上读**，不能照着"看着像"写。
			 *
			 * 顺带把另一条实测记下来（别再用）：
			 *   · `openWorkspace` 是"在这个工作区开始一次新对话"的语义，
			 *     **每调一次就新建一条会话**（实测：连调两次，3 条变 4 条）——
			 *     它只适合"第一次进这部片"，不能拿来回到历史。
			 *   · `archiveSession` 只归档，不会把会话从工作区的 `sessionIds` 里摘掉。
			 */
			const readIds = async () => {
				const again = await api.remote.workspace.create({ path: p.root });
				const ws2 = again && again.ok ? again.value && again.value.workspace : null;
				return ((ws2 && ws2.sessionIds) || []).map(String);
			};

			/*
			 * ★ 绑定有效就直接打开它 —— 判据是"**这条会话还在不在**"，不是"它在不在工作区名单里"。
			 *
			 * 2026-10-21 用户报「一个会话的会话历史要全部保留并显示」时抓到的真 bug：
			 *   · `.film/session.json` 记的会话**文件还在、有历史**（29KB）
			 *   · 但 `workspace.json` 里这部片的工作区名单是**另外两条**（我多次 openWorkspace 造的）
			 *   · 我原来要求 `ids.includes(bound)` 才算数 ⇒ 判据不过 ⇒ 退回去 openWorkspace
			 *     ⇒ 新建一条空会话 ⇒ **会话框一片空白**，看着像"历史丢了" ✗
			 *   ⇒ 工作区名单只是"这部片名下收着哪些会话"，跟"这条会话能不能打开"是两回事。
			 *     只要会话本体还在，openSession 就能把它打开（round 2 已实测）。
			 */
			const ids0 = await readIds();
			if (bound) {
				let alive = false;
				try {
					const snap = api.sessions && api.sessions.list ? api.sessions.list.getSnapshot() : null;
					alive = !!(snap && snap.byId && snap.byId[bound]);
				} catch { alive = false; }
				const inWs = ids0.includes(bound);
				diag("绑定检查：bound=" + bound + " 还在=" + alive + " 在工作区=" + inWs + " 工作区会话数=" + ids0.length);
				if (alive || inWs) {
					api.uiWorkspace.openSession(bound);
					diag("打开原会话：" + bound);
					// 不在名单里就顺手补进去，下次判断更干净（失败无所谓）
					if (!inWs) {
						try { api.uiWorkspace.insertSessionBefore && api.uiWorkspace.insertSessionBefore(bound, null); } catch { /* 忽略 */ }
					}
					return;
				}
			}

			// 第一次进这部片（或那条会话真的没了）：连上工作区，它会给一条会话
			await api.uiWorkspace.openWorkspace(ws.workspaceId, undefined, { agentPreset: "filmflow" });
			const ids = await readIds();
			const sessionId = String(ids[ids.length - 1] || "");
			diag("首次绑定：工作区 " + ws.workspaceId + "（会话 " + ids.length + " 条）取=" + (sessionId || "(空)"));
			if (sessionId && sessionId !== bound) {
				await post("/filmflow/session", { root: p.root, sessionId }).catch(() => { /* 记不上只是下次再建 */ });
			}
		}

		// ── 浮层 1：项目菜单（第一个页面，盖满内容区）────────────────────────
		/**
		 * 项目菜单浮层。
		 * @returns 盖住内容区的菜单，或 null。
		 */
		function MenuOverlay() {
			const screen = useScreen();
			if (screen !== "menu") return null;
			return h("div", { className: "ff-layer ff-layer-menu" }, h(ProjectsPanel));
		}

		// ── 浮层 2：画布（左边，让出右侧会话宽度）──────────────────────────
		/**
		 * 画布浮层 —— 同时负责把**官方中心列压成右侧一条**。
		 *
		 * ⚠️ 为什么要压官方中心列：对话只能在中心列里渲染（见 SCREEN 那段注释），
		 *   而用户要的是"画布在中间、会话在右边"。
		 *   ⇒ 中心列压到 430px 并靠右，剩下的宽度由这块浮层放画布。
		 *
		 * 怎么找中心列：右栏有一个**稳定的 data 属性** `[data-rightbar-col]`，
		 * 它的前一个兄弟节点就是中心列 —— 不依赖被压缩过的 class 名。
		 *
		 * 只加两个 inline 样式（maxWidth / marginLeft），离开时**原样还原**；
		 * 框架自己管的是 `grid-template-columns`，我没碰，所以不会打架。
		 * @returns 画布浮层，或 null。
		 */
		/**
		 * 「待确认提案」面板 —— 钉在会话框这一侧（用户 2026-10-22：
		 * 「有些提案没出现」「让所有提案都在与 agent 的会话框里，不要到处都是」）。
		 *
		 * 为什么不能只靠工具卡：提案可能是
		 *   · agent 调 filmflow_propose 提的（历史里有工具卡，但滚动上去就找不到了）
		 *   · 宿主/我直接写进 proposals.json 的（没有任何工具卡 ⇒ 用户完全看不到）
		 * ⇒ 这里直接轮询提案表，把**所有 pending** 集中显示，确认/驳回就地完成。
		 * @returns 面板，或 null（没有待确认时完全不占地方）。
		 */
		function ProposalsDock() {
			const screen = useScreen();
			const [list, setList] = react.useState([]);
			const [busy, setBusy] = react.useState("");
			const [root, setRoot] = react.useState("");

			react.useEffect(() => {
				if (screen !== "work") return undefined;
				let alive = true;
				const tick = () => {
					fetch("/filmflow/proposals", { headers: { accept: "application/json" } })
						.then((r) => r.json())
						.then((j) => {
							if (!alive) return;
							const pending = (j.proposals || []).filter((p) => p.status === "pending");
							setList(pending);
							if (pending[0]) setRoot(pending[0].root || "");
						})
						.catch(() => { /* 读不到就算了 */ });
				};
				tick();
				const t = setInterval(tick, 3000);
				return () => { alive = false; clearInterval(t); };
			}, [screen]);

			if (screen !== "work" || !list.length) return null;

			const decide = async (pr, action) => {
				setBusy(pr.id);
				try {
					await post("/filmflow/approve", { root: pr.root || root, id: pr.id, action });
					setList((old) => old.filter((x) => x.id !== pr.id));
				} catch (e) {
					/* ★ 失败必须让人看见：以前这里静默吞掉，用户只会觉得"点了没反应" */
					setList((old) => old.map((x) => (x.id === pr.id
						? { ...x, err: String((e && e.message) || e) }
						: x)));
				} finally {
					setBusy("");
				}
			};

			return h("div", { className: "ff-dock" },
				h("div", { className: "ff-dock-hd" }, "待确认提案（" + list.length + "）"),
				h("div", { className: "ff-dock-list" }, list.map((pr) => {
					const s = pr.struct || {};
					const isStruct = String(pr.kind || "") === "struct";
					const what = isStruct
						? (s.op === "delete" ? "删除节点 " + String(s.key || "")
							: s.op === "add" ? "新建节点（挂在 " + String(s.at || "") + " 下）"
							: s.op === "move" ? (s.dir === "up" ? "上移 " : "下移 ") + String(s.key || "")
							: s.op === "rename" ? "改名 " + String(s.key || "") + " → " + String(s.title || "")
							: JSON.stringify(s))
						: ((pr.node ? pr.node + " " : "") + (pr.nodeTitle || pr.src || ""));
					return h("div", { key: pr.id, className: "ff-dock-item" },
						h("div", { className: "ff-dock-t" }, (isStruct ? "结构：" : "内容：") + what),
						h("div", { className: "ff-dock-why" }, pr.why || "（没写理由）"),
						pr.err ? h("div", { className: "ff-dock-why", style: { color: "var(--dsw-alias-state-error-primary)" } }, "处理失败：" + pr.err) : null,
						h("div", { className: "ff-dock-btns" },
							h("button", {
								className: "ff-btn p",
								disabled: busy === pr.id,
								onClick: () => decide(pr, "approve"),
							}, busy === pr.id ? "处理中…" : (isStruct ? "确认，改结构" : "确认，写进画布")),
							h("button", {
								className: "ff-btn",
								disabled: busy === pr.id,
								onClick: () => decide(pr, "reject"),
							}, "驳回")));
				})));
		}
		/* ── 媒体查看器（全屏）──────────────────────────────────── */
		let VIEWER = null;                       // { root, item }
		const viewerSubs = new Set();
		/** 打开查看器（节点缩略图、素材库卡片都走这里）。 */
		function openViewer(v) {
			VIEWER = v;
			for (const f of [...viewerSubs]) { try { f(); } catch { /* 忽略 */ } }
		}
		/** 订阅查看器变化。 */
		function useViewer() {
			const [, force] = react.useReducer((x) => x + 1, 0);
			react.useEffect(() => { viewerSubs.add(force); return () => viewerSubs.delete(force); }, []);
			return VIEWER;
		}

		/**
		 * 全屏查看器：图片可放大看，视频/音频可播。
		 * @returns 查看器，或 null。
		 */
		function MediaViewer() {
			const v = useViewer();
			if (!v || !v.item) return null;
			const it = v.item;
			const url = "/filmflow/assets?action=file&root=" + encodeURIComponent(v.root || "") + "&p=" + encodeURIComponent(it.src);
			const close = () => openViewer(null);
			return h("div", { className: "ff-viewer", onClick: close },
				it.type === "image" ? h("img", { src: url, onClick: (e) => e.stopPropagation() }) : null,
				it.type === "video" ? h("video", { src: url, controls: true, autoPlay: true, onClick: (e) => e.stopPropagation() }) : null,
				it.type === "audio" ? h("audio", { src: url, controls: true, autoPlay: true, onClick: (e) => e.stopPropagation() }) : null,
				h("div", { className: "bar" },
					h("span", undefined, String(it.nodeTitle || it.node || "") + "　" + String(it.model || "")),
					h("button", { className: "ff-btn", onClick: (e) => { e.stopPropagation(); close(); } }, "关闭")));
		}

		/**
		 * 素材库：按项目分文件夹（用户 2026-10-28：「素材库要分文件夹，一个项目一个文件夹」）。
		 * 第一层是项目文件夹 → 点进去看那一部的素材；类型筛选只在这一层用。
		 * @returns 素材库面板，或 null。
		 */
		function AssetsOverlay() {
			const screen = useScreen();
			const [items, setItems] = react.useState([]);
			const [projs, setProjs] = react.useState([]);
			const [credit, setCredit] = react.useState("");
			const [filter, setFilter] = react.useState("all");
			const [folder, setFolder] = react.useState("");
			const [err, setErr] = react.useState("");

			react.useEffect(() => {
				if (screen !== "assets") return undefined;
				let alive = true;
				fetch("/filmflow/media?action=credit", { headers: { accept: "application/json" } })
					.then((x) => x.json())
					.then((j) => { if (alive && j && j.credit) setCredit(String(j.credit)); })
					.catch(() => { /* 拿不到就不显示 */ });
				/*
				 * 项目清单也从 state 拿：素材库要「一个项目一个文件夹」，
				 * 没生成过素材的片也得有文件夹（2026-10-28 用户：分文件夹，一个项目一个）。
				 */
				fetch("/filmflow/state", { headers: { accept: "application/json" } })
					.then((x) => x.json())
					.then((j) => { if (alive) setProjs((j && j.projects) || []); })
					.catch(() => { /* 拿不到就只列有素材的 */ });
				fetch("/filmflow/assets?action=list", { headers: { accept: "application/json" } })
					.then((x) => x.json())
					.then((j) => { if (alive) setItems(j.items || []); })
					.catch((e) => { if (alive) setErr(String((e && e.message) || e)); });
				return () => { alive = false; };
			}, [screen]);

			if (screen !== "assets") return null;
			syncRailWidth();

			/* 项目文件夹：先按全部项目铺一遍（空文件夹也在），再把素材归进去 */
			const folders = [];
			for (const p of projs) {
				const root = String(p.root || "");
				if (!root) continue;
				const title = String(p.title || "").split("·")[0].trim();
				folders.push({
					root,
					film: title || root.split(/[\\/]/).pop(),
					count: 0,
					last: "",
				});
			}
			for (const it of items) {
				const key = String(it.root || "");
				let f = folders.find((x) => x.root === key);
				if (!f) {
					f = {
						root: key,
						film: String(it.film || (key ? key.split(/[\\/]/).pop() : "未归片")),
						count: 0,
						last: "",
					};
					folders.push(f);
				}
				f.count += 1;
				const at = String(it.at || "");
				if (at > f.last) f.last = at;
			}
			folders.sort((a, b) => {
				if (a.last !== b.last) return String(b.last).localeCompare(String(a.last));
				return String(a.film).localeCompare(String(b.film), "zh");
			});

			const inside = items.filter((x) => String(x.root || "") === folder);
			const shown = inside.filter((x) => filter === "all" || x.type === filter);
			const cur = folders.find((f) => f.root === folder) || null;

			return h("div", { className: "ff-assets" },
				h("div", { className: "ff-assets-bar" },
					folder
						? h("button", { className: "ff-crumb", onClick: () => setFolder("") }, "← 素材库")
						: h("span", { className: "ff-docs-hd" }, "素材库"),
					h("span", { className: "ff-docs-meta" },
						folder
							? (cur ? cur.film : "项目") + " · " + shown.length + " / " + inside.length + " 条"
							: folders.length + " 个项目 · " + items.length + " 条"),
					credit ? h("span", { className: "ff-docs-meta", title: "小云雀积分余额" }, "积分 " + credit) : null,
					h("span", { style: { flex: 1 } }),
					folder ? ["all", "image", "video", "audio"].map((t) => h("button", {
						key: t,
						className: "ff-btn" + (filter === t ? " p" : ""),
						onClick: () => setFilter(t),
					}, t === "all" ? "全部" : t === "image" ? "图片" : t === "video" ? "视频" : "音频")) : null,
					h("div", { className: "ff-btn", onClick: () => setScreen(ENTERED ? "work" : "menu") }, ENTERED ? "回画布" : "返回片库")),
				!folder
					? h("div", { className: "ff-folder-grid" },
						folders.length ? folders.map((f) => h("div", {
							key: f.root || f.film,
							className: "ff-folder",
							onClick: () => { setFolder(f.root); setFilter("all"); },
						},
							h("div", { className: "ff-folder-ic" }, "📁"),
							h("div", { className: "ff-folder-t" }, f.film),
							h("div", { className: "ff-folder-m" }, f.count + " 条素材"))) :
						h("div", { className: "ff-media-empty", style: { margin: "auto" } }, err || "还没有任何素材"))
					: h("div", { className: "ff-assets-grid" },
						shown.length ? shown.map((it) => {
							const r = String(it.root || folder);
							const url = "/filmflow/assets?action=file&root=" + encodeURIComponent(r) + "&p=" + encodeURIComponent(it.src);
							return h("div", {
								key: it.id,
								className: "ff-asset-card",
								onClick: () => openViewer({ root: r, item: it }),
							},
								it.type === "image"
									? h("img", { className: "im", src: url, loading: "lazy" })
									: h("div", { className: "im", style: { display: "flex", alignItems: "center", justifyContent: "center", color: "#bbb", fontSize: 13 } }, it.type === "video" ? "▶ 视频" : "🔊 音频"),
								h("div", { className: "info" },
									h("div", { className: "t" }, String(it.nodeTitle || it.node || "")),
									h("div", { className: "m" }, String(it.model || "") + "　" + new Date(it.at).toLocaleDateString())));
						}) : h("div", { className: "ff-media-empty", style: { gridColumn: "1/-1", margin: "auto" } }, "这个项目还没有素材")));
		}
		/**
		 * 左侧竖条的真实宽度写进 CSS 变量。
		 *
		 * ⚠ 必须放在**模块级**：素材库面板（AssetsOverlay）是模块级组件，
		 * 而竖条是画布闭包里渲染的。放进闭包 → 面板渲染时 ReferenceError → 整个面板不出现
		 * （我第一次就放错了，表现正是"点素材库没反应"）。
		 */
		function syncRailWidth() {
			try {
				const rail = document.querySelector(".ff-rail");
				if (!rail) return;
				const w = Math.ceil(rail.getBoundingClientRect().right);
				document.documentElement.style.setProperty("--ff-rail-w", w + "px");
			} catch { /* 忽略 */ }
		}

		/**
		 * API 设置：只管 Agent 用哪把 Key / 哪个地址 / 哪个模型。
		 *
		 * 用户 2026-10-28：「已配置的要写出来」「agent 只允许配一个 api」「别写多余的文案」。
		 * ⇒ 只有一个接口；Key 直接显示（本机）；除了「改完重启生效」不多写一个字。
		 */
		function SettingsOverlay() {
			const screen = useScreen();
			const [state, setState] = react.useState(null);
			const [key, setKey] = react.useState("");
			const [baseURL, setBaseURL] = react.useState("");
			const [model, setModel] = react.useState("");
			const [msg, setMsg] = react.useState("");
			const [saving, setSaving] = react.useState(false);
			/* AIGC（火山引擎）：方舟 + 豆包语音，2026-10-30 用户要求 */
			const [aigc, setAigc] = react.useState(null);
			const [ark, setArk] = react.useState("");
			const [speech, setSpeech] = react.useState("");
			const [aigcMsg, setAigcMsg] = react.useState("");
			const [aigcSaving, setAigcSaving] = react.useState(false);

			react.useEffect(() => {
				if (screen !== "settings") return undefined;
				let alive = true;
				fetch("/filmflow/agent-api", { headers: { accept: "application/json" } })
					.then((r) => r.json())
					.then((j) => {
						if (!alive) return;
						setState(j);
						setKey(String((j && j.keyValue) || ""));
						setBaseURL(String((j && j.baseURL) || ""));
						setModel(String((j && j.model) || ""));
					})
					.catch(() => { if (alive) setState({ key: false }); });
				fetch("/filmflow/aigc", { headers: { accept: "application/json" } })
					.then((r) => r.json())
					.then((j) => {
						if (!alive || !j || !j.ok) return;
						setAigc(j);
						setArk(String((j.ark && j.ark.value) || ""));
						setSpeech(String((j.speech && j.speech.value) || ""));
					})
					.catch(() => { if (alive) setAigc({ ark: {}, speech: {} }); });
				return () => { alive = false; };
			}, [screen]);

			if (screen !== "settings") return null;
			syncRailWidth();

			const save = async (clearKey) => {
				setSaving(true);
				setMsg("");
				try {
					const body = clearKey
						? { clearKey: true }
						: { key: key.trim(), baseURL: baseURL.trim(), model: model.trim() };
					const j = await (await fetch("/filmflow/agent-api", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify(body),
					})).json();
					if (!j.ok) throw new Error(j.error || "保存失败");
					const fresh = await (await fetch("/filmflow/agent-api", { headers: { accept: "application/json" } })).json();
					setState(fresh);
					setKey(String((fresh && fresh.keyValue) || ""));
					setMsg((clearKey ? "已清除" : "已保存") + " · 重启片场后生效");
				} catch (e) {
					setMsg(String((e && e.message) || e));
				} finally {
					setSaving(false);
				}
			};

			const field = (label, value, onChange, placeholder, type) => h("div", { className: "ff-set-row" },
				h("div", { className: "ff-set-label" }, label),
				h("div", { className: "ff-set-line" },
					h("input", {
						className: "ff-set-input",
						type: type || "text",
						placeholder,
						value,
						onChange: (e) => onChange(e.target.value),
					})));

			/* AIGC（火山引擎）：保存即生效，不需要重启 */
			const saveAigc = async (clearWhat) => {
				setAigcSaving(true);
				setAigcMsg("");
				try {
					const body = clearWhat
						? { ["clear" + clearWhat]: true }
						: { ark: ark.trim(), speech: speech.trim() };
					const j = await (await fetch("/filmflow/aigc", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify(body),
					})).json();
					if (!j.ok) throw new Error(j.error || "保存失败");
					const fresh = await (await fetch("/filmflow/aigc", { headers: { accept: "application/json" } })).json();
					setAigc(fresh);
					setArk(String((fresh.ark && fresh.ark.value) || ""));
					setSpeech(String((fresh.speech && fresh.speech.value) || ""));
					setAigcMsg((clearWhat ? "已清除" : "已保存") + " · 生成时立即生效");
				} catch (e) {
					setAigcMsg(String((e && e.message) || e));
				} finally {
					setAigcSaving(false);
				}
			};

			return h("div", { className: "ff-docs ff-settings" },
				h("div", { className: "ff-docs-bar" },
					h("span", { className: "ff-docs-hd" }, "API 设置"),
					h("span", { style: { flex: 1 } }),
					h("div", { className: "ff-btn", onClick: () => setScreen(ENTERED ? "work" : "menu") }, ENTERED ? "回画布" : "返回片库")),
				h("div", { className: "ff-set-body" },
					h("div", { className: "ff-set-hd" }, "Agent 设置（DeepSeek）"),
					field("API Key", key, setKey, "sk-…"),
					field("Base URL", baseURL, setBaseURL, "https://api.deepseek.com/anthropic"),
					field("模型名", model, setModel, "deepseek-flash"),
					h("div", { className: "ff-set-actions" },
						h("button", { className: "ff-btn p", disabled: saving, onClick: () => save(false) }, saving ? "保存中…" : "保存"),
						h("button", { className: "ff-btn", disabled: saving, onClick: () => save(true) }, "清除 Key")),
					msg ? h("div", { className: "ff-set-msg" }, msg) : null,
					h("div", { className: "ff-set-hint" }, "改完重启片场生效"),

					h("div", { className: "ff-set-hr" }),
					h("div", { className: "ff-set-hd" }, "AIGC 设置（火山引擎）"),
					h("div", { className: "ff-set-sub" },
						"视频 / 图片走方舟（Seedance / Seedream），音频走豆包语音。只接火山，不配别的厂商。"),
					field("方舟 API Key", ark, setArk, "ark-…"),
					field("豆包语音 API Key（可选）", speech, setSpeech, "音频生成用；没有就留空"),
					h("div", { className: "ff-set-actions" },
						h("button", { className: "ff-btn p", disabled: aigcSaving, onClick: () => saveAigc("") }, aigcSaving ? "保存中…" : "保存"),
						h("button", { className: "ff-btn", disabled: aigcSaving, onClick: () => saveAigc("Ark") }, "清除方舟"),
						h("button", { className: "ff-btn", disabled: aigcSaving, onClick: () => saveAigc("Speech") }, "清除语音")),
					aigcMsg ? h("div", { className: "ff-set-msg" }, aigcMsg) : null,
					h("div", { className: "ff-set-hint" },
						"这两把是生成时现读的，保存后不用重启。方舟 key 在火山控制台「方舟 → API Key」；豆包语音 key 在「语音技术」控制台，两把不是同一个。")));
		}
		/** 节点库分类（和宿主 filmflow_templates 的 tag 规则保持一致）。 */
		function libCat(t) {
			const id = String((t && t.id) || "");
			if (t && t.kind === "media") return "媒体";
			if (/-model$/.test(String((t && t.id) || ""))) return "模型";
			if (["facts", "script", "script-series", "storyboard", "audio-prompt", "video-prompt", "video-gen", "blank"].includes(id)) return "流程";
			if (/^(character|identity|personality|appearance|costume)/.test(id)) return "人物";
			if (/^(worldview|cognition|timeline|scene|props|emotion-curve)$/.test(id)) return "世界";
			if (/^(visual|art-style|color|lighting|camera|aspect)$/.test(id)) return "视觉";
			if (/^(scifi-setting|theme-image|factions|power-system|comedy-beat)$/.test(id)) return "类型";
			if (/^(project-brief|drama-outline|episode-outline|foreshadow|arc)$/.test(id)) return "剧集";
			if (/^(brand-brief|selling-points|creative-concept|version-matrix)$/.test(id)) return "广告";
			if (/^(topic-thesis|interviewees|interview-outline|footage|narration)$/.test(id)) return "纪录片";
			if (/^(song-structure|beat-map|visual-motif)$/.test(id)) return "MV";
			if (/^(company-facts|audience|structure-script)$/.test(id)) return "企业";
			if (/^(style|model|audio-style|animation-style)$/.test(id)) return "风格";
			return "其它";
		}

		/** 一个模板的形态标签（节点库卡片上那一排小字）。 */
		function libShape(t) {
			if (t && t.kind === "media") return "媒体 · " + String(t.mediaType || "image");
			if (t && t.files) return "一文件一节点";
			const k = t && t.shape && t.shape.kind;
			if (k === "list") return "列表";
			if (k === "table") return "表格";
			if (k === "matrix") return "矩阵";
			if (k === "select") return "选择器";
			return "文本";
		}

		/**
		 * 节点库页面（用户 2026-10-28：「新设计一个节点库页面，里面放所有种类的节点，
		 * 并标注好节点的功能/使用方法」）。
		 *
		 * 数据来自 `/filmflow/templates?full=1`：59 个模板 + 每个模板的
		 * doctrine（怎么用）与出现在哪些预设里（在哪能用）。
		 * @returns 节点库浮层，或 null。
		 */
		function NodeLibraryOverlay() {
			const screen = useScreen();
			const [data, setData] = react.useState(null);
			const [err, setErr] = react.useState("");
			const [q, setQ] = react.useState("");
			const [cat, setCat] = react.useState("全部");
			const [open, setOpen] = react.useState({});
			/*
			 * ⚠️ `tick` 必须**先声明**再进 useEffect 的依赖数组（2026-10-30 实测踩到）：
			 *   原来 `[screen, tick]` 写在 `const [tick,setTick]` 之前 ⇒ 每次渲染都抛
			 *   ReferenceError: Cannot access 'tick' before initialization ⇒ slot entry 崩溃
			 *   ⇒ 节点库整页不显示，用户看到的是底下那个 agent 会话框。
			 */
			const [tick, setTick] = react.useState(0);

			react.useEffect(() => {
				if (screen !== "library") return undefined;
				let alive = true;
				let timer = null;
				let tries = 0;
				/*
				 * ★ 失败要重试（2026-10-29 实测踩到）：片场窗口比服务先起来时，
				 * 这一次 fetch 会失败，页面就永远停在「0 个节点模板」——用户看到的
				 * 是"节点库是空的"，而且没有任何重试入口。
				 * 现在：自动重试 8 次（间隔 2.5s），仍失败才显示错误 + 重试按钮。
				 */
				const load = () => {
					tries += 1;
					fetch("/filmflow/templates?full=1", { headers: { accept: "application/json" } })
						.then((x) => { if (!x.ok) throw new Error("HTTP " + x.status); return x.json(); })
						.then((j) => {
							if (!alive) return;
							if (!j || !Array.isArray(j.templates) || !j.templates.length) throw new Error("返回空数据");
							setData(j);
							setErr("");
						})
						.catch((e) => {
							if (!alive) return;
							if (tries < 8) { timer = setTimeout(load, 2500); return; }
							setErr(String((e && e.message) || e) + "（已重试 " + tries + " 次）");
						});
				};
				load();
				return () => { alive = false; if (timer) clearTimeout(timer); };
			}, [screen, tick]);
			/* 手动重试：把错误清掉重新来一轮 */
			const retry = () => { setErr(""); setData(null); setTick((n) => n + 1); };

			if (screen !== "library") return null;
			syncRailWidth();

			const tpls = (data && data.templates) || [];
			const packs = (data && data.packs) || [];
			const ql = q.trim().toLowerCase();
			const hit = (t) => !ql || [t.title, t.id, t.note, t.doctrine].some((s) => String(s || "").toLowerCase().indexOf(ql) >= 0);
			const cats = ["全部", "流程", "人物", "世界", "视觉", "类型", "剧集", "广告", "纪录片", "MV", "企业", "风格", "模型", "媒体", "其它"];
			const shown = tpls.filter((t) => (cat === "全部" || libCat(t) === cat) && hit(t));

			const groups = [];
			for (const c of cats.slice(1)) {
				const items = shown.filter((t) => libCat(t) === c);
				if (items.length) groups.push([c, items]);
			}

			const card = (t) => h("div", { key: t.id, className: "ff-lib-card" },
				h("div", { className: "ff-lib-t" }, String(t.title || t.id), h("span", { className: "ff-lib-id" }, t.id)),
				h("div", { className: "ff-lib-tags" },
					h("span", { className: "ff-lib-tag" }, libShape(t)),
					t.feed === "down" ? h("span", { className: "ff-lib-tag" }, "被父节点读") : null),
				String(t.note || "") ? h("div", { className: "ff-lib-note" }, String(t.note)) : null,
				Array.isArray(t.packs) && t.packs.length
					? h("div", { className: "ff-lib-packs" }, "用于：" + t.packs.map((p) => p.title).join("、"))
					: null,
				h("div", {
					className: "ff-lib-more",
					onClick: () => setOpen((o) => ({ ...o, [t.id]: !o[t.id] })),
				}, open[t.id] ? "收起怎么用 ▴" : "怎么用 ▾"),
				open[t.id]
					? h("div", { className: "ff-lib-doc" }, String(t.doctrine || "（这个模板没有写指令）"))
					: null);

			const groupEl = (c, items) => h("div", { key: c },
				h("div", { className: "ff-lib-h" }, c + "（" + items.length + "）"),
				h("div", { className: "ff-lib-grid" }, items.map(card)));

			return h("div", { className: "ff-lib" },
				h("div", { className: "ff-lib-bar" },
					h("span", { className: "ff-docs-hd" }, "节点库"),
					h("span", { className: "ff-docs-meta" }, tpls.length + " 个节点模板 · " + packs.length + " 套预设"),
					h("input", {
						className: "ff-lib-search",
						placeholder: "搜标题 / 功能 / 用法…",
						value: q,
						onChange: (e) => setQ(e.target.value),
					}),
					h("span", { style: { flex: 1 } }),
					h("div", { className: "ff-btn", onClick: () => setScreen(ENTERED ? "work" : "menu") }, ENTERED ? "回画布" : "返回片库")),
				h("div", { className: "ff-lib-body" },
					h("div", { className: "ff-lib-cats" }, cats.map((c) => h("button", {
						key: c,
						className: "ff-btn" + (cat === c ? " p" : ""),
						onClick: () => setCat(c),
					}, c + (c === "全部" ? "（" + tpls.length + "）" : "")))),
					packs.length ? h("div", { className: "ff-lib-packs" },
						"预设：" + packs.map((p) => p.title + "（" + p.count + "）").join("　")) : null,
					err ? h("div", { className: "ff-lib-note" }, err,
						h("button", { className: "ff-btn", style: { marginLeft: 8 }, onClick: retry }, "重试")) : null,
					groups.map(([c, items]) => groupEl(c, items))));
		}
		function CanvasOverlay() {
			const screen = useScreen();
			const ref = react.useRef(null);

			// 只在工作屏幕里挂画布；换屏幕就卸载（定时器跟着清）
			react.useEffect(() => {
				if (screen !== "work") return undefined;
				return mountCanvas(ref.current, {
					root: ENTERED,
					onBack: () => setScreen("menu"),
				});
			}, [screen]);

			/*
			 * 把官方中心列压成**靠左**的一条（会话在左、画布在右 —— 用户 2026-10-21 定的）。
			 *
			 * 只加 width / maxWidth / marginLeft 三个 inline 样式，
			 * 框架自己管的 grid-template-columns 不碰；离开这一屏原样还原。
			 */
			react.useEffect(() => {
				if (screen !== "work") return undefined;
				const rb = document.querySelector("[data-rightbar-col]");
				const center = rb && rb.previousElementSibling;
				if (!center) return undefined;
				const before = {
					maxWidth: center.style.maxWidth,
					marginLeft: center.style.marginLeft,
					width: center.style.width,
					marginRight: center.style.marginRight,
				};
				center.style.maxWidth = "430px";
				center.style.width = "430px";
				center.style.marginLeft = "0";
				center.style.marginRight = "auto";

				/*
				 * ★ 位置和宽度**量出来**，不要假设等于 430。
				 *   实测：只给 maxWidth 时它爹是 flex 容器、子项按内容收缩，
				 *   实际只有 314px —— 输入框被挤成两行，还会和画布之间空一条白缝。
				 * ⇒ 量真实右边缘，写到 `--ff-chat-right`（画布从这里开始）。
				 */
				const measure = () => {
					const box = center.getBoundingClientRect();
					const right = Math.round(box.right);
					document.documentElement.style.setProperty("--ff-chat-right", right + "px");
				};
				measure();
				const raf = requestAnimationFrame(measure);
				window.addEventListener("resize", measure);

				return () => {
					cancelAnimationFrame(raf);
					window.removeEventListener("resize", measure);
					document.documentElement.style.removeProperty("--ff-chat-right");
					center.style.maxWidth = before.maxWidth;
					center.style.marginLeft = before.marginLeft;
					center.style.width = before.width;
					center.style.marginRight = before.marginRight;
				};
			}, [screen]);

			if (screen !== "work") return null;
			return h("div", { className: "ff-layer ff-layer-work" },
				h("div", { className: "ff-pane-canvas", ref }));
		}

		// ── 图标 ──────────────────────────────────────────────────────────
		/** 一棵工序树（16×16）。 */
		function TreeIcon() {
			return h("svg", {
				width: 16, height: 16, viewBox: "0 0 16 16", fill: "none",
				stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round", strokeLinejoin: "round",
			},
				h("rect", { x: 1.5, y: 2.5, width: 4.5, height: 3.5, rx: 1 }),
				h("rect", { x: 9.5, y: 1.5, width: 5, height: 3, rx: 1 }),
				h("rect", { x: 9.5, y: 7, width: 5, height: 3, rx: 1 }),
				h("path", { d: "M6 4.25h1.5v5.5h2" }),
				h("path", { d: "M7.5 3h2" }));
		}

		/** 齿轮（设置）。 */
		function GearIcon() {
			return h("svg", {
				width: 16, height: 16, viewBox: "0 0 16 16", fill: "none",
				stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round", strokeLinejoin: "round",
			},
				h("circle", { cx: 8, cy: 8, r: 2.2 }),
				h("path", { d: "M8 1.6v1.8M8 12.6v1.8M1.6 8h1.8M12.6 8h1.8M3.5 3.5l1.3 1.3M11.2 11.2l1.3 1.3M12.5 3.5l-1.3 1.3M4.8 11.2l-1.3 1.3" }));
		}

		/** 一把钥匙（API 设置）。 */
		function KeyIcon() {
			return h("svg", {
				width: 16, height: 16, viewBox: "0 0 16 16", fill: "none",
				stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round", strokeLinejoin: "round",
			},
				h("circle", { cx: 4.9, cy: 11.1, r: 2.4 }),
				h("path", { d: "M6.6 9.4L13 3" }),
				h("path", { d: "M10.9 3h2.5v2.5" }));
		}

		/** 一个相框（素材库）。 */
		function GalleryIcon() {
			return h("svg", {
				width: 16, height: 16, viewBox: "0 0 16 16", fill: "none",
				stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round", strokeLinejoin: "round",
			},
				h("rect", { x: 1.8, y: 3.2, width: 12.4, height: 9.6, rx: 1.4 }),
				h("circle", { cx: 5.2, cy: 6.4, r: 1 }),
				h("path", { d: "M2.2 11.6l3.4-3.1 2.4 2.2 2.2-2.4 3.6 3.6" }));
		}

		/** 四宫格（节点库）。 */
		function GridIcon() {
			return h("svg", {
				width: 16, height: 16, viewBox: "0 0 16 16", fill: "none",
				stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round", strokeLinejoin: "round",
			},
				h("rect", { x: 2, y: 2, width: 5, height: 5, rx: 1.2 }),
				h("rect", { x: 9, y: 2, width: 5, height: 5, rx: 1.2 }),
				h("rect", { x: 2, y: 9, width: 5, height: 5, rx: 1.2 }),
				h("rect", { x: 9, y: 9, width: 5, height: 5, rx: 1.2 }));
		}

		/**
		 * 空态 hero 的品牌位（`conversation.hero.brand.mark`）。
		 * 用户 2026-10-28 要求去掉官方鲸鱼/「探索未至之境」，这里换片场字标。
		 */
		function HeroMark(props) {
			const size = Number((props && props.size) || 34);
			return h("span", {
				className: "ff-hero-mark",
				style: { fontSize: Math.max(15, Math.round(size * 0.52)) },
			}, "片厂");
		}
		/** 一排书（片库）。 */
		function BooksIcon() {
			return h("svg", {
				width: 16, height: 16, viewBox: "0 0 16 16", fill: "none",
				stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round", strokeLinejoin: "round",
			},
				h("rect", { x: 1.8, y: 2.2, width: 3.4, height: 11.6, rx: 1 }),
				h("rect", { x: 6.3, y: 2.2, width: 3.4, height: 11.6, rx: 1 }),
				h("path", { d: "M10.8 4.1l2.9-.8 1.6 10.3-2.9.6z" }));
		}

		// ══════════════════════════════════════════════════════════════
		// 插件体
		// ══════════════════════════════════════════════════════════════

		/** 布局服务的句柄 —— 面板里的按钮要用它切主面板。 */
		let ACTIVE_LAYOUT = null;
		/** 浏览器侧 ctx（要拿 `uiWorkspace` / `remote` 来切会话）。 */
		let ACTIVE_CTX = null;

		/**
		 * 需要的浏览器侧服务：
		 *   slots / layout —— 槽位与主面板
		 *   uiWorkspace    —— 打开某部片的会话（openSession / connectWorkspace）
		 *   remote.workspace —— `remote.workspace.create`（把片子目录登记成工作区）
		 *
		 * ⚠️ `remote.workspace` 必须**连命名空间一起**写进 inject。
		 *    只写 `remote` 会报 `cannot get property "remote.workspace" without inject`
		 *    （cordis 按 namespace 粒度声明依赖；ui-plugin-manager 也是这么写的）。
		 */
		const inject = ["slots", "layout", "uiWorkspace", "sessions", "remote", "remote.workspace"];

		/**
		 * 插件入口：控制条 + 两块浮层 + 提案卡。
		 * @param ctx - 浏览器侧 cordis 上下文。
		 */
		function apply(ctx) {
			ACTIVE_LAYOUT = ctx.layout;
			ACTIVE_CTX = ctx;

			// 记住上次进的是哪部片（刷新之后控制条上的「工序」仍然可点）
			try { ENTERED = localStorage.getItem("filmflow.entered") || ""; } catch { /* 忽略 */ }

			ctx.effect(() => {
				const style = document.createElement("style");
				style.textContent = CSS;
				document.head.append(style);
				return () => style.remove();
			}, "filmflow: canvas styles");

			ctx.effect(() => startHeartbeat(), "filmflow: page heartbeat");

			/*
			 * 第一个页面是**项目菜单**（用户定的）。
			 *
			 * 这里不再用 `ctx.layout.selectPanel` —— `main` 中心列整个留给官方对话，
			 * 屏幕切换由我自己的 SCREEN 状态管（见 SCREEN 那段注释）。
			 * 只把中心列**还原**成官方对话（万一上次停在别的 key 上）。
			 */
			ctx.effect(() => {
				const tries = [0, 250, 1000].map((ms) => setTimeout(() => {
					try { ctx.layout.selectPanel(null); } catch { /* 还没注册好 */ }
				}, ms));
				return () => tries.forEach(clearTimeout);
			}, "filmflow: main 中心列 = 官方对话");

			// 左边那条 56px 控制条（不是侧边栏：没有新会话、没有会话列表）
			//
			// 自己声明 `sidebar.settings` 这个座位：官方设置按钮（ui-settings-general）
			// 会注册进它，于是**设置入口照旧在**，不用我重写一个 ⚙。
			// 不声明 `sidebar.workspaces` ⇒ 会话/工作区列表不会出现（正合用户要求）。
			ctx.slots.inject("sidebar", () => ctx.slots.register({
				name: "sidebar",
				locale: NS,
				children: {
					"sidebar.settings": { kind: "single", scope: "root" },
				},
				inject: () => ({ layout: ACTIVE_LAYOUT }),
			}, Rail));

			/*
			 * 两块浮层，都挂 `shell.overlay`（AppFrame 直接声明的 list 槽，允许并存）。
			 *
			 * 为什么不挂 `main`：那是官方对话的座位，实测对话搬不走（见 SCREEN 注释）。
			 * 为什么不挂 `rightbar`：独占，且官方占用者 ui-sidebar-right 提供必需服务。
			 * order 决定叠放顺序：菜单(10) 盖在画布(5) 之上。
			 */
			ctx.slots.inject("shell.overlay", () => ctx.slots.register({
				name: "shell.overlay",
				id: "filmflow.work",
				order: 5,
				locale: NS,
			}, CanvasOverlay));

			ctx.slots.inject("shell.overlay", () => ctx.slots.register({
				name: "shell.overlay",
				id: "filmflow.menu",
				order: 10,
				locale: NS,
			}, MenuOverlay));
			// 待确认提案面板：钉在会话框这一侧（order 8，压在画布之上、菜单之下）。
			ctx.slots.inject("shell.overlay", () => ctx.slots.register({
				name: "shell.overlay",
				id: "filmflow.dock",
				order: 8,
				locale: NS,
			}, ProposalsDock));

			// 设置：填 API Key（桌面版"开箱即用"的入口）
			ctx.slots.inject("shell.overlay", () => ctx.slots.register({
				name: "shell.overlay",
				id: "filmflow.settings",
				order: 24,
				locale: NS,
			}, SettingsOverlay));

			// 素材库（一级菜单）：所有生成内容都在这里
			ctx.slots.inject("shell.overlay", () => ctx.slots.register({
				name: "shell.overlay",
				id: "filmflow.assets",
				order: 22,
				locale: NS,
			}, AssetsOverlay));

			// 媒体查看器：最上层
			ctx.slots.inject("shell.overlay", () => ctx.slots.register({
				name: "shell.overlay",
				id: "filmflow.viewer",
				order: 30,
				locale: NS,
			}, MediaViewer));

			// 节点库（一级菜单）：所有模板 + 功能/用法
			ctx.slots.inject("shell.overlay", () => ctx.slots.register({
				name: "shell.overlay",
				id: "filmflow.library",
				order: 23,
				locale: NS,
			}, NodeLibraryOverlay));

			// 空态 hero 的品牌位：换成片场字标（去掉官方鲸鱼）
			try {
				ctx.slots.inject("conversation.hero.brand.mark", () => ctx.slots.register({
					name: "conversation.hero.brand.mark",
					locale: NS,
				}, HeroMark));
			} catch (e) { /* 槽位不在就退回官方占位，不影响其它功能 */ }

			// 提案卡：长在 agent 调 filmflow_propose 的那张工具卡上（官方工具树里）。
			ctx.slots.inject("tool.call.toolview", () => ctx.slots.register({
				name: "tool.call.toolview",
				key: "filmflow_propose",
				locale: NS,
			}, ProposeToolRow));
		}

		exports.PANEL_ID = PANEL_ID;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
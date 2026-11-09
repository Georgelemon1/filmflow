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
//   4. `shell.overlay`/`filmflow.dock` = 待确认提案面板（钉在会话框一侧；
//      内联 `tool.call.toolview` 卡已停用 —— 它被折叠进「已调用的工具」步骤里，用户找不到）
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
/* 顶栏下的消息条：出错时一直留着，直到人点 ×（2026-11-02） */
.ff-errbar{flex:none;display:none;align-items:flex-start;gap:10px;margin:8px 16px 0;
  padding:9px 12px;border-radius:8px;font-size:13px;line-height:1.65;
  border:1px solid var(--dsw-alias-state-error-primary);
  background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 11%, transparent)}
.ff-errbar.on{display:flex}
.ff-errbar.ok{border-color:var(--dsw-alias-state-success-primary);
  background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 11%, transparent)}
.ff-errbar-tx{flex:1 1 auto;min-width:0;white-space:pre-wrap;overflow-wrap:anywhere}
.ff-errbar-x{flex:none;cursor:pointer;font-size:16px;line-height:1.1;padding:0 4px;user-select:none;
  color:var(--dsw-alias-label-secondary)}
.ff-errbar-x:hover{color:var(--dsw-alias-label-primary)}
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
/* 刷新按钮的即时反馈（2026-11-04）：请求中变淡、成功闪绿、失败闪红 */
.ff-btn.busy{opacity:.55;pointer-events:none}
.ff-btn.ok{color:var(--dsw-alias-state-success-primary,#3fb950);border-color:currentColor}
.ff-btn.bad{color:var(--dsw-alias-state-danger-primary,#f85149);border-color:currentColor}
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
/* 连接线（D39）：图片节点 → 生成单元的行。常显、虚线、不进表格、不参与布局 */
.ff-links{position:absolute;left:0;top:0;pointer-events:none;z-index:0;overflow:visible}
.ff-link-line{fill:none;stroke:#fff;stroke-width:0.7;stroke-opacity:.7;
  stroke-linecap:round;vector-effect:non-scaling-stroke}
.ff-link-dot{fill:#fff;fill-opacity:.9}
/* 图片节点兼容器（D39）：节点里的参考图 */
/* 我们自己的引用胶囊：官方那个文件图标藏起来，位置让给缩略图 */
[data-composer-chip="ffimg"] svg{opacity:0}
[data-composer-chip="ffimg"] span{color:transparent}
.ff-at-inline{position:fixed;z-index:128;width:16px;height:16px;object-fit:cover;border-radius:3px;pointer-events:none;box-shadow:0 0 0 1px rgba(255,255,255,.25)}
.ff-at-th{width:28px;height:28px;object-fit:cover;border-radius:4px;flex:0 0 auto;background:#000}
.ff-at-entry{padding:7px 10px;cursor:pointer;font-size:12px;border-bottom:1px solid var(--dsw-alias-border-l2)}
.ff-at-entry:hover{background:var(--dsw-alias-bg-layer-3)}
.ff-at-plus{position:fixed;z-index:129;display:flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:50%;cursor:pointer;font-size:14px;line-height:1;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.ff-at-plus:hover{border-color:var(--dsw-alias-brand-primary)}
.ff-at-chip{display:inline-flex;align-items:center;gap:4px;height:20px;padding:0 5px 0 2px;margin:0 2px;border-radius:5px;background:rgba(255,255,255,.1);border:1px solid var(--dsw-alias-border-l2);vertical-align:middle;font-size:11px}
.ff-at-chip .ff-at-at{color:var(--dsw-alias-label-secondary);margin-right:1px}
.ff-at-chip img{width:16px;height:16px;object-fit:cover;border-radius:3px;display:block}
.ff-at-chip .ff-at-ic{width:16px;text-align:center}
.ff-at-chip .ff-at-chip-p{max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary);font-size:10px;margin-left:2px}
.ff-at-chip .ff-at-chip-t{color:var(--dsw-alias-label-primary)}
.ff-at-picker{position:fixed;z-index:130;display:none;max-height:300px;overflow:auto;padding:4px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;box-shadow:0 10px 28px rgba(0,0,0,.35);font-size:11.5px}
.ff-at-hd{font-size:10.5px;color:var(--dsw-alias-label-tertiary);padding:2px 6px 4px}
.ff-at-it{display:flex;align-items:center;gap:6px;padding:4px 6px;border-radius:6px;cursor:pointer}
.ff-at-it.on,.ff-at-it:hover{background:var(--dsw-alias-bg-layer-3)}
.ff-at-tag{flex:0 0 auto;font-size:10px;padding:0 4px;border-radius:4px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}
.ff-at-nm{flex:0 0 auto;font-weight:600}
.ff-at-pa{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary)}
/* 画风主体（look-one）：没有标题行，整段文字按正常字号显示（用户 2026-11-06） */
.ff-node.look{padding:10px 14px}
.ff-node.look .ff-node-bd{font-size:13.5px;line-height:1.65;white-space:pre-wrap;max-height:none;overflow:visible}
/* 图片节点：自动建的「XXX 参考图」不再显示标题，只留一个很淡的编号 */
.ff-node.media.notitle .ff-node-hd{padding:2px 8px 0;min-height:0;border-bottom:0}
.ff-node.media.notitle .ff-node-hd .ff-node-no{opacity:.45;font-size:10px}
/* 图片节点兼容器（D39）：参考图就显示在预览框里，按钮叠在框内底部 */
.ff-media-thumb.hasref{border:1px dashed var(--dsw-alias-border-l1)}
.ff-media-ref-tag{position:absolute;left:4px;top:4px;font-size:10px;padding:0 5px;border-radius:4px;
  background:rgba(0,0,0,.55);color:#fff;pointer-events:none}
.ff-media-refops{position:absolute;right:4px;bottom:4px;display:flex;gap:4px;z-index:2}
.ff-media-refops .ff-media-addimg{font-size:10px;padding:1px 6px;background:rgba(0,0,0,.55);color:#fff;
  border:1px solid rgba(255,255,255,.25);border-radius:5px}
.ff-media-imgs-hd{font-size:11px;color:var(--dsw-alias-label-secondary)}
.ff-media-imgs-strip{display:flex;flex-wrap:wrap;gap:6px}
.ff-media-img-cell{position:relative;width:54px;height:54px;border-radius:6px;overflow:hidden;
  border:1px solid var(--dsw-alias-border-l2)}
.ff-media-img-cell img{width:100%;height:100%;object-fit:cover;display:block;cursor:zoom-in}
.ff-media-img-del{position:absolute;right:1px;top:1px;width:14px;height:14px;line-height:13px;text-align:center;
  font-size:10px;border-radius:50%;background:rgba(0,0,0,.6);color:#fff;cursor:pointer}
.ff-media-addimg{font-size:11px;padding:2px 8px;border-radius:6px;cursor:pointer;
  border:1px dashed var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary)}
.ff-media-addimg:hover{border-color:var(--dsw-alias-brand-primary)}
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
/* 参考资料节点的只读文件清单（2026-11-02）：给 agent 看的，画布上没有任何按钮 */
.ff-refs{margin-top:6px;padding:6px 8px;border-radius:7px;border:1px dashed var(--dsw-alias-border-l2);
  font-size:11.5px;line-height:1.6;color:var(--dsw-alias-label-secondary);white-space:pre-wrap}
.ff-refs-hd{font-weight:600;color:var(--dsw-alias-label-primary);margin-bottom:2px}
.ff-refs-it{word-break:break-all;display:flex;align-items:flex-start;gap:8px;justify-content:space-between}
.ff-refs-name{flex:1 1 auto;min-width:0;word-break:break-all}
.ff-refs-del{flex:none;cursor:pointer;opacity:.55;padding:0 2px}
.ff-refs-del:hover{opacity:1;color:var(--dsw-alias-state-error-primary)}
/* 标题空着的人名节点：画一个住手就想去填的空白框（2026-11-02） */
/* 空白人名框：要有高度，鼠标才好点（2026-11-03 用户：单击写不了） */
.ff-node.untitled .ff-node-t{display:inline-block;min-width:88px;min-height:20px;padding:2px 6px;
  border:1px dashed var(--dsw-alias-border-l2);border-radius:4px;vertical-align:middle}
.ff-node.untitled .ff-node-t:hover{border-color:var(--dsw-alias-brand-primary)}
/* 「选择文件」—— 参考资料唯一的交互入口（2026-11-02） */
.ff-refs-pick{margin-top:6px;padding:4px 8px;border-radius:6px;cursor:pointer;font-size:11.5px;
  border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);display:inline-block}
.ff-refs-pick:hover{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
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
/* 表格节点（分镜脚本，2026-11-02）：**横向不限宽**，让表格自己撑开 */
.ff-node.tbl{max-width:none;width:max-content}
.ff-node.tbl .ff-node-bd{width:max-content;max-width:none;overflow-x:visible;white-space:normal}
/* 表格节点永远全览：紧凑档的 140px 限高对它不生效，也不给折叠 */
/* 表格节点：默认折叠成 10 行，可滚；点一下全展开（2026-11-03 用户） */
.ff-node.tbl .ff-node-bd{overflow-y:auto;overflow-x:visible;scrollbar-width:thin}
/* 高度与滚动由 JS 按折叠状态设置（见 renderTableInto），这里不写死 */
.ff-tbl-wrap{max-width:none;overflow-x:visible}
.ff-tbl{border-collapse:collapse;font-size:11.5px;line-height:1.5;white-space:nowrap}
.ff-tbl th,.ff-tbl td{border:1px solid var(--dsw-alias-border-l1);padding:3px 8px;text-align:left;vertical-align:top}
.ff-tbl th{background:var(--dsw-alias-bg-layer-2);font-weight:600}
.ff-tbl td{white-space:pre-wrap;min-width:56px}
.ff-tbl-grp td{background:var(--dsw-alias-bg-layer-2);font-weight:600}
.ff-node{position:relative}
/*
 * 工具按钮：贴着节点右边缘（margin 0），中间那点空隙用 **padding** 给 ——
 * padding 属于按钮容器，鼠标从节点滑向按钮的途中一直在 hover 区里，
 * 不会「一离开节点按钮就消失，离得远还点不着」（用户 2026-11-03）。
 */
.ff-node-ops{position:absolute;left:100%;margin-left:0;padding-left:8px;top:0;
  display:none;gap:2px;align-items:center;z-index:3}
/* 表格节点太宽：钉在标题行右端，并给标题留出按钮的位置 */
.ff-node.tbl .ff-node-ops{left:auto;right:0;margin-left:0;top:0}
.ff-node.tbl .ff-node-hd{padding-right:108px}
/*
 * 图片节点（2026-11-05 用户报「有图的图片节点鼠标放上去没有工具卡片、删不掉」）：
 * 它 overflow:hidden（为了让图片贴齐圆角），而通用规则把按钮放在节点外面
 * → 被裁掉、点不到。这里把按钮放回节点内部右上角，并盖在图片上面。
 */
.ff-node.media .ff-node-ops{left:auto;right:6px;top:6px;margin-left:0;padding:2px 4px;
  border-radius:6px;background:rgba(0,0,0,.55);z-index:4}
.ff-node.media .ff-node-hd{padding-right:92px}
.ff-node:hover .ff-node-ops,.ff-node.ops-on .ff-node-ops{display:flex}
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
.ff-media-prompt-edit{width:auto;max-width:280px;margin:6px 8px 0;box-sizing:border-box;font:inherit;font-size:11.5px;line-height:1.5;
  color:var(--dsw-alias-label-secondary);background:transparent;
  border:0;border-bottom:1px solid var(--dsw-alias-border-l2);border-radius:0;padding:2px 0;resize:vertical;min-height:40px}
.ff-media-prompt-edit:focus{outline:none;border-bottom-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary)}
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
/*
 * 极简（用户 2026-11-05 第 3 条：「整个节点你可以全部重新做，极简，不要多余的大框小框」）：
 * 图片节点 = 图 + 一行提示词 + 两个下拉，外面不留框、里面不留框。
 */
.ff-node.media{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);padding:0;border-radius:10px;overflow:hidden;box-shadow:none}
.ff-node.media .ff-node-hd{border:0;background:transparent;padding:6px 8px 0}
/* 缩略框：宽固定，高由 padding-top（比例）决定；图片绝对定位铺满 */
.ff-media-thumb{position:relative;width:100%;max-width:none;height:auto;border-radius:0;overflow:hidden;
  background:transparent;border:0}
.ff-media-thumb img{position:static;display:block;width:100%;height:auto;object-fit:cover}
.ff-media-thumb video{position:absolute;inset:0;display:block;width:100%;height:100%;object-fit:contain;background:var(--dsw-alias-bg-base)}
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
/* 采用态（2026-11-05）：一个生成单元只有一条被采用，卡片上直接标出来 */
.ff-asset-card.p{border-color:var(--dsw-alias-brand-primary)}
.ff-asset-card .ff-asset-acts{display:flex;gap:6px;margin-top:4px;flex-wrap:wrap}
.ff-asset-card .ff-asset-acts .ff-btn{font-size:10.5px;padding:1px 7px}
.ff-viewer{position:fixed;inset:0;z-index:64;background:rgba(0,0,0,.86);
  display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px}
.ff-viewer img,.ff-viewer video{max-width:86vw;max-height:78vh;border-radius:8px;background:#000}
.ff-viewer .bar{display:flex;gap:8px;align-items:center;color:#ddd;font-size:12px}
/* 分镜表：行内删除 + 加一行（这两格是**虚拟列**，不写进 md） */
.ff-tbl-op{width:26px;min-width:26px;max-width:26px;cursor:pointer;text-align:center;
  color:var(--dsw-alias-label-secondary);opacity:.45;user-select:none}
.ff-tbl-op:hover{opacity:1;color:var(--dsw-alias-state-error-primary)}
/* 行内生成 + 预览两格（虚拟列：只渲染，不写进 md） */
.ff-tbl-gen{width:74px;min-width:74px;max-width:74px;cursor:pointer;text-align:center;
  font-size:11.5px;padding:3px 6px;border-radius:6px;user-select:none;
  border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary)}
.ff-tbl-gen:hover{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.ff-tbl-gen.run{border-style:dashed;color:var(--dsw-alias-brand-primary)}
.ff-tbl-gen.done{color:var(--dsw-alias-label-secondary)}
.ff-tbl-thumb{width:56px;min-width:56px;max-width:56px}
.ff-tbl-thumb-cell{width:56px;text-align:center}
.ff-tbl-gen-cell{text-align:center}
.ff-tbl-thumb-img{width:40px;height:24px;object-fit:cover;border-radius:4px;cursor:pointer;
  border:1px solid var(--dsw-alias-border-l2);display:inline-block;vertical-align:middle}
.ff-tbl-thumb-tag{width:28px;height:22px;line-height:20px;margin:0 auto;border-radius:4px;cursor:pointer;
  border:1px solid var(--dsw-alias-border-l2);font-size:11px;color:var(--dsw-alias-label-secondary)}
.ff-tbl-thumb-tag:hover{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
td.ff-tbl-span{vertical-align:middle}
/* 生成/预览不是一个"列"：行尾两个窄格的小图标，跟 ✕ 一样是操作，不是数据 */
.ff-tbl-gen-cell{width:34px;min-width:34px;max-width:34px;padding:2px}
.ff-tbl-thumb-cell{width:54px;min-width:54px;max-width:54px;padding:2px}
/* 行尾操作格：▶ 生成 + ✕ 删行（都不占"数据列"，表头只有一个空格） */
/* 参数格：一格显示「清晰度 · 模型 · 比例」，点开是三个下拉 */
.ff-tbl-params{width:104px;min-width:104px;max-width:104px;padding:2px 4px;vertical-align:middle}
.ff-params{position:relative}
.ff-params-sum{font-size:11px;line-height:20px;padding:0 4px;border-radius:5px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}
.ff-params-sum:hover{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary)}
.ff-params-pop{position:absolute;right:0;top:calc(100% + 4px);z-index:80;display:flex;flex-direction:column;gap:8px;padding:9px 10px;width:430px;border-radius:10px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);box-shadow:0 10px 28px rgba(0,0,0,.38)}
/* 生成参数四列（清晰度 / 模型 / 比例 / 提示词）+ ▶ + 预览 */
.ff-tbl-p1{width:74px;min-width:74px;max-width:74px}
/* 参考素材（虚拟列，竖跨整组） */
.ff-tbl-prefs{width:150px;min-width:150px;max-width:150px;white-space:normal}
.ff-refs{display:flex;flex-wrap:wrap;gap:3px;align-items:center}
.ff-ref-chip{display:flex;align-items:center;gap:3px;font-size:10.5px;line-height:16px;padding:1px 4px;border-radius:5px;border:1px solid var(--dsw-alias-border-l2);cursor:pointer;max-width:100%}
.ff-ref-chip:hover{border-color:var(--dsw-alias-brand-primary)}
.ff-ref-chip img{width:16px;height:16px;object-fit:cover;border-radius:3px;flex:0 0 auto}
/* 手加素材（素材1、素材2…）：和 agent 提的元素区分开（虚线 + 前缀名），但同样是"参考图" */
.ff-ref-chip.ff-ref-mat{border-style:dashed}
.ff-ref-chip.ff-ref-mat span{color:var(--dsw-alias-label-secondary)}
.ff-ref-chip span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ff-ref-ghost{font-size:10.5px;line-height:16px;color:var(--dsw-alias-label-tertiary);cursor:pointer;border-bottom:1px dashed var(--dsw-alias-border-l2)}
/* 单元级 opt-out（D39）：这个单元不用它 —— 删除线，点一下恢复 */
.ff-ref-ghost.ff-ref-off{text-decoration:line-through;opacity:.6}
.ff-ref-ghost:hover{color:var(--dsw-alias-label-primary)}
.ff-ref-add{font-size:11px;line-height:16px;padding:0 4px;border-radius:5px;border:1px dashed var(--dsw-alias-border-l2);cursor:pointer;color:var(--dsw-alias-label-secondary)}
.ff-ref-add:hover{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.ff-ref-menu{position:absolute;z-index:90;right:0;top:calc(100% + 3px);min-width:130px;display:flex;flex-direction:column;gap:2px;padding:4px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);box-shadow:0 8px 24px rgba(0,0,0,.28)}
.ff-ref-menu div{font-size:11px;padding:3px 6px;border-radius:5px;cursor:pointer}
.ff-ref-menu div:hover{background:var(--dsw-alias-bg-layer-3)}
.ff-refs-panel{position:fixed;inset:0;z-index:70;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center}
.ff-refs-panel .box{min-width:420px;max-width:70vw;max-height:70vh;overflow:auto;border-radius:10px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);padding:12px;display:flex;flex-direction:column;gap:8px}
.ff-refs-panel .row{display:flex;align-items:center;gap:8px;font-size:11.5px;padding:4px 6px;border-radius:6px;background:var(--dsw-alias-bg-layer-2)}
.ff-refs-panel .row img{width:26px;height:26px;object-fit:cover;border-radius:4px}
.ff-refs-panel .grow{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ff-ref-pick-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:8px}
.ff-ref-pick-item{display:flex;flex-direction:column;gap:4px;padding:4px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);cursor:pointer;background:var(--dsw-alias-bg-layer-2)}
.ff-ref-pick-item:hover{border-color:var(--dsw-alias-brand-primary)}
.ff-ref-pick-item img{width:100%;height:88px;object-fit:cover;border-radius:6px;background:#000}
.ff-ref-pick-item .lab{font-size:10.5px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ff-tbl-p2{width:70px;min-width:70px;max-width:70px}
.ff-tbl-p3{width:66px;min-width:66px;max-width:66px}
.ff-tbl-p4{width:150px;min-width:150px;max-width:150px;position:relative}
.ff-tbl-actsth{width:34px;min-width:34px;max-width:34px}
.ff-tbl-pcell{padding:2px 3px;vertical-align:middle;text-align:center}
.ff-tbl-psel{width:100%;height:22px;font-size:11px;border-radius:5px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);padding:0 2px}
.ff-pcell{position:relative}
.ff-pcell-sum{font-size:11px;line-height:20px;padding:0 5px;border-radius:5px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}
.ff-pcell-sum:hover{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary)}
.ff-pcell-pop{position:absolute;right:0;top:calc(100% + 4px);z-index:80;display:flex;flex-direction:column;gap:6px;padding:9px 10px;width:380px;border-radius:10px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);box-shadow:0 10px 28px rgba(0,0,0,.38);text-align:left}
.ff-pcell-lab{font-size:10.5px;color:var(--dsw-alias-label-tertiary)}
.ff-pcell-ta{width:100%;box-sizing:border-box;resize:vertical;font-size:11.5px;line-height:1.6;border-radius:6px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);padding:6px 7px}
.ff-pcell-bar{display:flex;align-items:center;justify-content:space-between;gap:8px}
.ff-pcell-hint{font-size:10.5px;color:var(--dsw-alias-label-tertiary)}
.ff-params-cols{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px}
.ff-params-col{display:flex;flex-direction:column;gap:3px;min-width:0}
.ff-params-prompt{display:flex;flex-direction:column;gap:5px;border-top:1px solid var(--dsw-alias-border-l2);padding-top:7px}
.ff-params-ta{width:100%;box-sizing:border-box;resize:vertical;font-size:11.5px;line-height:1.6;border-radius:6px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);padding:6px 7px}
.ff-params-bar{display:flex;align-items:center;justify-content:space-between;gap:8px}
.ff-params-hint{font-size:10.5px;color:var(--dsw-alias-label-tertiary)}
.ff-params-lab{font-size:10.5px;color:var(--dsw-alias-label-tertiary)}
.ff-params-sel{font-size:11.5px;height:24px;border-radius:5px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);padding:0 4px}
.ff-tbl-acts{width:64px;min-width:64px;max-width:64px;text-align:center;white-space:nowrap}
.ff-tbl-acts .ff-tbl-go,.ff-tbl-acts .ff-tbl-del{display:inline-block;vertical-align:middle;margin:0 2px}
.ff-tbl-del{cursor:pointer;font-size:11px;color:var(--dsw-alias-label-tertiary);padding:2px 3px;border-radius:4px}
.ff-tbl-del:hover{color:var(--dsw-alias-state-error-primary)}
.ff-tbl-go{width:24px;height:22px;line-height:20px;border-radius:5px;cursor:pointer;text-align:center;font-size:11px;user-select:none;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary)}
td.ff-tbl-span .ff-tbl-gen{margin:0 auto}
.ff-tbl-unitid{font-size:10px;line-height:12px;margin-bottom:2px;color:var(--dsw-alias-brand-primary);font-weight:700;letter-spacing:.4px}
/* 生成单元的"组带"：一行脚本格对一格视频 —— 组首那一条横带管整组 */
  border-top:1px solid var(--dsw-alias-border-l2);border-bottom:1px solid var(--dsw-alias-border-l2);
  font-size:11.5px;font-weight:600;letter-spacing:.2px;color:var(--dsw-alias-label-primary)}
.ff-tbl-no{cursor:pointer}
.ff-tbl-no:hover{color:var(--dsw-alias-brand-primary)}
.ff-tbl-detail td{padding:8px 10px;background:var(--dsw-alias-bg-layer-1)}
.ff-tbl-detail-box{display:flex;flex-direction:column;gap:6px;max-width:760px}
.ff-tbl-detail-lab{font-size:11.5px;color:var(--dsw-alias-label-secondary)}
.ff-tbl-detail-ta{font:12px/1.6 ui-monospace,Consolas,monospace;padding:8px;border-radius:8px;
  border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);
  color:var(--dsw-alias-label-primary);resize:vertical;width:100%;box-sizing:border-box}
.ff-tbl-detail-bar{display:flex;gap:8px}
.ff-tbl-add{margin-top:6px}
.ff-tbl-add .ff-btn{font-size:12px}
.ff-tbl-leftover{margin-top:8px;padding:8px 10px;border-radius:8px;
  border:1px dashed var(--dsw-alias-border-l2);font-size:11.5px;line-height:1.7;
  color:var(--dsw-alias-label-secondary);max-width:520px}
/* 会话历史：找回以前的对话（换过会话时切回去） */
.ff-sess{position:fixed;inset:0;z-index:72;background:rgba(0,0,0,.55);
  display:flex;align-items:center;justify-content:center;padding:24px}
.ff-sess-card{width:min(640px,88vw);max-height:74vh;overflow:auto;
  background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);
  border-radius:12px;padding:16px 18px;display:flex;flex-direction:column;gap:10px}
.ff-sess-hd{display:flex;align-items:center;justify-content:space-between;font-size:13px;font-weight:600}
.ff-sess-note{font-size:11.5px;line-height:1.65;color:var(--dsw-alias-label-secondary)}
.ff-sess-item{border:1px solid var(--dsw-alias-border-l2);border-radius:9px;padding:9px 11px;
  display:flex;align-items:center;gap:12px;justify-content:space-between}
.ff-sess-l{display:flex;flex-direction:column;gap:3px;min-width:0}
.ff-sess-t{font-size:12.5px;font-weight:600}
.ff-sess-id{font:11px/1.5 ui-monospace,Consolas,monospace;color:var(--dsw-alias-label-secondary);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* 待确认提案面板：钉在会话框这一侧（不是画布上，也不塞进对话流的折叠步骤里） */
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
  position:relative;   /* 删除按钮钉右上角 */
  padding-right:56px;   /* 给删除按钮留位，别压住标题 */
  display:flex;flex-direction:column;gap:8px;background:var(--dsw-alias-bg-base);
  transition:border-color .12s,background .12s}
.ff-proj:hover{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-1)}
.ff-proj-del{position:absolute;right:10px;top:10px;font-size:11px;line-height:1;padding:4px 6px;
  border-radius:6px;color:var(--dsw-alias-label-secondary);opacity:.55;cursor:pointer;user-select:none}
.ff-proj:hover .ff-proj-del{opacity:.9}
.ff-proj-del:hover{background:var(--dsw-alias-state-error-primary);color:#fff;opacity:1}
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
			 * 顶栏**不再放**「＋ 工序」（2026-11-02 用户）：
			 *   画布最左边的根节点（片名那个）本来就带 ＋，它才是"最上游"的入口；
			 *   两个入口功能完全一样，多一个只会让人犹豫点哪个。
			 */
			/*
			 * 「会话历史」（2026-11-03 用户：「你改完片厂总是把我和agent的历史会话给弄没有」）。
			 * 会话换了以后，老对话还在磁盘上（`.film/session-history.json` 记着），只是界面没入口。
			 * 这里给一个：列出来、点一下就用 openSession 打开，并把绑定改回那条。
			 */
			const btnSess = el("div", "ff-btn", "会话历史");
			btnSess.title = "找回以前的对话：换过会话就从这里切回去";
			btnSess.addEventListener("click", () => { void openSessions(); });
			/*
			 * 暂停：把 agent 当前这一轮打断（用户 2026-11-03：「暂停运行按钮貌似没用」）。
			 * 只在它**正在跑**的时候显示 —— 平时不占位置，也不误导人去点。
			 */
			const btnPause = el("div", "ff-btn w", "暂停");
			btnPause.title = "打断 agent 正在跑的这一轮（已排队的消息保留）";
			btnPause.className = "ff-btn w off";
			btnPause.addEventListener("click", async () => {
				const p0 = current();
				if (!p0) return;
				btnPause.textContent = "暂停中…";
				try {
					const r = await post("/filmflow/agent", { action: "pause", root: p0.root });
					/*
					 * 按下去那一刻它可能早就跑完了（模型快时 2–3 秒一轮）。
					 * 那种情况 cancel 是 no-op，不能报「已暂停」骗人 —— 直接说清楚。
					 */
					const wasRunning = r && r.ok && /running|busy|working/i.test(String(r.statusAtPress || ""));
					const why = r && r.ok ? (wasRunning ? "已暂停" : "刚才那一轮已经跑完了，没有可中断的")
						: ("没暂停成：" + String((r && r.error) || "未知原因"));
					showNote(why, r && r.ok ? "ok" : undefined);
				} catch (e) {
					showNote("没暂停成：" + String((e && e.message) || e));
				}
				btnPause.textContent = "暂停";
				SIG.tree = "";
				await load();
			});

			btnUndo.addEventListener("click", () => { void structure({ type: "undo" }); });
			btnRedo.addEventListener("click", () => { void structure({ type: "redo" }); });

			bar.append(btnBack, btnSess, chips, sp, meta, btnFit, btnReload, btnPause, btnUndo, btnRedo);
			/** 问宿主 undo/redo 各有几步；空就灰掉。 */
			async function refreshHist() {
				if (!S || !S.current) return;
				try {
					const j = await post("/filmflow/structure", { root: S.current, op: { type: "history" } });
					btnUndo.className = "ff-btn" + (j.undo ? "" : " off");
					btnRedo.className = "ff-btn" + (j.redo ? "" : " off");
				} catch { /* 忽略 */ }
			}

			/** 会话历史：列出这部片用过的会话，点一条就切过去。 */
			let sessEl = null;
			function closeSessions() { if (sessEl) { try { sessEl.remove(); } catch { /* 忽略 */ } sessEl = null; } }
			async function openSessions() {
				const rootNow = String((S && S.current) || wantRoot || "");
				if (!rootNow) { showNote("还没选片子"); return; }
				let cur = "", hist = [], curMeta = null;
				try {
					const r = await fetch("/filmflow/session?root=" + encodeURIComponent(rootNow), { headers: { accept: "application/json" } });
					const j = await r.json();
					if (j && j.ok) { cur = String(j.sessionId || ""); curMeta = j.meta || null; hist = Array.isArray(j.history) ? j.history : []; }
				} catch { /* 读不到就只列空表 */ }
				let wsIds = [];
				try {
					const api = ACTIVE_CTX;
					const w = api && api.remote && api.remote.workspace ? await api.remote.workspace.create({ path: rootNow }) : null;
					const ws2 = w && w.ok ? w.value && w.value.workspace : null;
					wsIds = ((ws2 && ws2.sessionIds) || []).map(String);
				} catch { /* 忽略 */ }
				const seen = new Set();
				const rows = [];
				const push = (id, at, tag, meta) => {
					const k = String(id || "");
					if (!k || seen.has(k)) return;
					seen.add(k);
					rows.push({ id: k, at: String(at || ""), tag, meta: meta || null });
				};
				push(cur, "", "当前绑定", curMeta);
				for (const h of hist) push(h && h.sessionId, h && h.at, "被换掉过：" + String((h && h.reason) || ""), h && h.meta);
				for (const id of wsIds) push(id, "", "工作区里的会话", null);
				/*
				 * 按**最近写入时间**排：会话文件大小/修改时间由宿主 stat 出来（/filmflow/session 的 meta）。
				 * 只按 history 的`at`（= 被换掉的时间）排会误导 —— 用户真正在聊的那条可能早就被换掉、
				 * 但之后一直在写（实测 a8e2e17f：258 条事件、74 次工具调用，写到 14:42）。
				 */
				const tOf = (r) => {
					const v = Date.parse((r.meta && r.meta.mtime) || r.at || "");
					return Number.isFinite(v) ? v : 0;
				};
				rows.sort((a, b) => {
					if (a.id === cur) return -1;
					if (b.id === cur) return 1;
					return tOf(b) - tOf(a);
				});
				if (!rows.length) { showNote("这部片还没有会话记录"); return; }
				closeSessions();
				const box = el("div", "ff-sess");
				box.addEventListener("click", (ev) => { if (ev.target === box) closeSessions(); });
				const card = el("div", "ff-sess-card");
				const hd = el("div", "ff-sess-hd");
				hd.append(el("div", null, "会话历史（" + rows.length + " 条）"));
				const x = el("div", "ff-btn", "关闭");
				x.addEventListener("click", closeSessions);
				hd.append(x);
				card.append(hd);
				card.append(el("div", "ff-sess-note", "点「打开」就用这条会话继续：界面切过去，agent 下次也被叫回这条。老会话里的内容不会丢。"));
				const openIt = async (id) => {
				try { localStorage.setItem("ff.sess." + rootNow, id); } catch { /* 忽略 */ }
					try { await post("/filmflow/session", { root: rootNow, sessionId: id }); }
					catch (e) { showNote("绑定写不进去：" + String((e && e.message) || e)); }
					try {
						if (ACTIVE_CTX && ACTIVE_CTX.uiWorkspace) ACTIVE_CTX.uiWorkspace.openSession(id);
					} catch (e) { showNote("打不开这条会话：" + String((e && e.message) || e)); }
					closeSessions();
					EXPANDED.clear();
					SIG.tree = "";
					await load();
				};
				for (const r of rows) {
				const row = el("div", "ff-sess-item");
				const left = el("div", "ff-sess-l");
				const mt = (r.meta && r.meta.mtime) || r.at || "";
				let when = "";
				if (mt) { try { when = new Date(mt).toLocaleString(); } catch { when = mt; } }
				const kb = r.meta && r.meta.size ? Math.max(1, Math.round(r.meta.size / 1024)) + " KB" : "";
				left.append(el("div", "ff-sess-t", (r.id === cur ? "● " : "") + (when || "（没有时间信息）") + (kb ? "　" + kb : "")));
				left.append(el("div", "ff-sess-id", r.id));
				if (r.tag) left.append(el("div", "ff-sess-note", r.tag));
				const open = el("div", "ff-btn" + (r.id === cur ? " off" : ""), r.id === cur ? "当前" : "打开");
				open.addEventListener("click", () => { void openIt(r.id); });
				row.append(left, open);
					card.append(row);
				}
				box.append(card);
				document.body.append(box);
				sessEl = box;
			}
			window.addEventListener("keydown", (ev) => {
				if (!(ev.ctrlKey || ev.metaKey)) return;
				const tag = String((ev.target && ev.target.tagName) || "").toLowerCase();
				if (tag === "input" || tag === "textarea" || (ev.target && ev.target.isContentEditable)) return;
				const k = String(ev.key || "").toLowerCase();
				if (k === "z" && !ev.shiftKey) { ev.preventDefault(); void structure({ type: "undo" }); }
				else if ((k === "z" && ev.shiftKey) || k === "y") { ev.preventDefault(); void structure({ type: "redo" }); }
			});

			/*
			 * 顶栏下的消息条（用户 2026-11-02：「画布上栏的错误信息显示时间太短了，根本看不清楚」）。
			 *
			 * 原来提示都写进顶栏的 meta，而 meta 由 2 秒一次的轮询重画（drawBar）清空 ——
			 * 一条错误最长亮 2 秒，还是 11.5px 的单行小字。现在单独做成一条：
			 *   出错 → 常驻，直到人点 × 或下一条消息覆盖（慢点看不会没）；
			 *   提示 → 8 秒自动收；网络类的「读不到状态」→ 15 秒自动收，恢复了别一直挂着。
			 */
			const errBar = el("div", "ff-errbar");
			const errTx = el("div", "ff-errbar-tx");
			const errX = el("div", "ff-errbar-x", "×");
			errX.title = "关闭";
			errBar.append(errTx, errX);
			let noteTimer = 0;
			function hideNote() {
				if (noteTimer) { clearTimeout(noteTimer); noteTimer = 0; }
				errBar.className = "ff-errbar";
				errTx.textContent = "";
			}
			/**
			 * 在顶栏下面显示一条消息。
			 * @param text - 说给人看的话
			 * @param tone - "ok"（8 秒收）/ "warn"（15 秒收）/ 省略 = 出错常驻
			 */
			function showNote(text, tone) {
				const msg = String(text == null ? "" : text).trim();
				if (!msg) { hideNote(); return; }
				if (noteTimer) { clearTimeout(noteTimer); noteTimer = 0; }
				errTx.textContent = msg;
				errBar.className = "ff-errbar on" + (tone === "ok" ? " ok" : "");
				if (tone === "ok") noteTimer = setTimeout(hideNote, 8000);
				else if (tone === "warn") noteTimer = setTimeout(hideNote, 15000);
			}
			errX.addEventListener("click", hideNote);
			const stage = el("div", "ff-stage");
			const world = el("div", "ff-world");
			stage.append(world);

			/*
			 * 节点高度会变（正文变长、折叠/展开、字体加载完）—— 导线必须跟着重画，
			 * 否则线停在旧位置。只观察 world 的尺寸变化，帧级 debounce。
			 */
			let linesRaf = 0;
			/*
			 * ★ 用 setTimeout 防抖，不用 requestAnimationFrame（2026-11-03）。
			 *
			 * 窗口被隐藏/遮挡时（Electron 后台窗、最小化、远程桌面断开），Chromium 把 rAF
			 * 整个掐掉（实测：页面 hidden 时 requestAnimationFrame 回调 0 次，setTimeout 照常）。
			 * 而导线重画全靠这条路径 ⇒ 后台画一次就再也不更新，切回来看到的就是旧线。
			 * 16ms 跟一帧等价，还不用挑可见性。
			 */
			const redrawLines = () => {
				if (linesRaf) return;
				linesRaf = setTimeout(() => {
					linesRaf = 0;
					try {
						if (world.querySelector(":scope > .ff-tree")) drawConnectors(world);
					} catch { /* 画失败不该影响别的 */ }
				}, 16);
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
			host.append(bar, errBar, stage, hud);

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

			/*
			 * 平移 / 缩放（鼠标操作画布）。
			 * 2026-11-06 补回：这一段在一次补丁事故里整块丢了，表现为「鼠标点画布没反应、滚轮也不缩放」。
			 */
			let panDrag = null;
			const onDown = (e) => {
				if (e.button !== 1) return;   /* 2026-11-06 用户定：拖拽 = 按住滚轮（中键），左键不拖画布 */
				if (e.target && e.target.closest && e.target.closest("input, textarea, select, button, [contenteditable='true']")) return;
				const editing = document.querySelector(".ff-inline-edit, .ff-inline-rename");
				if (editing) {
					if (!editing.contains(e.target)) { try { editing.blur(); } catch { /* 忽略 */ } }
					else { e.stopPropagation(); }
					panDrag = null;
					return;
				}
				panDrag = { x: e.clientX - VIEW.x, y: e.clientY - VIEW.y };
				try { stage.classList.add("drag"); } catch { /* 忽略 */ }
				e.preventDefault();
			};
			const onMove = (e) => {
				if (!panDrag) return;
				VIEW.x = e.clientX - panDrag.x;
				VIEW.y = e.clientY - panDrag.y;
				applyView();
			};
			const onUp = () => {
				if (!panDrag) return;
				panDrag = null;
				try { stage.classList.remove("drag"); } catch { /* 忽略 */ }
			};
			const onWheel = (e) => {
				if (e.target && e.target.closest && e.target.closest(".ff-card")) return;
				if (e.target && e.target.closest && e.target.closest("input, textarea, select, button, [contenteditable='true']")) return;
				if (document.querySelector(".ff-inline-edit, .ff-inline-rename")) return;
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
			stage.addEventListener("auxclick", (e) => { if (e.button === 1) e.preventDefault(); });
			window.addEventListener("mousedown", (e) => { if (e.button === 1) e.preventDefault(); }, { passive: false });
			stage.addEventListener("mousedown", onDown);
			stage.addEventListener("wheel", onWheel, { passive: false });
			window.addEventListener("mousemove", onMove);
			window.addEventListener("mouseup", onUp);


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
			/** Uint8Array → base64（分块，别一次性 apply 大数组）。 */
			function u8ToB64(u8) {
				let s = "";
				const CH = 0x8000;
				for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
				return btoa(s);
			}

			/**
			 * 参考资料：点「选择文件…」→ 系统文件选择框 → 上传到项目的「参考/」目录。
			 * 2026-11-02 用户：「是用来放文件的，不是用来填写的，要有点击选择文件的功能」。
			 */
			function pickRefFiles(n) {
				const inp = document.createElement("input");
				inp.type = "file";
				inp.multiple = true;
				inp.accept = ".docx,.txt,.md,.markdown";
				inp.style.display = "none";
				document.body.append(inp);
				inp.addEventListener("change", async () => {
					const files = [...(inp.files || [])];
					inp.remove();
					if (!files.length) return;
					try {
						const payload = [];
						for (const f of files) {
							const buf = await f.arrayBuffer();
							payload.push({ name: f.name, data: u8ToB64(new Uint8Array(buf)) });
						}
						const r = await post("/filmflow/reference", {
							root: n.root || (current() && current().root) || "",
							action: "add",
							files: payload,
						});
						if (r && r.ok === false) throw new Error(r.error || "上传失败");
						showNote("已加入 " + payload.length + " 个参考文件", "ok");
						SIG.tree = "";
						await load();
					} catch (e) {
						showNote("加参考文件失败：" + String((e && e.message) || e));
					}
				});
				/* 用户按了「取消」：把临时 input 收掉，别在 DOM 里越堆越多 */
				inp.addEventListener("cancel", () => inp.remove());
				inp.click();
			}

			/** 参考资料：删掉一份文件（宿主只删项目「参考/」里的那一份）。 */
			async function removeRefFile(n, f) {
				try {
					await post("/filmflow/reference", {
						root: n.root || (current() && current().root) || "",
						action: "remove",
						name: String(f.name || f.path || ""),
					});
					SIG.tree = "";
					await load();
				} catch (e) {
					showNote("删不掉：" + String((e && e.message) || e));
				}
			}

			/**
			 * 把 `table` 形态的 doc 画成真表格（2026-11-02）。
			 * doc 结构：{ kind:'table', columns:[{key,label}], groups:[{path:[], rows:[{key:value}]}] }
			 */
			/* ── 分镜表：加一行 / 删一行（2026-11-03 用户：「只能添加行」）──────────
			 *
			 * 只动**正文 markdown**：找到表格块、插入/删除一行、整篇写回（同一套护栏：备份 + 声明
			 * 白名单）。不碰 shape/表头 —— 表头是 schema，加列要另外设计（role/编排），这版不做。
			 * 镜号取现有最大值 +1，**不重排已有行**：生成状态以后按镜号绑，重排会把状态错位。
			 */
			/** 找出正文里所有 markdown 表格块（表头行 + 分隔行 + 行区间）。 */
			function mdTableBlocks(text) {
				const lines = String(text || "").split(/\r?\n/);
				const out = [];
				for (let i = 0; i < lines.length - 1; i++) {
					if (!/^\s*\|/.test(lines[i])) continue;
					if (!/^\s*\|[\s:|-]*$/.test(lines[i + 1])) continue;
					let end = i + 1;
					while (end + 1 < lines.length && /^\s*\|/.test(lines[end + 1])) end++;
					out.push({ head: i, sep: i + 1, start: i + 2, end, lines });
					i = end;
				}
				return out;
			}
			/** 比较用：去掉空白后比（文件里对齐用的空格不一致）。 */
			function rowNorm(s) { return String(s || "").replace(/\s+/g, ""); }
			/** 把一行 markdown 拆成单元格。 */
			function splitRow(s) {
				return String(s || "").replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((x) => x.trim());
			}
			/** 整篇写回 → 重画。 */
			async function saveTableText(n, text) {
				const p = current();
				if (!p) return;
				await post("/filmflow/edit", {
					root: p.root, src: n.src, line: n.line, whole: true,
					title: n.title, kind: n.kind, via: "md", text,
				});
				SIG.tree = "";
				await load();
			}
			/** 在最后一张表末尾追加一行。 */
			async function tableAddRow(n, cols) {
				try {
					const blocks = mdTableBlocks(n.fileText || "");
					/*
					 * 空表（新片刚建、文件里只有一个标题）也要能加行 ——
					 * 第一次点「＋ 加一行」就顺手把**标准表头**写进去，之后照常追加。
					 * 2026-11-03 实测：新片里点加行没反应，因为文件里还没表。
					 */
					if (!blocks.length) {
						const head = "| " + cols.map((c) => String(c.label || c.key)).join(" | ") + " |";
						const sep = "| " + cols.map(() => "---").join(" | ") + " |";
						const first = "| " + cols.map((c, i2) => (i2 === 0 ? "1" : "")).join(" | ") + " |";
						const base = String(n.fileText || "").replace(/\s+$/, "");
						const next = (base ? base + "\n\n" : "") + head + "\n" + sep + "\n" + first + "\n";
						await saveTableText(n, next);
						showNote("建好表头，加了第一行", "ok");
						return;
					}
					const b = blocks[blocks.length - 1];
					let maxNo = 0;
					for (let i = b.start; i <= b.end; i++) {
						const no = parseInt(String(splitRow(b.lines[i])[0] || "").replace(/[^0-9]/g, ""), 10);
						if (Number.isFinite(no) && no > maxNo) maxNo = no;
					}
					const cells = cols.map((c, i) => (i === 0 ? String(maxNo + 1) : ""));
					b.lines.splice(b.end + 1, 0, "| " + cells.join(" | ") + " |");
					await saveTableText(n, b.lines.join("\n"));
					showNote("加了一行（镜号 " + (maxNo + 1) + "）", "ok");
				} catch (e) {
					showNote("加行失败：" + String((e && e.message) || e));
				}
			}
			/** 删掉内容匹配的那一行（重复行只删第一处）。 */
			async function tableDelRow(n, cells) {
				try {
					const want = rowNorm("| " + cells.join(" | ") + " |");
					for (const b of mdTableBlocks(n.fileText || "")) {
						for (let i = b.start; i <= b.end; i++) {
							if (rowNorm(b.lines[i]) !== want) continue;
							b.lines.splice(i, 1);
							await saveTableText(n, b.lines.join("\n"));
							showNote("删掉了一行", "ok");
							return;
						}
					}
					showNote("没在文件里找到这一行（可能刚被别处改过），刷新再看");
				} catch (e) {
					showNote("删行失败：" + String((e && e.message) || e));
				}
			}

			/**
			 * 改一格（用户 2026-11-06：「表格里的文字不能手动更改吗？」）。
			 * 用「原始整行」在文件里定位，然后整行换掉再整篇写回 —— 跟加行/删行走同一条保存路径。
			 * @param n - 表格节点
			 * @param cols - 列定义
			 * @param row - 这一行的数据（改之前的）
			 * @param key - 哪一列
			 * @param value - 新值
			 */
			async function tableSetCell(n, cols, row, key, value) {
				const oldCells = cols.map((c) => String((row && row[c.key]) != null ? row[c.key] : ""));
				const newCells = cols.map((c, i) => (c.key === key ? String(value == null ? "" : value).replace(/\|/g, "／") : oldCells[i]));
				if (oldCells.join("\u0001") === newCells.join("\u0001")) return;
				try {
					const want = rowNorm("| " + oldCells.join(" | ") + " |");
					for (const b of mdTableBlocks(n.fileText || "")) {
						for (let i = b.start; i <= b.end; i++) {
							if (rowNorm(b.lines[i]) !== want) continue;
							b.lines[i] = "| " + newCells.join(" | ") + " |";
							await saveTableText(n, b.lines.join("\n"));
							showNote("改好了", "ok");
							return;
						}
					}
					showNote("没在文件里找到这一行（可能刚被别处改过），刷新再看");
				} catch (e) {
					showNote("改格子失败：" + String((e && e.message) || e));
				}
			}

			/** 双击一格 → 就地变成输入框；回车/失焦保存，Esc 取消。 */
			function bindCellEdit(td, n, cols, row, key) {
				td.title = "双击改这一格";
				td.addEventListener("dblclick", (ev) => {
					ev.stopPropagation();
					ev.preventDefault();
					if (td.querySelector("input")) return;
					const old = String(td.textContent || "");
					const inp = el("input", "ff-inline-edit");
					inp.value = old;
					inp.style.width = Math.max(80, Math.min(360, td.getBoundingClientRect().width + 40)) + "px";
					inp.style.fontSize = "11.5px";
					inp.style.padding = "1px 4px";
					td.textContent = "";
					td.append(inp);
					try { inp.focus(); inp.select(); } catch { /* 忽略 */ }
					let done = false;
					const finish = async (save) => {
						if (done) return;
						done = true;
						const v = String(inp.value || "");
						if (!save || v === old) { td.textContent = old; return; }
						td.textContent = v;
						await tableSetCell(n, cols, row, key, v);
					};
					inp.addEventListener("mousedown", (e2) => e2.stopPropagation());
					inp.addEventListener("click", (e2) => e2.stopPropagation());
					inp.addEventListener("keydown", (e2) => {
						e2.stopPropagation();
						if (e2.key === "Enter") { e2.preventDefault(); void finish(true); }
						else if (e2.key === "Escape") { e2.preventDefault(); void finish(false); }
					});
					inp.addEventListener("blur", () => { void finish(true); });
				});
			}

			/**
			 * 把一行汇总成提示词（2026-11-03：提示词由行内容编出来，不再手工写在节点里）。
			 *
			 * 顺序按镜头语言的读法：机位/运镜 → 景别 → 画面内容 → 台词/声音 → 备注。（时长不进提示词：那是 duration 参数。）
			 * 只把**非空**的格子写进去，空的不塞占位词 —— 否则模型会照着占位词编。
			 * 提示词最终以 `.film/generation.json` 里存的为准（用户在行详情里改过就用改过的）。
			 */
			function promptOfRow(row) {
				const get = (key) => String((row && row[key]) != null ? row[key] : "").trim();
				const parts = [];
				const look = get("look");
				if (look) parts.push("【画风】" + look + "。");
				const move = get("move");
				const shot = get("shot");
				const pic = get("pic");
				if (pic) parts.push(pic);
				const line = get("line");
				if (line) parts.push("声音/台词：" + line);
				const note = get("note");
				if (note) parts.push("备注：" + note);
				
				return parts.join("；");
			}

			/**
			 * 点了「单元」的生成：一次任务覆盖组内 1..N 个镜。
			 *
			 * 为什么要单元而不是行：模型最短 4 秒，而分镜里很多镜头 1 秒以内；
			 * 硬按行提交就是拿 4 秒换 1 秒，还不连贯。组内各镜按顺序拼成
			 * `镜头1：… 镜头2：…`（sd2.5 的多事件链写法）。**出来的就是一条片子，整条导出** —— 要拆镜交给剪辑软件。
			 */
			async function genUnit(n, u, running, btn) {
				const p = current();
				if (!p) return;
				if (running) {
					try {
						await post("/filmflow/gen", { action: "cancelUnit", root: p.root, id: u.id });
						showNote("已取消 " + u.id, "ok");
					} catch (e) { showNote("取消失败：" + String((e && e.message) || e)); }
					SIG.tree = "";
					await load();
					return;
				}
				btn.textContent = "提交中…";
				try {
					const r = await post("/filmflow/gen", { action: "genUnit", root: p.root, id: u.id });
					if (r && r.ok === false) { showNote("没生成：" + (r.error || ""), "warn"); btn.textContent = "生成"; return; }
					showNote("已提交：" + u.id + "（镜 " + (u.covers || []).join("/") + "，" + u.durationSec + " 秒）", "ok");
				} catch (e) {
					showNote("没生成：" + String((e && e.message) || e));
					btn.textContent = "生成";
					return;
				}
				SIG.tree = "";
				await load();
			}


			/**
			 * 把一组镜拼成一条多镜头提示词（和宿主 composeUnitPrompt 同一口径，用来在参数卡里预览/编辑）。
			 * @param covers - 镜号数组（按分镜顺序）
			 * @param rowByNo - 镜号 → 行对象
			 */
			function dialogueOfText(cell, speakers) {
				const raw = String(cell || "").trim();
				if (!raw) return "";
				const segs = raw.split(/[；;]/).map((s) => s.trim()).filter(Boolean);
				const out = [];
				for (const s of segs) {
					const m = /^([^：:]{1,14})[：:]([\s\S]+)$/.exec(s);
					if (m) { speakers.push(m[1].trim()); out.push(m[1].trim() + "说：{" + m[2].trim() + "}"); }
					else out.push(s);
				}
				return out.join("；");
			}
			/** 和宿主 composeUnitPrompt 同一口径：【事件脚本】镜头N… + 【保持一致】；台词写 {} */
			function composeUnitText(covers, rowByNo) {
				const beats = [];
				const notes = [];
				const speakers = [];
				const scenes = [];
				(covers || []).forEach((no, i) => {
					const r = rowByNo.get(String(no)) || {};
					const shot = String(r.shot || "").trim();
					const pic = String(r.pic || "").trim();
					const cam = String(r.move || "").trim();
					const sc = /^([^｜|]{1,12})[｜|]/.exec(pic);
					if (sc) scenes.push(sc[1].trim());
					const camMoves = cam && !/^(固定|固定镜头|不动|静止|固定机位)$/.test(cam);
					const seg = [];
					let beat = [shot, pic].filter(Boolean).join("，");
					if (beat && camMoves) beat += "（" + cam + "）";
					if (beat) seg.push(beat);
					const talk = dialogueOfText(r.line, speakers);
					if (talk) seg.push(talk);
					if (seg.length) beats.push("镜头" + (i + 1) + "：" + seg.join("；"));
					if (String(r.note || "").trim()) notes.push(String(r.note).trim());
				});
				const keep = [];
				const uniqScene = [...new Set(scenes)];
				if (uniqScene.length === 1) keep.push("同一场景：" + uniqScene[0]);
				else if (uniqScene.length > 1) keep.push("场景按顺序：" + uniqScene.join(" → "));
				keep.push("人物身份、服装与站位连续");
				const uniqSpeaker = [...new Set(speakers)];
				if (uniqSpeaker.length) keep.push("说话人不互换：" + uniqSpeaker.join("、"));
				for (const n of [...new Set(notes)]) keep.push(n);
				const looks = (covers || []).map((no) => String(((rowByNo.get(String(no)) || {}).look) || "").trim());
				const uniqLook = [...new Set(looks.filter(Boolean))];
				const lookLine = uniqLook.length === 1
					? uniqLook[0]
					: looks.map((x, i) => (x ? "镜头" + (i + 1) + "：" + x : "")).filter(Boolean).join("；");
				const parts = [];
				if (lookLine) { parts.push("【画风】"); parts.push(lookLine + "。"); }
				parts.push("【事件脚本】", ...beats);
				if (keep.length) { parts.push("【保持一致】"); parts.push(keep.join("；") + "。"); }
				return parts.join("\n");
			}
			/* ══ 参考素材（虚拟列，竖跨整组）══════════════════════════
			 *
			 * 设计见 `设计-参考素材.md`：元素由 agent 提、图只能由人绑，**绑一次全片生效**。
			 * 格子里：已绑的显示缩略图 chip；没绑的显示浅灰名字（点一下就能选图）；＋ 手动挑元素。
			 */
			let refMenuDocClose = null;
			let refMenuEsc = null;
			function closeRefMenus() {
				for (const x of Array.from(document.querySelectorAll(".ff-ref-menu"))) x.remove();
				if (refMenuDocClose) {
					document.removeEventListener("click", refMenuDocClose, true);
					refMenuDocClose = null;
				}
				if (refMenuEsc) {
					document.removeEventListener("keydown", refMenuEsc, true);
					refMenuEsc = null;
				}
			}

			function pickImageFiles(cb) {
				const inp = el("input");
				inp.type = "file";
				inp.accept = "image/*";
				inp.multiple = true;
				inp.style.position = "fixed";
				inp.style.left = "-9999px";
				document.body.append(inp);
				inp.addEventListener("change", () => {
					const files = Array.from(inp.files || []);
					inp.remove();
					if (files.length) cb(files);
				});
				inp.click();
			}

			function refImagesOf(n, id) {
				for (const u of (n.units || [])) for (const r of (u.refs || [])) {
					if (String(r.id) === String(id)) return (r.images || []).slice();
				}
				return [];
			}

			function refPost(n, payload) {
				return post("/filmflow/refs", { root: n.root || (current() && current().root) || "", ...payload });
			}

			async function refreshAfterRefs() {
				SIG.tree = "";
				await load();
			}

			/** 选图 → 上传到 素材/ → 绑到元素（全片生效） */
			async function uploadRefs(n, elementId, files, replace) {
				const made = [];
				for (const f of files) {
					if (f.size > 12 * 1024 * 1024) {
						showNote("这张太大（" + (f.size / 1048576).toFixed(1) + "MB，上限 12MB）：" + f.name + "，先压缩");
						continue;
					}
					const dataUrl = await new Promise((res, rej) => {
						const fr = new FileReader();
						fr.onload = () => res(String(fr.result || ""));
						fr.onerror = () => rej(new Error("读图失败：" + f.name));
						fr.readAsDataURL(f);
					});
					const r = await post("/filmflow/refs", { root: n.root || (current() && current().root) || "", action: "upload", name: f.name, dataUrl });
					if (r && r.ok === false) throw new Error(r.error || "上传失败");
					if (r && r.path) made.push(r.path);
				}
				const images = replace ? made.slice() : [...new Set([...refImagesOf(n, elementId), ...made])];
				const r2 = await refPost(n, { action: "bind", id: elementId, images });
				if (r2 && r2.ok === false) throw new Error(r2.error || "绑定失败");
				showNote("已绑定：" + images.length + " 张 · 全片生效", "ok");
				await refreshAfterRefs();
			}

			function openRefMenu(td, items) {
				closeRefMenus();
				const m = el("div", "ff-ref-menu");
				for (const it of items) {
					const row = el("div", undefined, it.label);
					row.addEventListener("click", (ev) => { ev.stopPropagation(); closeRefMenus(); it.fn(); });
					m.append(row);
				}
				td.append(m);
				/* 点画布别处 / 按 Esc 也要能收起（用户 2026-11-04：点开就收不回去了）。
				   监听**同步**挂上（不再等 setTimeout —— 那一拍里菜单可能已经被下一次打开换掉，
				   浏览器就把这个菜单留成孤儿），用 armed 躲开"打开它的那一下"点击。 */
				let armed = false;
				refMenuDocClose = (ev) => {
					if (!armed) return;
					if (!m.contains(ev.target)) closeRefMenus();
				};
				refMenuEsc = (ev) => { if (ev.key === "Escape") closeRefMenus(); };
				document.addEventListener("click", refMenuDocClose, true);
				document.addEventListener("keydown", refMenuEsc, true);
				setTimeout(() => { armed = true; }, 0);
			}

			/** 选图来源：本地文件 / 画布上已生成的图（素材库） */
			function chooseRefSource(td, n, elementId, replace) {
				openRefMenu(td, [
					{ label: "选本地图片…", fn: () => pickImageFiles((files) => {
						uploadRefs(n, elementId, files, replace).catch((e) => showNote(String((e && e.message) || e)));
					}) },
					{ label: "从素材库选（已生成的图）…", fn: () => openAssetPicker(n, elementId, replace) },
				]);
			}

			/** 素材库选择器：本片已生成的图片，点一张就绑到元素 */
			function openAssetPicker(n, elementId, replace) {
				const root = n.root || (current() && current().root) || "";
				Promise.all([fetchGlobalImages(), fetchRoleImages()])
					.then(([imgs, roles]) => {
						const wrap = el("div", "ff-refs-panel");
						const box = el("div", "box");
						const head = el("div", "row");
						head.append(el("div", "grow", "素材库 · 全库图片（" + imgs.length + " 张，角色库 " + roles.length + "）"));
						const bClose = el("div", "ff-btn", "关闭");
						bClose.addEventListener("click", () => wrap.remove());
						head.append(bClose);
						box.append(head);
						const bindIt = (it) => {
							refPost(n, { action: "fromAsset", id: elementId, src: it.src, replace: !!replace, fromRoot: it.root || root })
								.then(() => { wrap.remove(); return refreshAfterRefs(); })
								.catch((e) => showNote(String((e && e.message) || e)));
						};
						const mkGrid = (list) => {
							const grid = el("div", "ff-ref-pick-grid");
							for (const it of list) {
								const cell = el("div", "ff-ref-pick-item");
								const im = el("img");
								im.src = assetFileUrl(it);
								const lab = it.role && it.role.name
									? "★ " + String(it.role.name)
									: String(it.film || "") + "　" + String(it.nodeTitle || it.node || "");
								cell.append(im, el("div", "lab", lab));
								cell.title = String(it.src) + (it.film && String(it.root) !== root ? "（来自 " + it.film + "，会复制一份进本片）" : "");
								cell.addEventListener("click", () => bindIt(it));
								grid.append(cell);
							}
							return grid;
						};
						if (!imgs.length) {
							const empty = el("div", "row");
							empty.append(el("div", "grow", "全库还没有图片（视频/音频不能当参考图）"));
							box.append(empty);
						}
						if (roles.length) {
							box.append(el("div", "row", "角色库"));
							box.append(mkGrid(roles));
						}
						const roleIds = new Set(roles.map((x) => String(x.root) + "|" + String(x.id)));
						const others = imgs.filter((x) => !roleIds.has(String(x.root) + "|" + String(x.id)));
						if (others.length) {
							box.append(el("div", "row", "全部项目"));
							box.append(mkGrid(others));
						}
						wrap.append(box);
						wrap.addEventListener("click", (ev) => { if (ev.target === wrap) wrap.remove(); });
						document.body.append(wrap);
					})
					.catch((e) => showNote("素材库打不开：" + String((e && e.message) || e)));
			}

			/**
			 * ⛔ 已停用（B57，2026-11-05）：「新建自定义元素」这件事本身被用户否掉了 ——
			 * 元素只由 agent 分析产出；用户能加的是**素材**（见 refsCell 里的 `＋ → askMaterial`）。
			 * 下面这几个函数（askElementForm / bindPickedImage / openRefPickMenu）已经**没有调用点**，
			 * 别再接线；要清理就整块删掉。
			 */
			/**
			 * 新建元素的小表单：名字 + 种类 + **素材**（本地图片 / 素材库里任意项目的图）。
			 *
			 * 为什么素材必须在这个框里：用户点「新建元素」的目的就是"加一份参考资料"，
			 * 只收名字等于把功能做成半截（2026-11-05 用户两次指出："什么都有却没有素材选择"）。
			 * 为什么不用 `window.prompt`：Electron 不支持，调用直接抛（B54）。
			 *
			 * @returns {Promise<{name:string, kind:string, image:null|{type:'asset',item:object}|{type:'files',files:File[]}}|null>}
			 */
			function askElementForm() {
				return new Promise((resolve) => {
					let picked = null;   /* null | {type:'asset', item} | {type:'files', files} */
					const wrap = el("div", "ff-refs-panel");
					const box = el("div", "box");
					const head = el("div", "row");
					head.append(el("div", "grow", "新建参考元素"));
					box.append(head);

					const rowName = el("div", "row");
					const inp = el("input", "ff-inline-edit");
					inp.placeholder = "元素名（例如：唐老板 / A室）";
					rowName.append(inp);
					box.append(rowName);

					const rowKind = el("div", "row");
					const sel = el("select", "ff-tbl-psel");
					for (const pair of [["person", "人物"], ["scene", "场景"], ["prop", "道具"], ["look", "画风/影调"]]) {
						const o = el("option", undefined, pair[1]);
						o.value = pair[0];
						sel.append(o);
					}
					sel.style.width = "150px";
					sel.style.flex = "0 0 auto";
					rowKind.append(el("div", undefined, "种类"), sel);
					box.append(rowKind);

					/* 素材：本地文件 / 素材库（角色库 + 全部项目），选完先在这里看缩略图 */
					const rowImg = el("div", "row");
					const imgState = el("div", "grow", "素材：未选");
					const bLocal = el("div", "ff-btn", "选本地图片…");
					const bLib = el("div", "ff-btn", "从素材库选…");
					rowImg.append(imgState, bLocal, bLib);
					box.append(rowImg);

					const area = el("div");
					area.style.display = "flex";
					area.style.flexDirection = "column";
					area.style.gap = "8px";
					box.append(area);

					const showPicked = () => {
						area.textContent = "";
						if (!picked) { imgState.textContent = "素材：未选（先建也行，之后点格子里的浅字再选图）"; return; }
						const row = el("div", "row");
						const im = el("img");
						im.style.width = "54px";
						im.style.height = "54px";
						im.style.objectFit = "cover";
						im.style.borderRadius = "6px";
						if (picked.type === "asset") {
							im.src = assetFileUrl(picked.item);
							const nm = picked.item.role && picked.item.role.name
								? "★ " + String(picked.item.role.name)
								: String(picked.item.film || "") + " " + String(picked.item.nodeTitle || picked.item.node || "");
							imgState.textContent = "素材：" + nm;
						} else {
							im.src = URL.createObjectURL(picked.files[0]);
							imgState.textContent = "素材：本地 " + picked.files.map((f) => f.name).join("、");
						}
						const bClear = el("div", "ff-btn", "不要了");
						bClear.addEventListener("click", () => { picked = null; showPicked(); });
						row.append(im, el("div", "grow", ""), bClear);
						area.append(row);
					};

					bLocal.addEventListener("click", () => {
						pickImageFiles((files) => { picked = { type: "files", files }; showPicked(); });
					});

					bLib.addEventListener("click", () => {
						area.textContent = "读取素材库…";
						Promise.all([fetchGlobalImages(), fetchRoleImages()])
							.then(([imgs, roles]) => {
								area.textContent = "";
								const roleIds = new Set(roles.map((x) => String(x.root) + "|" + String(x.id)));
								const others = imgs.filter((x) => !roleIds.has(String(x.root) + "|" + String(x.id)));
								const mkGrid = (list) => {
									const grid = el("div", "ff-ref-pick-grid");
									for (const it of list) {
										const cell = el("div", "ff-ref-pick-item");
										const im = el("img");
										im.src = assetFileUrl(it);
										cell.append(im, el("div", "lab", it.role && it.role.name
											? "★ " + String(it.role.name)
											: String(it.film || "") + " " + String(it.nodeTitle || it.node || "")));
										cell.title = String(it.src);
										cell.addEventListener("click", () => { picked = { type: "asset", item: it }; showPicked(); });
										grid.append(cell);
									}
									return grid;
								};
								if (roles.length) {
									area.append(el("div", "row", "角色库（" + roles.length + "）"));
									area.append(mkGrid(roles));
								}
								if (others.length) {
									area.append(el("div", "row", "全部素材（" + others.length + "）"));
									area.append(mkGrid(others));
								}
								if (!roles.length && !others.length) area.append(el("div", "row", "全库还没有图片，先用「选本地图片…」"));
							})
							.catch((e) => { area.textContent = "素材库打不开：" + String((e && e.message) || e); });
					});

					const rowBtn = el("div", "row");
					const bOk = el("div", "ff-btn", "确定");
					const bNo = el("div", "ff-btn", "取消");
					rowBtn.append(bOk, bNo);
					box.append(rowBtn);

					wrap.append(box);
					let closed = false;
					const done = (v) => {
						if (closed) return;
						closed = true;
						document.removeEventListener("keydown", onKey, true);
						wrap.remove();
						resolve(v);
					};
					const onKey = (ev) => {
						if (ev.key === "Escape") { ev.stopPropagation(); done(null); }
					};
					bOk.addEventListener("click", () => {
						const name = String(inp.value || "").trim();
						if (!name) { inp.focus(); showNote("先给元素起个名字"); return; }
						done({ name, kind: String(sel.value || "person"), image: picked });
					});
					bNo.addEventListener("click", () => done(null));
					wrap.addEventListener("click", (ev) => { if (ev.target === wrap) done(null); });
					inp.addEventListener("keydown", (ev) => {
						if (ev.key !== "Enter") return;
						ev.preventDefault();
						bOk.click();
					});
					document.addEventListener("keydown", onKey, true);
					document.body.append(wrap);
					setTimeout(() => inp.focus(), 0);
				});
			}

			/** 把表单里选好的图绑到元素（素材库 → fromAsset；本地文件 → 上传到 素材/ 再绑）。 */
			async function bindPickedImage(n, elementId, pick) {
				if (!pick) return false;
				if (pick.type === "asset") {
					await refPost(n, { action: "fromAsset", id: elementId, src: pick.item.src, replace: true, fromRoot: pick.item.root || "" });
					return true;
				}
				if (pick.type === "files") {
					await uploadRefs(n, elementId, pick.files, true);
					return true;
				}
				return false;
			}

			/** 素材文件 URL（素材可能来自别的片，root 要用它自己的） */
			function assetFileUrl(it) {
				const r = String((it && it.root) || "").replace(/\\/g, "/");
				return "/filmflow/assets?action=file&root=" + encodeURIComponent(r) + "&p=" + encodeURIComponent(String((it && it.src) || ""));
			}

			/** 全库图片（所有项目）。用户 2026-11-05：片里选素材看到的就是全局素材库。 */
			async function fetchGlobalImages() {
				const j = await (await fetch("/filmflow/assets?action=list", { headers: { accept: "application/json" } })).json();
				return (j.items || []).filter((x) => String(x.type) === "image");
			}

			/** 角色库：挂了 role.name 的素材（跨项目）。只是素材上的标签，元素数据不变。 */
			async function fetchRoleImages() {
				const j = await (await fetch("/filmflow/assets?action=roles", { headers: { accept: "application/json" } })).json();
				return (j.items || []).filter((x) => String(x.type) === "image");
			}

			/**
			 * 给某个元素**选图**（居中面板）。
			 *
			 * 为什么不是格子里的弹出菜单：新建元素之后表格会重画，旧的 `<td>` 已经不在了，
			 * 菜单挂上去看不见 —— 用户就会看到"建完了但没地方加图"（2026-11-05）。
			 * 这里不依赖格子，选完（本地文件 / 素材库里的成片）就绑定、全片生效。
			 *
			 * @param {object} n 表格节点
			 * @param {string} elementId 元素 id
			 * @param {boolean} replace true=换图（替换已有），false=追加
			 * @param {string} label 显示用的元素名
			 */
			function askRefImage(n, elementId, replace, label) {
				const root = n.root || (current() && current().root) || "";
				const wrap = el("div", "ff-refs-panel");
				const box = el("div", "box");
				const head = el("div", "row");
				head.append(el("div", "grow", "给「" + String(label || "这个元素") + "」选参考图"));
				const bLater = el("div", "ff-btn", "稍后再说");
				head.append(bLater);
				box.append(head);

				const tip = el("div", "row");
				tip.append(el("div", "grow", "图会绑到这个元素上，全片生效（一个元素只配一次）"));
				box.append(tip);

				const rowBtn = el("div", "row");
				const bLocal = el("div", "ff-btn", "选本地图片…");
				const bLib = el("div", "ff-btn", "从素材库选（已生成的图）…");
				rowBtn.append(bLocal, bLib);
				box.append(rowBtn);

				const area = el("div");
				area.style.display = "flex";
				area.style.flexDirection = "column";
				area.style.gap = "8px";
				box.append(area);

				wrap.append(box);
				const close = () => wrap.remove();
				bLater.addEventListener("click", close);
				wrap.addEventListener("click", (ev) => { if (ev.target === wrap) close(); });

				bLocal.addEventListener("click", () => {
					pickImageFiles((files) => {
						uploadRefs(n, elementId, files, replace)
							.then(() => close())
							.catch((e) => showNote(String((e && e.message) || e)));
					});
				});

				bLib.addEventListener("click", () => {
					area.textContent = "读取素材库…";
					/* 素材库是**全局**的（用户 2026-11-05：片里选素材不该过滤掉别的项目） */
					Promise.all([fetchGlobalImages(), fetchRoleImages()])
						.then(([imgs, roles]) => {
							area.textContent = "";
							const roleIds = new Set(roles.map((x) => String(x.root) + "|" + String(x.id)));
							const others = imgs.filter((x) => !roleIds.has(String(x.root) + "|" + String(x.id)));
							const mkGrid = (list) => {
								const grid = el("div", "ff-ref-pick-grid");
								for (const it of list) {
									const cell = el("div", "ff-ref-pick-item");
									const im = el("img");
									im.src = assetFileUrl(it);
									const lab = it.role && it.role.name
										? "★ " + String(it.role.name)
										: String(it.film || "") + "　" + String(it.nodeTitle || it.node || "") + "　" + String(it.at || "").slice(5, 10);
									cell.append(im, el("div", "lab", lab));
									cell.title = String(it.src) + (it.film ? "（来自 " + it.film + "，会复制一份进本片）" : "");
									cell.addEventListener("click", () => {
										refPost(n, { action: "fromAsset", id: elementId, src: it.src, replace: !!replace, fromRoot: it.root || root })
											.then(() => { close(); return refreshAfterRefs(); })
											.catch((e) => showNote(String((e && e.message) || e)));
									});
									grid.append(cell);
								}
								return grid;
							};
							if (roles.length) {
								area.append(el("div", "row", "角色库（" + roles.length + "）"));
								area.append(mkGrid(roles));
							}
							if (others.length) {
								area.append(el("div", "row", "全部素材（" + others.length + "）"));
								area.append(mkGrid(others));
							}
							if (!roles.length && !others.length) {
								area.append(el("div", "row", "全库还没有图片（视频/音频不能当参考图），先用「选本地图片…」"));
							}
						})
						.catch((e) => { area.textContent = "素材库打不开：" + String((e && e.message) || e); });
				});

				document.body.append(wrap);
			}

			/** 点 ＋：从本组元素里挑一个来绑（或新建元素） */
			function openRefPickMenu(td, n, refs, unit) {
				const items = refs.map((r) => ({
					label: ((r.images || []).length ? "换图：" : "选图：") + String(r.name || ""),
					fn: () => chooseRefSource(td, n, r.id, (r.images || []).length > 0),
				}));
				items.push({
					label: "＋ 新建元素…",
					fn: async () => {
						const got = await askElementForm();
						if (!got) return;
						const name = got.name;
						const kind = got.kind;
						/* 新元素必须挂到这一格上（shots = 本组的镜号），否则它在表里没有落脚点。
						   图在表单里就选好了（`got.image`），这里只负责落库 + 绑定。 */
						const shots = (unit && Array.isArray(unit.covers)) ? unit.covers.map(String) : [];
						refPost(n, { action: "add", name, kind, shots })
							.then(async (j) => {
								const el0 = ((j && j.elements) || []).find((x) => String(x.name) === name);
								if (el0 && got.image) {
									try { await bindPickedImage(n, el0.id, got.image); } catch (e) { showNote(String((e && e.message) || e)); }
								}
								await refreshAfterRefs();
								if (!got.image) showNote("已建「" + name + "」，还没有图：点格子里的浅字随时选图");
							})
							.catch((e) => showNote(String((e && e.message) || e)));
					},
				});
				openRefMenu(td, items);
			}

			/** 点已绑的 chip：换图 / 解绑 / 不用参考 / 看大图 */
			function openRefChipMenu(td, n, r, unit) {
				const root = n.root || (current() && current().root) || "";
				const url = "/filmflow/refs/file?root=" + encodeURIComponent(root) + "&p=" + encodeURIComponent((r.images || [])[0] || "");
				openRefMenu(td, [
					{ label: "看大图", fn: () => window.open(url, "_blank") },
					{ label: "换图（全片生效）", fn: () => chooseRefSource(td, n, r.id, true) },
					{ label: "解绑这个元素", fn: () => { refPost(n, { action: "unbind", id: r.id }).then(() => refreshAfterRefs()).catch((e) => showNote(String((e && e.message) || e))); } },
					/* 单元级：全片照用，但**这一个单元**不要它（D39） */
					unit ? {
						label: "这个单元不用它",
						fn: () => { refPost(n, { action: "unitOptOut", unitId: String(unit.id), elementId: String(r.id), off: true }).then(() => refreshAfterRefs()).catch((e) => showNote(String((e && e.message) || e))); },
					} : null,
					{ label: "这片不用它的参考", fn: () => { refPost(n, { action: "skip", id: r.id, skip: true }).then(() => refreshAfterRefs()).catch((e) => showNote(String((e && e.message) || e))); } },
				].filter(Boolean));
			}

			/** 素材格：一个单元一格（并组时竖跨） */
			/**
			 * 素材格：元素（agent 提的）+ 用户手加的素材（素材1、素材2…）。
			 *
			 * 用户 2026-11-05 重新定义：
			 *   · 元素只由 agent 提（浅字），点浅字 = 给它选图，绑一次全片生效；
			 *   · **加号只加素材**（不是新建元素）：加完系统自动标「素材N」，同一张图全片同号；
			 *   · 素材没有语义（没有种类、没有名字含义），用途由用户自己在提示词里写。
			 */
			function refsCell(n, unit, spanN) {
				const td = el("td", "ff-tbl-pcell ff-tbl-prefs");
				if (spanN > 1) td.rowSpan = spanN;
				td.style.position = "relative";
				const box = el("div", "ff-refs");
				const refs = ((unit && Array.isArray(unit.refs)) ? unit.refs : []).filter((r) => r.state !== "skip");
				const mats = ((unit && Array.isArray(unit.materials)) ? unit.materials : []);
				if (!unit) {
					td.append(el("div", "ff-ref-ghost", "（没有生成单元，先分组）"));
					return td;
				}
				const root = n.root || (current() && current().root) || "";
				for (const r of refs) {
					const imgs = r.images || [];
					if (r.off) {
						/* 这个单元明确不用它：删除线浅字，点一下可以恢复 */
						const g0 = el("div", "ff-ref-ghost ff-ref-off", String(r.name || ""));
						g0.title = "这个单元不用「" + String(r.name || "") + "」的参考图；点一下恢复";
						g0.addEventListener("click", (ev) => {
							ev.stopPropagation();
							openRefMenu(td, [
								{ label: "恢复使用", fn: () => { refPost(n, { action: "unitOptOut", unitId: String(unit.id), elementId: String(r.id), off: false }).then(() => refreshAfterRefs()).catch((e) => showNote(String((e && e.message) || e))); } },
							]);
						});
						box.append(g0);
						continue;
					}
					if (imgs.length) {
						const chip = el("div", "ff-ref-chip");
						const im = el("img");
						im.src = "/filmflow/refs/file?root=" + encodeURIComponent(root) + "&p=" + encodeURIComponent(imgs[0]);
						chip.append(im, el("span", undefined, String(r.name || "")));
						chip.title = String(r.name || "") + (imgs.length > 1 ? "（" + imgs.length + " 张）" : "") + " · 全片生效；点一下换图/解绑";
						chip.addEventListener("click", (ev) => { ev.stopPropagation(); openRefChipMenu(td, n, r, unit); });
						box.append(chip);
					} else {
						const g = el("div", "ff-ref-ghost", String(r.name || ""));
						g.title = "点一下给「" + String(r.name || "") + "」选图（全片生效）";
						g.addEventListener("click", (ev) => {
							ev.stopPropagation();
							chooseRefSource(td, n, r.id, false);
						});
						box.append(g);
					}
				}
				/* 手加素材：编号一律显示，点击可换图 / 从这几镜撤掉 */
				for (const m of mats) {
					const chip = el("div", "ff-ref-chip ff-ref-mat");
					const im = el("img");
					im.src = "/filmflow/refs/file?root=" + encodeURIComponent(root) + "&p=" + encodeURIComponent(m.image);
					chip.append(im, el("span", undefined, String(m.label || "素材")));
					chip.title = String(m.label || "") + " · 手加素材（用途写在提示词里）；点一下换图/撤掉";
					chip.addEventListener("click", (ev) => { ev.stopPropagation(); openMaterialMenu(td, n, unit, m); });
					box.append(chip);
				}
				const add = el("div", "ff-ref-add", "＋");
				add.title = "添加素材（本地图片 / 素材库任意项目的图），系统自动标 素材1、素材2…";
				add.addEventListener("click", (ev) => { ev.stopPropagation(); askMaterial(n, unit); });
				box.append(add);
				td.append(box);
				return td;
			}

			/** 点手加素材：换图 / 从这几镜撤掉 */
			function openMaterialMenu(td, n, unit, m) {
				openRefMenu(td, [
					{ label: "换图（编号不变）", fn: () => askMaterial(n, unit, m) },
					{
						label: "从这几镜撤掉",
						fn: () => {
							refPost(n, { action: "dropMaterial", id: m.id, shots: (unit && unit.covers) || [] })
								.then(() => refreshAfterRefs())
								.catch((e) => showNote(String((e && e.message) || e)));
						},
					},
				]);
			}

			/**
			 * 图片节点上传参考图（D39）：本地图片 / 素材库全库（含角色库）。
			 * 图进节点后由宿主同步到元素绑定，表格里的 chip 与提示词自动跟着变。
			 */
			function openImageNodePicker(n) {
				const root = n.root || (current() && current().root) || "";
				const wrap = el("div", "ff-refs-panel");
				const box = el("div", "box");
				const head = el("div", "row");
				head.append(el("div", "grow", "给「" + String(n.title || "图片节点") + "」加参考图"));
				const bClose = el("div", "ff-btn", "关闭");
				bClose.addEventListener("click", () => wrap.remove());
				head.append(bClose);
				box.append(head);

				const area = el("div");
				area.style.display = "flex";
				area.style.flexDirection = "column";
				area.style.gap = "8px";
				box.append(area);

				const rowBtn = el("div", "row");
				const bLocal = el("div", "ff-btn", "选本地图片…");
				const bLib = el("div", "ff-btn", "从素材库选…");
				rowBtn.append(bLocal, bLib);
				box.append(rowBtn);

				wrap.append(box);
				wrap.addEventListener("click", (ev) => { if (ev.target === wrap) wrap.remove(); });
				document.body.append(wrap);

				const addOne = async (src, fromRoot) => {
					await post("/filmflow/media-node", { root, key: n.key, action: "add", src, fromRoot: fromRoot || root });
				};

				bLocal.addEventListener("click", () => {
					pickImageFiles((files) => {
						(async () => {
							for (const f of files) {
								if (f.size > 12 * 1024 * 1024) { showNote("这张太大（上限 12MB）：" + f.name); continue; }
								const dataUrl = await new Promise((res, rej) => {
									const fr = new FileReader();
									fr.onload = () => res(String(fr.result || ""));
									fr.onerror = () => rej(new Error("读图失败：" + f.name));
									fr.readAsDataURL(f);
								});
								const r = await post("/filmflow/refs", { root, action: "upload", name: f.name, dataUrl });
								if (r && r.path) await addOne(r.path, root);
							}
							wrap.remove();
							SIG.tree = "";
							await load();
						})().catch((e) => showNote(String((e && e.message) || e)));
					});
				});

				bLib.addEventListener("click", () => {
					area.textContent = "读取素材库…";
					Promise.all([fetchGlobalImages(), fetchRoleImages()])
						.then(([imgs, roles]) => {
							area.textContent = "";
							const roleIds = new Set(roles.map((x) => String(x.root) + "|" + String(x.id)));
							const others = imgs.filter((x) => !roleIds.has(String(x.root) + "|" + String(x.id)));
							const mkGrid = (list) => {
								const grid = el("div", "ff-ref-pick-grid");
								for (const it of list) {
									const cell = el("div", "ff-ref-pick-item");
									const im = el("img");
									im.src = assetFileUrl(it);
									cell.append(im, el("div", "lab", it.role && it.role.name
										? "★ " + String(it.role.name)
										: String(it.film || "") + " " + String(it.nodeTitle || it.node || "")));
									cell.title = String(it.src);
									cell.addEventListener("click", () => {
										(async () => {
											await addOne(it.src, it.root || root);
											wrap.remove();
											SIG.tree = "";
											await load();
										})().catch((e) => showNote(String((e && e.message) || e)));
									});
									grid.append(cell);
								}
								return grid;
							};
							if (roles.length) {
								area.append(el("div", "row", "角色库（" + roles.length + "）"));
								area.append(mkGrid(roles));
							}
							if (others.length) {
								area.append(el("div", "row", "全部素材（" + others.length + "）"));
								area.append(mkGrid(others));
							}
							if (!roles.length && !others.length) area.append(el("div", "row", "全库还没有图片，先用「选本地图片…」"));
						})
						.catch((e) => { area.textContent = "素材库打不开：" + String((e && e.message) || e); });
				});
			}

			/**
			 * 加素材：选本地图片 / 从素材库（全库 + 角色库）选 → 系统自动编号「素材N」。
			 * @param {object} n 表格节点
			 * @param {object} unit 生成单元（决定挂到哪些镜号）
			 * @param {object} [replace] 已有素材：换图（先撤旧图再加，编号不变）
			 */
			function askMaterial(n, unit, replace) {
				const root = n.root || (current() && current().root) || "";
				const shots = (unit && unit.covers) || [];
				const wrap = el("div", "ff-refs-panel");
				const box = el("div", "box");
				const head = el("div", "row");
				head.append(el("div", "grow", replace
					? ("换图：" + String(replace.label || "") + "（编号不变）")
					: ("添加素材 · 镜 " + shots.join("/"))));
				const bClose = el("div", "ff-btn", "关闭");
				bClose.addEventListener("click", () => wrap.remove());
				head.append(bClose);
				box.append(head);

				const area = el("div");
				area.style.display = "flex";
				area.style.flexDirection = "column";
				area.style.gap = "8px";
				box.append(area);

				const rowBtn = el("div", "row");
				const bLocal = el("div", "ff-btn", "选本地图片…");
				const bLib = el("div", "ff-btn", "从素材库选…");
				rowBtn.append(bLocal, bLib);
				box.append(rowBtn);

				wrap.append(box);
				wrap.addEventListener("click", (ev) => { if (ev.target === wrap) wrap.remove(); });
				document.body.append(wrap);

				bLocal.addEventListener("click", () => {
					pickImageFiles((files) => {
						(async () => {
							const made = [];
							for (const f of files) {
								if (f.size > 12 * 1024 * 1024) { showNote("这张太大（上限 12MB）：" + f.name); continue; }
								const dataUrl = await new Promise((res, rej) => {
									const fr = new FileReader();
									fr.onload = () => res(String(fr.result || ""));
									fr.onerror = () => rej(new Error("读图失败：" + f.name));
									fr.readAsDataURL(f);
								});
								const r = await post("/filmflow/refs", { root, action: "upload", name: f.name, dataUrl });
								if (r && r.path) made.push(r.path);
							}
							for (const p of made) {
								if (replace) await refPost(n, { action: "dropMaterial", id: replace.id, shots }).catch(() => null);
								await refPost(n, { action: "addMaterial", src: p, shots });
							}
							wrap.remove();
							showNote("已加素材：" + made.length + " 张", "ok");
							await refreshAfterRefs();
						})().catch((e) => showNote(String((e && e.message) || e)));
					});
				});

				bLib.addEventListener("click", () => {
					area.textContent = "读取素材库…";
					Promise.all([fetchGlobalImages(), fetchRoleImages()])
						.then(([imgs, roles]) => {
							area.textContent = "";
							const roleIds = new Set(roles.map((x) => String(x.root) + "|" + String(x.id)));
							const others = imgs.filter((x) => !roleIds.has(String(x.root) + "|" + String(x.id)));
							const mkGrid = (list) => {
								const grid = el("div", "ff-ref-pick-grid");
								for (const it of list) {
									const cell = el("div", "ff-ref-pick-item");
									const im = el("img");
									im.src = assetFileUrl(it);
									cell.append(im, el("div", "lab", it.role && it.role.name
										? "★ " + String(it.role.name)
										: String(it.film || "") + " " + String(it.nodeTitle || it.node || "")));
									cell.title = String(it.src);
									cell.addEventListener("click", () => {
										(async () => {
											if (replace) await refPost(n, { action: "dropMaterial", id: replace.id, shots }).catch(() => null);
											await refPost(n, { action: "addMaterial", src: it.src, fromRoot: it.root || root, shots });
											wrap.remove();
											await refreshAfterRefs();
										})().catch((e) => showNote(String((e && e.message) || e)));
									});
									grid.append(cell);
								}
								return grid;
							};
							if (roles.length) {
								area.append(el("div", "row", "角色库（" + roles.length + "）"));
								area.append(mkGrid(roles));
							}
							if (others.length) {
								area.append(el("div", "row", "全部素材（" + others.length + "）"));
								area.append(mkGrid(others));
							}
							if (!roles.length && !others.length) area.append(el("div", "row", "全库还没有图片，先用「选本地图片…」"));
						})
						.catch((e) => { area.textContent = "素材库打不开：" + String((e && e.message) || e); });
				});
			}

			/** 素材库：全片元素一览（绑/解绑/不用/新建/自动匹配） */
			function openRefsPanel(n) {
				const root = n.root || (current() && current().root) || "";
				fetch("/filmflow/refs?root=" + encodeURIComponent(root), { headers: { accept: "application/json" } })
					.then((r) => r.json())
					.then((j) => {
						const wrap = el("div", "ff-refs-panel");
						const box = el("div", "box");
						const head = el("div", "row");
						head.append(el("div", "grow", "素材库 · 元素（agent 提的）绑一次全片生效（" + (j.elements || []).length + " 个）"));
						const bAuto = el("div", "ff-btn", "自动匹配同名图");
						bAuto.addEventListener("click", () => { refPost(n, { action: "autobind" }).then(() => { wrap.remove(); openRefsPanel(n); }).catch((e) => showNote(String((e && e.message) || e))); });
						/* 没有「＋ 新元素」：元素只由 agent 提，用户加的是素材（表格里的 ＋） */
						const bClose = el("div", "ff-btn", "关闭");
						bClose.addEventListener("click", () => wrap.remove());
						head.append(bAuto, bClose);
						box.append(head);
						for (const elx of (j.elements || [])) {
							const row = el("div", "row");
							const imgs = elx.images || [];
							if (imgs.length) {
								const im = el("img");
								im.src = "/filmflow/refs/file?root=" + encodeURIComponent(root) + "&p=" + encodeURIComponent(imgs[0]);
								row.append(im);
							}
							row.append(el("div", "grow", String(elx.name || "") + "　"
								+ (imgs.length ? imgs.length + " 张" : "未绑") + "　· " + (elx.units || []).length + " 个单元"));
							const bBind = el("div", "ff-btn", imgs.length ? "换图" : "绑图");
							bBind.addEventListener("click", () => pickImageFiles((files) => {
								uploadRefs(n, elx.id, files).then(() => { wrap.remove(); openRefsPanel(n); }).catch((e) => showNote(String((e && e.message) || e)));
							}));
							const bSkip = el("div", "ff-btn", elx.state === "skip" ? "恢复参考" : "不用参考");
							bSkip.addEventListener("click", () => {
								refPost(n, { action: "skip", id: elx.id, skip: elx.state !== "skip" })
									.then(() => { wrap.remove(); openRefsPanel(n); })
									.catch((e) => showNote(String((e && e.message) || e)));
							});
							row.append(bBind, bSkip);
							box.append(row);
						}
						wrap.append(box);
						wrap.addEventListener("click", (ev) => { if (ev.target === wrap) wrap.remove(); });
						document.body.append(wrap);
					})
					.catch((e) => showNote("素材库打不开：" + String((e && e.message) || e)));
			}

			/**
			 * 提示词列的内容：平时一行摘要（前 18 字），点开是整段编辑框。
			 * 标题里标出来源（程序拼的草稿 / agent 写的 / 我改过的），让人知道要不要审。
			 */
			function promptCell(n, promptInfo) {
				const box = el("div", "ff-pcell");
				const srcTxt = ({ program: "草稿", agent: "agent", human: "我改的" })[String((promptInfo && promptInfo.source) || "")] || "未写";
				const sum = el("div", "ff-pcell-sum", "");
				const paint = () => {
					const v = String((promptInfo && promptInfo.value) || "").replace(/\s+/g, " ").trim();
					sum.textContent = v ? (v.slice(0, 18) + (v.length > 18 ? "…" : "")) : "（还没写）";
					sum.title = "提示词 · " + srcTxt + (v ? "\n\n" + v : "");
				};
				paint();
				const pop = el("div", "ff-pcell-pop");
				pop.style.display = "none";
				let built = false;
				let labEl = null;
				const build = () => {
					pop.innerHTML = "";
					const ta = el("textarea", "ff-pcell-ta");
					ta.value = String((promptInfo && promptInfo.value) || "");
					ta.rows = 8;
					/* Esc 关掉弹层（不然只能再点一次那格） */
					ta.addEventListener("keydown", (ev) => {
						if (ev.key === "Escape") { ev.stopPropagation(); closePop(); }
					});
					const bar = el("div", "ff-pcell-bar");
					const hint = el("div", "ff-pcell-hint", "点 ▶ 发出去的就是这段");
					const bSave = el("div", "ff-btn p", "保存提示词");
					bSave.addEventListener("click", async (ev) => {
						ev.stopPropagation();
						try {
							await (promptInfo && promptInfo.save ? promptInfo.save(ta.value) : Promise.resolve());
							promptInfo.value = ta.value;
							promptInfo.source = "human";
							paint();
							showNote("提示词已保存", "ok");
							if (labEl) labEl.textContent = "提示词 · 我改的";
							closePop();
						} catch (e) { showNote("保存失败：" + String((e && e.message) || e)); }
					});
					bar.append(hint, bSave);
					labEl = el("div", "ff-pcell-lab", "提示词 · " + srcTxt);
					pop.append(labEl, ta, bar);
				};
				/*
				 * 弹层怎么关（用户 2026-11-04 报「保存了框也不消失」）：
				 * 点外面关、按 Esc 关、保存成功也关 —— 只靠"再点一次那格"是不够的。
				 */
				let docClose = null;
				let foldRestore = null;
				const closePop = () => {
					pop.style.display = "none";
					if (docClose) { document.removeEventListener("click", docClose, true); docClose = null; }
					/* 把折叠框照原样收回去（高度是 px 字符串，原样存原样还） */
					if (foldRestore) {
						foldRestore.clip.style.maxHeight = foldRestore.max;
						foldRestore.clip.style.overflowY = foldRestore.oy;
						foldRestore.clip.scrollTop = foldRestore.scroll;
						foldRestore = null;
					}
				};
				/*
				 * 弹层放哪儿、怎么收（2026-11-04 用户报「保存了框也不消失」「有时候收不到十行」一起修的）：
				 * ① 折叠时那层是滚动框（实测高 278），弹层 231 高 ⇒ 靠下的行必然被裁掉半截，
				 *    所以打开时把折叠框临时全展开，关掉照原样收回去（连滚动位置一起还）。
				 * ② 展开后还有第二个裁剪者（节点正文），下面放不下就翻到这一格上面。
				 * ③ 判定只比 rect；要写高度就用布局像素 —— 画布有 scale，rect 量到的是缩放后的值。
				 */
				const nearestClipper = (node) => {
					for (let e = node.parentElement; e; e = e.parentElement) {
						const st = getComputedStyle(e);
						if (st.overflowY !== "visible" || st.overflowX !== "visible") return e;
					}
					return null;
				};
				const placePop = () => {
					pop.style.top = "";
					pop.style.bottom = "";
					pop.style.maxHeight = "";
					pop.style.overflowY = "";
					const c2 = nearestClipper(pop);
					if (!c2) return;
					const cr = c2.getBoundingClientRect();
					const sr = sum.getBoundingClientRect();
					const pr = pop.getBoundingClientRect();
					if (cr.bottom - sr.bottom >= pr.height + 8) return;
					pop.style.top = "auto";
					pop.style.bottom = "calc(100% + 4px)";
					if (pop.getBoundingClientRect().top >= cr.top + 2) return;
					/* 上下都放不下：留出可视高度，自己在里面滚 */
					pop.style.top = "";
					pop.style.bottom = "";
					pop.style.maxHeight = Math.max(140, Math.round(c2.clientHeight * 0.9)) + "px";
					pop.style.overflowY = "auto";
				};
				const openPop = () => {
					if (!built) { built = true; build(); }
					pop.style.display = "";
					const clip = pop.closest ? pop.closest(".tbl-fold") : null;
					if (clip && String(clip.className).indexOf("tbl-open") < 0) {
						foldRestore = { clip: clip, max: clip.style.maxHeight, oy: clip.style.overflowY, scroll: clip.scrollTop };
						clip.style.maxHeight = "none";
						clip.style.overflowY = "visible";
					}
					placePop();
					if (!docClose) {
						docClose = (ev) => { if (!box.contains(ev.target)) closePop(); };
						/* 下一拍再挂，否则这一下点击自己就把框关了 */
						setTimeout(() => { if (docClose) document.addEventListener("click", docClose, true); }, 0);
					}
				};
				sum.addEventListener("click", (ev) => {
					ev.stopPropagation();
					if (pop.style.display === "none") openPop(); else closePop();
				});
				pop.addEventListener("click", (ev) => ev.stopPropagation());
				box.append(sum, pop);
				return box;
			}
			/** 点了行内「生成」：先定提示词，再交给宿主起任务。 */
			async function genRow(n, no, row, g, running, btn) {
				const p = current();
				if (!p) return;
				if (running) {
					try {
						await post("/filmflow/gen", { action: "cancel", root: p.root, no });
						showNote("已取消这一行", "ok");
					} catch (e) { showNote("取消失败：" + String((e && e.message) || e)); }
					SIG.tree = "";
					await load();
					return;
				}
				/* 提示词：已存的优先（用户可能在行详情里改过），没有再按行内容汇总 */
				const prompt = String((g && g.prompt) || "").trim() || promptOfRow(row);
				if (!prompt) { showNote("这一行还没内容，先写「画面」再说"); return; }
				btn.textContent = "提交中…";
				try {
					const r = await post("/filmflow/gen", { root: p.root, action: "gen", no, prompt, type: "video" });
					if (r && r.ok === false) { showNote("没生成：" + r.error); btn.textContent = "生成"; return; }
					showNote("已提交：镜" + no, "ok");
				} catch (e) {
					showNote("没生成：" + String((e && e.message) || e));
					btn.textContent = "生成";
		return;
	}
				SIG.tree = "";
				await load();
			}

			function renderTableInto(bd, n) {
				const doc = n.doc || {};
				const cols = (Array.isArray(doc.columns) && doc.columns.length ? doc.columns : (n.shape && n.shape.columns) || []);
				const wrap = el("div", "ff-tbl-wrap");
				const table = el("table", "ff-tbl");
				const thead = el("thead");
				const trh = el("tr");
				for (const c of cols) trh.append(el("th", undefined, String((c && (c.label || c.key)) || "")));
				const editable = !!(n.src && n.fileText);
				const genRows = n.genRows && typeof n.genRows === "object" ? n.genRows : null;
				if (genRows) {
					trh.append(
						el("th", "ff-tbl-prefs", "素材"),
						el("th", "ff-tbl-p1", "清晰度"),
						el("th", "ff-tbl-p2", "模型"),
						el("th", "ff-tbl-p3", "比例"),
						el("th", "ff-tbl-p4", "提示词"),
						el("th", "ff-tbl-actsth", ""),
					);
				} else if (editable) {
					trh.append(el("th", "ff-tbl-op", ""));
				}
				if (genRows) trh.append(el("th", "ff-tbl-thumb", "预览"));
				/* 行内生成 + 预览（2026-11-03：生成不再是一个独立节点）—— 两格都是**虚拟列**，不写进 md */

				thead.append(trh);
				if (trh.querySelector(".ff-tbl-prefs")) {
					const th0 = trh.querySelector(".ff-tbl-prefs");
					th0.style.cursor = "pointer";
					th0.title = "点开素材库：全片元素与绑定（绑一次，全片生效）";
					th0.addEventListener("click", (ev) => { ev.stopPropagation(); openRefsPanel(n); });
				}
				table.append(thead);
				const tbody = el("tbody");
				for (const g of doc.groups || []) {
					const p = (g.path || []).filter(Boolean);
					/* 组标题 == 节点标题时不用重复画一行（文件里 `# 分镜脚本` 会被当成组） */
					const dupTitle = p.length && String(p[p.length - 1]).trim() === String(n.title || "").trim();
					if (p.length && !dupTitle) {
						const tr = el("tr", "ff-tbl-grp");
						const td = el("td");
						td.colSpan = Math.max(1, cols.length) + (editable ? 1 : 0) + (genRows ? 3 : 0);
						td.textContent = String(p[p.length - 1]);
						tr.append(td);
						tbody.append(tr);
					}
					/* ★ 生成单元（2026-11-03）：几行脚本格 → **一格视频**（rowspan 竖跨这几行）。*/
					const rowByNo = new Map();
					for (const gg of doc.groups || []) for (const rr of gg.rows || []) rowByNo.set(String(rr && rr.no), rr);
					const unitMap = new Map((Array.isArray(n.units) ? n.units : []).map((u) => [String(u.id), u]));
					const drawnUnits = new Set();
					const drawnParams = new Set();
					const spanCells = new Map(); // unitId → [生成格, 预览格]，详情展开时要跟着加 rowSpan
					for (const row of g.rows || []) {
						const tr = el("tr", "ff-tbl-row");
						for (const c of cols) {
							const td = el("td", undefined, String((row && row[c.key]) ?? ""));
							bindCellEdit(td, n, cols, row, c.key);
							tr.append(td);
						}
						const noU = String((row && row.no) != null ? row.no : "").trim();
						const gsU = genRows ? (genRows[noU] || null) : null;
						const uidAll = String((gsU && gsU.unit) || "");
						/* 只有覆盖 ≥2 镜的单元才竖跨；一镜一单元保持一行一格 */
						/*
						 * 单元一律认（含"一镜一组"）—— 参数 / 提示词 / 生成 / 预览全都挂在单元上；
						 * 只有覆盖 ≥2 镜时才需要竖跨（下面用 spanN0 控制）。
						 * 2026-11-04 修的坑：原来这里把一镜一组的单元直接 return null，
						 * 于是那些行读的是**行级**参数、改也改行级，而生成用的是**单元级** ⇒
						 * agent 把清晰度改成 720p，单镜那些行永远显示旧值、点了也没用。
						 */
						const uU = uidAll ? (unitMap.get(uidAll) || null) : null;
						/* 连接线锚点：这一行属于哪个生成单元（D39，客户端按它算线的终点 y） */
						if (uU) tr.dataset.unit = String(uU.id);
						const spanN0 = uU ? Math.max(1, (uU.covers || []).length) : 1;
						const spanList = []; /* 本行的竖跨格（参数/生成/预览），详情展开时要一起加 rowSpan */
						/* 行尾操作格：▶ 生成（并组时只有组首那一行有） + ✕ 删行 */
						if (genRows || editable) {
							/** 这一行是不是"组首"（没有并组时，自己也算自己那组的首） */
							const isUnitHead = !uU || !drawnUnits.has(String(uU.id));
				/*
				 * 生成参数四列（2026-11-04 用户要求：清晰度 / 模型 / 比例 / 提示词 **各占一列**）。
				 * 并组时这四列 + ▶ + 预览 全部竖跨整组，组内其余行不再重复占格。
				 */
				if (genRows && (!uU || !drawnParams.has(String(uU.id)))) {
					if (uU) drawnParams.add(String(uU.id));
					const spanN = spanN0;
					const P = (uU ? uU.params : (gsU && gsU.params)) || {};
					const tgt = uU ? { id: uU.id } : { no: noU };
					const saveP = (k, v) => {
						P[k] = v;
						post("/filmflow/gen", { root: n.root || (current() && current().root) || "", action: "setParams", ...tgt, params: P })
							.catch((e) => showNote("参数没存上：" + String((e && e.message) || e)));
					};
					const promptInfo = uU
						? {
							unit: true,
							source: String(uU.promptSource || ""),
							value: String(uU.prompt || "") || composeUnitText(uU.covers || [], rowByNo),
							save: (txt) => post("/filmflow/gen", { root: n.root || (current() && current().root) || "", action: "setUnitPrompt", id: uU.id, prompt: txt }),
						}
						: {
							unit: false,
							source: String((gsU && gsU.promptSource) || ""),
							value: String((gsU && gsU.prompt) || "") || promptOfRow(row),
							save: (txt) => post("/filmflow/gen", { root: n.root || (current() && current().root) || "", action: "setPrompt", no: noU, prompt: txt }),
						};

					/* 选项写死在前端：模型/清晰度/比例都是固定枚举，没必要异步拉一次（异步会导致下拉先空后填，踩过） */
					const MODEL_LIST = [
						{ v: "doubao-seedance-2-5-260628", t: "2.5", res: ["480p", "720p", "1080p"], ratios: ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"] },
						{ v: "doubao-seedance-2-0-260128", t: "2.0", res: ["480p", "720p", "1080p", "4k"], ratios: ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"] },
						{ v: "doubao-seedance-2-0-fast-260128", t: "2.0 fast", res: ["480p", "720p", "1080p"], ratios: ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"] },
						{ v: "doubao-seedance-2-0-mini-260615", t: "2.0 mini", res: ["480p", "720p", "1080p"], ratios: ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"] },
					];
					const modelOf = () => MODEL_LIST.find((m) => m.v === (P.model || MODEL_LIST[0].v)) || MODEL_LIST[0];
					const mkSel = (cls, key, fallback) => {
						const td = el("td", "ff-tbl-pcell " + cls);
						td.rowSpan = spanN;
						const sel = el("select", "ff-tbl-psel");
						sel.addEventListener("click", (ev) => ev.stopPropagation());
						const list = key === "model"
							? MODEL_LIST.map((m) => ({ v: m.v, t: m.t }))
							: (key === "resolution" ? modelOf().res : modelOf().ratios).map((v) => ({ v: String(v), t: String(v) }));
						const cur = String(P[key] || "");
						for (const it of list) {
							const o = el("option", undefined, it.t);
							o.value = it.v;
							if (it.v === cur) o.selected = true;
							sel.append(o);
						}
						/*
						 * 参数是稀疏存的（可能只记了清晰度），没记的那几项要显示**宿主真正会用的默认值**：
						 * 模型回落 2.5、清晰度 720p、比例 16:9（host/media/ark.js: ratio 缺省 16:9；
						 * 清晰度缺省不传 = 720p，见 /filmflow/videoopts 的 default）。
						 * 2026-11-04：原来直接选列表第一项 ⇒ 比例显示成 21:9、清晰度显示 480p，人在画布上看到的和实际发出去的不是一回事。
						 */
						if (!cur) {
							const fallback = { model: MODEL_LIST[0].v, resolution: "720p", ratio: "16:9" }[key];
							if (fallback && list.some((x) => String(x.v) === fallback)) sel.value = fallback;
							else if (list.length) sel.value = list[0].v;
						}
						sel.addEventListener("change", () => saveP(key, sel.value));
						td.append(sel);
						return td;
					};

					const tdRefs = refsCell(n, uU, spanN);

					const tdRes = mkSel("ff-tbl-p1", "resolution", "720p");
					const tdMode = mkSel("ff-tbl-p2", "model", "2.5");
					const tdRatio = mkSel("ff-tbl-p3", "ratio", "16:9");
					const tdPrompt = el("td", "ff-tbl-pcell ff-tbl-p4");
					tdPrompt.rowSpan = spanN;
					tdPrompt.append(promptCell(n, promptInfo));
					tr.append(tdRefs, tdRes, tdMode, tdRatio, tdPrompt);
					if (uU && spanN > 1) spanList.push(tdRefs, tdRes, tdMode, tdRatio, tdPrompt);
				}
							const tdAct = el("td", "ff-tbl-acts");
				if (spanN0 > 1) tdAct.rowSpan = spanN0;
							if (genRows && isUnitHead) {
								if (uU) {
									drawnUnits.add(String(uU.id));
									const ust = String(uU.status || "idle");
									const urun = ust === "running" || ust === "queued";
									const ubtn = el("div", "ff-tbl-go" + (urun ? " run" : uU.asset ? " done" : ""), urun ? "◌" : (uU.asset ? "↻" : "▶"));
									ubtn.title = uU.error ? ("上次失败：" + uU.error) : ("这一格管 " + (uU.covers || []).length + " 个镜（镜" + (uU.covers || []).join("/") + "），一次生成一条 " + (uU.durationSec || "?") + " 秒");
									ubtn.addEventListener("click", (ev) => { ev.stopPropagation(); void genUnit(n, uU, urun, ubtn); });
									tdAct.append(ubtn);
								} else {
									const st = String((gsU && gsU.status) || "idle");
									const running = st === "running" || st === "queued";
									const btn = el("div", "ff-tbl-go" + (running ? " run" : gsU && gsU.asset ? " done" : ""), running ? "◌" : (gsU && gsU.asset ? "↻" : "▶"));
									btn.title = gsU && gsU.error ? ("上次失败：" + gsU.error) : "点一下生成这一镜";
									btn.addEventListener("click", (ev) => { ev.stopPropagation(); void genRow(n, noU, row, gsU, running, btn); });
									tdAct.append(btn);
								}
							}
							if (genRows && isUnitHead) { tr.append(tdAct); if (uU && spanN0 > 1) spanList.push(tdAct); }
						}
						/* 预览列：并组时只有组首那行有，竖跨组内所有行 */
						if (genRows) {
							if (uU) {
								if (!spanCells.has(String(uU.id))) {
									const td2 = el("td", "ff-tbl-thumb-cell ff-tbl-span");
									if (spanN0 > 1) td2.rowSpan = spanN0;
									const ua = uU.asset;
									if (ua && ua.src) {
										const uurl = "/filmflow/assets?action=file&root=" + encodeURIComponent(n.root || (current() && current().root) || "") + "&p=" + encodeURIComponent(ua.src);
										if (String(ua.type) === "image") {
											const im = el("img", "ff-tbl-thumb-img");
											im.src = uurl;
											im.title = "点开看大图";
											im.addEventListener("click", (ev) => { ev.stopPropagation(); openViewer({ root: n.root, item: ua }); });
											td2.append(im);
										} else {
											const tag = el("div", "ff-tbl-thumb-tag", String(ua.type) === "audio" ? "♪" : "▸");
											tag.title = "点开播放（这一组那一条）";
											tag.addEventListener("click", (ev) => { ev.stopPropagation(); openViewer({ root: n.root, item: ua }); });
											td2.append(tag);
										}
									}
									tr.append(td2);
									if (spanN0 > 1) {
										spanList.push(td2);
										spanCells.set(String(uU.id), spanList.slice());
									}
								}
							} else {
								const td2 = el("td", "ff-tbl-thumb-cell");
								const a = gsU && gsU.asset;
								if (a && a.src) {
									const url = "/filmflow/assets?action=file&root=" + encodeURIComponent(n.root || (current() && current().root) || "") + "&p=" + encodeURIComponent(a.src);
									if (String(a.type) === "image") {
										const im = el("img", "ff-tbl-thumb-img");
										im.src = url;
										im.title = "点开看大图";
										im.addEventListener("click", (ev) => { ev.stopPropagation(); openViewer({ root: n.root, item: a }); });
										td2.append(im);
									} else {
										const tag = el("div", "ff-tbl-thumb-tag", String(a.type) === "audio" ? "♪" : "▸");
										tag.title = "点开播放";
										tag.addEventListener("click", (ev) => { ev.stopPropagation(); openViewer({ root: n.root, item: a }); });
										td2.append(tag);
									}
								}
								tr.append(td2);
							}
						}
					/*
					 * 行详情（点镜号展开）：显示/编辑这一行汇总出来的提示词。
					 * 用户问「最后汇总出来的提示词需不需要显示出来」—— 要：生成结果不对时，
					 * 先要能看见到底发过去的是什么，再能就地改一句。所以提示词不占表头，折叠在行下面。
					 */
					if (genRows) {
						const no = String((row && row.no) != null ? row.no : "").trim();
						const g2 = genRows[no] || null;
						const uidRow = String((g2 && g2.unit) || "");
						const uRow = uidRow ? unitMap.get(uidRow) : null;
						const mergedRow = !!(uRow && (uRow.covers || []).length >= 2);
						const isUnitRow = !!uRow; /* 有单元就按单元走（含一镜一组） */
						const detail = el("tr", "ff-tbl-detail");
						detail.style.display = "none";
						const dtd = el("td");
						dtd.colSpan = Math.max(1, cols.length) + ((editable || genRows) ? 1 : 0) + (genRows ? 2 : 0);
						const box = el("div", "ff-tbl-detail-box");
						const labTxt = mergedRow
							? ("最终提示词（整组 " + uidRow + " 共用 · 只读；要改请点上面参数卡里的「保存提示词」)")
							: (isUnitRow
								? ("最终提示词（" + uidRow + " = 镜" + (uRow.covers || []).join("/") + "；改了就以改的为准）")
								: "提示词（由这一行汇总；改了就以改的为准）");
						const lab = el("div", "ff-tbl-detail-lab", labTxt);
						const ta = el("textarea", "ff-tbl-detail-ta");
						ta.value = isUnitRow ? (String(uRow.prompt || "") || composeUnitText(uRow.covers || [], rowByNo)) : String((g2 && g2.prompt) || promptOfRow(row) || "");
						ta.readOnly = mergedRow; /* 并组的行：提示词是整组共用的，别在这里单改 */
						ta.rows = 4;
						ta.addEventListener("click", (ev) => ev.stopPropagation());
						const bar = el("div", "ff-tbl-detail-bar");
						const bSave = el("div", "ff-btn", "保存提示词");
						bSave.addEventListener("click", async (ev) => {
							ev.stopPropagation();
							try {
								await post("/filmflow/gen", isUnitRow
									? { root: n.root || (current() && current().root) || "", action: "setUnitPrompt", id: uidRow, prompt: ta.value }
									: { root: n.root || (current() && current().root) || "", action: "setPrompt", no, prompt: ta.value });
								showNote("提示词已保存", "ok");
							} catch (e) { showNote("保存失败：" + String((e && e.message) || e)); }
						});
						/*
						 * 这里**不再放「用这段生成」**（2026-11-04）。
						 * 用户点「保存提示词」，紧挨着的生成按钮被误触，直接花了一次钱。
						 * 生成只留表格里那个 ▶：一个入口，一个动作。
						 */
						/* 「删除这一行」放在这里（表格之外的最后一项），表格里不再有 ✕ 那一列 */
						const bDel = el("div", "ff-btn", "删除这一行");
						bDel.title = "从分镜表里删掉这一行";
						bDel.addEventListener("click", (ev) => {
							ev.stopPropagation();
							if (!editable) return;
							if (!confirm("删掉这一行？")) return;
							const cells = [...tr.children].map((x) => x.textContent).slice(0, cols.length);
							void tableDelRow(n, cells);
						});
						const bClose = el("div", "ff-btn", "收起");
						bClose.addEventListener("click", (ev) => { ev.stopPropagation(); detail.style.display = "none"; });
						if (mergedRow) bSave.style.display = "none";
						bar.append(bSave, bDel, bClose);
						box.append(lab, ta, bar);
						dtd.append(box);
						detail.append(dtd);
						tbody.append(detail);
						/* 点镜号那一格展开/收起 */
						const noCell = tr.children[0];
						if (noCell) {
								noCell.classList.add("ff-tbl-no");
								noCell.title = "点一下看/改这一行的提示词";
								noCell.addEventListener("click", (ev) => {
										ev.stopPropagation();
										const opening = detail.style.display === "none";
										detail.style.display = opening ? "" : "none";
										/* 详情行插在组里：竖跨格的 rowSpan 要跟着加/减，否则整张表从这一行起错位 */
										if (uU && spanCells.has(String(uU.id))) {
											for (const cell of spanCells.get(String(uU.id))) {
												cell.rowSpan = Math.max(1, (cell.rowSpan || 1) + (opening ? 1 : -1));
											}
										}
								});
						}
					}
						tbody.append(tr);
					}
				}
				table.append(tbody);
				wrap.append(table);
				if (editable) {
					const foot = el("div", "ff-tbl-add");
					const addBtn = el("div", "ff-btn", "＋ 加一行");
					addBtn.title = "在表格末尾加一行（镜号自动接下一个）";
					addBtn.addEventListener("click", (ev) => {
						ev.stopPropagation();
						void tableAddRow(n, cols);
					});
					foot.append(addBtn);
					wrap.append(foot);
				}
				bd.append(wrap);
				/*
				 * 文件里没有表格时（宿主把表形态兜成空表骨架），把已有的非表格文字一起显示出来，
				 * 不然创建节点时随手写的字会看不见（2026-11-03）。
				 */
				if (n.leftover) {
					const lo = el("div", "ff-tbl-leftover", "文件里还没有表格，以下是原文：\n" + String(n.leftover));
					lo.style.whiteSpace = "pre-wrap";
					wrap.append(lo);
				}

				/*
				 * 2026-11-06 用户：「把表格收起功能去掉」
				 * ⇒ 不再折成 10 行、不再有展开/收起的手势；表格永远整张显示（节点自己长高）。
				 */
				bd.style.maxHeight = "none";
				bd.style.overflow = "visible";
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
				 * 人名节点（以及标题还空着的节点）：**单击**就进改名，不用双击。
				 * 2026-11-03 用户：「有点难用，要左键单击更改/填写」——
				 * 空白人名框只有一个虚线框，点它一下就应该是「填名字」，不是等双击。
				 */
				const nameEditable = !n.pseudo
					&& (String(n.template || "") === "character-one" || !String(n.title || "").trim());
				if (nameEditable) {
					/* 整块都能点：数字、标题、空白处都算「填名字」 */
					d.style.cursor = "text";
					d.addEventListener("click", (ev) => {
						if (ev.target && ev.target.closest && ev.target.closest(".ff-node-ops")) return;
						ev.stopPropagation();
						startRename(n, tEl);
					});
					tEl.style.cursor = "text";
					tEl.title = "点一下填名字";
					tEl.addEventListener("click", (ev) => {
						ev.stopPropagation();
						startRename(n, tEl);
					});
				}

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
				} else if (!n.pseudo && n.doc && n.doc.kind === "table") {
					/*
					 * 表格形态（分镜脚本）：在画布上画**真表格**，不是一个字一个字的文本。
					 * 用户 2026-11-02：「分镜脚本节点的格式做成表格，横向长度不限」
					 */
					d.className += " tbl";
					renderTableInto(bd, n);
					/*
					 * 2026-11-03 用户：「点开全览后格式变了」—— 之前点表格会切成 markdown 原文。
					 * ⇒ 表格节点**只读展示**：点它不变形；要改原文用右上角 ✎（见 ops 那段）。
					 */
					/* title 由 renderTableInto 按折叠状态设置 */
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
					/* 画风主体没有源文件，但正文照样要能在这里改（保存走 via:look，宿主整组写回画风列） */
					if ((n.src || String(n.via || "") === "look") && !hasSections) {
						bd.title = "点一下直接在画布上改";
						bd.addEventListener("click", (ev) => {
							ev.stopPropagation();
							startEdit(n, bd);
						});
					}
				}
				/*
				 * 参考资料（2026-11-02 用户：「是用来放文件的，不是用来填写的」）：
				 * 它**不画正文框**，只画文件清单 + 选择按钮；正文那套编辑逻辑整块跳过。
				 */
				const isRefNode = String(n.nodeRole || "") === "ref" || String(n.template || "") === "ref-file";
				/* 容器节点（人物）：本节点不装正文，跟参考资料一样不画正文框 */
				const isContainer = !isRefNode && (!!n.noBody || String(n.template || "") === "character");
				/* 画风主体（look-one）：没有「标题 / 正文」之分，整段文字按正常字号显示（用户 2026-11-06） */
				const isLookNode = !isRefNode && String(n.template || "") === "look-one";
				if (isLookNode) { d.className += " look"; d.append(bd); }
				else if (isRefNode || isContainer) d.append(hd);
				else d.append(hd, bd);
				/* 标题空着的节点（刚建的人名节点）：画一个小空白框，提示这里要填东西 */
				if (!n.pseudo && !String(n.title || "").trim()) {
					d.className += " untitled";
					tEl.textContent = "";
					tEl.title = "点我填名字";
				}
				/*
				 * 参考资料（2026-11-02 用户）：正文下面列**只读**的文件清单。
				 * 用户的原话是「作用就是给旁边的 agent 看，在画布上跟其他节点不会有任何互动」
				 * ⇒ 只画文件名和大小，不给 ＋ / ✕ / 拖拽，也没有依赖关系。
				 */
				if (isRefNode) {
					const box = el("div", "ff-refs");
					const refs = Array.isArray(n.refFiles) ? n.refFiles : [];
					box.append(el("div", "ff-refs-hd", refs.length ? "参考文件 " + refs.length + " 个" : "还没有参考文件"));
					for (const f of refs) {
						const kb = f.bytes ? "  " + Math.max(1, Math.round(f.bytes / 1024)) + " KB" : "";
						const row = el("div", "ff-refs-it");
						row.append(el("span", "ff-refs-name", "· " + String(f.path || f.name || "") + kb));
						const del = el("span", "ff-refs-del", "✕");
						del.title = "把这份文件从项目的「参考/」里删掉";
						del.addEventListener("click", (ev) => {
							ev.stopPropagation();
							askConfirm("把「" + String(f.name || f.path) + "」从项目的「参考/」目录里删掉？", () => removeRefFile(n, f));
						});
						row.append(del);
						box.append(row);
					}
					const pick = el("div", "ff-refs-pick", "＋ 选择文件…");
					pick.title = "选 Word(.docx) / TXT / Markdown，会复制进项目的「参考/」目录";
					pick.addEventListener("click", (ev) => { ev.stopPropagation(); pickRefFiles(n); });
					box.append(pick);
					d.append(box);
				}

				/*
				 * 伪节点没有结构操作 —— 它不独立：增删改都归上游文件。
				 * 真节点才有 ＋（新建子节点）↑ ↓（同层移动）✕（删除，宿主查依赖）。
				 */
				if (!n.pseudo) {
					const ops = el("span", "ff-node-ops");
					/*
					 * 用户 2026-11-03：「鼠标一离开节点工具就消失，工具又离那么远，怎么点？」
					 * ⇒ 离开节点后**留 250ms 宽限**（够鼠标滑到按钮上），进按钮再续命；
					 *   真正离开按钮后同样 250ms 才收。纯 CSS :hover 中间那段空隙会闪没。
					 */
					let opsTimer = 0;
					const showOps = () => { if (opsTimer) { clearTimeout(opsTimer); opsTimer = 0; } d.className += " ops-on"; };
					const hideOpsSoon = () => {
						if (opsTimer) clearTimeout(opsTimer);
						opsTimer = setTimeout(() => { opsTimer = 0; d.className = d.className.replace(/\s*ops-on/g, ""); }, 250);
					};
					d.addEventListener("mouseenter", showOps);
					d.addEventListener("mouseleave", hideOpsSoon);
					ops.addEventListener("mouseenter", showOps);
					ops.addEventListener("mouseleave", hideOpsSoon);
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
					/* 表格节点：看是表格，改要进原文编辑（✎） */
					if (n.doc && n.doc.kind === "table") {
						const editTbl = el("button", "ff-op", "✎");
						editTbl.title = "编辑 markdown 原文（表格按原文渲染）";
						editTbl.addEventListener("click", (ev) => { ev.stopPropagation(); startEdit(n, bd); });
						ops.append(editTbl);
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
				/* 连接线起点：连接线按这个 key 找图片节点（D39） */
				d.dataset.nodeKey = String(n.key || "");
				/* 节点就是相框本身：内边距留 0，图片直接占满（用户 2026-11-05） */
				d.style.padding = "0";
				const media = n.media || {};
				const model = MEDIA_MODELS || { image: {}, video: {}, audio: {} };

				/* 标题行：编号 + 标题 + 结构操作 */
				const hd = el("div", "ff-node-hd");
				/*
				 * 图片节点不再显示标题（用户 2026-11-06）：自动建出来的参考图容器名字就是「<主体> 参考图」，
				 * 上游主体已经写着；用户自己起的名字（不带「参考图」后缀）照旧显示。
				 */
				const hideTitle = /参考图\s*$/.test(String(n.title || ""));
				if (hideTitle) {
					hd.append(el("span", "ff-node-no", n.no ? String(n.no) : ""));
					d.className += " notitle";
				} else {
					hd.append(el("span", "ff-node-no", n.no ? String(n.no) : ""), el("span", "ff-node-t", String(n.title || "")));
				}
				if (!inGrid) {
					const ops = el("span", "ff-node-ops");
					/*
					 * 2026-11-02：生成类节点不再一律当叶子 —— 「生成视频」下面要能挂
					 * 画风/色彩/光影/风格（用户：这些挂在视频生成节点的下游）。
					 * 给不给 ＋ 不看 kind，看宿主算出来的 canAdd：空 = 真叶子。
					 */
					if (Array.isArray(n.canAdd) && n.canAdd.length) {
						const addM = el("button", "ff-op", "＋");
						addM.title = "在这里加节点";
						addM.addEventListener("click", (ev) => { ev.stopPropagation(); openTplMenu(addM, n); });
						ops.append(addM);
					}
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
				/* 参考图（D39）：没有生成图时，预览框里就显示这张主体的参考图（用户：图就放预览框里） */
				const refImgs = Array.isArray(n.mediaImages) ? n.mediaImages : [];
				const refFirst = refImgs[0] || null;
				const refSrc = refFirst
					? "/filmflow/refs/file?root=" + encodeURIComponent(n.root || current()?.root || "") + "&p=" + encodeURIComponent(refFirst.src)
					: "";
				const box = el("div", "ff-media-thumb " + (type === "audio" ? "audio" : ""));
				if (type !== "audio") {
					/* 图片：宽度占满节点、高度跟着图走（用户 2026-11-05） */
					if (type === "image") { box.style.width = "100%"; box.style.height = "auto"; }
					else box.style.width = boxW + "px";
					if (type !== "image") box.style.height = Math.round((boxW * ratio[1]) / ratio[0]) + "px";
				}
				if (last && type === "image") {
					const img = el("img");
					img.src = src;
					img.loading = "lazy";
					box.append(img);
				} else if (!last && type === "image" && refFirst) {
					/* 没有生成图 → 预览框显示参考图；生成了新图就替换成生成图 */
					const img = el("img");
					img.src = refSrc;
					img.loading = "lazy";
					box.className += " hasref";
					box.append(img, el("div", "ff-media-ref-tag", "参考图"));
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

				/*
				 * 图片节点兼容器（D39）：节点里的图 = 这个主体的参考图。
				 * 用户 2026-11-05 第 2 条：「参考图不要自己新找一个地方放，直接放在生成的图片的预览框里，
				 * 如果有新生成的图片就替换掉」⇒ 预览框显示 latest 生成图，没有就显示参考图；
				 * 上传/换图/删图都做成预览框上的小按钮，不再单开一条缩略图区。
				 */
				if (type === "image" && !inGrid) {
					const opsImg = el("div", "ff-media-refops");
					const bAddImg = el("button", "ff-media-addimg", refFirst ? "换参考图" : "＋ 上传参考图");
					bAddImg.title = "本地图片 / 素材库任意项目的图（一个主体一个图片节点；三视图放一张）";
					bAddImg.addEventListener("click", (ev) => {
						ev.stopPropagation();
						openImageNodePicker(n);
					});
					opsImg.append(bAddImg);
					if (refFirst) {
						const bDelImg = el("button", "ff-media-addimg", "删参考图");
						bDelImg.addEventListener("click", async (ev) => {
							ev.stopPropagation();
							try {
								await post("/filmflow/media-node", { root: n.root || current()?.root || "", key: n.key, action: "remove", src: refFirst.src });
								SIG.tree = "";
								await load();
							} catch (e) { errLine.textContent = String((e && e.message) || e); }
						});
						opsImg.append(bDelImg);
					}
					box.append(opsImg);
				}

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
							showNote("已改名并自动统一：" + String(n.title || "") + " → " + title
								+ "（其它 " + au.files.length + " 个文件共 " + au.total + " 处）", "ok");
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
			/**
			 * 在 parent 下建一个子节点。
			 * 2026-11-02 用户：「点人物节点的加号之后，下游自动新建一个看起来完全空白的节点」。
			 * ⇒ 人物·单人建出来是**空标题**，这里顺手进入改名状态，人直接填名字。
			 */
			async function addChildUnder(parent, tpl) {
				closeLayer(".ff-tpl");
				const done = structure({ type: "add", at: parent.key || "", template: tpl.id });
				if (String(tpl.id) !== "character-one") return done;
				await Promise.resolve(done);
				await new Promise((r) => setTimeout(r, 250));
				const empty = [...document.querySelectorAll(".ff-node:not(.pseudo)")]
					.find((x) => { const e = x.querySelector(".ff-node-t"); return e && !String(e.textContent || "").trim(); });
				const tEl = empty && empty.querySelector(".ff-node-t");
				if (tEl) tEl.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
				return done;
			}

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
				/* 只有一个合法下位时，＋ **直接建**，不弹菜单（人物 → 人物·单人 就是这种） */
				if (legal.length === 1) {
					void addChildUnder(parent, legal[0]);
					return;
				}

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
							void addChildUnder(parent, t);
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
					showNote("结构没改成：" + String((e && e.message) || e));
					return undefined;
				}
				if (r && r.ok === false) {
					showNote("结构没改成：" + r.error);
					return undefined;
				}
				hideNote();
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
					/*
					 * ★ 收起开关必须跟子节点待在**同一列**（2026-11-03 修）。
					 *
					 * 原来它自己独占一列（节点 → kids(开关) → kids(真子节点) 三列），
					 * drawConnectors 只走第一列 ⇒ 真子节点整列没有导线、孙节点更走不到，
					 * 用户截图报的「唐老板后面那个 性格 没有导线」就是它。
					 * 挪进同一列之后，开关就是"第一个孩子"，父节点照常连到每个孩子。
					 */
					const less = el("div", "ff-more");
					less.textContent = "▼ 收起这 " + kids.length + " 个下级";
					const col = el("div", "ff-kids");
					const row = el("div", "ff-tree");
					row.append(less);
					col.append(row);
					appendKids(col, kids);
					less.addEventListener("click", (ev) => {
						ev.stopPropagation();
						EXPANDED.delete(String(n.key));
						SIG.tree = "";
						draw();
					});
					wrap.append(col);
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
			/**
			 * 把表格节点钉到总节点左边（D39）。画布不许拖，位置全由布局算：
			 * 左缘 = 总节点左缘 - 表格宽 - 28，顶 = 总节点顶（与标题行对齐）。
			 * @returns {{table: Element, root: Element}|null}
			 */
			function pinTable(world) {
				const tblNode = world.querySelector(".ff-node.tbl");
				const tree = world.querySelector(":scope > .ff-tree");
				const rootNode = tree ? tree.querySelector(":scope > .ff-node") : null;
				if (!tblNode || !rootNode) return null;
				const s = VIEW.s || 1;
				/* 先转成绝对定位（宽度会变），再按"屏幕差值"挪 —— 不依赖 offsetParent 是哪层 */
				if (tblNode.style.position !== "absolute") {
					tblNode.style.position = "absolute";
					tblNode.style.zIndex = "2";
					tblNode.style.left = "0px";
					tblNode.style.top = "0px";
				}
				const rr = rootNode.getBoundingClientRect();
				let b = tblNode.getBoundingClientRect();
				/* ① 横向：右缘距总节点左缘 28px */
				let curLeft = parseFloat(tblNode.style.left) || 0;
				const wantRight = rr.left - 28;
				tblNode.style.left = (curLeft + (wantRight - b.right) / s).toFixed(1) + "px";
				/* ② 纵向：顶对齐总节点标题行 */
				b = tblNode.getBoundingClientRect();
				let curTop = parseFloat(tblNode.style.top) || 0;
				tblNode.style.top = (curTop + (rr.top - b.top) / s).toFixed(1) + "px";
				return { table: tblNode, root: rootNode };
			}

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
				 * 表格钉在总节点左边（用户 2026-11-05：「表格的位置将单独固定在总节点的左边，
				 * 由一根导线连接，无论其在画布上的建立时间」；画布**不许手动拖动**，全靠布局算）。
				 * 挂在 drawConnectors 开头：每次重画布局都重新算，与建立顺序无关。
				 */
				const pinned = pinTable(world);

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
					/* 接线高度 = **整块节点的垂直中心**（用户 2026-11-05：从节点中间连，不管多大） */
					const nrAll = rel(node);
					const cy = (nrAll.t + nrAll.b) / 2;
					/*
					 * ★ 一棵树的直接子列可能**不止一个**（历史上「收起开关」自己占一列，真子节点在下一列）。
					 * 只认第一列 ⇒ 真子节点整列连不上导线，它们的孙节点也跟着一根线都没有
					 * （2026-11-03 实测：唐老板 → 性格 那根线完全没有，用户截图报的就是这个）。
					 * ⇒ 把所有直接子列都收进来，一个孩子都不落。
					 */
					const childTrees = [...tree.querySelectorAll(":scope > .ff-kids")]
						.flatMap((kc) => [...kc.children].filter((c) => c.tagName === "DIV"))
						/*
						 * 表格节点已经由 pinTable 钉到总节点左边（D39）：
						 * 它**不再是树里的孩子**，否则会在树的括号上多画一条、和表格→总节点那根导线重复
						 * （用户 2026-11-05 截图："为什么有两条线"）。
						 */
						.filter((c) => !(c.matches && c.matches(".ff-node.tbl")) && !(c.querySelector && c.querySelector(":scope > .ff-node.tbl")));
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
						/* 孩子也从**整块节点中心**接（同样的口径） */
						const ctr = rel(cn);
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
				/* 表格 → 总节点的**导线**（实线，短横；表格已由 pinTable 摆到左边） */
				if (pinned) {
					const a = rel(pinned.table);
					const r2 = rel(pinned.root);
					const tx = a.r + 2;
					const ty = (a.t + a.b) / 2;
					const rx = r2.l - 2;
					const ry = r2.t + 14;
					const mid = Math.max(tx + 12, rx - 12);
					d.push("M " + tx.toFixed(1) + " " + ty.toFixed(1)
						+ " H " + mid.toFixed(1)
						+ " V " + ry.toFixed(1)
						+ " H " + rx.toFixed(1));
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
				/* 连接线（D39）跟着同一份布局重画：常显、虚线、不进表格 */
				try { drawLinks(world); } catch { /* 画失败不影响画布 */ }
			}

			/**
			 * 连接线（D39）：图片节点 → 表格里每个引用它的生成单元。
			 *
			 * 用户 2026-11-05 定的四条：①**常显**；②从图片节点起，另一头指向"生成单元的行"，
			 * **不要插进表格里面**（终点落在表格左缘、与那一行同高）；③一个主体只允许一个图片节点；
			 * ④画布不许手动拖拽 —— 位置全由布局算，这里只画，不参与布局。
			 */
			function drawLinks(world) {
				const NS = "http://www.w3.org/2000/svg";
				const old = world.querySelector("svg.ff-links");
				if (old) old.remove();
				const p0 = current();
				if (!p0) return;
				const tables = [];
				const walk = (n) => {
					if (!n) return;
					if (n.doc && n.doc.kind === "table" && Array.isArray(n.linkNodes) && n.linkNodes.length) tables.push(n);
					for (const c of n.children || []) walk(c);
				};
				for (const s of p0.stages || []) walk(s);
				if (!tables.length) return;
				const tbl = world.querySelector("table.ff-tbl");
				if (!tbl) return;
				const W = world.scrollWidth;
				const H = world.scrollHeight;
				if (!W || !H) return;
				const NS2 = NS;
				const svg = document.createElementNS(NS2, "svg");
				svg.setAttribute("class", "ff-links");
				svg.setAttribute("width", String(W));
				svg.setAttribute("height", String(H));
				svg.setAttribute("viewBox", "0 0 " + W + " " + H);
				svg.setAttribute("aria-hidden", "true");
				const wr = world.getBoundingClientRect();
				const s = VIEW.s || 1;
				const rel = (r) => ({
					l: (r.left - wr.left) / s, r: (r.right - wr.left) / s,
					t: (r.top - wr.top) / s, b: (r.bottom - wr.top) / s,
				});
				const tblBox = rel(tbl.getBoundingClientRect());
				/*
				 * 终点 = 表格**右缘**外 2px（用户 2026-11-05 第 1 条）：
				 * 表格钉在总节点左边，右侧才是画面主体所在的地方，从右边进不用绕一大圈；
				 * 仍然不进表格内部，只是贴着右缘、与那一行同高。
				 */
				const endX = tblBox.r + 2;
				let drawn = 0;
				for (const t of tables) {
					for (const link of t.linkNodes || []) {
						const startKey = String(link.subjectKey || link.nodeKey || "");
						const nodeEl0 = world.querySelector('[data-node-key="' + startKey.replace(/"/g, '\\"') + '"]') || world.querySelector('[data-node-key="' + String(link.nodeKey || "").replace(/"/g, '\\"') + '"]');
						if (!nodeEl0) continue;
						/* 连接线起点 = **主体节点左缘**垂直中心（用户 2026-11-05：统一从主体节点向左出发） */
						const a = rel(nodeEl0.getBoundingClientRect());
						const ax = a.l - 2;
						const ay0 = (a.t + a.b) / 2;
						const spread = Math.max(0, (a.b - a.t) / 2 - 14);
						let kLine = 0;
						for (const unitId of link.units || []) {
							const rows = tbl.querySelectorAll('tr[data-unit="' + String(unitId).replace(/"/g, '\\"') + '"]');
							if (!rows.length) continue;
							const first = rows[0];
							if (!first.getClientRects().length) continue;
							const raw = first.getBoundingClientRect();
							/* 表格是内部滚动的：只有落在**滚动视口**里的行才画线，收起/滚出去的不画 */
							let vp = tbl.parentElement;
							while (vp && vp !== world) {
								const ov = getComputedStyle(vp).overflowY;
								if (ov === "auto" || ov === "scroll") break;
								vp = vp.parentElement;
							}
							const rawTbl = (vp && vp !== world) ? vp.getBoundingClientRect() : tbl.getBoundingClientRect();
							if (raw.top < rawTbl.top - 1 || raw.bottom > rawTbl.bottom + 1) continue;
							const rb = rel(raw);
							/* 表格收起/折叠后这一行没有高度（或不在可视区）⇒ 这条线也不画（用户 2026-11-05 第 2 条） */
							if (!(rb.b - rb.t > 2)) continue;
							if (!(rb.l > -1e5)) continue;
							const by = (rb.t + rb.b) / 2;
							/* 从节点先横向出线，弯在远处收 —— 贴着一个点扇形发散很难看 */
							const dir = endX >= ax ? 1 : -1;
							const dx = Math.max(56, Math.abs(endX - ax) * 0.5);
							const ay = ay0;
							/* 自然弧线：节点左缘 → 表格右缘那一行（三次贝塞尔，水平进出） */
							const dirX = endX >= ax ? 1 : -1;
							const dArc = Math.max(40, Math.abs(endX - ax) * 0.45);
							const path = document.createElementNS(NS2, "path");
							path.setAttribute("d", "M" + ax.toFixed(1) + "," + ay.toFixed(1)
								+ " C" + (ax + dirX * dArc).toFixed(1) + "," + ay.toFixed(1)
								+ " " + (endX - dirX * dArc).toFixed(1) + "," + by.toFixed(1)
								+ " " + endX.toFixed(1) + "," + by.toFixed(1));
							path.setAttribute("class", "ff-link-line");
							path.dataset.element = String(link.elementId || "");
							path.dataset.unit = String(unitId);
							svg.append(path);
							drawn += 1;
						}
						/* 不画端点圆点：一堆线收成一个点很难看（用户 2026-11-05） */
					}
				}
				if (drawn) world.insertBefore(svg, world.firstChild);
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

			/*
			 * ★★ 2026-11-03：**agent 一开工，就把右侧对话切到它那条会话**。
			 *
			 * 为什么非切不可：DSH 那个蓝圈停止键，停的是**界面当前显示的那条会话**。
			 * 宿主在 A 上跑活、界面停在 B ⇒ 按停止 = cancel 一条空闲会话
			 * ⇒ client 把错误静默吞掉 ⇒ 用户看到的就是「停止键没用」。
			 * 切过去之后，同一个 agent 对象既在画布上可暂停，也在对话里停得下。
			 */
			let lastRunKey = "";
			function followRun(p) {
				try {
					if (!p || !p.agent || !p.agent.busy) return;
					const key = String(p.root) + "|" + String(p.agent.startedAt || "");
					if (key === lastRunKey) return;
					lastRunKey = key;
					fetch("/filmflow/session?root=" + encodeURIComponent(p.root), { headers: { accept: "application/json" } })
						.then((r) => (r.ok ? r.json() : null))
						.then((j) => {
							const sid = String((j && j.sessionId) || "");
							if (!sid) return;
							let cur = "";
							try {
								cur = String((JSON.parse(localStorage.getItem("dsh.sessions.current") || "{}") || {}).sessionId || "");
							} catch { /* 忽略 */ }
							if (cur === sid) return;
							if (!ACTIVE_CTX || !ACTIVE_CTX.uiWorkspace) return;
							ACTIVE_CTX.uiWorkspace.openSession(sid);
							try { localStorage.setItem("ff.sess." + p.root, sid); } catch { /* 忽略 */ }
							diag("agent 开工 → 把对话切到它的会话 " + sid);
						})
						.catch(() => { /* 切不过去也不影响干活 */ });
				} catch { /* 这一拍读不到就算了 */ }
			}

			/** 重画工具条。 */
			function drawBar(p) {
				if (!p) { chips.innerHTML = ""; return; }
				followRun(p);
				/* agent 在跑才给「暂停」—— 状态来自宿主算出来的真实状态，不是本地标志 */
				try {
					const ag = p.agent || {};
					btnPause.className = "ff-btn w" + (ag.busy ? "" : " off");
					if (ag.busy) btnPause.textContent = "暂停";
				} catch { /* 状态读不到就不显示 */ }
				/* 2026-10-29：story/board 授权锁已撤，工具条不再有锁 chip。 */
				/* 顶栏不再显示「待对齐」计数（用户 2026-10-27：这几项都不必显示）。 */
				/* 出错提示已挪到顶栏下面的消息条（showNote），这里不再清它 ——
				   2026-11-02 用户说清了就只亮 2 秒、看不清。 */
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
					 * ★ 盯的是**根树的盒子**，不是 world 的盒子（2026-11-03 修）。
					 *
					 * 原来那个 ResizeObserver 只观察 world：world 是铺满舞台的定尺寸容器（实测 1100px 高，
					 * 内容 1036px），内容变高变矮它一点不动 ⇒ 永远不触发。
					 * 那个「每 2 秒比 svg 尺寸 vs world.scrollHeight」的哨兵同样失效（svg 自己撑着 scrollHeight）。
					 * 实测现场：分镜脚本那张表在 1200ms 补算折叠高度，矮下 126px，根节点（align-items:center）
					 * 跟着上移 63px，三条导线留在老位置 —— 屏幕上就是「线从节点旁边的空气里长出来」。
					 * ⇒ 换成盯根树：高度一变就在下一帧重画（用现成的 redrawLines，帧级防抖）。
					 */
					if (linesRO && world._ffObsTree !== top) {
						try { if (world._ffObsTree) linesRO.unobserve(world._ffObsTree); } catch { /* 忽略 */ }
						linesRO.observe(top);
						world._ffObsTree = top;
					}
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
					return true;
				} catch (err) {
					showNote("读不到状态：" + String((err && err.message) || err), "warn");
					return false;
				}
			}

			// ── 交互 ──────────────────────────────────────────────────
			// 回项目菜单：这边的画布只是"里层"，导航交给外层的菜单面板
			btnBack.addEventListener("click", () => { if (onBack) onBack(); });
			btnFit.addEventListener("click", () => fit());
			/*
			 * 刷新（2026-11-04 用户「点了没反应」）：
			 * 原来只做 `SIG.tree=''; load()` —— 请求确实发了、DOM 也重建了，
			 * 但画布本来每 ~2 秒就自动轮询一次，数据早就是新的；重建出来的画面一模一样，
			 * 也没任何提示 ⇒ 看起来像死键。
			 * 现在：按钮就地变「刷新中…」→「已刷新」（失败「刷新失败」），
			 * 同时把撤销/重做状态也刷新；按住 Shift 点 = 顺便重新适配视图。
			 */
			btnReload.title = "重新读一次状态（Shift 点 = 顺便重新适配视图）";
			btnReload.addEventListener("click", async (ev) => {
				if (btnReload.dataset.busy === "1") return;
				btnReload.dataset.busy = "1";
				btnReload.className = "ff-btn busy";
				btnReload.textContent = "刷新中…";
				const t0 = Date.now();
				SIG.tree = "";
				let ok = false;
				try { ok = await load(); } catch { ok = false; }
				const sec = ((Date.now() - t0) / 1000).toFixed(1);
				btnReload.className = "ff-btn";
				btnReload.textContent = ok ? ("已刷新 " + sec + "s") : "刷新失败";
				setTimeout(() => {
					btnReload.textContent = "刷新";
					btnReload.className = "ff-btn";
					delete btnReload.dataset.busy;
				}, 1400);
			});
		}
		/*
		 * 画布素材引用（2026-11-06，用户原话）：
		 *   「不要艾特，改成旁边加号点开选择画布上的素材。」
		 *   「我说的加号就是原有的这个添加节点按钮。」「添加文件按钮的原功能要保留啊」
		 *   「点开之后只有文字描述，要有很小的图」「菜单栏不要出现在下面」
		 *   「选择了之后输入框里要出现选择了的图片的缩小版，
		 *     直接在用户发给agent的文字信息中精准指向所引用的图片」
		 *
		 * 做法：**不自建按钮**。官方 ＋（添加文件或调用指令）弹出菜单时，在菜单最上面插一条
		 * 「🖼 引用画布素材…」；点它把选择面板弹在输入框**上方**（缩略图 + 名字 + 路径），
		 * 选中后往输入框插「@图[名字](相对路径)」，并在 token 左侧贴一张 16px 缩略图 ——
		 * 文字是给 agent 的精确指路，小图是给人看的。
		 */
		function initComposerMentions() {
			const TOKRE = /@图\[([^\]\n]*)\]\(([^)\n]+)\)/g;
			let picker = null;
			let items = [];
			let active = 0;
			let savedRange = null;
			let pickerOpen = false;   /* 面板是否「应该」显示：异步返回后据此决定要不要再摆一次 */
			let curRoot = "";
			const INSERTED = [];   /* 本次会话插过的胶囊（拿不到草稿投影时用） */

			/* 缩略图 URL 要用 root：早点拿到，免得每次启动先发一串 400 */
			fetch("/filmflow/state", { headers: { accept: "application/json" } })
				.then((r) => r.json())
				.then((st) => { const v = String((st && st.current) || ""); if (v) curRoot = v; })
				.catch(() => { /* 忽略 */ });

			const boxOf = (n) => {
				const e = n && n.nodeType === 1 ? n : (n && n.parentElement) || null;
				try { return e ? e.closest('[role="textbox"]') : null; } catch { return null; }
			};
			const hostOf = (box) => (box && box.querySelector('[contenteditable="true"]')) || box || null;
			const urlOf = (src, root) => {
				const rel = String(src || "").replace(/\\/g, "/").replace(/^\/+/, "");
				if (!rel) return "";
				if (rel.indexOf(".film/assets/") === 0) {
					return "/filmflow/assets?action=file&root=" + encodeURIComponent(root) + "&p=" + encodeURIComponent(rel);
				}
				return "/filmflow/refs/file?root=" + encodeURIComponent(root) + "&p=" + encodeURIComponent(rel);
			};
			const urlFor = (src) => urlOf(src, curRoot);
			/* mention 里放**节点 key**（稳定唯一），不是显示标题；列表里看到的仍是 label */
			const tokenOf = (it) => "@图[" + String(it.key || it.label) + "](" + String(it.src) + ")";

			const hide = () => { pickerOpen = false; if (picker) picker.style.display = "none"; };

			/* token 在输入框里可能被拆进多个文本节点（官方内容分段渲染），
			   所以按"整段 textContent 的字符坐标"找，再映射回（节点, 偏移）。 */
			const textSegs = (host) => {
				const segs = [];
				let pos = 0;
				const tw = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
				while (tw.nextNode()) {
					const n = tw.currentNode;
					const len = String(n.nodeValue || "").length;
					if (len) segs.push({ n: n, start: pos, end: pos + len });
					pos += len;
				}
				return { segs: segs, total: pos };
			};
			const posOf = (segs, idx) => {
				let last = null;
				for (const s of segs) {
					if (idx >= s.start && idx < s.end) return { n: s.n, off: idx - s.start };
					if (idx === s.end) last = { n: s.n, off: s.end - s.start };
					if (idx < s.start) break;
				}
				return last;
			};
			const rectOfToken = (host, token, nth) => {
				if (!token) return null;
				const flat = textSegs(host);
				const txt = String(host.textContent || "");
				let seen = 0;
				let from = 0;
				for (;;) {
					const k = txt.indexOf(token, from);
					if (k < 0) return null;
					if (seen === nth) {
						const a = posOf(flat.segs, k);
						const b = posOf(flat.segs, k + token.length);
						if (a && b) {
							try {
								const rg = document.createRange();
								rg.setStart(a.n, a.off);
								rg.setEnd(b.n, b.off);
								const r = rg.getBoundingClientRect();
								if (r && r.width) return r;
							} catch { /* 忽略 */ }
						}
					}
					seen++;
					from = k + token.length;
				}
			};

			/* 输入框里的 token 旁边贴小图；token 被删掉，图跟着消失 */
			/* 当前草稿的「剪贴板投影」：chip 会展开成完整 mention（这就是发给 agent 的文本） */
			/* 会话 id 候选：先本机记的「上次在看的」，再主视图保留的，最后全部 */
			const sidCandidates = () => {
				const out = [];
				const push = (v) => { const s = String(v || ""); if (s && out.indexOf(s) < 0) out.push(s); };
				try { push(localStorage.getItem("ff.sess." + curRoot)); } catch { /* 忽略 */ }
				let byId = null;
				try {
					const st = ACTIVE_CTX && ACTIVE_CTX.sessions && ACTIVE_CTX.sessions.list ? ACTIVE_CTX.sessions.list.getSnapshot() : null;
					byId = st && st.byId ? st.byId : null;
				} catch { byId = null; }
				if (byId) {
					const rest = [];
					for (const id of Object.keys(byId)) {
						const row = byId[id];
						const rb = row && row.retainedBy ? row.retainedBy : null;
						if (rb && (rb.mainView || rb.conversation || rb.composer)) push(id);
						else rest.push(id);
					}
					for (const id of rest) push(id);
				}
				return out;
			};
			/* 会话输入门面（拿到就记住；失败返回 null） */
			const shellOf = (sid) => {
				try {
					if (!MENTION_HUB || typeof MENTION_HUB.shell !== "function") return null;
					return MENTION_HUB.shell(sid) || null;
				} catch { return null; }
			};
			/*
			 * 找到「界面上这个输入框」对应的门面：
			 * 判据是 shell 自己的 Lexical editor 就挂在眼前这个 contenteditable 上 ——
			 * 比猜 session id 可靠（本地记的那个可能已经不在了）。
			 */
			const shellForComposer = (host) => {
				const same = (sh) => {
					try {
						const ed = sh && sh.editor;
						const root = ed && (typeof ed.getRootElement === "function" ? ed.getRootElement() : ed._rootElement);
						if (!root || !host) return false;
						return root === host || root.contains(host) || host.contains(root);
					} catch { return false; }
				};
				if (LAST_SHELL && same(LAST_SHELL)) return LAST_SHELL;
				LAST_SHELL = null;
				for (const sid of sidCandidates()) {
					const sh = shellOf(sid);
					if (!sh || typeof sh.insertReference !== "function") continue;
					if (same(sh)) { LAST_SHELL = sh; return sh; }
				}
				return null;
			};
			/* 当前草稿的「剪贴板投影」：chip 会展开成完整 mention（这就是发给 agent 的文本） */
			const draftNow = () => {
				const sh = LAST_SHELL || shellForComposer(hostOf(document.querySelector('[role="textbox"]')));
				if (!sh) return "";
				try {
					const st = sh.state && sh.state.getSnapshot ? sh.state.getSnapshot() : null;
					return st ? String(st.draft || "") : "";
				} catch { return ""; }
			};

			/* 官方引用胶囊：外壳带 data-composer-chip，里面那个 span 才是可见的胶囊 */
			/* 胶囊所在**那一行字**的盒子：缩略图要跟文字对齐，不是跟 14px 的胶囊对齐 */
			const lineBoxOf = (chip) => {
				try {
					const para = (chip && (chip.closest("p") || (chip.parentElement && chip.parentElement.parentElement))) || null;
					if (!para) return null;
					const tw = document.createTreeWalker(para, NodeFilter.SHOW_TEXT);
					while (tw.nextNode()) {
						const t = tw.currentNode;
						if (!String(t.nodeValue || "").trim()) continue;
						const rg = document.createRange();
						rg.selectNodeContents(t);
						const r = rg.getBoundingClientRect();
						if (r && r.height) return r;
					}
				} catch { /* 忽略 */ }
				return null;
			};

			const chipElsOf = (host) => Array.from(host.querySelectorAll("[data-composer-chip]")).map((w) => w.querySelector("span") || w);

			/* 输入框里的引用旁边贴小图；引用被删掉，图跟着消失 */
			/* 输入框里的引用：在胶囊的位置上贴一张「字那么高」的小图（宽 ≈1.8 个字） */
			/*
			 * 输入框里的引用：在胶囊的槽位上贴一张「字那么高」的小图（宽 ≈1.8 个字）。
			 * 注意：**先无条件清理多余的小图**，再按需布置 —— 否则换屏幕/切项目后，
			 * 那些 position:fixed 的图会留在画面上（用户 2026-11-06：「胶囊会穿模」）。
			 */
			const syncChips = () => {
				const box = document.querySelector('[role="textbox"]');
				const host = hostOf(box);
				const have = Array.prototype.slice.call(document.querySelectorAll("img.ff-at-inline"));
				const want = [];
				let FH = 14;
				let IW = 25;
				if (host && curRoot) {
					try { FH = Math.round(parseFloat(getComputedStyle(host).fontSize) || 14); } catch { /* 忽略 */ }
					IW = Math.round(FH * 1.8);
					/* ① 官方胶囊：横向用胶囊的槽位，纵向用「这一行文字」的中心 */
					const draft = draftNow();
					const chips = chipElsOf(host);
					if (chips.length) {
						const mentions = [];
						TOKRE.lastIndex = 0;
						let mm = TOKRE.exec(draft);
						while (mm) { mentions.push({ token: mm[0], src: mm[2] }); mm = TOKRE.exec(draft); }
						const list = mentions.length === chips.length ? mentions
							: INSERTED.slice(INSERTED.length - chips.length).map((x) => {
								const mt = /@图\[[^\]]*\]\(([^)]+)\)/.exec(x.mention);
								return { token: x.mention, src: mt ? mt[1] : "" };
							});
						for (let i2 = 0; i2 < chips.length && i2 < list.length; i2++) {
							if (!list[i2].src) continue;
							const cr = chips[i2].getBoundingClientRect();
							if (!cr.width) continue;
							/* 胶囊必须在看得见的输入框里（换屏幕后别留着） */
					/* 输入框被别的层（片库/项目菜单）盖住时，别在它上面飘一张图 */
					try {
						const hit = document.elementFromPoint(Math.round(cr.left + cr.width / 2), Math.round(cr.top + cr.height / 2));
						if (!hit || !(hit === host || host.contains(hit))) continue;
					} catch { /* 忽略 */ }
							if (cr.bottom < 0 || cr.top > window.innerHeight) continue;
							const lb = lineBoxOf(chips[i2]);
							want.push({
								key: list[i2].token + "#" + i2,
								src: list[i2].src,
								chip: true,
								cx: cr.left + cr.width / 2,
								cy: lb ? (lb.top + lb.height / 2) : (cr.top + cr.height / 2),
							});
						}
					}
					/* ② 退路：纯文本 token（没插成胶囊时） */
					const txt = String(host.textContent || "");
					const nthOf = {};
					TOKRE.lastIndex = 0;
					let m = TOKRE.exec(txt);
					while (m) {
						const key = m[0];
						const nth = nthOf[key] || 0;
						nthOf[key] = nth + 1;
						const r = rectOfToken(host, key, nth);
						if (r) want.push({ key: "t#" + key + "#" + nth, src: m[2], chip: false, cx: r.left + IW / 2, cy: r.top + r.height / 2 });
						m = TOKRE.exec(txt);
					}
				}
				
				for (let i2 = 0; i2 < want.length; i2++) {
					const w = want[i2];
					let img = have[i2];
					if (!img) {
						img = document.createElement("img");
						img.className = "ff-at-inline";
						img.style.zIndex = "129";
						document.body.append(img);
						have[i2] = img;
					}
					img.dataset.token = w.key;
					const u = urlFor(w.src);
					if (u && img.getAttribute("src") !== u) img.setAttribute("src", u);
					img.title = w.src;
					img.style.display = "";
					img.style.width = IW + "px";
					img.style.height = FH + "px";
					img.style.left = Math.round(w.cx - IW / 2) + "px";
					img.style.top = Math.round(w.cy - FH / 2) + "px";
				}
				/* 多余的一律删掉（换屏幕、删胶囊、切项目都走这里） */
				for (let k = want.length; k < have.length; k++) {
					try { have[k].remove(); } catch { /* 忽略 */ }
				}
			};

			const render = () => {
				const p = picker;
				if (!p) return;
				p.textContent = "";
				const hd = document.createElement("div");
				hd.className = "ff-at-hd";
				hd.textContent = items.length
					? ("画布素材 · " + items.length + " 张（点一下插到输入框）")
					: "画布上还没有图片：先在画布上给主体节点放图";
				p.append(hd);
				items.forEach((it, i) => {
					const row = document.createElement("div");
					row.className = "ff-at-it" + (i === active ? " on" : "");
					row.dataset.i = String(i);
					const th = document.createElement("img");
					th.className = "ff-at-th";
					th.loading = "lazy";
					th.onerror = () => { th.style.visibility = "hidden"; };
					th.setAttribute("src", it.url);
					const tg = document.createElement("span");
					tg.className = "ff-at-tag";
					tg.textContent = it.tag;
					const nm = document.createElement("span");
					nm.className = "ff-at-nm";
					nm.textContent = it.label;
					const pa = document.createElement("span");
					pa.className = "ff-at-pa";
					pa.textContent = it.src;
					row.append(th, tg, nm, pa);
					p.append(row);
				});
				const on = p.querySelector(".ff-at-it.on");
				try { if (on) on.scrollIntoView({ block: "nearest" }); } catch { /* 忽略 */ }
			};

			/* 面板贴在锚点（官方菜单里我们那一条）**上方** */
			const placeRect = (r) => {
				if (!pickerOpen && picker && picker.style.display !== "block") return;
				const p = picker;
				if (!p || !r) return;
				const W = 360;
				const left = Math.max(8, Math.min(Math.round(r.left), Math.max(8, window.innerWidth - W - 8)));
				p.style.display = "block";
				p.style.width = W + "px";
				p.style.left = left + "px";
				p.style.top = "auto";
				p.style.bottom = Math.round(window.innerHeight - r.top + 6) + "px";
				p.style.maxHeight = Math.min(320, Math.max(160, Math.round(r.top) - 24)) + "px";
			};

			const insert = (text) => {
				const box = boxOf(document.activeElement) || document.querySelector('[role="textbox"]');
				if (!box) return false;
				try { box.focus(); } catch { /* 忽略 */ }
				const host = hostOf(box);
				try {
					if (savedRange && host && host.contains(savedRange.startContainer)) {
						const s = window.getSelection();
						s.removeAllRanges();
						s.addRange(savedRange);
					}
				} catch { /* 忽略 */ }
				let ok = false;
				try { ok = document.execCommand("insertText", false, text); } catch { ok = false; }
				if (!ok && host) {
					try {
						host.focus();
						const s2 = window.getSelection();
						if (s2 && s2.rangeCount) s2.getRangeAt(0).insertNode(document.createTextNode(text));
						ok = true;
					} catch { ok = false; }
				}
				savedRange = null;
				setTimeout(syncChips, 90);
				return ok;
			};

			/*
			 * 把选中项插成官方 reference chip（输入框里只显示小图标 +「图片」）。
			 * 成功返回 true；任何一步不满足都返回 false，调用方退回纯文本。
			 */
			/* 把选中项插成官方 reference chip；成功返回 true，任何一步不满足都返回 false（调用方退回纯文本） */
			/* 把选中项插成官方 reference chip；成功返回 true，任何一步不满足都返回 false（调用方退回纯文本） */
			/*
			 * 把选中项插成官方 reference chip；成功返回 true，任何一步不满足都返回 false（调用方退回纯文本）。
			 *
			 * ⚠ span 必须是**检测坐标**（detect），不是草稿文本坐标：有胶囊时两者长度不同。
			 *   官方给的口子就是 shell.actions.captureInsertion()（= caretSpan + 当前 rev）。
			 */
			const insertChip = (mention) => {
				if (!MENTION_HUB || typeof MENTION_HUB.shell !== "function") return false;
				const host = hostOf(document.querySelector('[role="textbox"]'));
				const sh = shellForComposer(host);
				if (!sh || typeof sh.insertReference !== "function") return false;
				const txt = String(mention || "");
				const spans = [];
				try {
					const sp = sh.actions && sh.actions.captureInsertion ? sh.actions.captureInsertion() : null;
					if (sp) spans.push(sp);
				} catch { /* 忽略 */ }
				try {
					const st = sh.state && sh.state.getSnapshot ? sh.state.getSnapshot() : null;
					if (st) {
						const at = String(st.draft || "").length;
						spans.push({ start: at, end: at, draftRev: st.draftRev });
					}
				} catch { /* 忽略 */ }
				const mk = (label) => ({ source: MENTION_SOURCE, ref: txt, label: label, appearance: "file", clipboardText: txt });
				/* 官方对 label 有校验：先试空格（只剩图标，图标再被缩略图盖住），不行退「图片」 */
				for (const span of spans) {
					for (const label of [MENTION_LABEL, MENTION_LABEL_FALLBACK]) {
						try {
							if (sh.insertReference(mk(label), span) === true) { LAST_SHELL = sh; INSERTED.push({ mention: txt }); return true; }
						} catch { /* 换下一个组合 */ }
					}
				}
				return false;
			};

			/* 选中一项：插胶囊；会话门面可能还没热起来，最多重试 6 次（约 2.5 秒），仍不行退回纯文本 */
			const choose = (i) => {
				const it = items[i];
				if (!it) return;
				hide();
				const mention = tokenOf(it);
				let tries = 0;
				const go = () => {
					if (insertChip(mention)) { setTimeout(syncChips, 140); return; }
					tries++;
					if (tries < 6) { setTimeout(go, 400); return; }
					insert(mention + " ");
				};
				go();
			};

			const move = (d) => {
				const n = items.length;
				if (!n) return;
				active = ((active + d) % n + n) % n;
				render();
			};

			/* 画布上的图：元素参考图 + 手加素材 + 图片节点里的图（含光杆图）+ 素材库产物 */
			const load = async () => {
				curRoot = "";
				let refs = {};
				let ja = {};
				/* 先拿当前片子：缩略图 URL 要用它 */
				try {
					const st = await (await fetch("/filmflow/state", { headers: { accept: "application/json" } })).json();
					curRoot = String((st && st.current) || "");
				} catch { /* 拿不到就空 */ }
				/* 两个接口分开取：一个挂了另一个照用 */
				try {
					const r1 = await fetch("/filmflow/refs?root=" + encodeURIComponent(curRoot), { headers: { accept: "application/json" } });
					refs = await r1.json();
				} catch { refs = {}; }
				try {
					const r2 = await fetch("/filmflow/assets?action=list&root=" + encodeURIComponent(curRoot), { headers: { accept: "application/json" } });
					ja = await r2.json();
				} catch { ja = {}; }
				const out = [];
				const seen = {};
				const push = (tag, label, src, key) => {
					const s = String(src || "").trim().replace(/\\/g, "/");
					if (!s) return;
					const k = s.toLowerCase();
					if (seen[k]) return;
					seen[k] = 1;
					out.push({ tag: tag, label: String(label || ""), key: String(key || label || ""), src: s, url: urlFor(s) });
				};
				for (const el of (refs.elements || [])) {
					for (const src of (el.images || [])) push("参考", el.name, src);
				}
				for (const mt of (refs.materials || [])) push("素材", mt.label, mt.image);
				for (const nd of (refs.mediaNodes || [])) {
					for (const im of (nd.images || [])) push("图", nd.title || nd.key || nd.name, im && im.src, nd.key);
				}
				for (const it of (ja.items || [])) {
					if (!it) continue;
					if (it.type && it.type !== "image") continue;
					push("库", it.nodeTitle || it.name || "产物", it.src || it.path);
				}
				items = out.slice(0, 80);
				active = 0;
			};

			const show = async (rect) => {
				if (!picker) return;
				pickerOpen = true;
				render();
				placeRect(rect);
				await load();
				if (!pickerOpen) return;   /* 加载期间已经关掉了（选中/点外面）就别再弹回来 */
				render();
				placeRect(rect);
			};

			const buildPicker = () => {
				if (picker) return picker;
				picker = document.createElement("div");
				picker.className = "ff-at-picker";
				picker.style.zIndex = "2147483000";
				picker.addEventListener("mousedown", (ev) => { ev.preventDefault(); ev.stopPropagation(); }, true);
				picker.addEventListener("click", (ev) => {
					ev.preventDefault();
					ev.stopPropagation();
					let row = ev.target;
					while (row && row !== picker && !(row.classList && row.classList.contains("ff-at-it"))) row = row.parentElement;
					if (!row || row === picker) return;
					choose(Number(row.dataset.i || 0));
				});
				document.body.append(picker);
				document.addEventListener("mousedown", (ev) => {
					if (!picker || picker.style.display !== "block") return;
					try { if (picker.contains(ev.target)) return; } catch { /* 忽略 */ }
					hide();
				}, true);
				window.addEventListener("keydown", (ev) => {
					if (!picker || picker.style.display !== "block") return;
					if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); hide(); }
					else if (ev.key === "ArrowDown") { ev.preventDefault(); ev.stopPropagation(); move(1); }
					else if (ev.key === "ArrowUp") { ev.preventDefault(); ev.stopPropagation(); move(-1); }
					else if (ev.key === "Enter") { ev.preventDefault(); ev.stopPropagation(); choose(active); }
				}, true);
				picker.addEventListener("wheel", (ev) => ev.stopPropagation(), true);
				return picker;
			};

			/* 官方「添加文件」菜单一出现，就在最上面插一条我们的入口；官方每一项都不动 */
			const isPopup = (elm) => {
				try {
					const st = getComputedStyle(elm);
					if (st.position !== "fixed" && st.position !== "absolute") return false;
					const r = elm.getBoundingClientRect();
					if (r.width < 120 || r.height < 24) return false;
					if (elm.closest('[role="textbox"]')) return false;
					if (/发消息或创建任务/.test(elm.textContent || "")) return false;
					return true;
				} catch { return false; }
			};
			const ensureEntry = () => {
				const cands = Array.prototype.slice.call(document.querySelectorAll('div, ul, [role="menu"]')).filter((elm) => {
					const t = String(elm.textContent || "");
					if (!/添加文件|调用指令/.test(t)) return false;
					if (elm.querySelector(".ff-at-entry")) return false;
					return isPopup(elm);
				});
				if (!cands.length) return;
				cands.sort((a, b) => String(a.textContent || "").length - String(b.textContent || "").length);
				const menu = cands[0];
				const entry = document.createElement("div");
				entry.className = "ff-at-entry";
				entry.textContent = "🖼 引用画布素材…";
				entry.addEventListener("mousedown", (ev) => {
					ev.preventDefault();
					const r = entry.getBoundingClientRect();
					const box = document.querySelector('[role="textbox"]');
					if (box) {
						try { box.focus(); } catch { /* 忽略 */ }
						try {
							const s = window.getSelection();
							if (s && s.rangeCount && box.contains(s.getRangeAt(0).startContainer)) savedRange = s.getRangeAt(0).cloneRange();
						} catch { /* 忽略 */ }
					}
					buildPicker();
					void show({ left: r.left, top: r.top, width: r.width, height: r.height });
				});
				menu.insertBefore(entry, menu.firstChild);
			};

			buildPicker();
			/* 调试/排障用（不参与界面）：window.__ffInsertChip("@图[名字](路径)") 直接插一枚胶囊 */
			try {
				window.__ffInsertChip = (m) => insertChip(String(m || ""));
				window.__ffClearDraft = () => {
					try {
						const sh = shellForComposer(hostOf(document.querySelector('[role="textbox"]')));
						if (sh && typeof sh.setDraft === "function") { sh.setDraft(""); return true; }
					} catch { /* 忽略 */ }
					return false;
				};
				window.__ffPickerItems = async () => {
					await load();
					return { root: curRoot, items: items.map((x) => x.tag + "|" + x.label + "|" + x.key + "|" + x.src) };
				};
				window.__ffChipState = () => ({
					hub: !!MENTION_HUB,
					shell: !!LAST_SHELL,
					sids: sidCandidates().length,
					hostMatch: (() => {
						try {
							const h = hostOf(document.querySelector('[role="textbox"]'));
							return !!shellForComposer(h);
						} catch { return false; }
					})(),
				});
			} catch { /* 忽略 */ }
			setInterval(ensureEntry, 400);
			setInterval(syncChips, 500);
		}
		try { setTimeout(initComposerMentions, 900); } catch { /* 忽略 */ }

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
					const res = await post("/filmflow/approve", { root: record.root, id: record.id, action });
					/*
					 * 宿主办不到（目标节点已经不在了）时回 action:'invalid' ——
					 * 不能当成功一样盖个「已写进画布 ✓」，否则用户只会觉得「我点了但画布没变化」（2026-11-03）。
					 */
					if (res && res.action === "invalid") {
						setState("error");
						setNote("没执行：" + String(res.reason || "目标节点已不存在"));
						return;
					}
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
				if (op === "delete" && Array.isArray(s.keys) && s.keys.length > 1) return "删除 " + s.keys.length + " 个节点（批量）";
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

			/**
			 * 删一部片 —— 其实是**挪进同级的 _已删除**（2026-11-03 用户：「片库的项目要能删除」）。
			 *
			 * 为什么不真删：项目里全是手写正文，误删没法重来。挪走还能自己搬回来；
			 * 宿主那边还要求把**目录名**原样回传做二次确认。
			 */
			const delProject = (p) => {
				const name = String(p.root || "").split(/[\\/]/).filter(Boolean).pop() || "";
				if (!name) { setMsg("读不到目录名，没法删"); return; }
				const ok = confirm("把「" + (p.title || name) + "」移到回收站？\n"
					+ "目录：" + p.root + "\n\n"
					+ "不是永久删除：会挪到同级的 _已删除 文件夹里，想找回直接挪回去就行。");
				if (!ok) return;
				setBusy(true);
				setMsg("正在挪走…");
				post("/filmflow/deleteproject", { root: p.root, confirm: name })
					.then((r) => {
						if (r && r.ok === false) { setMsg("没删成：" + r.error); setBusy(false); return; }
						setMsg("已移到回收站：" + ((r && r.movedTo) || name));
						setBusy(false);
						if (String(ENTERED || "").toLowerCase() === String(p.root || "").toLowerCase()) {
							ENTERED = "";
							try { localStorage.removeItem("filmflow.entered"); } catch { /* 忽略 */ }
							setScreen("menu");
						}
						fetchState().then((s) => setState(s), () => { /* 忽略 */ });
					})
					.catch((e) => { setMsg("没删成：" + String((e && e.message) || e)); setBusy(false); });
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
					h("span", {
						className: "ff-proj-del",
						title: "移到回收站（同级 _已删除，可找回）",
						onClick: (ev) => { ev.stopPropagation(); delProject(p); },
					}, "删除"),
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
			const lastKey = "ff.sess." + String(p.root || "");
			let last = "";
			try { last = String(localStorage.getItem(lastKey) || ""); } catch { /* 忽略 */ }
			/*
			 * ★ 先开**上次真正在看的那条**，再退到绑定号（2026-11-03 用户：
			 *   「你改完片厂总是把我和agent的历史会话给弄没有」）。
			 *
			 * 现场：绑定号被并发叫醒换成一条空会话（39 条事件，全是唤醒），
			 * 用户真正在聊的是另一条（258 条事件、74 次工具调用，直到 14:42 还在写）。
			 * 重启后按绑定号打开 ⇒ 眼前只剩空会话 ⇒ 看起来历史没了。
			 * ⇒ 客户端把自己上次打开的会话记在 localStorage，启动时优先它，
			 *   并把宿主绑定改回它（agent 下次也回到这条）。
			 */
			const mainIs = (id) => {
				try {
					const s = api.sessions && api.sessions.list ? api.sessions.list.getSnapshot() : null;
					if (!s) return null;
					if (s.phase && s.phase !== "ready") return null; // 还没装完 ⇒ 不知道，别乱判
					const row = s.byId && s.byId[id];
					return !!(row && ((row.retainedBy && row.retainedBy.mainView) || 0) > 0);
				} catch { return null; }
			};
			const waitMain = async (id, ms) => {
				const t0 = Date.now();
				let v = mainIs(id);
				while (Date.now() - t0 < ms && v !== true) {
					await new Promise((r) => setTimeout(r, 100));
					v = mainIs(id);
				}
				return v;
			};
			/*
			 * ★ 顺序：**先绑定号，再"上次在看的"**（2026-11-03 调过来）。
			 *
			 * 之前是"上次在看的"优先（那是并发叫醒把绑定号换空会话时的应急做法）。
			 * 现在绑定号不会再被换人（ensureAgent 撞被占用就借界面那个 agent，
			 * 不新建 id），所以**宿主记的那条才是准的**。
			 * 反过来让 localStorage 优先，就会出现：宿主在 A 上跑 agent，
			 * 界面停在 B —— 停止键停 B，等于没停。
			 */
			const candidates = [];
			if (bound) candidates.push(bound);
			if (last && last !== bound) candidates.push(last);
			for (const id of candidates) {
				/*
				 * ★★ 2026-11-03：**不再预判"还能不能打开"** —— 直接开，再看它有没有真的切过去。
				 *
				 * 老写法 `aliveOf` 在启动早期会**假否定**（会话列表 phase=pending，
				 * `byId` 里当然还没有这条）⇒ 判成"打不开" ⇒ 掉到 openWorkspace
				 * ⇒ **新建一条空会话** ⇒ 用户眼前的历史又没了。
				 * 现场：重启后 bindOnBoot 把 空白3 绑到了一条刚建的空会话 ebb0bdd3，
				 * 而真正在聊的是 a8e2e17f（29 轮）—— 就是因为这个假否定。
				 *
				 * openSession 对"这会话真没了"是**无害空操作**，所以先开是对的；
				 * 只有当列表已经 ready 且主视图确实没切过去，才认为这条真没了。
				 */
				api.uiWorkspace.openSession(id);
				const ok = await waitMain(id, 1600);
				diag("绑定检查：候选=" + id + " 切过去=" + String(ok) + " 工作区会话数=" + ids0.length);
				if (ok === false) continue; // 只有**确知**没切过去才换下一条
				try { localStorage.setItem(lastKey, id); } catch { /* 忽略 */ }
				diag("打开会话：" + id + (id === last ? "（上次在看的）" : "（绑定号）"));
				// 不在名单里就顺手补进去，下次判断更干净（失败无所谓）
				if (!ids0.includes(id)) {
					try { api.uiWorkspace.insertSessionBefore && api.uiWorkspace.insertSessionBefore(id, null); } catch { /* 忽略 */ }
				}
				if (id !== bound) {
					await post("/filmflow/session", { root: p.root, sessionId: id }).catch(() => { /* 记不上下次还会优先 localStorage */ });
				}
				return;
			}

			/*
			 * 两条都没开成：**能用工作区里已有的会话就别新建**（新建 = 眼前历史又空一条）。
			 * 只有这个工作区一条会话都没有，才是真的"第一次进这部片"。
			 */
			if (ids0.length) {
				const sid = String(ids0[ids0.length - 1] || "");
				api.uiWorkspace.openSession(sid);
				diag("回落到工作区已有的会话：" + sid + "（共 " + ids0.length + " 条）");
				await post("/filmflow/session", { root: p.root, sessionId: sid }).catch(() => { /* 忽略 */ });
				return;
			}
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
		 * 「待确认提案」面板 —— 钉在会话框这一侧。
		 *
		 * ★ 2026-11-03 恢复（用户：「你把正确的那个 agent 提案确认卡给弄掉了，
		 *   结果保留了另一个藏在 step 流里的老选项卡」）。
		 *
		 * 之前 v2.58 撤掉它、只留 `tool.call.toolview` 的内联卡；但那张卡长在
		 * agent 的工具调用里，被折叠进「已调用工具 / 步骤」那一串里 —— 用户根本看不到，
		 * 于是「提案在哪、点哪确认」全凭自己去翻折叠块。
		 * 这里直接轮询提案表，把**本片所有 pending** 集中钉在会话框一侧：
		 * 一眼能看见、就地确认/驳回。
		 *
		 * 只查当前这部片（`?root=`）：以前不带 root 会把别的片的待确认也列进来。
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
					const r0 = String(ENTERED || "");
					fetch("/filmflow/proposals" + (r0 ? "?root=" + encodeURIComponent(r0) : ""), { headers: { accept: "application/json" } })
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
					const res = await post("/filmflow/approve", { root: pr.root || root, id: pr.id, action });
					/*
					 * 宿主办不到（目标节点已经不在了）时回 action:'invalid' ——
					 * 不能当成功一样把卡静默拿掉，否则用户只会觉得「我点了但画布没变化」（2026-11-03）。
					 */
					if (res && res.action === "invalid") {
						setList((old) => old.map((x) => (x.id === pr.id
							? { ...x, err: "没执行：" + String(res.reason || "目标节点已不存在") }
							: x)));
						return;
					}
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
						? (Array.isArray(s.keys) && s.keys.length > 1
							? "删除 " + s.keys.length + " 个节点"
							: s.op === "delete" ? "删除节点 " + String(s.key || "")
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
		 * 一句文本输入（替掉原生 prompt —— Electron 不支持，B54）。
		 * 角色库要在素材库里给一张图改角色名，就靠它（模块级：AssetsOverlay 是模块级组件）。
		 * @param label - 标题
		 * @param hint - 占位提示
		 * @param initial - 初值
		 * @returns {Promise<string|null>} 确定/回车 = 文本（可为空串）；取消 = null
		 */
		function askText(label, hint, initial) {
			return new Promise((resolve) => {
				for (const o of Array.from(document.querySelectorAll(".ff-asktext"))) {
					try { o.remove(); } catch { /* 忽略 */ }
				}
				const box = el("div", "ff-confirm ff-asktext");
				const tx = el("div", undefined, String(label || ""));
				tx.style.fontSize = "13px";
				tx.style.lineHeight = "1.5";
				box.append(tx);
				const inp = el("input");
				inp.type = "text";
				inp.placeholder = String(hint || "");
				inp.value = String(initial == null ? "" : initial);
				inp.style.cssText = "width:100%;box-sizing:border-box;font:inherit;font-size:12.5px;padding:6px 8px;"
					+ "border-radius:6px;border:1px solid var(--dsw-alias-border-l2);"
					+ "background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)";
				box.append(inp);
				const row = el("div", "ff-confirm-row");
				const no = el("button", "ff-btn", "取消");
				const yes = el("button", "ff-btn w", "确定");
				const done = (v) => {
					try { box.remove(); } catch { /* 忽略 */ }
					resolve(v);
				};
				no.addEventListener("click", (ev) => { ev.stopPropagation(); done(null); });
				yes.addEventListener("click", (ev) => { ev.stopPropagation(); done(String(inp.value || "")); });
				inp.addEventListener("keydown", (ev) => {
					if (ev.key === "Enter") { ev.preventDefault(); ev.stopPropagation(); done(String(inp.value || "")); }
					else if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); done(null); }
				});
				row.append(no, yes);
				box.append(row);
				box.style.left = Math.round(window.innerWidth / 2 - 150) + "px";
				box.style.top = "120px";
				document.body.append(box);
				setTimeout(() => { try { inp.focus(); inp.select(); } catch { /* 忽略 */ } }, 30);
			});
		}


		function AssetsOverlay() {
			const screen = useScreen();
			const [items, setItems] = react.useState([]);
			const [projs, setProjs] = react.useState([]);
			const [credit, setCredit] = react.useState("");
			const [filter, setFilter] = react.useState("all");
			const [folder, setFolder] = react.useState("");
			const [roleOnly, setRoleOnly] = react.useState(false);
			const [err, setErr] = react.useState("");
			const [tick, setTick] = react.useState(0);
			const reload = () => setTick((t) => t + 1);

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
			}, [screen, tick]);

			if (screen !== "assets") return null;
			syncRailWidth();

			const ROOTOF = (it) => String(it.root || folder || "");
			const setStateOf = (it, st) => {
				post("/filmflow/assets", { action: "state", root: ROOTOF(it), id: it.id, state: st })
					.then(reload)
					.catch((e) => setErr(String((e && e.message) || e)));
			};
			const setRoleOf = async (it) => {
				const nm = await askText("角色库 · 角色名", "例如：唐老板 / 警察（留空=移出角色库）", String((it.role && it.role.name) || ""));
				if (nm === null) return;
				post("/filmflow/assets", { action: "role", root: ROOTOF(it), id: it.id, name: nm })
					.then(reload)
					.catch((e) => setErr(String((e && e.message) || e)));
			};
			const delOf = (it) => {
				if (!confirm("删掉这条素材？")) return;
				post("/filmflow/assets", { action: "remove", root: ROOTOF(it), id: it.id })
					.then(reload)
					.catch((e) => setErr(String((e && e.message) || e)));
			};

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

			const roles = items.filter((x) => x.role && String(x.role.name || "").trim());
			const inside = items.filter((x) => String(x.root || "") === folder);
			const shown = roleOnly
				? roles.filter((x) => filter === "all" || x.type === filter)
				: inside.filter((x) => filter === "all" || x.type === filter);
			const cur = folders.find((f) => f.root === folder) || null;

			const card = (it, showFilm) => {
				const r = ROOTOF(it);
				const url = "/filmflow/assets?action=file&root=" + encodeURIComponent(r) + "&p=" + encodeURIComponent(it.src);
				const st = String(it.state || "candidate");
				return h("div", {
					key: String(r) + "|" + it.id,
					className: "ff-asset-card" + (st === "accepted" ? " p" : ""),
					onClick: () => openViewer({ root: r, item: it }),
				},
					it.type === "image"
						? h("img", { className: "im", src: url, loading: "lazy" })
						: it.type === "video"
							? h("video", { className: "im", src: url, preload: "metadata", muted: true })
							: h("div", { className: "im", style: { display: "flex", alignItems: "center", justifyContent: "center", color: "#bbb", fontSize: 13 } }, "🔊 音频"),
					h("div", { className: "info" },
						h("div", { className: "t" }, (st === "accepted" ? "✓ " : "") + String(it.nodeTitle || it.node || "")),
						h("div", { className: "m" }, (showFilm ? String(it.film || "") + "　" : "")
							+ (it.role && it.role.name ? "★ " + String(it.role.name) + "　" : "")
							+ String(it.model || "") + "　" + new Date(it.at).toLocaleDateString()),
						h("div", { className: "ff-asset-acts" },
							it.type !== "audio"
								? h("button", {
									className: "ff-btn",
									onClick: (e) => { e.stopPropagation(); setStateOf(it, st === "accepted" ? "candidate" : "accepted"); },
								}, st === "accepted" ? "取消采用" : "采用")
								: null,
							h("button", {
								className: "ff-btn",
								onClick: (e) => { e.stopPropagation(); void setRoleOf(it); },
							}, it.role && it.role.name ? "改角色名" : "设为角色"),
							h("button", {
								className: "ff-btn",
								onClick: (e) => { e.stopPropagation(); delOf(it); },
							}, "删"))));
			};

			return h("div", { className: "ff-assets" },
				h("div", { className: "ff-assets-bar" },
					roleOnly
						? h("button", { className: "ff-crumb", onClick: () => setRoleOnly(false) }, "← 素材库")
						: folder
							? h("button", { className: "ff-crumb", onClick: () => setFolder("") }, "← 素材库")
							: h("span", { className: "ff-docs-hd" }, "素材库"),
					h("span", { className: "ff-docs-meta" },
						roleOnly
							? "角色库 · " + shown.length + " 个角色图（跨项目）"
							: folder
								? (cur ? cur.film : "项目") + " · " + shown.length + " / " + inside.length + " 条"
								: folders.length + " 个项目 · " + items.length + " 条"),
					credit ? h("span", { className: "ff-docs-meta", title: "小云雀积分余额" }, "积分 " + credit) : null,
					h("span", { style: { flex: 1 } }),
					(!folder && !roleOnly)
						? h("button", { className: "ff-btn", onClick: () => { setRoleOnly(true); setFilter("all"); } }, "角色库（" + roles.length + "）")
						: null,
					(folder || roleOnly) ? ["all", "image", "video", "audio"].map((t) => h("button", {
						key: t,
						className: "ff-btn" + (filter === t ? " p" : ""),
						onClick: () => setFilter(t),
					}, t === "all" ? "全部" : t === "image" ? "图片" : t === "video" ? "视频" : "音频")) : null,
					h("div", { className: "ff-btn", onClick: () => setScreen(ENTERED ? "work" : "menu") }, ENTERED ? "回画布" : "返回片库")),
				err ? h("div", { className: "ff-media-empty", style: { margin: "auto" } }, err) : null,
				roleOnly
					? h("div", { className: "ff-assets-grid" },
						shown.length ? shown.map((it) => card(it, true))
							: h("div", { className: "ff-media-empty", style: { gridColumn: "1/-1", margin: "auto" } },
								"角色库还是空的：在任意素材上点「设为角色」并起个名字，绑参考图时就能直接选"))
					: !folder
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
							shown.length ? shown.map((it) => card(it, false))
								: h("div", { className: "ff-media-empty", style: { gridColumn: "1/-1", margin: "auto" } }, "这个项目还没有素材")));
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
				const kill = mountCanvas(ref.current, {
					root: ENTERED,
					onBack: () => setScreen("menu"),
				});
				/*
				 * 刚点进片子时，宿主的「当前项目」可能还没切过来 ⇒ 画布第一次 load 拿到的是旧状态，
				 * 画出来是空的（用户 2026-11-06 报：必须手动点一次刷新）。
				 * 这里在挂载后自动点一次「刷新」，用户不用再点。
				 */
				const nudge = setTimeout(() => {
					try {
						const host = ref.current || document;
						const btns = Array.from(host.querySelectorAll(".ff-btn"));
						const rl = btns.find((b) => String(b.textContent || "").trim() === "刷新");
						if (rl) rl.click();
					} catch { /* 忽略 */ }
				}, 700);
				return () => { clearTimeout(nudge); if (typeof kill === "function") kill(); };
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

		/*
		 * 输入框引用「小胶囊」（D41，2026-11-06）：选中画布图片时，不再往输入框里塞长文本
		 * （那种 @图[名字](素材/…png) 的写法），而是插一枚官方 reference chip ——
		 * 输入框里只显示小图标 +「图片」，**发给 agent 的仍是完整 mention（路径一字不差）**：
		 * chip 的模型文本由我们注册的 referita 源 codec 决定（见 MENTION_SOURCE）。
		 * 两个服务缺任何一个都自动退回纯文本，不影响别的功能。
		 */
		const MENTION_SOURCE = "ffimg";
		const MENTION_LABEL = " ";   /* 空标签会被官方拒；用空格 = 只剩图标，图标再被缩略图盖住 */
		let MENTION_HUB = null;   /* ctx.conversation.input（会话输入门面） */
		let LAST_SHELL = null;    /* 上次插成功的会话输入门面（草稿投影要用） */
		const MENTION_LABEL_FALLBACK = "图片";   /* 空格标签也被拒时的退路 */
		const MENTION_SOURCE_DEF = {
			trigger: "@",
			name: MENTION_SOURCE,
			order: 90,
			showGroupTitle: false,
			/* 不往 @ 菜单里放任何候选（我们只借它做编解码，菜单由 ＋ 面板负责） */
			candidates: async () => [],
			onPick: () => undefined,
			codec: {
				/* 剪贴板 / 草稿持久化的形态 */
				clipboardText: (ref) => String(ref || ""),
				/* 真正发给 agent 的形态：完整 mention（含项目相对路径） */
				serialize: async (ref) => String(ref || ""),
			},
		};

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

			/*
			 * 注册「画布图片」引用源的编解码 + 拿到会话输入门面（D41）。
			 * 用 ctx.inject 而不是写进插件 inject：这两个服务在别的宿主里可能没有，
			 * 缺了只影响小胶囊（自动退回纯文本），不能让整个插件不激活。
			 */
			try {
				ctx.inject(["conversation", "inputTriggers"], (c) => {
					MENTION_HUB = (c.conversation && c.conversation.input) || null;
					try {
						const off = c.inputTriggers.registerSource(MENTION_SOURCE_DEF);
						/*
						 * 自检：同名（trigger+name）再注册一次必须抛错 —— 抛了才说明上面那次真的注册上了。
						 * 结果放在 window.__ffMentionSourceOk，排查时一眼能看到（不影响任何功能）。
						 */
						try {
							const probe = c.inputTriggers.registerSource({ trigger: "@", name: MENTION_SOURCE, order: 91, candidates: async () => [], onPick: () => undefined });
							probe();
							window.__ffMentionSourceOk = false;
						} catch { window.__ffMentionSourceOk = true; }
						c.effect(() => () => { try { off(); } catch { /* 忽略 */ } }, "filmflow: mention source");
					} catch { /* 同名已注册 / 老版本：退回纯文本 */ }
				});
			} catch { /* 没有这些服务 */ }

			// 记住上次进的是哪部片（刷新之后控制条上的「工序」仍然可点）
			try { ENTERED = localStorage.getItem("filmflow.entered") || ""; } catch { /* 忽略 */ }

			/*
			 * ★ 启动/刷新之后也要把会话接回来（2026-11-03）。
			 *
			 * 原来只有「在项目菜单里点一部片」才 bindSession ⇒ 刷新、重启后界面停在
			 * DSH 自己记住的那条会话上。会话一旦被换过（并发叫醒时代，见 index.js 的 ensureAgent），
			 * 那条就是几乎空的 —— 用户看到的就是「历史会话被弄没了」。
			 * ⇒ 开到这部片就把绑定号/上次在看的会话接回来。服务可能还没就绪，失败退避重试两轮。
			 */
			const bindOnBoot = async (attempt = 1) => {
				/*
				 * ★★ 2026-11-03：**认哪部片，以宿主为准**（画布也是按 `state.current` 画的）。
				 *
				 * 现场（trace 10:19:27 → 10:19:28）：宿主把工具绑在 空白3、画布画的是 空白3，
				 * 右侧会话却被绑到 `session-bb0c7e2d`（空白4 的），因为
				 * `localStorage["filmflow.entered"]` 是旧的。
				 *
				 * 后果不只是"历史不对"：**DSH 的停止键停的是界面上那条会话**。
				 * 界面显示 A、agent 在 B 上跑 ⇒ 按停止 = 对一个空闲会话 cancel
				 * ⇒ `session/not-found` 被 client 静默吞掉 ⇒ 看着就是「停止键没用」。
				 * ⇒ 两边必须指同一条片子（进而同一条会话）。
				 */
				let root = "";
				let hostCur = "";
				try {
					const r = await fetch("/filmflow/state", { headers: { accept: "application/json" } });
					if (r.ok) {
						const st = await r.json();
						hostCur = String((st && st.current) || "");
						root = hostCur;
					}
				} catch { /* 服务还没起来：退回到 localStorage */ }
				if (!root) root = ENTERED;
				if (!root) return;
				if (root !== ENTERED) {
					ENTERED = root;
					try { localStorage.setItem("filmflow.entered", root); } catch { /* 忽略 */ }
				}
				// 宿主还不知道是哪部（重启后 CURRENT 空）⇒ 告诉它，别让它靠猜
				if (hostCur !== root) {
					post("/filmflow/select", { root }).catch(() => { /* 失败的话画布会落到 list[0]，下次刷再说 */ });
				}
				bindSession({ root }).catch((e) => {
					const msg = String((e && e.message) || e);
					diag("启动绑定会话失败（第 " + attempt + " 次）：" + msg);
					if (attempt < 3) setTimeout(() => bindOnBoot(attempt + 1), 1500 * attempt);
				});
			};
			setTimeout(() => bindOnBoot(), 1200);

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

			/*
			 * ★ 内联提案卡**已停用**（2026-11-03 用户：「你把正确的那个 agent 提案确认卡给弄掉了，
			 *   结果保留了另一个藏在 step 流里的老选项卡」）。
			 *
			 * `tool.call.toolview` 的卡是长在 agent 工具调用里的，被折叠进「已调用工具 / 步骤」，
			 * 用户根本找不到；集中确认改由 `ProposalsDock`（会话框一侧，order 8）负责。
			 * 组件 `ProposeToolRow` 先留着不注册（哪天要先确认再挂回去），别再两条路同时出卡。
			 */
		}

		exports.PANEL_ID = PANEL_ID;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
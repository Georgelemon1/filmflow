/**
 * dsh-filmflow —— 宿主半（零依赖，只用 node: 内置模块）
 *
 * 职责：
 *   1. 发现项目：扫 config.roots 的一级子目录找 .film/project.json
 *      （外加 config.projects 里显式列出的路径）
 *   2. 读每个项目的工序声明，按 glob 扫盘核对产物「声明了的有没有、各有几个」
 *   3. 注册同源路由给浏览器半：
 *        GET  /filmflow/ping    极简探针，用来确认路由链路通不通
 *        GET  /filmflow/state   全量工序树 JSON
 *        POST /filmflow/diag    收浏览器侧诊断 → 追加到 trace 日志
 *
 * 为什么要有 /filmflow/diag：GUI 是主对话那个标签页，浏览器侧的事实（比如
 * "客户端插件能不能拿到 remote 服务"）宿主看不见。本工作区的 dsh-ui-side-answer
 * 就是这么干的（"收浏览器侧诊断（GUI 是无调试端口的 chrome --app 窗口，
 * 只能靠它回传事实）"）。有它才能在不上调试器的前提下判客户端的能力。
 *
 * 为什么不 import 任何包：本目录没有 node_modules，宿主不替插件注入依赖
 * （同一工作区的 wps-docs / piano-practice 都已实测踩过）。
 * 所以只用 node: 内置模块，**也不导出 Config**（普通对象会让 cordis 崩在
 * `Cannot read properties of undefined (reading 'validate')`）。
 *
 * ⚠️ 服务名必须是 `webServer`（大驼峰）。本工作区的 piano-practice 写成了
 *    小写 `webserver`，结果自 2026-10-11 挂载至今一直卡在
 *    `pending (waiting for service: webserver)`，从未激活（证据见
 *    ~/.dsh\dsh-web.log.err）。官方包一律用 webServer：
 *    dsh-web-app / dsh-client-hmr / dsh-host-frontend-static /
 *    dsh-host-directory-picker-auto / dsh-host-open-in-app / dsh-webhook-github。
 *
 * 仍然不做：不写任何项目文件、不算指纹、不判失效、不跑校验脚本。
 */
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { createMediaService, contentTypeOf } from './host/media/service.js';
import {
  ROLE_PARENTS,
  roleChildrenTable,
  menuTable,
  ruleWarnings,
  normalizeRole,
  TERMINAL_ROLES,
  DEP_RULES,
  roleOfTemplate,
  buildRoleIndex,
  inferRole,
  checkPlacement,
  checkDeps,
  checkAdd,
  depCandidates,
  roleLabel,
  canHaveChildren,
  identityOfTemplate,
  identityOfTitle,
  identityTable,
  checkIdentityPlacement,
  canAddUnder,
  childrenWarnings,
  templateIdOf,
} from './host/node-rules.js';
import { defaultProject } from './host/default-project.js';

export const name = 'filmflow';

/** 宿主半唯一依赖的服务。大驼峰，见文件头注释。 */
/*
 * ── 为什么 inject 里是这两个 ────────────────────────────────────────
 *
 * `webServer`：注册 HTTP 路由用。**必须 camelCase** —— 写成小写 `webserver`
 *   插件会永远 pending 不加载（`piano-practice` 被这个坑了三天）。
 *
 * `tools`：注册"模型可见的工具"给 Agent 用。**这是插件 ↔ Agent 协作的唯一活路**，
 *   依据（2026-10-14 实测）：
 *     · 客户端 `ctx.remote.commands.execute` 虽然存在且可用，但它只能执行 6 个
 *       斜杠命令（compact/export/feedback/goal/permission/plan）——
 *       **没有"往对话里送任意文字"这种能力**，所以"点按钮开工"那条路是死的。
 *     · `ctx.tools` 不 inject 时报 `cannot get property "tools" without inject`
 *       —— 服务名是对的。旁证：`piano-practice` 声明 `['tools','webserver']` 时
 *       cordis 报的是 `waiting for service: webserver`（第一个没满足的依赖），
 *       它没报 `tools`，说明 `tools` 当时是满足的。
 *
 * 万一这次加进去插件变成 pending，报错会明确指向 `tools` —— 那就说明旁证不成立，
 * 把这个名字从这个数组里删掉即可（其余功能不受影响）。
 */
/*
 * ══ `webServer` 必须列进来（2026-10-20 第二次修正）══
 *
 * 上一版把它从 inject 里拿掉、改成 `ctx.get('webServer')` 惰性获取，
 * 目的是让插件在**没有 webServer 的 headless profile** 里也能激活（好在那边注册工具）。
 *
 * 实测证明这个权衡是**错的**，依据是插件自己的追踪日志：
 *
 *     apply() 进入; ctx.webServer=undefined      ← web profile 里也是 undefined ✗
 *     已注册路由 /filmflow/ping …（13 条）        ← 注册进了"空壳"对象，等于没有
 *
 * ⇒ 结果：13 个路由**一个都没真正挂上**，`/filmflow/ping` 一律 404 ✗
 *   （之前"`/filmflow/app` 被 SPA fallback 劫持"的怪现象，根因就是这一条 ——
 *     路由压根没注册，所有路径都落到 fallback 上。）
 *
 * 原因：cordis 的 `inject` 是"这个插件要用哪些服务"的声明（没有 optional 语义），
 * 没列进来的服务**在当前上下文里就取不到**，`ctx.get()` 同样取不到。
 *
 * 现在架构也变了：片场**就是**一个 dsh web 进程，不再 spawn headless 子进程当大脑，
 * 所以"headless 里也要激活"这个需求已经不存在 ⇒ 直接老实把 webServer 列进来。
 */
export const inject = ['webServer', 'tools', 'agents', 'sessionPersistence'];

/*
 * 诊断日志写到哪儿。
 *
 * ⚠️ **环境变量 `DSH_FILMFLOW_TRACE` 可以接管或关闭它** —— 这是为了治一个真问题：
 *    测试（`selftest.mjs` / `verify-*.mjs`）都会调 `apply()`，于是往**同一个日志**里写
 *    "apply() 进入"、"已注册路由 X"，跟真实进程的记录混在一起。
 *    我因此**两次误判"进程换版了"**（其实那些行是测试写的）。
 *    · 设成路径 → 写到那儿
 *    · 设成**空字符串** → 完全静默（测试里就这么用）
 */
const TRACE = process.env.DSH_FILMFLOW_TRACE !== undefined
  ? process.env.DSH_FILMFLOW_TRACE
  : 'C:\\Users\\PC\\.dsh\\filmflow-trace.log';

/** 工序声明的相对路径。 */
const DECL = join('.film', 'project.json');

/**
 * 节点模板库的路径（跟着插件走，不放进片子里）。
 *
 * 用户 2026-10-21：「一切皆可拆为模板」——事实层/认知层/角色/世界观/模型 这些
 * 不是每个项目都要，所以它们以**零件**的形式放在这里，画布上"新建节点"时再挑。
 */
const TEMPLATES = fileURLToPath(new URL('./templates.json', import.meta.url));

/**
 * 读模板库（出厂 53 条 + 用户自建）。
 *
 * 2026-10-30（R57）加 mtime 缓存：现在每个节点都要算一次「下位白名单」，
 * 而画布每 2–4 秒轮询一次 state —— 不缓存就会每轮把 53 个模板从磁盘读上百遍。
 * 用户模板文件也参与缓存键（存完新节点立刻生效，不用重启）。
 * @returns {Array} 模板数组（读不到就返回空，画布上只显示"空白"）
 */
let TPL_CACHE = { key: '', list: [] };

/**
 * 用户自建节点存哪。
 *
 * 为什么不写进 `templates.json`（R58，2026-10-30）：
 *   · 那个文件是**出厂模板**，跟着插件走；升级/重装会被覆盖；
 *   · 用户数据和程序要分开。
 * 顺序：`FILMFLOW_USER_TEMPLATES`（测试用）→ 数据目录 → 插件目录兜底。
 */
function userTemplatesPath() {
  if (process.env.FILMFLOW_USER_TEMPLATES) return process.env.FILMFLOW_USER_TEMPLATES;
  /*
   * ⚠️ `FILMFLOW_DSH_HOME` 在 Electron 里指的就是**数据根**（main.js 的 dataHome()），
   *    不是数据根下面的 dsh-home —— 实测 2026-10-30 踩过一次：
   *    多套一层 dirname 会把文件写到 `%LOCALAPPDATA%\user-templates.json`。
   *    为了兼容别的启动形态（真给到 dsh-home 的情况），两种都认。
   */
  const raw = process.env.FILMFLOW_DATA_HOME
    || process.env.FILMFLOW_DSH_HOME
    || (process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'FilmFlow') : '');
  const home = raw && /[\\/]dsh-home$/i.test(raw) ? dirname(raw) : raw;
  return home
    ? join(home, 'user-templates.json')
    : fileURLToPath(new URL('./user-templates.json', import.meta.url));
}

/** 读用户模板文件（容错：坏文件当空，不让它挡住片厂启动）。 */
function readUserTemplates() {
  const file = userTemplatesPath();
  try {
    if (!existsSync(file)) return [];
    const j = JSON.parse(readFileSync(file, 'utf8'));
    return Array.isArray(j?.templates) ? j.templates.filter((t) => t && t.id && t.title) : [];
  } catch (e) {
    trace('用户模板库读不了（' + file + '）：' + String((e && e.message) || e));
    return [];
  }
}

/** 写用户模板文件（写前留一份 .bak；先写临时文件再改名，避免写坏）。 */
function writeUserTemplates(list) {
  const file = userTemplatesPath();
  const dir = dirname(file);
  try { mkdirSync(dir, { recursive: true }); } catch { /* 忽略 */ }
  if (existsSync(file)) {
    try { copyFileSync(file, file + '.bak'); } catch { /* 忽略 */ }
  }
  const tmp = file + '.tmp';
  writeFileSync(tmp, JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), templates: list }, null, 2) + '\n', 'utf8');
  writeFileSync(file, readFileSync(tmp, 'utf8'), 'utf8');
  try { rmSync(tmp); } catch { /* 忽略 */ }
  return file;
}

/** 正文形态的校验与归一（用户节点只支持这五种；一任务一文件暂不开放）。 */
function normalizeUserShape(s) {
  const k = String((s && s.kind) || 'text').trim();
  const arr = (v) => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : []);
  if (k === 'text') return { kind: 'text' };
  if (k === 'list' || k === 'matrix') {
    const fields = arr(s && s.fields);
    if (!fields.length) throw new Error('shape 是 ' + k + ' 时必须给 fields（字段名数组）');
    return { kind: k, fields };
  }
  if (k === 'table') {
    const columns = arr(s && s.columns);
    if (!columns.length) throw new Error('shape 是 table 时必须给 columns（列名数组）');
    return { kind: 'table', columns };
  }
  if (k === 'select') {
    const options = arr(s && s.options);
    if (!options.length) throw new Error('shape 是 select 时必须给 options（选项数组）');
    return { kind: 'select', options };
  }
  throw new Error('shape 只支持 text / list / table / matrix / select（一任务一文件暂不开放）');
}

/** 用户节点的模板 id：`u-` 前缀，ASCII slug，重名自动加 -2。 */
function makeUserId(title, taken) {
  const ascii = String(title || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
  const base = 'u-' + (ascii || Date.now().toString(36));
  let id = base;
  for (let i = 2; taken.has(id); i++) id = base + '-' + i;
  return id;
}

/**
 * 校验并写入一条用户模板。
 *
 * 为什么校验这么严：节点一旦存进模板库，以后每个 ＋ 菜单都会出现它；
 * 写歪了（缺格式、缺 doctrine、role 不合法）会长期污染菜单。
 *
 * @param def 工具参数
 * @param existing 当前模板库（系统+用户）
 * @returns 存下来的完整模板对象
 */
function saveUserTemplate(def, existing) {
  const list = Array.isArray(existing) ? existing : [];
  const taken = new Set(list.map((t) => String(t && t.id)));
  const title = String((def && def.title) || '').trim();
  if (!title) throw new Error('缺 title：节点叫什么名字（画布上显示的那个）');
  if (title.length > 24) throw new Error('title 太长（≤24 个字）');
  const note = String((def && def.note) || '').trim();
  if (!note) throw new Error('缺 note：一句话说清这个节点干什么');
  const doctrine = String((def && def.doctrine) || '').trim();
  for (const tag of ['【任务】', '【读】', '【写】', '【格式】']) {
    if (!doctrine.includes(tag)) {
      throw new Error('doctrine 缺 ' + tag + ' 段：必须五段齐全（任务/读/写/格式/规矩）');
    }
  }
  const shape = normalizeUserShape(def && def.shape);
  const role = String((def && def.role) || 'content').trim();
  const ROLE_OK = new Set(['content', 'style', 'prompt-video', 'prompt-audio', 'other']);
  if (!ROLE_OK.has(role)) {
    throw new Error('role 只能是 content / style / prompt-video / prompt-audio / other（模型与生成节点不给用户建）');
  }
  const usableUnder = (Array.isArray(def && def.usableUnder) ? def.usableUnder : [])
    .map((x) => String(x).trim()).filter(Boolean);
  for (const p of usableUnder) {
    if (p !== 'root' && !taken.has(p)) throw new Error('usableUnder 里的「' + p + '」不是现有节点');
  }
  const children = (Array.isArray(def && def.children) ? def.children : [])
    .map((x) => String(x).trim()).filter(Boolean);
  for (const c of children) {
    if (!taken.has(c)) throw new Error('children 里的「' + c + '」不是现有节点');
  }
  let id = String((def && def.id) || '').trim();
  if (id) {
    if (!/^u-[a-z0-9-]{2,32}$/.test(id)) throw new Error('自定义 id 必须形如 u-xxx（小写字母/数字/-）');
    if (taken.has(id)) throw new Error('模板 id 已存在：' + id);
  } else {
    id = makeUserId(title, taken);
  }
  const row = {
    id,
    title,
    note,
    doctrine,
    shape,
    role,
    usableUnder: usableUnder.length ? usableUnder : ['root'],
    children,
    group: 'story',
    feed: 'up',
    user: true,
    createdAt: new Date().toISOString(),
  };
  const user = readUserTemplates().filter((t) => String(t.id) !== id);
  user.push(row);
  const file = writeUserTemplates(user);
  trace('已保存用户模板 ' + id + '（' + title + '）→ ' + file);
  return row;
}

function readTemplates() {
  try {
    const sysStat = statSync(TEMPLATES);
    let userStat = null;
    try { userStat = statSync(userTemplatesPath()); } catch { /* 没有就是没有 */ }
    const key = sysStat.mtimeMs + '|' + (userStat ? userStat.mtimeMs + ':' + userStat.size : '0');
    if (TPL_CACHE.key === key && TPL_CACHE.list.length) return TPL_CACHE.list;
    const j = JSON.parse(readFileSync(TEMPLATES, 'utf8'));
    const sys = Array.isArray(j?.templates) ? j.templates : [];
    const seen = new Set(sys.map((t) => String(t && t.id)));
    const extra = readUserTemplates().filter((t) => {
      const id = String(t.id);
      if (seen.has(id)) { trace('用户模板 id 与出厂撞车，已忽略：' + id); return false; }
      return true;
    });
    const list = [...sys, ...extra];
    TPL_CACHE = { key, list };
    return list;
  } catch (e) {
    trace('模板库读不了：' + String((e && e.message) || e));
    return TPL_CACHE.list.length ? TPL_CACHE.list : [];
  }
}

/**
 * 读骨架包（新建片子时选的那几套）。
 *
 * 用户 2026-10-21：「一切皆可拆为模板」，但每次从空片开始挑节点太重。
 * 骨架包 = 标准五道工序 + 若干现成节点；选完照样能在画布上增删 —— **包只是起点，不是锁**。
 * @returns {Array} 包数组（读不到返回空）
 */
function readPacks() {
  try {
    const j = JSON.parse(readFileSync(TEMPLATES, 'utf8'));
    return Array.isArray(j?.packs) ? j.packs : [];
  } catch (e) {
    trace('骨架包读不了：' + String((e && e.message) || e));
    return [];
  }
}

/* ------------------------------------------------------------------ *
 * 节点角色与层级合法性（R47，2026-10-28）
 *
 * 规则本体在 host/node-rules.js；这里只做"从模板库建索引 / 读节点角色"。
 * 结构操作、提案、状态树、旧片迁移都走这几个函数，只有一套判断。
 * ------------------------------------------------------------------ */

/** 模板标题 → 角色（模板库是静态文件，进程内缓存一次足够）。 */
let ROLE_INDEX_CACHE = null;

function roleIndexOfTemplates() {
  if (!ROLE_INDEX_CACHE) ROLE_INDEX_CACHE = buildRoleIndex(readTemplates());
  return ROLE_INDEX_CACHE;
}

/** 一个节点的角色：优先读存下来的 nodeRole，旧节点按标题/媒体类型/组推断。 */
function roleOfNode(raw, group) {
  return inferRole(raw, { group, roleIndex: roleIndexOfTemplates() });
}

/**
 * 父角色 → 子节点该继承的组提示。
 *
 * 为什么需要它：老 project.json 里**子节点不写 group**（子层本来就继承父组），
 * 而父节点自己也常常没写 group（顶层工序靠模板默认）。只按字符串继承会得到空组，
 * 于是「分镜脚本」下面那些 Ch1/Ch3 会被误判成 story。
 */
function groupHintForRole(role) {
  const r = String(role || '');
  if (!r || r === 'root' || r === 'other') return '';
  if (r === 'story') return 'story';
  return 'board'; // board / prompt-* / model-* / gen-*
}

/** 收集所有节点的 {node, role, key, title}，供校验/自动接依赖用。 */
function roleEntriesOf(stages) {
  const out = [];
  const walk = (list, grp, parentRole) => {
    for (const n of Array.isArray(list) ? list : []) {
      if (!n || typeof n !== 'object') continue;
      const g = n.group ? String(n.group) : (grp || groupHintForRole(parentRole));
      const role = roleOfNode(n, g);
      out.push({ node: n, role, key: String(n.key || ''), title: String(n.title || '') });
      walk(n.children, g, role);
    }
  };
  for (const s of Array.isArray(stages) ? stages : []) walk([s], '', 'root');
  return out;
}

/** key → 角色 的映射。 */
function roleByKeyOf(stages) {
  const m = new Map();
  for (const e of roleEntriesOf(stages)) if (e.key) m.set(e.key, e.role);
  return m;
}

/**
 * 生成节点的依赖自动接线：挂顶层、又没显式给依赖时，找项目里现成的
 * 同类型提示词（图片节点找分镜/设定）接上。
 *
 * @returns {{key:string, role:string}|null} 接上的依赖；找不到返回 null
 */
function autoWireDep(stages, role, opts = {}) {
  if (!DEP_RULES[role]) return null;
  const entries = roleEntriesOf(stages);
  const list = depCandidates(role, entries, opts);
  return list.length ? list[0] : null;
}

/**
 * 旧片结构迁移（R47）。
 *
 * 用户 2026-10-28：「旧片违规的全都改，现在的旧片全都是测试用途的，没有成本」。
 * 做四件事（幂等）：
 *   ① 给每个节点落一个 nodeRole（以后改名也不影响判断）
 *   ② 位置非法的节点挪到顶层（保持它的子节点不变）
 *   ③ 生成节点补依赖：没有可依赖的提示词就记 warning，不硬造节点
 *   ④ 断开"父节点依赖自己的生成子节点"这种反向边，补媒体默认模型
 *
 * 迁移完写 `.film/structure-v2.json` 标记；启动时只跑没标记的片子。
 */
function migrateProjectStructure(root, opts = {}) {
  const marker = join(root, '.film', 'structure-v2.json');
  if (!opts.force && existsSync(marker)) return { ok: true, root, skipped: true };
  const abs = join(root, DECL);
  let decl;
  try {
    decl = JSON.parse(readFileSync(abs, 'utf8'));
  } catch (e) {
    return { ok: false, root, error: '工序声明读不了：' + String((e && e.message) || e) };
  }
  if (!Array.isArray(decl.stages)) return { ok: false, root, error: 'project.json 里没有 stages 数组' };

  const before = JSON.stringify(decl);
  const fixes = [];
  const warnings = [];

  // 先把整棵树摊平，记下父节点和继承组
  const flat = [];
  const walk = (list, parent, grp, parentRole) => {
    for (const n of Array.isArray(list) ? list : []) {
      if (!n || typeof n !== 'object') continue;
      const g = n.group ? String(n.group) : (grp || groupHintForRole(parentRole));
      const role = roleOfNode(n, g);
      flat.push({ node: n, parent, role, list, grp: g });
      walk(n.children, n, g, role);
    }
  };
  walk(decl.stages, null, '', 'root');
  const info = new Map(flat.map((x) => [x.node, x]));

  // ① 角色落盘 + ② 位置合法性
  for (const it of flat) {
    const n = it.node;
    const role = it.role;
    if (String(n.nodeRole || '') !== role) {
      n.nodeRole = role;
      fixes.push('标注角色：' + (n.title || n.key) + ' → ' + roleLabel(role));
    }
    const parentRole = it.parent ? ((info.get(it.parent) || {}).role || 'root') : 'root';
    const p = checkPlacement(role, parentRole);
    if (p.ok) continue;
    const idx = it.list.indexOf(n);
    if (idx >= 0) it.list.splice(idx, 1);
    decl.stages.push(n);
    if (!n.group) {
      n.group = it.grp || ((role.startsWith('gen-') || role.startsWith('model-')) ? 'board' : 'story');
    }
    fixes.push(
      '挪到顶层：' + (n.title || n.key)
      + '（原来在「' + ((it.parent && it.parent.title) || '顶层') + '」下面；' + p.error + '）',
    );
    it.parent = null;
    it.list = decl.stages;
  }

  const roleOfKey = new Map();
  const titleOfKey = new Map();
  for (const it of flat) {
    const k = String(it.node.key || '');
    if (!k) continue;
    roleOfKey.set(k, it.role);
    titleOfKey.set(k, String(it.node.title || k));
  }

  // ③ 生成节点依赖
  for (const it of flat) {
    const n = it.node;
    const role = it.role;
    let keys = Array.isArray(n.dependsOn) ? n.dependsOn.map(String).filter(Boolean) : [];
    if (keys.includes(String(n.key))) {
      keys = keys.filter((k) => k !== String(n.key));
      n.dependsOn = keys;
      fixes.push('去掉自依赖：' + (n.title || n.key));
    }
    if (!DEP_RULES[role]) continue;
    const depRoles = keys.map((k) => roleOfKey.get(k)).filter(Boolean);
    if (checkDeps(role, depRoles).ok) continue;
    const cand = autoWireDep(decl.stages, role, { preferredKey: it.parent ? String(it.parent.key || '') : '' });
    if (cand) {
      n.dependsOn = [...new Set([...keys, cand.key])];
      fixes.push('接依赖：' + (n.title || n.key) + ' → ' + (titleOfKey.get(cand.key) || cand.key));
    } else {
      warnings.push((n.title || n.key) + '：找不到' + DEP_RULES[role].label + '节点可依赖');
    }
  }

  // ④ 断开"父节点依赖自己的生成子节点"（反向边）
  for (const it of flat) {
    const n = it.node;
    if (!Array.isArray(n.dependsOn) || !n.dependsOn.length) continue;
    const descendants = new Set();
    const collect = (list) => {
      for (const c of Array.isArray(list) ? list : []) {
        descendants.add(String(c.key || ''));
        collect(c.children);
      }
    };
    collect(n.children);
    const bad = n.dependsOn.map(String).filter((k) => {
      const r = roleOfKey.get(k);
      return descendants.has(k) && r && r.startsWith('gen-');
    });
    if (!bad.length) continue;
    n.dependsOn = n.dependsOn.map(String).filter((k) => !bad.includes(k));
    fixes.push('断开反向依赖：' + (n.title || n.key) + ' ← ' + bad.map((k) => titleOfKey.get(k) || k).join('、'));
  }

  // ⑤ 生成节点补默认模型
  for (const it of flat) {
    const n = it.node;
    if (!String(it.role).startsWith('gen-') || !n.media || typeof n.media !== 'object') continue;
    if (String(n.media.model || '').trim()) continue;
    const mt = String(n.media.type || it.role.slice(4) || 'image');
    const def = mt === 'video' ? 'Seedance_2.5' : (mt === 'image' ? 'seedream_5.0_pro' : 'seed-audio-1.0');
    n.media.model = def;
    fixes.push('补默认模型：' + (n.title || n.key) + ' → ' + def);
  }

  const changed = JSON.stringify(decl) !== before;
  if (changed) {
    try {
      backup(root, abs);
      writeFileSync(abs, JSON.stringify(decl, null, 2) + '\n', 'utf8');
      logChange(root, {
        op: 'repair',
        key: '',
        title: '',
        by: 'migrate',
        why: 'R47 节点层级迁移',
        detail: fixes.slice(0, 12).join('；'),
      });
      trace('[迁移] ' + root + ' 修复 ' + fixes.length + ' 处：' + fixes.slice(0, 6).join('；'));
    } catch (e) {
      return { ok: false, root, error: '迁移写盘失败：' + String((e && e.message) || e), fixes };
    }
  }
  try {
    writeFileSync(marker, JSON.stringify({
      version: 2,
      at: new Date().toISOString(),
      changed,
      fixes,
      warnings,
    }, null, 2), 'utf8');
  } catch { /* 标记写不了不影响治理结果 */ }

  return { ok: true, root, changed, fixes, warnings };
}

/** 对所有已发现的片子跑一次迁移（只跑没有标记的）。 */
function migrateAllProjects(roots, explicit) {
  const out = [];
  for (const root of discoverProjects(roots, explicit)) {
    try {
      out.push(migrateProjectStructure(root));
    } catch (e) {
      trace('[迁移] ' + root + ' 失败：' + String((e && e.message) || e));
      out.push({ ok: false, root, error: String((e && e.message) || e) });
    }
  }
  return out;
}

/**
 * 迁移入口（也导出给维护脚本/自动化验证调用）。
 * @param root 片子目录
 * @param opts `{force:true}` 忽略已迁移标记重跑
 */
export function migrateStructure(root, opts) {
  return migrateProjectStructure(String(root || ''), opts || {});
}

/**
 * 顶层能建哪些模板（R57）。
 *
 * 和「某个节点的下位白名单」分开：顶层没有父模板，只能按**角色法定**算，
 * 再排掉"有主节点"的身份模板 —— 身份/性格/外貌/服装/人物·单人/单品
 * 悬空在项目顶层没有意义（画布也不支持跨层移动，建了也挪不回去）。
 */
function rootCanAddTemplates(templates) {
  const list = Array.isArray(templates) ? templates : [];
  return list
    .filter((t) => checkPlacement(roleOfTemplate(t), 'root').ok)
    .filter((t) => {
      const info = identityOfTemplate({ id: String(t && t.id) });
      return !(info && Array.isArray(info.masters) && info.masters.length);
    })
    .map((t) => String(t.id));
}

/**
 * 一次 add 的落盘校验（角色 → 依赖 → 身份 → 下位白名单），只读、不改文件。
 *
 * 为什么抽出来（R57）：画布 ＋、骨架包、agent 提案原来各写一遍（提案那边还
 * 漏了身份层）。三处必须同一套判据，否则就会出现"菜单点不到、提案能过、
 * 落盘又被拒"的三种口径。
 *
 * @returns {ok:true, tpl, tplRole, loc} 或 {ok:false, error}
 */
function placementIssue(stages, templates, tplId, at, selfTitle) {
  const list = Array.isArray(templates) ? templates : [];
  const id = String(tplId || 'blank');
  const tpl = list.find((t) => String(t.id) === id) || null;
  if (!tpl && id !== 'blank') {
    return { ok: false, error: '没有这个模板：' + id + '。先用 filmflow_templates 看可用的 id。' };
  }
  const atKey = String(at || '');
  const loc = atKey ? locateNode(stages, atKey) : null;
  if (atKey && !loc) return { ok: false, error: '没有这个父节点：' + atKey };

  const tplRole = roleOfTemplate(tpl);
  const entries = roleEntriesOf(stages);
  const parentRole = loc ? (entries.find((e) => e.node === loc.node)?.role || roleOfNode(loc.node)) : 'root';

  /* ① 角色矩阵（R47） */
  const p = checkPlacement(tplRole, parentRole);
  if (!p.ok) {
    const where = p.allowed.filter((r) => r !== 'root').map(roleLabel).join(' / ');
    return {
      ok: false,
      error: p.error + '。' + roleLabel(tplRole) + '只能放在：项目顶层' + (where ? ' / ' + where : ''),
    };
  }

  /* ② 父节点必须能当依赖（R53） */
  const depRule = DEP_RULES[tplRole];
  if (depRule && loc && !depRule.roles.includes(normalizeRole(parentRole))) {
    return {
      ok: false,
      error: roleLabel(tplRole) + '不能建在「' + String(loc.node?.title || parentRole) + '」下面：'
        + '它必须依赖' + depRule.label + '，这个父节点当不了它的依赖。'
        + '换到' + depRule.label + '节点下面，或者建在项目顶层。',
    };
  }

  /* ③ 主从层（R52 / R54 / R56） */
  const selfId = identityOfTemplate(tpl) || identityOfTitle(selfTitle || (tpl && tpl.title));
  const parentId = loc
    ? (identityOfTemplate({ id: loc.node && loc.node.template })
      || identityOfTitle(loc.node && loc.node.title))
    : null;
  const ip = checkIdentityPlacement(selfId, parentId, !!loc, loc ? String(loc.node?.title || '') : '');
  if (!ip.ok) return { ok: false, error: ip.error + (ip.hint ? '。' + ip.hint : '') };

  /* ④ 下位白名单（R57）：父模板声明了"只收谁"，菜单和落盘读同一份 */
  const allowed = loc
    ? canAddUnder(loc.node, list, { roleIndex: roleIndexOfTemplates() })
    : rootCanAddTemplates(list);
  if (!allowed.includes(id)) {
    const nameOf = (k) => {
      const t = list.find((x) => String(x.id) === String(k));
      return String((t && t.title) || k);
    };
    /* 顶层最常见的一种：把"归属某个节点的描述节点"悬空建（身份/性格/外貌/服装/单品） */
    const selfInfo = identityOfTemplate({ id });
    if (!loc && selfInfo && Array.isArray(selfInfo.masters) && selfInfo.masters.length) {
      return {
        ok: false,
        error: '「' + nameOf(id) + '」不能悬空在项目顶层：它是「' + (selfInfo.label || '') 
          + '」下面的描述节点，要挂在对应的主节点下。',
      };
    }
    const kids = allowed.map(nameOf).filter(Boolean).join(' / ');
    const where = loc ? '「' + String(loc.node?.title || parentRole) + '」' : '项目顶层';
    return {
      ok: false,
      error: where + '下面只能建：' + (kids || '（没有可建的下位）')
        + '，不能建「' + nameOf(id) + '」',
    };
  }

  return { ok: true, tpl, tplRole, loc };
}

/**
 * 校验 agent 的 struct.add 提案（只读，不改文件）。
 *
 * 为什么在**提案时**就校验：让 agent 当场拿到"音频模型不能挂在视频提示词下"，
 * 而不是等用户点了确认才失败 —— 那时候用户已经以为改成了。
 */
function validateAddProposal(root, op) {
  let decl;
  try {
    decl = JSON.parse(readFileSync(join(root, DECL), 'utf8'));
  } catch {
    return; // 声明读不了：让真正执行时去报那个错，这里不重复
  }
  if (!Array.isArray(decl.stages)) return;

  const tplId = String(op.template || 'blank');
  const at = String(op.at || '');
  /* 角色 / 依赖 / 身份 / 下位白名单：与 structureOp 共用同一套判据（R57） */
  const ph = placementIssue(decl.stages, readTemplates(), tplId, at, op.title);
  if (!ph.ok) throw new Error(ph.error);
  const role = ph.tplRole;
  const loc = ph.loc;
  const entries = roleEntriesOf(decl.stages);

  const roleMap = new Map(entries.map((e) => [e.key, e.role]));
  const depKeys = Array.isArray(op.dependsOn) ? op.dependsOn.map(String).filter(Boolean) : [];
  const depRoles = depKeys.map((k) => roleMap.get(k)).filter(Boolean);
  const chk = checkDeps(role, depRoles);
  if (!chk.ok) {
    if (!depKeys.length) {
      const cand = autoWireDep(decl.stages, role, { preferredKey: loc ? String(loc.node.key || '') : '' });
      if (!cand) throw new Error(chk.error + '。先在项目里建一个' + chk.label + '节点，再把生成节点挂上去。');
      return; // 执行时会自动接上
    }
    throw new Error(
      chk.error + '（提案里的依赖：' + depKeys.join('、') + '）。'
      + '把 dependsOn 改成' + chk.label + '节点的 key。',
    );
  }
}

/**
 * 把一套骨架包铺到一部新片上（在标准五道工序之后追加节点）。
 *
 * @param root 片子根
 * @param packId 包 id
 * @returns {{pack:string, added:string[], skipped:string[]}}
 */
function applyPack(root, packId) {
  const pack = readPacks().find((x) => String(x.id) === String(packId));
  if (!pack) throw new Error('没有这个骨架包：' + packId);
  // 新版骨架包：整棵树（替换骨架）；老版：顶层追加，保留兼容
  if (Array.isArray(pack.tree)) return applyPackTree(root, pack);
  const added = [];
  const skipped = [];
  for (const item of pack.add || []) {
    // 包里的 atNo 是**显示编号**（"1"/"5"）—— 落盘时解析成那一步真实的 key
    const p = buildProject(root);
    if (!p.ok) throw new Error(p.error || '项目读不了');
    const stage = (p.stages || []).find((s) => String(s.no) === String(item.atNo));
    if (!stage) { skipped.push(String(item.atNo) + '→' + String(item.template) + '（没有第 ' + item.atNo + ' 步）'); continue; }
    /*
     * 同名就跳过 —— 新建片子的底模板里**已经**有「事实层 / 认知层 / 角色」这些节点，
     * 骨架包再铺一遍就会撞出两个同名节点（实测踩到：① 下面出现 事实层 ×2）。
     * 判据用标题（模板 id 没有写进节点，标题才是用户看得见的那个"同一个"）。
     */
    const tpl = readTemplates().find((t) => String(t.id) === String(item.template));
    const wantTitle = String((tpl && tpl.title) || '').trim();
    const exists = (stage.children || []).some((c) => String(c.title || '').trim() === wantTitle);
    if (wantTitle && exists) { skipped.push(wantTitle + '（已经有了）'); continue; }
    try {
      const r = structureOp(root, { type: 'add', at: stage.key, template: item.template });
      added.push(String(item.template) + '→' + String(r.key));
    } catch (e) {
      skipped.push(String(item.template) + '（' + String((e && e.message) || e) + '）');
    }
  }
  return { pack: String(pack.id), added, skipped };
}

/**
 * 按骨架包的 `tree` 铺一整棵初始树（**替换**默认骨架，从空白开始）。
 *
 * 为什么要这层：广告/纪录片这类片子树里没有事实层、没有人物，
 * 在"标准五道工序"上追加是做不出来的。
 *
 * 每个 tree 节点：`{t:模板id, title?, group?, deps?:[标题], children?:[]}`
 *   · 先按顺序建节点（structureOp add：自带备份/编号/落盘）
 *   · 再按**标题**把 deps 解析成 key，写回 dependsOn
 *     （元素 → 提示词就是靠这一步连起来的）
 */
function applyPackTree(root, pack) {
  const abs = join(root, DECL);
  const decl = JSON.parse(readFileSync(abs, 'utf8'));
  decl.stages = [];
  writeFileSync(abs, JSON.stringify(decl, null, 2) + '\n', 'utf8');
  for (const d of ['设定', '剧本', '音频提示词', '视频提示词', '采访', '工艺', 'tools']) {
    try { mkdirSync(join(root, d), { recursive: true }); } catch { /* 忽略 */ }
  }

  const added = [];
  const skipped = [];
  const keyOf = new Map();
  const byTitle = new Map();

  const addAll = (items, parentKey) => {
    for (const it of items || []) {
      const tplId = String((it && it.t) || '');
      if (!tplId) continue;
      try {
        const r = structureOp(root, {
          type: 'add',
          at: parentKey || '',
          template: tplId,
          title: it.title,
          group: it.group,
          by: 'pack',
        });
        keyOf.set(it, r.key);
        if (r.title && !byTitle.has(String(r.title))) byTitle.set(String(r.title), r.key);
        added.push(String(r.key));
        if (it.children) addAll(it.children, r.key);
      } catch (e) {
        skipped.push(tplId + '（' + String((e && e.message) || e) + '）');
      }
    }
  };
  addAll(pack.tree, '');

  let next;
  try { next = JSON.parse(readFileSync(abs, 'utf8')); } catch { next = decl; }
  const all = [];
  const walk = (list) => { for (const n of list || []) { all.push(n); walk(n.children); } };
  walk(next.stages);
  const byKey = new Map(all.map((n) => [String(n.key), n]));

  const applyDeps = (items) => {
    for (const it of items || []) {
      const key = keyOf.get(it);
      const node = key ? byKey.get(String(key)) : null;
      if (node && Array.isArray(it.deps) && it.deps.length) {
        const ks = it.deps.map((t) => byTitle.get(String(t))).filter(Boolean);
        const uniq = [...new Set(ks.map(String))].filter((k) => k !== String(key));
        if (uniq.length) node.dependsOn = uniq;
      }
      applyDeps(it.children);
    }
  };
  applyDeps(pack.tree);

  renumber(next.stages);
  writeFileSync(abs, JSON.stringify(next, null, 2) + '\n', 'utf8');
  return { pack: String(pack.id), added, skipped };
}

/** 一次请求最多读多少请求体（诊断用，防止无界缓冲）。 */
const MAX_BODY = 64 * 1024;

/**
 * 诊断日志。best-effort：追踪绝不能成为插件加载失败的原因
 * （照抄 dsh-ui-session-files 的做法 —— 宿主启动失败否则是静默的）。
 *
 * ⚠️ **测试会污染真实日志** —— 这是个真问题，坑过我两次：
 *    `selftest.mjs` / `verify-*.mjs` 都会调 `apply()`，于是往同一个日志里写
 *    "已注册路由 X"、"apply() 进入"，跟真实进程的记录混在一起。
 *    我因此两次误判"进程换版了"（其实那是测试写的）。
 *
 * 所以：**环境变量 `DSH_FILMFLOW_TRACE` 可以接管或关闭它**。
 *   · 设成一个路径 → 写到那儿
 *   · 设成空字符串 → 完全静默
 * 测试里设空字符串，真实日志就干净了。
 */
function trace(msg) {
  if (!TRACE) return; // 显式关闭
  try {
    appendFileSync(TRACE, new Date().toISOString() + '  ' + msg + '\n', 'utf8');
  } catch {
    /* 追踪是尽力而为 */
  }
}

/* ------------------------------------------------------------------ *
 * glob：只支持 `*`，够用了，不为它引依赖
 * ------------------------------------------------------------------ */

/** 转义正则元字符。 */
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 把一个 `*` 通配的文件名片段编成正则。
 * @param pattern 文件名部分，可含 `*`
 */
function nameMatcher(pattern) {
  const source = pattern.split('*').map(escapeRe).join('.*');
  const re = new RegExp('^' + source + '$');
  return (name) => re.test(name);
}

/**
 * 把 `目录/文件名通配` 形式的 glob 解析成实际文件列表。
 * @param root 项目根绝对路径
 * @param glob 相对 glob，如 `音频提示词/audio-*.txt`
 * @returns `{ count, files }`；目录不存在或读不了时是 `{count:0, files:[]}`
 */
function resolveGlob(root, glob) {
  const norm = String(glob).replace(/\\/g, '/');
  const cut = norm.lastIndexOf('/');
  const dirPart = cut >= 0 ? norm.slice(0, cut) : '';
  const filePart = cut >= 0 ? norm.slice(cut + 1) : norm;

  const dir = dirPart ? join(root, ...dirPart.split('/')) : root;
  if (!existsSync(dir)) return { count: 0, files: [], all: [], dir };

  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return { count: 0, files: [], all: [], dir, error: String((e && e.message) || e) };
  }

  const test = nameMatcher(filePart);
  const files = entries
    .filter((e) => e.isFile() && test(e.name))
    .map((e) => e.name)
    .sort();

  // `files` 只给前几个做预览；`all` 是全部（内容树要按文件逐个建节点，需要全部）。
  return { count: files.length, files: files.slice(0, 8), all: files.slice(0, 3000), dir };
}

/* ------------------------------------------------------------------ *
 * 内容树：markdown 标题层级 = 树，正文 = 内容
 *
 * 用户 2026-10-14 定的模型（B）：**画布就是文档本身**，最下游的节点就是内容，
 * 不是"指向某个文件"。所以内容得从 markdown 里解析成节点。
 *
 * 约定（一个文件一份真源）：
 *   # 文件标题        ← 对应"声明了它的那个节点"，不参与建树
 *   ## 节点标题       ← 建一个内容节点
 *   > 作用：一句话     ← 可选，标题下开头的 blockquote 就是这个节点的「作用」
 *   其余正文          ← 这个节点的「内容」
 *   ### 更深的标题     ← 继续往下建
 *
 * 一个文件里连一个 ## 都没有 → 整个正文就是"声明它的那个节点"的内容。
 * ------------------------------------------------------------------ */

/**
 * 单个内容节点送上画布的正文上限（字符）。
 *
 * ⚠️ 这个值直接关系**会不会丢数据**：客户端拿这段文字填编辑框，
 *    保存时原样写回。所以上限一旦卡住真实内容，用户一保存就把后半段截没了。
 *    原来设 4000，对剧本那种长正文不够 —— 提到 20 万，实际等于不截断。
 *    画布上只显示一行摘要，全文在编辑框里（可滚动），所以大一点不影响观感。
 */
const MAX_TEXT = 200000;

/** 按上限裁一段文本，裁了就明说（正常内容永远裁不到）。 */
function cap(text) {
  const t = String(text == null ? '' : text);
  return t.length > MAX_TEXT ? t.slice(0, MAX_TEXT) + '\n…（超长已截断）' : t;
}

/**
 * 把 markdown 按标题切成树。代码围栏里的 `#` 不算标题。
 * @param text 文件正文
 * @returns 一棵标题树（虚拟根 level=0，它的 children 是顶层标题）
 */
function parseHeadings(text) {
  const lines = String(text).split(/\r?\n/);
  const root = { level: 0, title: '', lines: [], children: [], line: 0 };
  const stack = [root];
  let fence = false;
  /*
   * ★ 容错：一个文件里出现**多个一级标题**时，第二个起按二级读。
   *
   * 用户 2026-10-22《测试2/剧本/剧本.md》：
   *     # 写剧本
   *     # 校准            ← 第二个一级标题
   *     ## 场次一 · 校验室
   * 严格解析时 `# 校准` 会变成第一个标题的**兄弟**，于是这个节点自己只剩一句"校准"，
   * 而 `## 场次一` 也不再是它的条目 —— 画布上就是"2 写剧本 / 校准"这种怪东西。
   * ⇒ 只改**读法**，文件本身一个字不动。
   */
  let sawH1 = false;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (/^\s*(```|~~~)/.test(raw)) fence = !fence;
    const m = fence ? null : raw.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (m) {
      let level = m[1].length;
      if (level === 1) {
        if (sawH1) level = 2;
        else sawH1 = true;
      }
      while (stack.length > 1 && stack[stack.length - 1].level >= level) stack.pop();
      const node = { level, title: m[2], lines: [], children: [], line: i + 1 };
      stack[stack.length - 1].children.push(node);
      stack.push(node);
    } else {
      stack[stack.length - 1].lines.push(raw);
    }
  }
  return root;
}

/**
 * 从一段正文里分出「作用」与「内容」。
 * 作用 = 正文开头紧跟标题的那个 blockquote（写成 `> 作用：…` 或 `> 说明：…` 都认）。
 * @param lines 该标题下的原始行
 * @returns `{ role, text }`
 */
function splitRole(lines) {
  const body = lines.join('\n').replace(/^\s*\n/, '').trim();
  const m = body.match(/^>\s*(?:作用|说明)\s*[：:]\s*([\s\S]*?)(?:\n\s*\n|$)/);
  if (!m) return { role: '', text: body };
  const role = m[1].replace(/\n\s*>\s?/g, ' ').trim();
  return { role, text: body.slice(m[0].length).trim() };
}

/**
 * 标题树 → 内容节点数组。
 *
 * **`#` 那一层不建树** —— 它是文件标题，对应"声明了这个文件的那个节点"。
 * 所以先把 `#` 的子节点提上来，再往下建。（文件名 `人物.md` 里的 `# 人物`
 * 不该在画布上多出一层"人物"。）
 *
 * @param parent 标题树里的一个节点
 * @param path 前缀，用来生成稳定 id
 * @param src 源文件的相对路径（将来就地编辑要靠它定位）
 */
function toContentNodes(parent, path, src) {
  const list = [];
  for (const c of parent.children) {
    if (c.level === 1) list.push(...c.children);
    else list.push(c);
  }

  return list.map((c, i) => {
    const id = path + '/' + i;
    const { role, text } = splitRole(c.lines);
    return {
      id,
      kind: 'content',
      via: 'md',
      title: c.title,
      role,
      text: cap(text),
      line: c.line,
      src,
      children: toContentNodes(c, id, src),
    };
  });
}

/**
 * 收集一个工序节点声明的内容。
 *
 * 声明里两种写法：
 *   `md:    ["设定/人物.md"]`       → 解析它的标题树，挂成子树（一份文件一份真源）
 *   `files: ["音频提示词/*.txt"]`   → 一个文件 = 一个内容节点，节点正文就是文件内容
 *
 * @param root 项目根
 * @param node 工序声明里的一个节点
 * @param path 树路径，用来生成稳定 id
 */
/**
 * 读一个节点**自己的正文**，以及它下面的子节点。
 *
 * ⚠️ 2026-10-14 改对的一处关键模型错误：
 *   原来是"节点指着一个内容文件、另生一个子节点去装它"，于是 `1.3 事实层` 自己是空的、
 *   正文跑到了旁边一个红色子节点里。用户要的是 ——
 *   **每个节点自己就是正文的家，所有节点的正文都能在图上直接改。**
 *   所以现在：`md: [file]` 那份文件属于**本节点**；文件里的 `##` 子标题才是子节点。
 *
 * @returns `{ role, text, src, line, via, children }`
 */
/* ------------------------------------------------------------------ *
 * 形态解析 —— markdown ⇄ 结构化
 *
 * 用户 2026-10-14：「每个节点的目标任务都不同，UI 上全部都共用一种单个内容框
 * 肯定是不合适的，该一个框就一个框，该分表格的就分表格，该多栏的就多栏。」
 *
 * 契约见 plugins/dsh-filmflow/形态规范.md。一句话：
 *   **markdown 是存储格式，形态是它的一种视图。**
 *
 * ⚠️ 铁律：**解析不了就退回纯文本，绝不丢内容。**
 *     Agent 可能写出格式不对的东西，用户也可能手改文件 ——
 *     宁可让人看到一个原始文本框，也不能把内容解析没了。
 * ------------------------------------------------------------------ */

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 去掉首尾空行。 */
function trimBlank(lines) {
  const a = lines.slice();
  while (a.length && a[0].trim() === '') a.shift();
  while (a.length && a[a.length - 1].trim() === '') a.pop();
  return a;
}

/** 拆一行 markdown 表格：`| a | b |` → `['a','b']`。 */
function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
}

/** 这一行是表格分隔行吗（`|---|---|`）。 */
function isTableSep(line) {
  return /^\s*\|?[\s:|-]*\|?\s*$/.test(line) && line.includes('-');
}

/* ---------------- list：一条一张卡 ---------------- */

/**
 * 把一个 `list` 条目的字段值拼回一段 markdown —— 子节点的 `text` 用它。
 * （卡片主要按字段渲染；这个 `text` 是"形态不认时退回纯文本"的兜底，按铁律不能丢内容）
 */
function renderListItemText(doc, item) {
  const fields = Array.isArray(doc?.fields) ? doc.fields : [];
  const L = [];
  for (const f of fields) {
    const v = String((item && item[f.key]) ?? '').trim();
    if (!v) continue;
    if (f.type === 'line') {
      L.push(f.quote ? '> ' + f.label + '：' + v : v);
    } else {
      L.push(v);
    }
    L.push('');
  }
  if (!L.length) {
    // 字段全空 ⇒ 退回整条对象的可读文本，绝不吐出空串
    for (const [k, v] of Object.entries(item || {})) {
      if (typeof v === 'string' && v.trim()) L.push(String(v).trim());
    }
  }
  return L.join('\n').trim();
}
function parseList(text, shape) {
  const tree = parseHeadings(String(text ?? ''));
  const fields = (Array.isArray(shape.fields) ? shape.fields : []).map((f) => ({
    key: String(f.key),
    label: String(f.label || f.key),
    type: f.type === 'line' ? 'line' : 'text',
    quote: !!f.quote,
    heading: !!f.heading,
  }));

  // parseHeadings 返回的是**嵌套树**：`## 唐老板` 挂在 `# 人物` 的 children 里
  const root = tree.children.find((c) => c.level === 1) || tree;
  const items = root.children || [];
  if (items.length === 0) return null; // 一条都没有 → 不是这个形态

  const out = [];
  for (const it of items) {
    const rec = { title: it.title || '' };
    const lines = it.lines.slice();

    for (const f of fields) {
      if (f.key === 'title') continue;
      if (f.quote) {
        const re = new RegExp('^\\s*>\\s*' + esc(f.label) + '\\s*[：:]');
        const i = lines.findIndex((l) => re.test(l));
        rec[f.key] = i >= 0 ? lines[i].replace(/^\s*>\s*[^：:]*[：:]\s*/, '').trim() : '';
        if (i >= 0) lines.splice(i, 1);
      } else if (f.heading) {
        const kid = (it.children || []).find((c) => c.title === f.label);
        rec[f.key] = kid ? trimBlank(kid.lines).join('\n') : '';
      } else if (f.type === 'line') {
        /*
         * 单行字段写成 `- 标签：值`（见 renderList）。
         * ⚠️ 这里必须**读回来** —— 否则往返时那一行会掉进正文里，
         * 是静默的数据错位，不是丢一行那么简单。
         */
        const re = new RegExp('^\\s*[-*·]\\s*' + esc(f.label) + '\\s*[：:]');
        const i = lines.findIndex((l) => re.test(l));
        rec[f.key] = i >= 0 ? lines[i].replace(re, '').trim() : '';
        if (i >= 0) lines.splice(i, 1);
      } else {
        rec[f.key] = '';
      }
    }

    // 剩下的正文归给第一个既不是 quote 也不是 heading 的字段
    const bodyF = fields.find((f) => f.key !== 'title' && !f.quote && !f.heading);
    if (bodyF) rec[bodyF.key] = trimBlank(lines).join('\n');

    out.push(rec);
  }

  return { kind: 'list', itemLabel: String(shape.item || '条目'), fields, items: out };
}

function renderList(data) {
  const lines = [];
  for (const it of data.items || []) {
    lines.push('## ' + (String(it.title || '').trim() || '(未命名)'), '');
    for (const f of data.fields || []) {
      if (f.key === 'title' || f.heading) continue;
      const v = String(it[f.key] ?? '').trim();
      if (!v) continue;
      if (f.quote) lines.push('> ' + f.label + '：' + v, '');
      else if (f.type === 'line') lines.push('- ' + f.label + '：' + v, '');
      else lines.push(...v.split('\n'), '');
    }
    for (const f of data.fields || []) {
      if (!f.heading) continue;
      const v = String(it[f.key] ?? '').trim();
      lines.push('### ' + f.label, '');
      if (v) lines.push(...v.split('\n'));
      lines.push('');
    }
  }
  return lines.join('\n');
}

/* ---------------- table：一行一条 ---------------- */

function parseTable(text, shape) {
  const cols = (Array.isArray(shape.columns) ? shape.columns : []).map((c) => ({
    key: String(c.key),
    label: String(c.label || c.key),
  }));
  if (cols.length === 0) return null;

  const raw = String(text ?? '').split(/\r?\n/);
  const groups = [];
  let path = []; // 标题栈 —— `## Chapter 1` / `### 场次` 都算分组
  let cur = null;
  let head = null;

  const fresh = () => ({ path: path.filter(Boolean), rows: [] });

  for (const line of raw) {
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const lv = h[1].length;
      path = path.slice(0, lv - 1);
      path[lv - 1] = h[2].trim();
      cur = null;
      head = null;
      continue;
    }
    if (!/^\s*\|/.test(line)) continue;
    if (isTableSep(line)) continue;

    const cells = splitRow(line);
    if (!head) {
      head = cells;
      cur = fresh();
      groups.push(cur);
      continue;
    }
    if (!cur) {
      cur = fresh();
      groups.push(cur);
    }
    const rec = {};
    cols.forEach((c, idx) => {
      let at = cells.length === cols.length ? idx : head.indexOf(c.label);
      if (at < 0) at = idx;
      const v = cells[at];
      rec[c.key] = v === undefined ? '' : v;
    });
    cur.rows.push(rec);
  }

  const real = groups.filter((g) => g.rows.length > 0);
  if (real.length === 0) return null; // 没解析出表格 → 不是这个形态

  return { kind: 'table', columns: cols, groups: real };
}

function renderTable(data) {
  const cols = data.columns || [];
  const lines = [];
  for (const g of data.groups || []) {
    const p = (g.path || []).filter(Boolean);
    if (p.length) lines.push('## ' + p[p.length - 1], '');
    lines.push('| ' + cols.map((c) => c.label).join(' | ') + ' |');
    lines.push('|' + cols.map(() => '---').join('|') + '|');
    for (const r of g.rows || []) {
      lines.push(
        '| ' + cols.map((c) => String(r[c.key] ?? '').replace(/\|/g, '\\|')).join(' | ') + ' |',
      );
    }
    lines.push('');
  }
  return lines.join('\n');
}

/* ---------------- matrix：行 × 列 ---------------- */

function parseMatrix(text, shape) {
  const fields = (Array.isArray(shape.fields) ? shape.fields : []).map((f) => ({
    key: String(f.key),
    label: String(f.label || f.key),
  }));
  if (fields.length === 0) return null;

  // 嵌套树：`## 阶段` 挂在 `# 认知层` 下，`### 人物` 挂在 `## 阶段` 下
  const tree2 = parseHeadings(String(text ?? ''));
  const top = tree2.children.find((c) => c.level === 1) || tree2;
  const rows = (top.children || []).filter((c) => c.level >= 2);
  if (rows.length === 0) return null;

  const out = [];
  for (const r of rows) {
    const cols = (r.children || []).filter((c) => c.level >= 3);
    const cells = cols.map((c) => {
      const rec = { title: c.title || '' };
      for (const f of fields) {
        const re = new RegExp('^\\s*[-*·]?\\s*' + esc(f.label) + '\\s*[：:]');
        const hit = c.lines.find((l) => re.test(l));
        rec[f.key] = hit ? hit.replace(re, '').trim() : '';
      }
      return rec;
    });
    out.push({ title: r.title || '', cells });
  }

  return {
    kind: 'matrix',
    rowLabel: String(shape.row || '行'),
    colLabel: String(shape.col || '列'),
    fields,
    rows: out,
  };
}

function renderMatrix(data) {
  const lines = [];
  for (const r of data.rows || []) {
    lines.push('## ' + (String(r.title || '').trim() || '(未命名)'), '');
    for (const c of r.cells || []) {
      lines.push('### ' + (String(c.title || '').trim() || '(未命名)'), '');
      for (const f of data.fields || []) {
        lines.push('- ' + f.label + '：' + String(c[f.key] ?? '').trim());
      }
      lines.push('');
    }
  }
  return lines.join('\n');
}

/* ---------------- 总入口 ---------------- */

/** 按形态解析。**解析不了返回 null**，调用方据此退回纯文本。 */
function parseShape(text, shape) {
  const kind = shape && shape.kind ? String(shape.kind) : 'text';
  if (kind === 'text') return { kind: 'text', text: String(text ?? '') };
  try {
    if (kind === 'list') return parseList(text, shape);
    if (kind === 'table') return parseTable(text, shape);
    if (kind === 'matrix') return parseMatrix(text, shape);
    /*
     * 2026-10-28：`select` —— 模型选择节点用。
     * 内容就是一行「选中的值」；选项由声明里的 options 给（[字符串] 或 [{value,label}]）。
     * 值不在选项里 → 仍然返回 doc（好让选择器把值显示出来），但 valid=false、给 hint。
     */
    if (kind === 'select') {
      const opts = (Array.isArray(shape.options) ? shape.options : [])
        .map((o) => (o && typeof o === 'object'
          ? { value: String(o.value ?? o.label ?? ''), label: String(o.label ?? o.value ?? '') }
          : { value: String(o), label: String(o) }))
        .filter((o) => o.value);
      // 文件自带 # 标题 行（structureOp 建的），取第一条非标题行作为选中值
      const value = String(text ?? '').split(/\r?\n/).map((s) => s.trim()).filter((l) => l && !/^#{1,6}\s/.test(l))[0] || '';
      const ok = !value || opts.some((o) => o.value === value);
      return { kind: 'select', options: opts, value: ok ? value : value, valid: ok };
    }
  } catch {
    return null;
  }
  return null;
}

/** 结构化数据 → markdown。 */
function renderShape(data) {
  if (!data) return '';
  if (data.kind === 'text') return String(data.text ?? '');
  if (data.kind === 'list') return renderList(data);
  if (data.kind === 'table') return renderTable(data);
  if (data.kind === 'matrix') return renderMatrix(data);
  if (data.kind === 'select') return String(data.value ?? '');
  return '';
}

/**
 * 空内容的形态骨架。
 *
 * ⚠️ 这个函数是**必需的**，不是锦上添花：
 *   空白模板上每个节点的内容都是空的。如果不给空骨架，
 *   `doc` 就是 null → 客户端一律退回纯文本框 →
 *   **用户要求的「该分表格的就分表格、该多栏的就多栏」在空白模板上根本看不见**，
 *   得等 Agent 先写出合规内容才出现。那等于没做。
 *
 * 所以空内容也要给出该形态的空结构：列表有「＋ 加一条」，表格有表头，
 * 矩阵有「＋ 加一个阶段」。
 */
function emptyDoc(shape) {
  const kind = shape && shape.kind ? String(shape.kind) : 'text';
  const fields = (arr) =>
    (Array.isArray(arr) ? arr : []).map((f) => ({
      key: String(f.key),
      label: String(f.label || f.key),
      type: f.type === 'line' ? 'line' : 'text',
      quote: !!f.quote,
      heading: !!f.heading,
    }));
  const columns = (arr) =>
    (Array.isArray(arr) ? arr : []).map((c) => ({ key: String(c.key), label: String(c.label || c.key) }));

  if (kind === 'list') {
    return {
      kind: 'list',
      itemLabel: String(shape.item || '条目'),
      fields: fields(shape.fields),
      items: [],
    };
  }
  if (kind === 'table') {
    // 留一个空组，这样「＋ 加一行」在空表上也看得见
    return { kind: 'table', columns: columns(shape.columns), groups: [{ path: [], rows: [] }] };
  }
  if (kind === 'matrix') {
    return {
      kind: 'matrix',
      rowLabel: String(shape.row || '行'),
      colLabel: String(shape.col || '列'),
      fields: fields(shape.fields),
      rows: [],
    };
  }
  if (kind === 'select') {
    const opts = (Array.isArray(shape.options) ? shape.options : [])
      .map((o) => (o && typeof o === 'object'
        ? { value: String(o.value ?? o.label ?? ''), label: String(o.label ?? o.value ?? '') }
        : { value: String(o), label: String(o) }))
      .filter((o) => o.value);
    return { kind: 'select', options: opts, value: '', valid: true };
  }
  return null; // text 形态不需要骨架（客户端本来就用纯文本框）
}

/**
 * 把形态与解析结果挂到节点上。
 *
 * `doc` 有值 = 客户端按形态渲染（内容为空时也是一个**空的该形态结构**）；
 * `doc` 为 null = 这个节点就是纯文本，或者内容不符合声明的形态。
 * `shapeOk` 为 false 时卡片里要明说"这份内容不符合本节点的形态"。
 */
function attachShape(node, text) {
  const shape =
    node && node.shape && typeof node.shape === 'object' ? node.shape : { kind: 'text' };
  const src = String(text ?? '');
  const empty = src.trim() === '';
  const doc = empty ? emptyDoc(shape) : parseShape(src, shape);
  node.shape = shape;
  node.doc = doc;
  node.shapeOk = empty || !!doc;
  if (shape.kind !== 'text' && !empty && !doc) {
    node.hint = '这份内容不符合本节点的「' + shape.kind + '」形态，先按纯文本显示。';
  }
  return node;
}

function buildContent(root, node, path) {
  const children = [];
  let role = '';
  let text = '';
  let src = '';
  let line = 0;
  let via = '';

  // ---- md：这份文件就是**本节点的正文**；它的 `##` 子标题才是子节点 ----
  const mds = Array.isArray(node?.md) ? node.md : [];

  /*
   * `files`：一个文件 = 一个内容节点。
   * 两种历史写法都有：数组（老片子）和单个字符串（D13 骨架包一开始写成了 String）。
   * 统一 `[].concat(...)` —— 否则字符串会被当成"没有 glob"，一集一文件直接失效。
   * ⚠️ 这个值要在下面的 `wholeFile` 判断**之前**算出来：带 `files` 的模板
   *    通常也声明了 `shape:{kind:'text'}`，如果先走 wholeFile 分支就永远不会建文件子节点
   *    （2026-10-27 实测：短剧预设的「分集剧本」一个子节点都不出）。
   */
  const globs = [].concat(node?.files || []).map((g) => String(g)).filter(Boolean);

  /*
   * 声明了非 `text` 形态 → **整份文件归本节点，不按标题切子节点**。
   *
   * 为什么必须这样：`分镜表.md` 的结构是
   *     # 分镜表  →  ## Chapter 1  →  ### 场次  →  表格
   * 旧逻辑把 `##` 切成子节点，于是节点头上没内容、表格跑到孙子节点去了，
   * 而 `table` 形态的解析器要的是**整份文件**。两者不可能同时成立。
   *
   * 规则：`shape.kind === 'text'`（默认）走标题树；其余形态整份归本节点。
   */
  /*
   * **声明了形态的节点 → 整份文件归它，不按标题切子节点。**
   *
   * 规则（v18 起，比原来干净）：
   *   · 声明了 `shape`（不管哪种）→ 整份文件是这个节点的正文。
   *     `text` = "一个大框，别切"；list/table/matrix 由形态解析器自己认结构。
   *   · **没声明** `shape` → 老行为：按标题树切，`##` 变子节点。
   *
   * 为什么原来不对：原来只有"非 text 形态"才整份归自己，于是 `shape: {kind:'text'}`
   * 反而走标题树 —— **"我要一个大框，把故事全丢进去"这个最朴素的需求做不到**
   * （故事里只要有 `##`，就会被切成一堆子节点）。用户 2026-10-14 提的。
   */
  const wholeFile = !!(node?.shape && node.shape.kind) && !globs.length;
  if (wholeFile) {
    const rel = String(mds[0] || '').replace(/\\/g, '/');
    const abs = rel ? join(root, ...rel.split('/')) : '';
    let raw = '';
    if (abs && existsSync(abs)) {
      try {
        raw = readFileSync(abs, 'utf8');
      } catch {
        raw = '';
      }
    }
    const sn = attachShape({ shape: node.shape }, raw);

    /*
     * ══ ★★ `list` 形态：**一个条目一个子节点** ══
     *
     * 用户 2026-10-19：「人物不要全放一个框里，要做成多个下游节点，每个节点两个框，
     * 一个是人物名，一个是人物的简单介绍，给人看，给人改的，**一个人物新建一个节点**。」
     *
     * 原来这里对所有声明了 shape 的节点一律 `wholeFile` ⇒ 1.1 人物 只有一个大框 ✗
     * 但 `list` 跟 `table`/`matrix` 不一样：
     *   · `table` / `matrix` —— 结构是**整份文件**的（列定义 + 行），切了就散 ✗
     *   · **`list` —— 每个条目本来就是独立的一块** ✓ 天然适合一节点一条目 ✓
     *
     * 所以：`list` ⇒ 把 `doc.items` 拆成子节点，**每个子节点带自己的字段值**，
     * 卡片就能按字段渲染成一个个框（姓名 / 简介 …），给人看、给人改 ✓
     */
    const isList = sn.doc && sn.doc.kind === 'list' && Array.isArray(sn.doc.items);
    const listKids = isList
      ? sn.doc.items.map((it, i) => ({
          id: '', // 由调用方补
          no: '',
          title: String(it.title || (sn.doc.itemLabel || '条目') + ' ' + (i + 1)),
          role: '',
          text: cap(renderListItemText(sn.doc, it)),
          src: rel,
          line: Number(it.line) || 0,
          via: 'md',
          whole: false,
          shape: sn.shape,
          // ★ 这一个条目的字段值 —— 卡片按它渲染成一排框
          doc: { kind: 'item', itemLabel: sn.doc.itemLabel || '条目', fields: sn.doc.fields, values: it, index: i },
          shapeOk: true,
          shapeHint: '',
          children: [],
          // 内部用：写回时要靠它把条目塞回父的 list doc
          __parentSrc: rel,
          __itemIndex: i,
        }))
      : [];

    return {
      role: '',
      // 退回纯文本时给的就是**整份原始文件**，一个字都不少
      text: cap(raw),
      src: rel,
      line: 0,
      via: 'md',
      whole: true,
      shape: sn.shape,
      doc: sn.doc,
      shapeOk: sn.shapeOk,
      shapeHint: sn.hint || '',
      children: listKids,
    };
  }

  for (let i = 0; i < mds.length; i++) {
    const rel = String(mds[i]).replace(/\\/g, '/');
    const abs = join(root, ...rel.split('/'));
    const id = path + '/md' + i;

    if (!existsSync(abs)) {
      // 文件还没建。**第一个 md 认作本节点的正文来源**（src 先记下、正文留空，
      // 用户在图上写完保存时把文件建出来）；多出来的那些仍出一个红色子节点，
      // 好让"还缺哪份文件"看得见。
      if (i === 0) {
        src = rel;
        line = 0;
        via = 'md';
      } else {
        children.push({
          id,
          kind: 'missing',
          via: 'md',
          title: rel,
          role: '',
          hint: '这个文件还没建 —— 写下内容点保存，它会连文件一起建出来',
          text: '',
          line: 0,
          src: rel,
          children: [],
        });
      }
      continue;
    }

    let raw = '';
    try {
      raw = readFileSync(abs, 'utf8');
    } catch (e) {
      children.push({
        id,
        kind: 'missing',
        via: 'md',
        title: rel,
        role: '',
        hint: '读不了：' + String((e && e.message) || e),
        text: '',
        line: 0,
        src: rel,
        children: [],
      });
      continue;
    }

    const tree = parseHeadings(raw);
    const head = tree.children.find((c) => c.level === 1) || tree;
    const kids = toContentNodes(tree, id, rel);
    const own = splitRole(head.lines);

    if (i === 0) {
      // 本节点的正文 = `# 标题` 到第一个 `##` 之间那一段
      role = own.role;
      text = own.text;
      src = rel;
      line = head.line || 1;
      via = 'md';
      children.push(...kids);
    } else {
      // 多余的 md 文件：整份挂成一个子节点
      children.push({
        id,
        kind: 'content',
        via: 'md',
        title: head.title || rel,
        role: own.role,
        text: cap(own.text),
        line: head.line || 1,
        src: rel,
        children: kids,
      });
    }
  }

  // ---- files：一个文件 = 一个内容节点（`globs` 已在函数开头算好）----
  for (const g of globs) {
    const r = resolveGlob(root, g);
    for (const name of r.all || []) {
      const abs = join(r.dir, name);
      let text = '';
      try {
        text = readFileSync(abs, 'utf8');
      } catch {
        text = '';
      }
      const rel = relative(root, abs).replace(/\\/g, '/');
      children.push({
        id: path + '/f' + children.length,
        kind: 'content',
        via: 'files',
        title: name,
        role: '',
        text: cap(text),
        /*
         * ⚠️ `line: 0` + `whole: true` —— 这两个字段**必须**是这对值。
         *
         * `files:` 出来的文件（audio-001.txt 这类提示词）**根本没有标题行**。
         * 原来这里填的是 `line: 1`，于是写回时走"按节改写"分支，
         * `applyEdit` 去校验第 1 行是不是标题 → 抛「第 1 行不是标题，拒绝按节改写」。
         * 后果：④⑤ 的提示词在界面上**一个都改不了**（赛博故事里 84+58 个）。
         * 自测抓出来的。
         */
        line: 0,
        whole: true,
        src: rel,
        children: [],
      });
    }
  }

  // 形态：这个节点的正文该用哪种编辑形态（规范见 形态规范.md）
  const shaped = attachShape({ shape: node?.shape }, text);

  // 本节点的正文与它的子节点一起交出去
  return {
    role,
    text: cap(text),
    src,
    line,
    via,
    shape: shaped.shape,
    doc: shaped.doc,
    shapeOk: shaped.shapeOk,
    shapeHint: shaped.hint || '',
    children,
  };
}

/* ------------------------------------------------------------------ *
 * 写回：把图上的一次编辑落回源文件
 *
 * 这是本插件唯一会**改用户文件**的地方，所以三道护栏：
 *   ① 路径白名单：只能写 project.json 里 md / files 声明过的文件
 *      （绝对路径必须命中，且 src 不许含 ..）
 *   ② 先备份：改之前把原文件复制到 <项目>/.film/backups/<时间戳>-<文件名>
 *   ③ 标题校验：按行号改的时候，那一行必须真的是标题，否则拒绝
 * ------------------------------------------------------------------ */

/** 备份目录（在项目的 .film 下，跟项目一起走）。 */
const BACKUP_DIR = join('.film', 'backups');

/**
 * 改之前先备份原文件。原文件不存在就跳过（那是"新建"）。
 * @param root 项目根
 * @param abs 要改的文件绝对路径
 * @returns 备份文件路径；没备份则空串
 */
function backup(root, abs) {
  if (!existsSync(abs)) return '';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const flat = relative(root, abs).replace(/[\\/]/g, '__');
  const dir = join(root, BACKUP_DIR);
  mkdirSync(dir, { recursive: true });
  const dst = join(dir, stamp + '-' + flat);
  copyFileSync(abs, dst);
  return dst;
}

/**
 * 这个绝对路径允许被写吗？
 *
 * 只认 project.json 里声明过的：
 *   · `md: ["设定/人物.md"]`      → 精确路径，**文件还不存在也允许**（那是"新建"）
 *   · `files: ["提示词/*.txt"]`   → 相对路径要匹配那个 glob
 *
 * @param root 项目根
 * @param decl 工序声明
 * @param abs 待写文件的绝对路径
 */
function isWritable(root, decl, abs) {
  const low = abs.toLowerCase();
  const rel = relative(root, abs).replace(/\\/g, '/');
  let ok = false;

  const walk = (s) => {
    for (const r of Array.isArray(s?.md) ? s.md : []) {
      const p = join(root, ...String(r).replace(/\\/g, '/').split('/'));
      if (p.toLowerCase() === low) ok = true;
    }
    for (const g of [].concat(s?.files || []).map((x) => String(x)).filter(Boolean)) {
      const norm = String(g).replace(/\\/g, '/');
      const cut = norm.lastIndexOf('/');
      const dirPart = cut >= 0 ? norm.slice(0, cut) : '';
      const filePart = cut >= 0 ? norm.slice(cut + 1) : norm;
      const relOk = dirPart ? rel.startsWith(dirPart + '/') : !rel.includes('/');
      const relFile = dirPart ? rel.slice(dirPart.length + 1) : rel;
      if (relOk && nameMatcher(filePart)(relFile)) ok = true;
    }
    for (const c of Array.isArray(s?.children) ? s.children : []) walk(c);
  };

  for (const s of Array.isArray(decl?.stages) ? decl.stages : []) walk(s);
  return ok;
}

/**
 * 取出这段文本**第一行非空内容**；如果它是标题就原样返回（去掉首尾空白），否则 null。
 *
 * 为什么要有这个 —— 一个真 bug（2026-10-20 实测抓到）：
 *
 *   节点 1.3 的 `text` 是**整个文件的内容**（含 `# 事实层` 这一行），
 *   而 `whole` 模式又会把文件原有的标题行拼回去：
 *       writeFileSync(abs, keepHead + '\n\n' + body + '\n')
 *   ⇒ 提交的正文自己带 `# 事实层`、宿主又补一个 ⇒ 落盘变成两个标题 ✗
 *   ⇒ 每次"保存"都多一个标题；agent 每次读到的正文里带着这个重复，
 *     于是反复提"删掉重复标题"的提案 —— **改完又被加回来**，永远修不好 ✗
 *
 *   实测证据：提案 after 以 `# 事实层` 开头，落盘后文件里是两行；
 *   测试片里的 `# 人物\n\n# 人物\n\nx` 也是同一个 bug 留下的。
 *
 * ⚠️ **只认"同一个标题"**，不能见到标题就跳过 ——
 *   结构化写回（list / table 形态）渲染出来是以 `## 条目名` 开头的，
 *   这时文件那个 `# 人物` 大标题是它的**父级**，必须留着。
 *   一刀切会把大标题吞掉（selftest 里「写回时保留了 `# 人物` 标题行」抓的就是它）。
 *
 * @param text 待写入的正文
 * @returns 首个非空行（是标题时）或 null
 */
function firstHeadingLine(text) {
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (line.trim() === '') continue;
    return /^#{1,6}\s+\S/.test(line) ? line.trim() : null;
  }
  return null;
}

/** 这段文本的第一行是不是**就是**这个标题行（判断"作者已经自己写了标题"）。 */
function startsWithThatHeading(text, headLine) {
  const first = firstHeadingLine(text);
  return !!first && !!headLine && first === String(headLine).trim();
}

/**
 * 把一次编辑写回源文件。
 *
 * 三种情形：
 *   · 节点是 missing 且文件还不存在 → 把文件建出来（写 `# 标题` + 作用 + 正文）
 *   · 没有行号（files: 那种"一个文件一个节点"）→ 整文件替换
 *   · 有行号（md 标题节点）→ 只换那个标题底下的正文，到下一个同级/更高级标题为止
 *
 * @param root 项目根绝对路径
 * @param req 客户端发来的编辑：`{ src, line, kind, title, role, text }`
 */
function applyEdit(root, req) {
  const rel = String(req?.src || '').replace(/\\/g, '/');
  if (!rel) throw new Error('缺少 src（不知道该改哪个文件）');
  if (rel.includes('..')) throw new Error('src 不允许包含 ..');

  const abs = join(root, ...rel.split('/'));
  /*
   * 两种写法都收：
   *   · `text` —— 纯文本（默认形态，或形态解析失败时退回的路）
   *   · `doc`  —— 结构化数据（list / table / matrix），在这儿序列化回 markdown
   * 这样无论图上用什么形态编辑，落盘的**始终是 markdown**。
   */
  const text = (req?.doc ? renderShape(req.doc) : String(req?.text ?? ''));
  const role = String(req?.role ?? '');

  const bak = backup(root, abs);
  const dir = dirname(abs);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  // ---- ⓪ 整份文件归这个节点 → 整份重写 ----
  if (req?.whole) {
    const wanted = String(req?.title ?? '').trim();
    let keepHead = '';
    /*
     * `files:` 出来的文件（提示词 txt）**不该有标题行** —— 用户把它删了就是删了，
     * 不要自作聪明补一个 `# 文件名` 回去。只有 md 那种才保留原有标题行。
     */
    if (req?.via !== 'files' && existsSync(abs)) {
      const h = readFileSync(abs, 'utf8')
        .split(/\r?\n/)
        .find((l) => /^#\s+\S/.test(l));
      if (h) keepHead = h;
    }
    if (!keepHead && wanted && req?.via !== 'files') keepHead = '# ' + wanted;
    const body = text.trim();
    /*
     * ★ **正文的第一行就是这个标题时才跳过补标题。**
     *   否则每次整份保存都会多一行 `# 标题` —— 见 firstHeadingLine 的注释。
     */
    const head = keepHead && !startsWithThatHeading(body, keepHead) ? keepHead + '\n\n' : '';
    writeFileSync(abs, head + body + '\n', 'utf8');
    return { mode: 'whole', src: rel, backup: bak, chars: body.length };
  }

  // ---- ① 文件还不存在 → 建出来（节点自己的正文就是要写进这个文件）----
  if (!existsSync(abs)) {
    /*
     * 标题取 src 的文件名去掉扩展名（`设定/人物.md` → `人物`）。
     * 不能拿客户端传来的 title —— 对 missing 节点那是相对路径，
     * 会写出 `# 设定/人物.md` 这种标题（实测踩过）。
     * `files:` 那种（一个文件一条提示词）本来就没有标题，不写 `#` 行。
     * 正文自己已经用同一个标题开头时也不补（同一个"多一行标题"的坑）。
     */
    let head = '';
    if (req?.via !== 'files') {
      const base = String(rel).split('/').pop().replace(/\.[^.]+$/, '');
      const want = '# ' + base;
      if (!startsWithThatHeading(text, want)) head = want + '\n\n';
    }
    const body = (role ? '> 作用：' + role + '\n\n' : '') + text + '\n';
    writeFileSync(abs, head + body, 'utf8');
    return { mode: 'created', src: rel, backup: bak };
  }

  // ---- ② 没有行号 → 整文件替换 ----
  const line = Number(req?.line) || 0;
  if (!line || !existsSync(abs)) {
    writeFileSync(abs, text === '' || text.endsWith('\n') ? text : text + '\n', 'utf8');
    return { mode: 'whole-file', src: rel, backup: bak };
  }

  // ---- ③ 有行号 → 只换那个标题底下的正文 ----
  const src = readFileSync(abs, 'utf8');
  const lines = src.split(/\r?\n/);
  const hi = line - 1;
  const head = lines[hi] || '';
  const m = head.match(/^(#{1,6})\s+/);
  if (!m) {
    throw new Error('第 ' + line + ' 行不是标题，拒绝按节改写：' + JSON.stringify(head.slice(0, 50)));
  }
  const level = m[1].length;

  // 本节"自己的正文"到哪里结束：**碰到第一个标题就停**（不管几级）。
  // 不能停在"下一个同级或更高级标题" —— 那样会把本节点的**子节点整棵抹掉**（丢数据）。
  // 一个节点的正文就是它标题与第一个子标题之间的那几行。
  let end = lines.length;
  let fence = false;
  for (let i = hi + 1; i < lines.length; i++) {
    const raw = lines[i];
    if (/^\s*(```|~~~)/.test(raw)) fence = !fence;
    if (fence) continue;
    if (/^#{1,6}\s+/.test(raw)) {
      end = i;
      break;
    }
  }

  // 标题那一行也重写 —— 这样"改内容节点的名字"就是改 `## 那一行`。
  // 客户端没传 title 就原样保留。
  const wanted = String(req?.title ?? '').trim();
  const headLine = wanted ? '#'.repeat(level) + ' ' + wanted : head;

  const block = [];
  if (role) block.push('> 作用：' + role, '');
  if (text) {
    /*
     * ★ 正文第一行**就是这一节的标题**时，把那一行去掉 —— 标题由上面的 headLine 统一写。
     *   不去的话就是「headLine + 正文里的标题」= 两个标题，跟 whole 模式同一个 bug。
     *   （实测：1.3 / 1.4 的保存都在这条路上留下过重复标题。）
     *   注意只认**同一个标题**：正文以 `## 某条目` 开头是正常结构，不能删。
     */
    const bodyLines = text.split(/\r?\n/);
    const firstNonBlank = bodyLines.findIndex((l) => l.trim() !== '');
    if (firstNonBlank >= 0 && startsWithThatHeading(bodyLines[firstNonBlank], headLine)) {
      bodyLines.splice(0, firstNonBlank + 1);
      while (bodyLines.length && bodyLines[0].trim() === '') bodyLines.shift();
    }
    block.push(...bodyLines);
  }

  const merged = [...lines.slice(0, hi), headLine, '', ...block, '', ...lines.slice(end)];

  // 连续空行压到最多一个 —— 否则反复编辑会把空行越堆越多、行号乱飘
  const out = [];
  for (const l of merged) {
    if (l === '' && out.length && out[out.length - 1] === '') continue;
    out.push(l);
  }

  writeFileSync(abs, out.join('\n'), 'utf8');
  return { mode: 'section', src: rel, level, backup: bak };
}

/**
 * 改 `project.json` 里某个节点的字段 —— 这是"画布上直接改"的**另一半**。
 *
 * 内容节点改的是 md 文件；**工序节点（① 设计故事 / 1.1 人物 / ② 写剧本…）改的是声明本身**：
 * 标题 / 编号 / 口径 / 注 / 产物 glob / 校验器 glob。
 * 之前只做了前一半，所以图上大部分节点是死的。
 *
 * @param root 项目根
 * @param declPath `stages/2/children/1` 这样的路径；空串 = 根（改片名）
 * @param fields 要设的字段，只认 title / no / doctrine / note / out / checks
 */
function editDecl(root, declPath, fields) {
  const abs = join(root, DECL);
  const bak = backup(root, abs);

  let decl;
  try {
    decl = JSON.parse(readFileSync(abs, 'utf8'));
  } catch (e) {
    throw new Error('工序声明不是合法 JSON，拒绝改写：' + String((e && e.message) || e));
  }

  // 定位到目标节点
  let node = decl;
  for (const seg of String(declPath || '').split('/')) {
    if (seg === '') continue;
    node = Array.isArray(node) ? node[Number(seg)] : node[seg];
    if (node === undefined || node === null) {
      throw new Error('声明路径不存在：' + declPath + '（在「' + seg + '」处断了）');
    }
  }
  if (typeof node !== 'object' || Array.isArray(node)) {
    throw new Error('声明路径指向的不是一个节点对象：' + declPath);
  }

  // 声明里**凡是从图上能看到的，都应该能改**（算出来的除外）。
  const ARRAY_FIELDS = new Set(['out', 'checks', 'md', 'files', 'dependsOn']);
  const ALLOWED = new Set(['title', 'no', 'doctrine', 'note', 'kind', 'items', ...ARRAY_FIELDS]);
  const changed = [];
  for (const [k, v] of Object.entries(fields || {})) {
    if (!ALLOWED.has(k)) continue;
    if (ARRAY_FIELDS.has(k)) {
      const arr = String(v ?? '')
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
      if (arr.length) node[k] = arr;
      else delete node[k];
      changed.push(k);
    } else {
      const s = String(v ?? '').trim();
      if (s === '') delete node[k];
      else node[k] = s;
      changed.push(k);
    }
  }

  writeFileSync(abs, JSON.stringify(decl, null, 2) + '\n', 'utf8');
  return { mode: 'decl', declPath: declPath || '(root)', changed, backup: bak };
}

/* ------------------------------------------------------------------ *
 * 画布结构编辑（2026-10-21 P2）
 *
 * 用户：「画布上点击新建节点，既可以新建空白，也可以直接调用库里的现成的」
 *       「节点还可能经常添加或者删除」
 *
 * 分工：**结构归宿主、正文归 agent**。
 *   · 增删改移是确定性的（改一棵 JSON + 建一个空文件 + 查依赖），宿主做
 *   · 但**不许**让结构坏掉：key 唯一、分组继承、被依赖的节点不许直接删
 *
 * 每个操作都先备份 project.json，再整体重写（原子性靠"读-改-写"一次完成）。
 * ------------------------------------------------------------------ */

/** 在工序树里按 key 找节点，并给出它所在的**数组**和下标（删除/插入要用）。 */
function locateNode(stages, key) {
  const want = String(key ?? '');
  let found = null;
  const walk = (list) => {
    for (let i = 0; i < list.length; i++) {
      const n = list[i];
      if (!n || typeof n !== 'object') continue;
      if (String(n.key) === want) { found = { node: n, list, index: i }; return true; }
      if (Array.isArray(n.children) && walk(n.children)) return true;
    }
    return false;
  };
  walk(stages);
  return found;
}

/**
 * 收集所有节点的 key / no / title，用于唯一性检查和"谁依赖我"的反查。
 * @returns {{all: Array, dependents: Map<string, string[]>}}
 */
function graphOf(stages) {
  const all = [];
  const walk = (n, parent) => {
    all.push({ node: n, parent });
    for (const c of n.children || []) walk(c, n);
  };
  for (const s of stages) walk(s, null);
  const dependents = new Map();
  for (const { node } of all) {
    for (const d of node.dependsOn || []) {
      const k = String(d);
      if (!dependents.has(k)) dependents.set(k, []);
      dependents.get(k).push(String(node.key || node.no));
    }
  }
  return { all, dependents };
}

/** 由标题派生一个可读的 key 前缀（中文也认，做文件名安全处理）。 */
function keyFromTitle(title) {
  const s = String(title || '').trim().toLowerCase().replace(/[\s/\\:*?"<>|]+/g, '-').replace(/^-+|-+$/g, '');
  return s || 'node';
}

/**
 * 把 fs 系工具（read / write / edit / glob / grep）限定在这部片目录里的**预置**。
 *
 * ⚠️ 2026-10-28 查源码后确认：`dsh-api-workspace-files` 与 `dsh-fs` 都没有
 *    「注册一个读限制回调」的公开钩子，所以这个函数目前**没有挂上去**，
 *    留在这里是为了钩子一出现就能直接接（写法对：命中放行、越界抛错）。
 *    当前的真实约束是沙箱：`sandbox-policy(mode: workspace-write)` 把**写**限定在
 *    会话 cwd（= 片目录）之下；读不限制。
 *
 * 拦住两种写法：
 *   ① 绝对路径：必须是 root 之下（或正好是 root）
 *   ② 相对路径：先按 root 解析，解析后必须仍在 root 之下
 * 命不中的一律抛错（工具会把这句话回给模型，它就知道该在哪干活）。
 *
 * @param root 片子目录（绝对路径）
 * @returns 给 `webServer.register` 的 `guard` 回调
 */
function makeFsGuard(root) {
  const R = String(root || '').replace(/[\\/]+$/, '');
  const low = R.toLowerCase();
  return (req) => {
    let url;
    try {
      url = new URL(req.url || '/', 'http://127.0.0.1');
    } catch {
      return;
    }
    const raw = url.searchParams.get('path');
    if (raw == null) return;                       // 没有 path 参数就不管（grep 只带 pattern 的情况）
    const p = String(raw).trim();
    if (!p) return;
    const norm = p.replace(/\\/g, '/');
    const absLike = /^[a-zA-Z]:\//.test(norm) || norm.startsWith('/');
    const resolved = absLike ? norm : (low + '/' + norm).replace(/\/{2,}/g, '/');
    const gone = /(^|\/)\.\.(\/|$)/.test(relPathLower(resolved, low));
    const inside = !gone && (resolved.toLowerCase() === low || resolved.toLowerCase().startsWith(low + '/'));
    const forbidden = /\/\.film(\/|$)/.test(resolved.toLowerCase());
    if (inside && !forbidden) return;
    throw new Error(
      '片场只允许读写《' + R.split(/[\\/]/).pop() + '》这一部片的目录（'
      + R + '），而且不能进 .film/。'
      + '要查资料请用 web_search / web_fetch，总结成文档请放在片子目录里（例如 资料/ 或 设定/）。',
    );
  };
}

/**
 * 把绝对路径折成相对于 root 的形式（只用于判断有没有 `..` 逃逸）。
 * @param abs 已经折叠过斜杠的绝对路径（小写）
 * @param lowRoot 小写 root
 */
function relPathLower(abs, lowRoot) {
  return abs.startsWith(lowRoot) ? abs.slice(lowRoot.length) : abs;
}

/**
 * 校验 agent 自建节点时给的产物路径（`struct.md`）。
 *
 * 为什么需要它（2026-10-27 实测踩到）：`structureOp` 原来**只认** `工艺/<key>.md`，
 * 而 agent 在 doctrine 的【写】里写的是 `设定/人物关系.md` ⇒ 画布读 A 文件、
 * agent 写 B 文件，节点永远显示空。有了这条，agent 可以把「写哪儿」一起提案。
 *
 * 只放行"片子目录里的相对 .md 路径"：不许绝对路径、盘符、`..`、`.film`/`tools`。
 * 不合格返回空串，调用方退回默认 `工艺/<key>.md`（并记 trace）。
 * @param want - 提案里的 `md`
 * @returns 规范化后的相对路径，或 ''
 */
function safeMdRel(want) {
  let s = String(want || '').trim().replace(/\\/g, '/');
  if (!s) return '';
  s = s.replace(/^\.\//, '');
  if (!/\.md$/i.test(s)) return '';
  if (/[:*?"<>|\u0000-\u001f]/.test(s)) return '';
  if (s.startsWith('/')) return '';
  const segs = s.split('/').filter(Boolean);
  if (!segs.length) return '';
  if (segs.some((x) => x === '.' || x === '..')) return '';
  if (['.film', 'tools'].includes(segs[0].toLowerCase())) return '';
  return segs.join('/');
}

/**
 * 产物路径是否落在某个「一文件一节点」（`files` glob）节点的目录里。
 *
 * `files` 型节点会把目录里每个文件派生成一个内容子节点；自建节点的 md 如果
 * 也指向那里，同一个文件会出现两个入口（一个直属、一个派生），编辑与过期都会打架。
 * 用和 `resolveGlob` 相同的单层匹配规则判断，命中就退回默认路径。
 */
function mdInsideFilesGlob(root, all, mdRel) {
  const segs = mdRel.split('/');
  const base = segs.pop();
  const absDir = join(root, ...segs).toLowerCase();
  for (const x of all) {
    for (const g of [].concat(x.node.files || []).map((v) => String(v)).filter(Boolean)) {
      const norm = String(g).replace(/\\/g, '/');
      const cut = norm.lastIndexOf('/');
      const dirPart = cut >= 0 ? norm.slice(0, cut) : '';
      const filePart = cut >= 0 ? norm.slice(cut + 1) : norm;
      const gDir = (dirPart ? join(root, ...dirPart.split('/')) : root).toLowerCase();
      if (gDir !== absDir) continue;
      try {
        if (nameMatcher(filePart)(base)) return true;
      } catch { /* 匹配器写坏就当没命中，后面还有路径合法性兜底 */ }
    }
  }
  return false;
}

/**
 * 按**位置**重算所有节点的显示编号（`1` / `1.2` / `1.2.3`）。
 *
 * 这是"key 是身份、编号是显示"那条设计的落地：
 *   · 插一个节点 → 后面自动重编号，人看着连贯 ✓
 *   · key 一个都不动 → 依赖、同步记录、工具的引用全部不受影响 ✓
 * 任何结构变更（增/删/移）之后都必须调它，否则画布上会出现
 * 「1.5 排在 1.4 前面」这种自相矛盾的顺序。
 * @param stages - 工序数组（就地改）
 */
function renumber(stages) {
  const walk = (list, prefix) => {
    list.forEach((n, i) => {
      if (!n || typeof n !== 'object') return;
      n.no = prefix ? prefix + '.' + (i + 1) : String(i + 1);
      if (Array.isArray(n.children)) walk(n.children, n.no);
    });
  };
  walk(stages, '');
}

/**
 * 结构编辑：唯一入口。
 *
 * @param root 片子根目录
 * @param op  `{type:'add', at, template, title}` / `{type:'delete', key, force}`
 *          / `{type:'rename', key, title}` / `{type:'move', key, dir}`
 * @returns 结果摘要
 */
/**
 * 记一条**结构变更**（`.film/changes.jsonl`，一行一条）。
 *
 * 用户 2026-10-21：「谁改的、改了什么、为什么」要能查 —— B6「变更摘要留痕」。
 * 结构变更是最需要留痕的一类（删了节点、移了位置，画布上过一会儿就看不出痕迹了）。
 * 正文改动由 agent 的 why 承载，不在这里重复记。
 *
 * @param root 片子根
 * @param rec `{op, key, title, by, why, detail}`
 */
function logChange(root, rec) {
  try {
    const abs = join(root, '.film', 'changes.jsonl');
    mkdirSync(dirname(abs), { recursive: true });
    appendFileSync(abs, JSON.stringify({ at: new Date().toISOString(), ...rec }) + '\n', 'utf8');
  } catch (e) {
    trace('变更留痕写不进去：' + String((e && e.message) || e));
  }
}

/**
 * 读最近的变更记录（给画布的"最近改动"或排查用）。
 * @param root 片子根
 * @param limit 最多几条（新的在前）
 */
function readChanges(root, limit = 20) {
  try {
    const abs = join(root, '.film', 'changes.jsonl');
    if (!existsSync(abs)) return [];
    const lines = readFileSync(abs, 'utf8').split(/\r?\n/).filter(Boolean);
    return lines.slice(-limit).reverse().map((s) => { try { return JSON.parse(s); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

/**
 * **自动统一**：把一处改动推平到全片（用户 2026-10-22 的规矩）。
 *
 * 用户原话：「节点中信息错位的永远以最近更改的那一版为准，无论后改的是成品节点还是
 * 下游节点里的伪节点。提案规则/自动同步规则保持不变。」
 * ⇒ 不管改的是成品节点的名字、还是伪节点（文件里一个小节）的名字，
 *   改完之后**自动**把其它文件里同一个名字换掉，不需要用户再点确认。
 *
 * 只在"改的是同一个名字"时生效 —— 判断依据是 `old` 在各个文件里**独立出现**的次数：
 *   · 至少 1 处（在别的文件里）才值得推
 *   · 按**名字边界**匹配，绝不碰「森林/丛林」这种包含关系
 *
 * @param root 片子根
 * @param oldName 改之前的名字
 * @param newName 改之后的名字
 * @param skipRel 跳过哪个文件（刚改过的那个，别重复写）
 * @returns `{total, files}`；没得改时 `{total:0, files:[]}`
 */
function autoUnify(root, oldName, newName, skipRel) {
  const out = { total: 0, files: [] };
  const o = String(oldName || '').trim();
  const n = String(newName || '').trim();
  if (!o || !n || o === n) return out;
  const skip = String(skipRel || '').replace(/\\/g, '/');
  const esc = o.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(
    '(?<![\\u4e00-\\u9fa5A-Za-z0-9])' + esc + '(?![\\u4e00-\\u9fa5A-Za-z0-9])',
    'g',
  );
  const seen = new Set();
  const hit = (abs2, rel2) => {
    if (seen.has(rel2) || rel2 === skip) return;
    seen.add(rel2);
    let body = '';
    try { body = readFileSync(abs2, 'utf8'); } catch { return; }
    const found = body.match(re);
    if (!found || !found.length) return;
    backup(root, abs2);
    writeFileSync(abs2, body.replace(re, n), 'utf8');
    out.files.push({ src: rel2, hits: found.length });
    out.total += found.length;
  };
  // ① 已声明的文件
  let decl = null;
  try { decl = JSON.parse(readFileSync(join(root, DECL), 'utf8')); } catch { decl = null; }
  const walk = (node) => {
    for (const g of [].concat(node.md || [], node.files || [], node.out || [])) {
      const rel2 = String(g).replace(/\\/g, '/');
      hit(join(root, ...rel2.split('/')), rel2);
    }
    for (const c of node.children || []) walk(c);
  };
  for (const s of (decl && decl.stages) || []) walk(s);
  // ② 孤儿文件（节点删了、文件还留着）
  const scan = (dir) => {
    let ents = [];
    try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of ents) {
      if (ent.name.startsWith('.')) continue;
      const abs2 = join(dir, ent.name);
      if (ent.isDirectory()) { scan(abs2); continue; }
      if (!/\.(md|txt)$/i.test(ent.name)) continue;
      hit(abs2, abs2.slice(root.length + 1).replace(/\\/g, '/'));
    }
  };
  scan(root);
  if (out.total > 0) {
    logChange(root, {
      op: 'autoUnify', key: o, title: n, by: 'host', why: '以最近改动为准，自动统一',
      detail: o + ' -> ' + n + ' total=' + out.total + ' files=' + out.files.length,
    });
  }
  return out;
}
/**
 * **下游直写**：上游改动引起的下游过期，agent 可以直接写，不需要提案。
 *
 * 用户 2026-10-21 定的规则（宪法 二·五）：
 *   · 上游改了 → 下游过期：**可以直接改下游**（已授权）
 *   · 下游改了 → 上游要跟着改：**必须先问**（走 proposal）
 *
 * 但在这之前，agent 手里只有 `filmflow_propose` ⇒ 两个方向都被迫"提案+人点确认"，
 * 宪法写的那条授权**实际做不到**（用户 2026-10-22 追问时发现的）。
 * ⇒ 这个函数是那条授权的机械实现，判据是**硬条件**，不是让 agent 自己声明方向：
 *     节点现在处于 `stale`（= 它的上游被改过、它因此过期）才允许直写；
 *     否则一律拒绝，并让它去走提案。
 *
 * @param root 片子根
 * @param req `{ node, text, why }`
 * @returns `{ok, src, mode}`；不满足授权条件时抛错
 */
function applyDownstream(root, req) {
  const want = String(req?.node || '').trim();
  if (!want) throw new Error('要指定节点（编号 / key / 源文件）');
  const p = buildProject(root);
  /*
   * 自己找节点：`findNode` 是 agent 工厂里的闭包，模块级拿不到
   * （第一次写就是这么错的 —— 报 "findNode is not defined"）。
   * 这里按 key → 编号 → src → 标题 依次匹配，和工具里的顺序一致。
   */
  const all = [];
  const walkAll = (x) => {
    all.push(x);
    for (const c of x.children || []) walkAll(c);
    for (const c of x.content || []) walkAll(c);
  };
  for (const s of p.stages || []) walkAll(s);
  const norm = (v) => String(v || '').replace(/\\/g, '/').toLowerCase();
  const n =
    all.find((x) => x.key && String(x.key) === want)
    || all.find((x) => x.no !== undefined && String(x.no) === want)
    || all.find((x) => x.src && norm(x.src) === norm(want))
    || all.find((x) => x.src && norm(x.src).endsWith('/' + norm(want)))
    || all.find((x) => String(x.title || '') === want)
    || null;
  if (!n) throw new Error('找不到节点：' + want);
  if (!n.src) throw new Error('节点「' + (n.no || n.title) + '」没有声明源文件，写不了');
  /*
   * ★ 授权判据：**它现在必须是因为上游改动而过期**。
   *   这不是"agent 说是这个方向"就算，而是宿主自己算出来的状态 —— 骗不了。
   */
  if (n.stale !== 'stale') {
    throw new Error(
      '节点「' + (n.no || n.title) + '」现在不是"上游改过导致过期"的状态（stale=' + String(n.stale || 'none') + '）。'
      + '这种情况属于新改动 ⇒ 请用 filmflow_propose 提案，等用户确认。',
    );
  }
  const r = applyEdit(root, {
    src: n.src,
    line: n.line,
    whole: !!n.whole,
    title: n.title,
    kind: n.kind,
    via: n.via,
    text: String(req?.text ?? ''),
  });
  logChange(root, {
    op: 'applyDownstream', key: String(n.key || n.no || ''), title: String(n.title || ''),
    by: 'agent', why: String(req?.why || ''),
    detail: '上游改动引起的同步（已授权直写）→ ' + String(n.src),
  });
  trace('[下游直写] ' + (n.no || n.title) + ' ← ' + String(req?.why || ''));
  return { ok: true, src: n.src, mode: r.mode, node: String(n.no || n.title) };
}
/** 媒体生成服务（进程内单例）：资产库 + 任务队列。 */
const MEDIA = createMediaService({
  /*
   * AK 从凭据文件读，**每次生成时现读**（用户换了 key 不用重启）。
   * 路径跟 DSH_HOME 走；读不到就报"还没配置"，不让任务静默失败。
   */
  readKey: () => {
    try {
      /*
       * 凭据文件位置要**按顺序试**：
       *   1. FILMFLOW_CREDENTIALS（显式指定，最可靠）
       *   2. DSH_HOME/.credentials.yaml
       *   3. %USERPROFILE%/.dsh/.credentials.yaml
       * 实测踩过：进程里的 DSH_HOME 未必等于启动脚本里设的那个，
       * 只认第一个会读不到 key，任务报"还没配置"。
       */
      const candidates = [
        process.env.FILMFLOW_CREDENTIALS,
        process.env.DSH_HOME ? join(process.env.DSH_HOME, '.credentials.yaml') : '',
        process.env.USERPROFILE ? join(process.env.USERPROFILE, '.dsh', '.credentials.yaml') : '',
      ].filter(Boolean);
      for (const p of candidates) {
        try {
          const m = /PIPPIT_ACCESS_KEY:\s*(\S+)/.exec(readFileSync(p, 'utf8'));
          if (m) { trace('[媒体] AK 来自 ' + p); return m[1]; }
        } catch { /* 试下一个 */ }
      }
      trace('[媒体] 没找到 PIPPIT_ACCESS_KEY，试过：' + candidates.join(' | '));
      return '';
    } catch {
      return '';
    }
  },
  /*
   * 火山方舟的 key（ARK_API_KEY）。
   * 和上面小云雀那把**完全分开**：凭据文件里有哪把就走哪家，换 provider 不用改代码。
   */
  readArkKey: () => {
    try {
      const candidates = [
        process.env.FILMFLOW_CREDENTIALS,
        process.env.DSH_HOME ? join(process.env.DSH_HOME, ".credentials.yaml") : "",
        process.env.USERPROFILE ? join(process.env.USERPROFILE, ".dsh", ".credentials.yaml") : "",
      ].filter(Boolean);
      for (const p of candidates) {
        try {
          const m = /ARK_API_KEY:\s*(\S+)/.exec(readFileSync(p, "utf8"));
          if (m) return m[1];
        } catch { /* 试下一个 */ }
      }
      return "";
    } catch {
      return "";
    }
  },
  /*
   * 豆包语音的 key（SPEECH_API_KEY）。
   * 音频生成走 openspeech.bytedance.com，**不认方舟的 ark- 前缀 key**（实测 401）；
   * 所以两把 key 分开读，环境变量 SPEECH_API_KEY 也可以。
   */
  readSpeechKey: () => {
    if (process.env.SPEECH_API_KEY) return String(process.env.SPEECH_API_KEY).trim();
    try {
      const candidates = [
        process.env.FILMFLOW_CREDENTIALS,
        process.env.DSH_HOME ? join(process.env.DSH_HOME, ".credentials.yaml") : "",
        process.env.USERPROFILE ? join(process.env.USERPROFILE, ".dsh", ".credentials.yaml") : "",
      ].filter(Boolean);
      for (const p of candidates) {
        try {
          const m = /SPEECH_API_KEY:\s*(\S+)/.exec(readFileSync(p, "utf8"));
          if (m) return m[1];
        } catch { /* 试下一个 */ }
      }
      return "";
    } catch {
      return "";
    }
  },
  trace,
  concurrency: 1,
});
function structureOp(root, op) {
  const abs = join(root, DECL);

  /*
   * ★ 一步撤销：每次结构变更前，把整份 project.json 另存一份。
   *
   * 为什么不复用 .film/backups/：那边是**每次改写都存**（含正文保存），
   * 挑"最近一份"很容易撤到别的东西上去。这里只记**结构操作**前那一版，语义干净。
   */
  /*
   * ★ 撤销 / 重做：一个栈，不是单步（用户 2026-10-27：
   *   「把单撤销按钮改成现在主流软件那样的、可以反向撤销的两个按钮」）。
   *
   * 旧实现只存一份 structure-undo.json，撤一次就没了。现在：
   *   · 每次结构操作前，把当前 project.json 压进 undo 栈，并清空 redo 栈
   *   · undo：弹出 undo → 当前版本压进 redo
   *   · redo：弹出 redo → 当前版本压回 undo
   * 快照只记 project.json（结构）；正文不在这里回滚。
   */
  const histFile = join(root, '.film', 'structure-history.json');
  const readHist = () => {
    try {
      const h = JSON.parse(readFileSync(histFile, 'utf8'));
      return { undo: Array.isArray(h.undo) ? h.undo : [], redo: Array.isArray(h.redo) ? h.redo : [] };
    } catch { return { undo: [], redo: [] }; }
  };
  const writeHist = (h) => {
    h.undo = h.undo.slice(-50);
    h.redo = h.redo.slice(-50);
    writeFileSync(histFile, JSON.stringify(h), 'utf8');
  };
  const pushUndo = (snapshot) => {
    const h = readHist();
    h.undo.push(snapshot);
    h.redo = [];
    writeHist(h);
  };
  if (String(op?.type) === 'history') {
    const h = readHist();
    return { ok: true, type: 'history', undo: h.undo.length, redo: h.redo.length };
  }
  if (String(op?.type) === 'undo' || String(op?.type) === 'redo') {
    const wantUndo = String(op.type) === 'undo';
    const h = readHist();
    const from = wantUndo ? h.undo : h.redo;
    if (!from.length) throw new Error(wantUndo ? '没有可撤销的操作' : '没有可重做的操作');
    const snap = from.pop();
    try { JSON.parse(snap); } catch { throw new Error('历史快照不是合法 JSON，拒绝覆盖'); }
    const cur = readFileSync(abs, 'utf8');
    (wantUndo ? h.redo : h.undo).push(cur);
    writeHist(h);
    writeFileSync(abs, snap, 'utf8');
    return { ok: true, type: op.type, undo: h.undo.length, redo: h.redo.length };
  }
  let decl;
  try {
    decl = JSON.parse(readFileSync(abs, 'utf8'));
  } catch (e) {
    throw new Error('工序声明读不了，拒绝改结构：' + String((e && e.message) || e));
  }
  if (!Array.isArray(decl.stages)) throw new Error('project.json 里没有 stages 数组');

  const type = String(op?.type || '');
  const stages = decl.stages;
  const { all, dependents } = graphOf(stages);
  const keySet = new Set(all.map((x) => String(x.node.key)));

  if (type === 'add') {
    const tplId = String(op.template || 'blank');
    const at = String(op.at || '');
    /*
     * ★ 一次 add 的全部合法性（R47 角色 / R53 依赖 / R52·R54·R56 身份 / R57 下位白名单）。
     *
     * 判据抽在 placementIssue 里，agent 提案路径 validateAddProposal 调的是同一个函数 ——
     * 菜单、提案、落盘只有一个口径，不会出现"这里能过、那里不能过"。
     * 这里是**唯一入口** —— 画布、agent 提案、骨架包全都走 structureOp add。
     */
    const ph = placementIssue(stages, readTemplates(), tplId, at, op.title);
    if (!ph.ok) throw new Error(ph.error);
    const tpl = ph.tpl;
    const tplRole = ph.tplRole;
    const loc = ph.loc;

    // 标题：显式给 > 模板默认标题
    /*
     * 人物·单人：**标题就是人名**（2026-10-30 用户：名字要填在人物节点里，不要另起一个
     * 看起来像节点的东西）。没给标题时不要用模板名「人物·单人」当标题 —— 那看着像占位符，
     * 用户还得再改一次；这里直接给一个一眼就知道要改的占位。
     */
    const fallbackTitle = String(tplId) === 'character-one' ? '人名（点我改）' : (tpl?.title || '新节点');
    const baseTitle = String(op.title || fallbackTitle).trim();
    // key 唯一：`角色` → `角色`，重名就 `角色-2`
    const slug = keyFromTitle(baseTitle) || tplId;
    let key = slug;
    for (let i = 2; keySet.has(key); i++) key = slug + '-' + i;

    /*
     * 产物路径：agent 自建节点可以指定（op.md），否则默认 `工艺/<key>.md`。
     * 被别的节点占用、落在 files glob 里、或不安全的路径 → 退回默认（见 safeMdRel 注释）。
     * 占用判断按小写比较（Windows 文件系统不区分大小写）。
     */
    const mdWant = safeMdRel(op.md);
    const mdKey = mdWant ? mdWant.toLowerCase() : '';
    const mdTaken = mdKey
      ? all.some((x) => (Array.isArray(x.node.md) ? x.node.md : []).some((m) => String(m).toLowerCase() === mdKey))
      : false;
    const mdInGlob = mdWant ? mdInsideFilesGlob(root, all, mdWant) : false;
    if (mdWant && mdTaken) trace('[结构] 产物路径已被占用，退回默认：' + mdWant);
    if (mdWant && !mdTaken && mdInGlob) trace('[结构] 产物路径落在文件型节点的目录里，退回默认：' + mdWant);
    const mdRel = (mdWant && !mdTaken && !mdInGlob) ? mdWant : ('工艺/' + key + '.md');
    if (mdWant && !mdTaken && !mdInGlob) trace('[结构] 自建节点产物路径：' + mdRel);
    const node = {
      key,
      title: baseTitle,
      /** 来自哪个模板（2026-10-29）：主从层校验靠它认"这个父是谁"，改名也不丢。 */
      template: String(tplId || ''),
      /** 层级角色：落盘保存，节点改名后合法性判断仍然成立（R47）。 */
      nodeRole: tplRole,
      doctrine: String(op.doctrine || tpl?.doctrine || '【任务】TBD —— 一句话说清这一步要产出什么。'),
      md: [mdRel],
    };
    /* 模板自带的 kind（aggregate/media）也带进节点：聚合节点正文整段显示在自己身上。 */
    if (tpl && tpl.kind) node.kind = String(tpl.kind);
    /*
     * 形态：显式 op.shape 优先（agent 自建节点时用），否则用模板的。
     * 只认四种；list/table/matrix 缺 fields/columns 就退回 text ——
     * 宁可显示成纯文本，也不因为形态写坏把内容吃掉。
     */
    {
      const wanted = (op.shape && typeof op.shape === 'object') ? op.shape : tpl?.shape;
      const shapeOk = (s) => {
        const k = String((s && s.kind) || '');
        if (!['text', 'list', 'table', 'matrix', 'select'].includes(k)) return false;
        if (k === 'list' || k === 'matrix') return Array.isArray(s.fields) && s.fields.length > 0;
        if (k === 'table') return Array.isArray(s.columns) && s.columns.length > 0;
        if (k === 'select') return Array.isArray(s.options) && s.options.length > 0;
        return true;
      };
      if (wanted && shapeOk(wanted)) node.shape = wanted;
      else if (wanted) trace('[结构] shape 不合法，退回 text：' + JSON.stringify(wanted).slice(0, 120));
    }
    /*
     * 文件型节点（一任务一文件）：不建单文件，靠 files glob 派生内容节点。
     * （剧本/采访提纲/提示词这类天然"一人一份/一镜一份"的节点）
     */
    if (tpl?.files) { node.files = [String(tpl.files)]; delete node.md; }
    /*
     * 媒体模板（图片/视频/音频）：媒体节点**没有正文文件**，
     * 生成配置放在 `media` 里，生成按钮由用户点（程序不自己发起）。
     */
    if (tpl?.kind === 'media') {
      node.kind = 'media';
      delete node.md;
      /*
       * 默认模型**按媒体类型给**（2026-10-28）：视频给 Seedance、图片给 Seedream、
       * 音频给 Doubao-音频生成（2026-10-28 接入后不再是空串）。
       */
      const mt = String(tpl.mediaType || 'image');
      const defaultModel = mt === 'video' ? 'Seedance_2.5'
        : (mt === 'image' ? 'seedream_5.0_pro' : 'seed-audio-1.0');
      node.media = {
        type: mt,
        model: String(tpl.model || defaultModel),
        prompt: '',
        ...(tpl.media || {}),
      };
    }

    /*
     * 2026-10-29：story/board 授权分组已撤，新节点不再写 `group`。
     * 老项目里的 group 字段保留兼容（没有代码再读写它）。
     */
    if (!loc) {
      stages.push(node);
    } else {
      // 加在某个节点下面
      const parent = loc.node;
      parent.children = Array.isArray(parent.children) ? parent.children : [];
      parent.children.push(node);
      /*
       * 数据方向（用户 2026-10-21：数据流是双向的，方向由"谁读谁"决定）：
       *   feed='up'   → 新节点读父节点（分析型：事实层、认知层…）
       *   feed='down' → 父节点读新节点（注入型：模型节点 —— 提示词要参考它）
       */
      const feed = String(tpl?.feed || op.feed || 'up');
      if (feed === 'down') {
        // 父节点读**新节点**（模型节点就是这种：提示词要参考它）
        parent.dependsOn = Array.isArray(parent.dependsOn) ? parent.dependsOn : [];
        if (!parent.dependsOn.includes(key)) parent.dependsOn.push(key);
      } else {
        // 新节点读父节点（分析型：从父节点的内容里往外扒）
        node.dependsOn = [String(parent.key || '')];
      }
    }

    const bak = backup(root, abs);
    // 建空的产物文件（有个标题，agent 才知道往哪儿写）；files 型节点跳过
    if (node.md) {
      const artAbs = join(root, mdRel);
      try {
        mkdirSync(dirname(artAbs), { recursive: true });
        if (!existsSync(artAbs)) writeFileSync(artAbs, '# ' + baseTitle + '\n', 'utf8');
      } catch (e) {
        throw new Error('产物文件建不了：' + String((e && e.message) || e));
      }
    }
    /*
     * 显式依赖（骨架包按标题解析后传进来）优先于 feed 自动依赖。
     * 骨架包就是靠这个把「视频提示词 ← 画风/外貌/上装/场景…」连起来的。
     */
    if (Array.isArray(op.dependsOn) && op.dependsOn.length) {
      const want = [...new Set(op.dependsOn.map(String).filter((k) => k && k !== key))];
      const known = want.filter((k) => keySet.has(k));
      const missing = want.filter((k) => !keySet.has(k));
      if (missing.length) trace('[结构] 依赖里有不存在的 key，已忽略：' + missing.join(','));
      if (known.length) node.dependsOn = known;
    }
    /*
     * ★ 生成节点的依赖必须对得上（R47）。
     *
     * 只卡"挂在哪"不够：视频生成挂顶层、依赖却写着剧本，照样是错的。
     * 规则：
     *   · 没显式给依赖 → 自动接项目里现成的同类型提示词（图片节点接分镜/设定）；
     *   · 显式给了但类型不对 → 直接拒绝，让调用方自己改 —— 不默默加一条它没写的依赖。
     */
    if (DEP_RULES[tplRole]) {
      const roleMap = roleByKeyOf(stages);
      const depKeys = (Array.isArray(node.dependsOn) ? node.dependsOn : []).map(String);
      const depRoles = depKeys.map((k) => roleMap.get(k)).filter(Boolean);
      const chk = checkDeps(tplRole, depRoles);
      if (!chk.ok) {
        const explicitGiven = Array.isArray(op.dependsOn) && op.dependsOn.length > 0;
        if (!explicitGiven) {
          const cand = autoWireDep(stages, tplRole, { preferredKey: loc ? String(loc.node.key || '') : '' });
          if (cand) {
            node.dependsOn = [cand.key];
            trace('[结构] ' + roleLabel(tplRole) + '自动接上依赖：' + cand.key + '（' + cand.title + '）');
          } else {
            throw new Error(chk.error + '。先在项目里建一个' + chk.label + '节点，或把它挂在' + chk.label + '下面。');
          }
        } else {
          throw new Error(
            chk.error + '（你给的依赖是：' + depKeys.join('、') + '）。'
            + '把 dependsOn 改成' + chk.label + '节点的 key，或者不传 dependsOn 让程序自动接。',
          );
        }
      }
    }
    pushUndo(readFileSync(abs, 'utf8'));  // 撤销快照（放在 renumber 之前 = 原样保存上一版）
    renumber(decl.stages);  // 显示编号按位置重算；key 不动 ⇒ 依赖、同步记录全不受影响
    writeFileSync(abs, JSON.stringify(decl, null, 2) + '\n', 'utf8');
    logChange(root, { op: type, key, title: baseTitle, by: op.by || 'user', why: op.why || '', detail: '模板 ' + tplId + ' → ' + mdRel });
    return { ok: true, type, key, title: baseTitle, template: tplId, md: mdRel, backup: bak };
  }

  if (type === 'delete') {
    const key = String(op.key || '');
    const loc = locateNode(stages, key);
    if (!loc) throw new Error('没有这个节点：' + key);
    // 被依赖就不许删 —— 删了下游的"依据"就悬空了，而过期判定会静默失灵
    const users = (dependents.get(key) || []).filter((k) => k !== key);
    if (users.length && !op.force) {
      throw new Error(
        '有 ' + users.length + ' 个节点依赖它（' + users.join('、') + '），不能直接删。'
        + '先改掉那边的依赖，或者确认后带 force 再删。',
      );
    }
    const bak = backup(root, abs);
    const [removed] = loc.list.splice(loc.index, 1);
    /*
     * ★ force 删除时，把下游的依赖**改接到被删节点自己的上游**（用户 2026-10-22）。
     *
     * 为什么不能只删了事：删掉「④ 生成音频提示词」后，⑤ 原本 dependsOn: k4 就悬空了，
     * 过期判定会静默失灵（它的上游永远"没变"）。④ 的上游是 ③ 分镜脚本 ⇒ ⑤ 改依赖 ③。
     * 只有这么接，"删掉中间一环"才不留裂缝。
     */
    {
      const gone = String(removed?.key || key);
      const up = Array.isArray(removed?.dependsOn)
        ? removed.dependsOn.map(String).filter((d) => d !== gone)
        : [];
      if (users.length) {
        const fix = (n) => {
          if (Array.isArray(n.dependsOn)) {
            const hit = n.dependsOn.some((d) => String(d) === gone);
            if (hit) {
              const rest = n.dependsOn.map(String).filter((d) => d !== gone);
              n.dependsOn = [...new Set([...rest, ...up])].filter((d) => d && d !== String(n.key));
              if (!n.dependsOn.length) delete n.dependsOn;
            }
          }
          for (const c of n.children || []) fix(c);
        };
        for (const s of decl.stages) fix(s);
      }
    }
    pushUndo(readFileSync(abs, 'utf8'));  // 撤销快照（放在 renumber 之前 = 原样保存上一版）
    renumber(decl.stages);  // 显示编号按位置重算；key 不动 ⇒ 依赖、同步记录全不受影响
    writeFileSync(abs, JSON.stringify(decl, null, 2) + '\n', 'utf8');
    logChange(root, {
      op: type,
      key,
      title: String(removed?.title || ''),
      by: op.by || 'user',
      why: op.why || '',
      detail: users.length ? '强制删（下游：' + users.join('、') + '）' : '删除了这个节点',
    });
    return { ok: true, type, key, title: String(removed?.title || ''), backup: bak, removedDependents: users };
  }

  if (type === 'rename') {
    const key = String(op.key || '');
    const loc = locateNode(stages, key);
    if (!loc) throw new Error('没有这个节点：' + key);
    const title = String(op.title || '').trim();
    if (!title) throw new Error('标题不能为空');
    const bak = backup(root, abs);
    const before = String(loc.node.title || '');
    loc.node.title = title;
    pushUndo(readFileSync(abs, 'utf8'));  // 撤销快照（放在 renumber 之前 = 原样保存上一版）
    renumber(decl.stages);  // 显示编号按位置重算；key 不动 ⇒ 依赖、同步记录全不受影响
    writeFileSync(abs, JSON.stringify(decl, null, 2) + '\n', 'utf8');
    logChange(root, { op: type, key, title, by: op.by || 'user', why: op.why || '', detail: before + ' → ' + title });
    /*
     * 真节点改名同样自动统一：用户说"无论后改的是成品节点还是下游节点里的伪节点"，
     * 这条规则对两边一视同仁（不需要用户再点确认）。
     */
    const unified2 = autoUnify(root, before, title, '');
    return { ok: true, type, key, before, title, backup: bak, autoUnified: unified2 };
  }

  /*
   * 改「文件里一个小节的标题」—— 伪节点的改名走这里（用户 2026-10-22）。
   *
   * 伪节点（人物下面的人名、世界观下面的每条设定）**不是 decl 里的节点**，没有 key，
   * 所以 rename 打过去等于空 key ⇒ 宿主报「没有这个节点」⇒ 客户端 reload ⇒ **看起来改完又变回去**。
   * 它们真实的家是 src 文件里的那一行 ## 标题。
   * ⇒ 按 src + 原标题找到那一行，只换标题文字，别的行一律不动（改前备份、留痕）。
   */
  /*
   * 把一个旧名字在**全片已声明文件**里统一换成新名字（用户 2026-10-22：
   * 「人物名字改了后其他层没有同步」）。
   *
   * 为什么归宿主：改名是**确定性替换**，不需要判断 —— 正是"能做确定性的绝不交给 agent"。
   * 每个文件改前备份、改后留痕，返回每个文件替换了几处。
   */
  /*
   * 改媒体节点的**配置**（提示词/模型/分辨率/时长…）—— 不触发生成。
   *
   * 用户 2026-10-22：「程序有填入提示词的权限，没请求生成的权限，确认生成由用户手动点击」。
   * ⇒ agent 能走这个 op 把提示词写进去，但**碰不到** startJob。
   */
  if (type === 'setMedia') {
    const key = String(op.key || '');
    const loc = locateNode(stages, key);
    if (!loc) throw new Error('没有这个节点：' + key);
    const n = loc.node;
    if (String(n.kind || '') !== 'media') throw new Error('「' + (n.title || key) + '」不是媒体节点');
    const f = op.fields || {};
    const allowed = ['type', 'model', 'prompt', 'resolution', 'ratio', 'durationSec', 'count', 'seed'];
    const media = { ...(n.media || {}) };
    const changed = [];
    for (const k of allowed) {
      if (f[k] === undefined) continue;
      const v = f[k];
      media[k] = k === 'durationSec' || k === 'count' || k === 'seed' ? Number(v) : String(v);
      changed.push(k);
    }
    if (!changed.length) return { ok: true, type, key, changed: [] };
    n.media = media;
    const bak = backup(root, abs);
    writeFileSync(abs, JSON.stringify(decl, null, 2) + '\n', 'utf8');
    logChange(root, {
      op: type, key, title: String(n.title || ''), by: op.by || 'agent', why: op.why || '',
      detail: '改了 ' + changed.join('/'),
    });
    return { ok: true, type, key, changed, backup: bak };
  }

  if (type === 'replaceName') {
    const oldName = String(op.old || '');
    const newName = String(op.new || '');
    if (!oldName || !newName) throw new Error('old / new 都要给');
    if (oldName === newName) return { ok: true, type, files: [], total: 0 };
    const touched = [];
    const seen = new Set();
    let total = 0;
    const walk = (n) => {
      for (const g of [].concat(n.md || [], n.files || [], n.out || [])) {
        const rel = String(g).replace(/\\/g, '/');
        if (seen.has(rel)) continue;
        seen.add(rel);
        const abs2 = join(root, ...rel.split('/'));
        if (!existsSync(abs2)) continue;
        let body = '';
        try { body = readFileSync(abs2, 'utf8'); } catch { continue; }
        if (!body.includes(oldName)) continue;
        /*
         * op.whole = 只在**独立名字**处替换（"以最近改动为准"会用到）。
         * 中文名可能只有一两个字（如「林」），无脑替换会连「森林/丛林」一起改。
         * 规定：old 前后紧挨着另一个汉字/字母数字时，不算独立名字，跳过。
         */
        let hits = 0;
        let out2 = body;
        if (op.whole) {
          const esc = oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const re = new RegExp('(?<![\\u4e00-\\u9fa5A-Za-z0-9])' + esc + '(?![\\u4e00-\\u9fa5A-Za-z0-9])', 'g');
          hits = (body.match(re) || []).length;
          if (!hits) continue;
          out2 = body.replace(re, newName);
        } else {
          hits = body.split(oldName).length - 1;
          out2 = body.split(oldName).join(newName);
        }
        backup(root, abs2);
        writeFileSync(abs2, out2, 'utf8');
        touched.push({ src: rel, hits });
        total += hits;
      }
      for (const c of n.children || []) walk(c);
    };
    for (const s of decl.stages) walk(s);
    /*
     * `all: true` —— 连**孤儿文件**一起扫（节点删了、文件还在片子里）。
     * 实测：删掉「剧情框架」节点后，`设定/剧情框架.md` 里还剩 18 处旧名，
     * 按声明扫根本看不到它 ⇒ 用户会说"还是没同步"。
     */
    if (op.all) {
      const findAll = (dir) => {
        for (const ent of readdirSync(dir, { withFileTypes: true })) {
          if (ent.name.startsWith('.')) continue;
          const abs2 = join(dir, ent.name);
          if (ent.isDirectory()) { findAll(abs2); continue; }
          if (!/\.(md|txt)$/i.test(ent.name)) continue;
          const rel2 = abs2.slice(root.length + 1).replace(/\\/g, '/');
          if (seen.has(rel2)) continue;
          seen.add(rel2);
          let bodyAll = '';
          try { bodyAll = readFileSync(abs2, 'utf8'); } catch { continue; }
          if (!bodyAll.includes(oldName)) continue;
          const hits = bodyAll.split(oldName).length - 1;
          backup(root, abs2);
          writeFileSync(abs2, bodyAll.split(oldName).join(newName), 'utf8');
          touched.push({ src: rel2, hits });
          total += hits;
        }
      };
      findAll(root);
    }
    if (total > 0) {
      logChange(root, {
        op: type, key: oldName, title: newName, by: op.by || 'user', why: op.why || '',
        detail: oldName + ' -> ' + newName + ' total=' + total + ' files=' + touched.length,
      });
    }
    return { ok: true, type, files: touched, total };
  }

  /*
   * 改「文件里一个小节的标题」—— 伪节点的改名走这里（用户 2026-10-22）。
   *
   * 伪节点（人物下面的人名、世界观下面的每条设定）**不是 decl 里的节点**，没有 key，
   * 所以 rename 打过去等于空 key => 宿主报「没有这个节点」=> 客户端 reload => 看起来改完又变回去。
   * 它们真实的家是 src 文件里的那一行 `## 标题`。
   */
  if (type === 'renameSection') {
    const srcRel = String(op.src || '').replace(/\\/g, '/');
    const oldTitle = String(op.title || '').trim();
    const newTitle = String(op.newTitle || '').trim();
    if (!srcRel) throw new Error('缺少 src（不知道该改哪个文件）');
    if (!oldTitle || !newTitle) throw new Error('原标题和新标题都要给');
    if (oldTitle === newTitle) return { ok: true, type, changed: false, reason: '名字没变' };
    const target = join(root, ...srcRel.split('/'));
    if (!existsSync(target)) throw new Error('文件不存在：' + srcRel);
    const text = readFileSync(target, 'utf8');
    const ls = text.split(/\r?\n/);
    const hit = ls.findIndex((l) => {
      const m = l.match(/^(#{1,6})\s+(.*)$/);
      return !!m && m[2].trim() === oldTitle;
    });
    if (hit < 0) throw new Error('这个文件里没有标题为「' + oldTitle + '」的小节：' + srcRel);
    const lv = (ls[hit].match(/^(#{1,6})/) || [, '##'])[1];
    const bak = backup(root, target);
    ls[hit] = lv + ' ' + newTitle;
    writeFileSync(target, ls.join('\n'), 'utf8');
    logChange(root, {
      op: type, key: srcRel, title: newTitle, by: op.by || 'user', why: op.why || '',
      detail: oldTitle + ' -> ' + newTitle,
    });

    /* 改完顺手扫一遍还有哪些文件里留着旧名（只扫，不擅自改） */
    const leftOld = [];
    const seen = new Set();
    const scan = (n) => {
      for (const g of [].concat(n.md || [], n.files || [], n.out || [])) {
        const rel2 = String(g).replace(/\\/g, '/');
        if (seen.has(rel2)) continue;
        seen.add(rel2);
        const abs2 = join(root, ...rel2.split('/'));
        if (!existsSync(abs2)) continue;
        let body2 = '';
        try { body2 = readFileSync(abs2, 'utf8'); } catch { continue; }
        const hits = body2.split(/\r?\n/).filter((l) => l.includes(oldTitle)).length;
        if (hits > 0) leftOld.push({ src: rel2, hits });
      }
      for (const c of n.children || []) scan(c);
    };
    for (const s of decl.stages) scan(s);

    /*
     * ★ 自动统一（用户 2026-10-22 的要求："程序自己具备自动统一的功能"）。
     * 改完这个小节标题，立刻把其它文件里同一个名字也换掉 —— 不再等用户点确认。
     */
    const unified = autoUnify(root, oldTitle, newTitle, srcRel);

    return { ok: true, type, src: srcRel, before: oldTitle, title: newTitle, backup: bak, leftOld, autoUnified: unified };
  }
  if (type === 'move') {
    const key = String(op.key || '');
    const loc = locateNode(stages, key);
    if (!loc) throw new Error('没有这个节点：' + key);
    const dir = String(op.dir || 'up');
    const i = loc.index;
    const j = dir === 'up' ? i - 1 : i + 1;
    if (j < 0 || j >= loc.list.length) return { ok: true, type, key, moved: false, reason: '已经在' + (dir === 'up' ? '最前' : '最后') };
    const bak = backup(root, abs);
    const [n] = loc.list.splice(i, 1);
    loc.list.splice(j, 0, n);
    pushUndo(readFileSync(abs, 'utf8'));  // 撤销快照（放在 renumber 之前 = 原样保存上一版）
    renumber(decl.stages);  // 显示编号按位置重算；key 不动 ⇒ 依赖、同步记录全不受影响
    writeFileSync(abs, JSON.stringify(decl, null, 2) + '\n', 'utf8');
    logChange(root, { op: type, key, title: String(n.title || ''), by: op.by || 'user', why: op.why || '', detail: '移到第 ' + (j + 1) + ' 位' });
    return { ok: true, type, key, moved: true, to: j, backup: bak };
  }

  /*
   * expand：把一个节点按**文件**展开成子节点（"一段提示词一个节点"）。
   *
   * 用户 2026-10-21：「一段提示词一个单独的节点」「一切皆可拆为模板」。
   * 现在 ⑤ 那一步的产物是 `视频提示词/v*.txt`（31 个）+ `b*.txt`（27 个）——
   * 每个文件本来就是一段独立的提示词，展开成子节点之后：
   *   · 每段可以单独改、单独过期、单独重跑
   *   · 「画风 / 模型」这类共享节点挂在下游，改一次就同步到每一段
   *
   * 幂等：已经以同一个 `md` 存在的子节点不重复建。
   */
  if (type === 'expand') {
    const key = String(op.key || '');
    const loc = locateNode(stages, key);
    if (!loc) throw new Error('没有这个节点：' + key);
    const parent = loc.node;
    const glob = String(op.glob || '');
    if (!glob) throw new Error('要给我一个 glob（比如 视频提示词/v*.txt）');

    const files = (() => {
      /*
       * ⚠️ `resolveGlob().files` 只是**预览**（前几个），全部文件在 `.all` 里；
       *    而且 `.all` 只有文件名，不含目录部分 ⇒ 这里自己拼回相对路径。
       */
      const norm = glob.replace(/\\/g, '/');
      const cut = norm.lastIndexOf('/');
      const dirPart = cut >= 0 ? norm.slice(0, cut) : '';
      const r = resolveGlob(root, glob);
      const names = (r.all && r.all.length ? r.all : r.files) || [];
      return names.map((n) => (dirPart ? dirPart + '/' + n : String(n)));
    })();
    if (!files.length) throw new Error('这个 glob 一个文件都没匹配到：' + glob);

    /*
     * ⚠️ 这些文件**通常已经是内容节点**了。
     *
     * 实测（2026-10-21，真实片子）：⑤ 的 `files: 视频提示词/v*.txt` 已经由
     * `buildContent` 生成了 58 个**内容节点**（每个文件一个、`src` 指到它）——
     * 也就是说"一段提示词一个节点"**本来就已经成立** ✓
     * ⇒ 再展开一遍只会得到一堆重复的 children ✗
     *
     * 判据必须从**声明**推（`md` / `files` / `out` 三个 glob 字段）：
     * content 节点是运行时派生的，decl 里根本没有 `content` 这个键 ——
     * 我第一版就是读的 `parent.content`，结果一个都没挡住（实测 created=31）。
     */
    const declaredFiles = (g) => {
      const norm = String(g).replace(/\\/g, '/');
      const cut = norm.lastIndexOf('/');
      const dirPart = cut >= 0 ? norm.slice(0, cut) : '';
      const rr = resolveGlob(root, String(g));
      const names = (rr.all && rr.all.length ? rr.all : rr.files) || [];
      return names.map((n) => (dirPart ? dirPart + '/' + n : String(n)));
    };
    const existing = new Set([
      ...(parent.children || []).flatMap((c) => (Array.isArray(c?.md) ? c.md.map(String) : [])),
      ...[...(Array.isArray(parent.md) ? parent.md : []),
        ...[].concat(parent.files || []).map(String).filter(Boolean),
        ...(Array.isArray(parent.out) ? parent.out : [])].flatMap(declaredFiles),
    ].map((s) => String(s).replace(/\\/g, '/')));
    parent.children = Array.isArray(parent.children) ? parent.children : [];
    const created = [];
    for (const raw of files) {
      const rel = String(raw).replace(/\\/g, '/');
      if (existing.has(rel)) continue;
      const base = rel.split('/').pop().replace(/\.[^.]+$/, '');
      const slug = keyFromTitle(base) || 'seg';
      let k = slug;
      for (let i = 2; keySet.has(k); i++) k = slug + '-' + i;
      keySet.add(k);
      const one = {
        key: k,
        title: base,
        /* 展开出来的是"同一个提示词的分段"，角色跟父节点一致（R47）。 */
        nodeRole: roleOfNode(parent),
        /* 模板也跟父节点一致（R57）：否则分段节点认不出模板，＋ 菜单会退化成宽口 */
        template: String(parent.template || ''),
        md: [rel],
        doctrine: String(
          op.doctrine
          || '【任务】写这一段的提示词（这一段只负责它自己那一镜，别管别的镜头）。\n'
            + '【读】上游的分镜脚本 + 这一段对应的音频提示词；另读下游「画风 / 模型」节点，**整段遵循**它们。\n'
            + '【写】本节点声明的产物文件（整份重写）。\n'
            + '【格式】沿用同一部片其它段的写法：参考素材职责 / 画面风格 / 事件脚本。\n'
            + '【规矩】改这一段不要牵动别的段；共享的规矩（画风、模型写法）改在下游节点里。',
        ),
        dependsOn: [String(parent.key || '')],
      };
      parent.children.push(one);
      created.push(k);
    }

    if (!created.length) return { ok: true, type, key, created: [], reason: '这些文件已经是子节点了' };

    const bak = backup(root, abs);
    pushUndo(readFileSync(abs, 'utf8'));
    renumber(decl.stages);
    writeFileSync(abs, JSON.stringify(decl, null, 2) + '\n', 'utf8');
    logChange(root, { op: type, key, title: '', by: op.by || 'user', why: op.why || '', detail: '展开 ' + created.length + ' 个子节点（' + glob + '）' });
    return { ok: true, type, key, created, count: created.length, backup: bak };
  }

  throw new Error('不认识的结构操作：' + type);
}

/* ------------------------------------------------------------------ *
 * Agent API 配置（key / baseURL / model）
 *
 * 用户 2026-10-28：「这个只配置 agent 的 apikey，key/url/modelname 等全自己填」。
 *   · key     → `.credentials.yaml` 的 refs.DEEPSEEK_API_KEY（provider 启动时读）
 *   · baseURL → profiles/filmflow/cordis.patch.yml 的 llm-deepseek.config.baseURL
 *   · model   → `.agent-api.json`（本插件自己在建 agent 时读）
 * 改完都要重启片场才生效 —— 界面会明说。
 * ------------------------------------------------------------------ */

/** 片场的 dsh-home（等于 DSH_HOME）。 */
function agentHome() {
  return process.env.DSH_HOME || join(process.env.USERPROFILE || '', '.dsh');
}

/** 片场自己的 agent 设置文件（目前只存 model，不碰 DSH 的凭据）。 */
function agentApiFile() {
  return join(agentHome(), '.agent-api.json');
}

/** 读 `{ model, baseURL }`；没配过返回 `{}`。 */
function readAgentApi() {
  try {
    const j = JSON.parse(readFileSync(agentApiFile(), 'utf8'));
    return j && typeof j === 'object' ? j : {};
  } catch { return {}; }
}

/** 写 agent 设置（合并）。 */
function writeAgentApi(patch) {
  const next = { ...readAgentApi(), ...(patch || {}), savedAt: new Date().toISOString() };
  writeFileSync(agentApiFile(), JSON.stringify(next, null, 2) + '\n', 'utf8');
  return next;
}

/*
 * 凭据 YAML 的键匹配：流式 `refs: { KEY: v }` 和块式 `refs:\n  KEY: v` 都要认。
 * （DSH 设置页写出来的是流式；只认块式会误报未配置，还会写出重复的 refs 段。）
 */
const credKeyRe = (k) => new RegExp('(^|[\\s{,])\\s*' + k + '\\s*:\\s*("[^"]*"|[^,}\\r\\n]*)');
function credHas(raw, k) {
  const m = credKeyRe(k).exec(String(raw || ''));
  return !!m && String(m[2] || '').trim().replace(/^"|"$/g, '') !== '';
}
/** 取出一把 key 的值（界面要把它写出来；只在本机显示，不外发）。 */
function credGet(raw, k) {
  const m = credKeyRe(k).exec(String(raw || ''));
  return m ? String(m[2] || '').trim().replace(/^"|"$/g, '') : '';
}
function credUpsert(raw, k, v) {
  const val = /^[\w.-]+$/.test(v) ? v : JSON.stringify(v);
  const re = new RegExp('(^|[\\s{,])(\\s*' + k + '\\s*:\\s*)("[^"]*"|[^,}\\r\\n]*)');
  if (re.test(raw)) return raw.replace(re, (m0, pre) => pre + k + ': ' + val);
  if (/refs:\s*\{/.test(raw)) {
    if (/refs:\s*\{\s*\}/.test(raw)) return raw.replace(/refs:\s*\{\s*\}/, 'refs: { ' + k + ': ' + val + ' }');
    return raw.replace(/refs:\s*\{([^}]*)\}/, (m0, inner) => {
      const body = String(inner || '').trim().replace(/,\s*$/, '');
      return 'refs: { ' + (body ? body + ', ' : '') + k + ': ' + val + ' }';
    });
  }
  if (/^refs:\s*$/m.test(raw)) return raw.replace(/^refs:\s*$/m, 'refs:\n  ' + k + ': ' + val);
  return raw.replace(/\s*$/, '\n') + 'refs:\n  ' + k + ': ' + val + '\n';
}
function credDrop(raw, k) {
  let out = raw.replace(new RegExp('(^|[\\s{,])\\s*' + k + '\\s*:\\s*("[^"]*"|[^,}\\r\\n]*)\\s*,?', 'g'), '$1');
  out = out.replace(new RegExp('^\\s*' + k + '\\s*:.*\\r?\\n?', 'm'), '');
  out = out.replace(/,\s*\}/g, ' }').replace(/\{\s*,/g, '{ ');
  // 块式删空后会剩下一个光秃秃的 `refs:`（null）—— 那正是 B15 的 YAML 报错形态
  out = out.replace(/^refs:\s*\r?\n(?=\S|$)/m, 'refs: {}\n');
  return out;
}

/** 往 profile 的 llm-deepseek 行里写 baseURL（改前备份；没有这一行就补一段）。 */
function writeProfileBaseURL(file, url) {
  const raw = readFileSync(file, 'utf8');
  try { copyFileSync(file, file + '.bak-' + Date.now()); } catch { /* 备份失败不拦 */ }
  const lines = raw.split(/\r?\n/);
  const start = lines.findIndex((l) => /^-\s*id:\s*llm-deepseek\s*$/.test(l));
  if (start >= 0) {
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i += 1) {
      if (/^-\s/.test(lines[i])) { end = i; break; }
    }
    let idx = -1;
    for (let i = start; i < end; i += 1) {
      if (/^\s*baseURL:/.test(lines[i])) { idx = i; break; }
    }
    if (idx >= 0) {
      lines[idx] = lines[idx].replace(/baseURL:.*$/, 'baseURL: ' + url);
    } else {
      const ci = lines.findIndex((l, i) => i > start && i < end && /^\s*config:\s*$/.test(l));
      if (ci >= 0) lines.splice(ci + 1, 0, '    baseURL: ' + url);
      else lines.splice(end, 0, '  config:', '    baseURL: ' + url);
    }
  } else {
    lines.push(
      '- id: llm-deepseek',
      '  name: "@deepseek-ai/dsh-llm-deepseek-api-key"',
      '  config:',
      '    baseURL: ' + url,
      '',
    );
  }
  writeFileSync(file, lines.join('\n'), 'utf8');
}

/* ------------------------------------------------------------------ *
 * 项目发现
 * ------------------------------------------------------------------ */

/**
 * 读一份工序声明的原始对象（不解析工序树）。
 * @param declPath .film/project.json 的绝对路径
 * @returns `{ decl }` 或 `{ error }`
 */
function readDecl(declPath) {
  try {
    return { decl: JSON.parse(readFileSync(declPath, 'utf8')) };
  } catch (e) {
    return { error: '工序声明不是合法 JSON：' + String((e && e.message) || e) };
  }
}

/**
 * 发现项目：扫每个 root 的**一级子目录**找 `.film/project.json`，
 * 再加上显式列出的 projects。按路径排序去重。
 *
 * 只扫一级：一部片就是一个顶层目录（赛博故事 / 新片 …），这个约定够用且快。
 *
 * @param roots 要扫的目录（通常是工作区根）
 * @param explicit 显式列出的项目根
 * @returns 项目根绝对路径数组
 */
function discoverProjects(roots, explicit) {
  const found = [];
  const seen = new Set();

  const add = (p) => {
    const key = String(p).replace(/[\\/]+$/, '').toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    found.push(String(p).replace(/[\\/]+$/, ''));
  };

  for (const root of roots) {
    if (!existsSync(root)) continue;
    let entries;
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name.startsWith('.')) continue;
      const dir = join(root, e.name);
      if (existsSync(join(dir, DECL))) add(dir);
    }
  }

  for (const p of explicit) add(p);

  return found.sort();
}

/* ------------------------------------------------------------------ *
 * 工序树
 * ------------------------------------------------------------------ */

/**
 * 一段工序的产物状态。
 * @param outputs 已解析的产物数组
 * @returns 'ok' 全有 / 'partial' 部分有 / 'missing' 全无 / 'na' 未声明产物
 */
function statusOf(outputs) {
  if (!Array.isArray(outputs) || outputs.length === 0) return 'na';
  const hit = outputs.filter((o) => o.count > 0).length;
  if (hit === 0) return 'missing';
  if (hit === outputs.length) return 'ok';
  return 'partial';
}

/** 有子层而自己没产物时，用子层状态归并出父层状态。 */
function aggregate(children) {
  const real = children.map((c) => c.status).filter((s) => s !== 'na');
  if (real.length === 0) return 'na';
  const ok = real.filter((s) => s === 'ok').length;
  if (ok === real.length) return 'ok';
  if (ok === 0) return 'missing';
  return 'partial';
}

/**
 * 递归构造一段工序。
 * @param root 项目根
 * @param raw project.json 里的一个 stage 对象
 * @param path 本节点在树里的路径（用来生成稳定 id，供画布引用）
 */
/**
 * ★ **把 doctrine 里写死的项目名剥掉。**
 *
 * 用户 2026-10-19 实测：《测试》是从《新片》那份模板复制来的，而 doctrine 里
 * 有 **8 处**写死了别的项目的路径：
 *      【写】新片/设定/人物.md
 *      【写】新片/设定/事实层.md
 *      【写】新片/分镜表.md   …
 * 而同一个节点的 `md` 是 `设定/人物.md`（相对路径）——
 * **⇒ 指令与声明互相矛盾，而且指令指向另一个项目** ✗
 *
 * 后果：agent 照着 doctrine 写，路径就是错的（`filmflow_propose` 的提案里也会带错路径）；
 * 复制模板越多次，错得越多。
 *
 * 修法选"**渲染时剥掉**"而不是"批量改数据"：
 *   · 不动 `project.json` 里用户的数据（真源在文件系统，不改声明）✓
 *   · 相对项目根的路径本来就该是 `设定/人物.md` ✓
 *   · ⇒ **搬家 / 改名 / 再复制，都不会错** ✓
 *
 * 只剥【行首或【写】【读】后面紧跟的】`<项目目录名>/`，不做全局替换 ——
 * 免得把正文里正当提到的目录名也改掉。
 */
function normDoctrine(root, rawDoctrine) {
  if (!rawDoctrine) return '';
  let text = String(rawDoctrine);
  /*
   * ⚠️ 第一版我按「**项目自己的目录名**」去剥 ⇒ **一处都没剥掉** ✗
   *    因为 doctrine 里写死的是**别的项目**的名字（《测试》的指令里写着「新片/」）。
   *
   * 改成按「**这一段是不是真实存在的目录**」判断：
   *   · `设定/人物.md`   → `设定` 在项目根下存在 ✓ ⇒ 保留
   *   · `新片/设定/人物.md` → `新片` 在项目根下**不存在** ✗ ⇒ 剥掉这段
   * ⇒ 不依赖"是哪个项目的副本"，也不怕改名/搬家 ✓
   * ⇒ 万一哪天项目里真有个叫 `新片` 的子目录，也只会保留、不会误删 ✓
   */
  const existing = (seg) => {
    try {
      return existsSync(join(root, seg));
    } catch {
      return false;
    }
  };
  // 只处理【写】/【读】后面那种路径（行首的也算），一次最多剥一段
  text = text.replace(/((?:【[读写]】)[ \t]*)([^\s/\\]+)[/\\]/g, (m0, lead, seg) => {
    if (existing(seg)) return m0; // 是真目录 ⇒ 不动
    return lead; // 是被复制来的项目名前缀 ⇒ 剥掉
  });
  return text;
}
function buildStage(root, raw, path, dp, parentGroup, parentRole) {
  const no = String(raw?.no ?? '');
  const id = path + ':' + (no || String(raw?.title ?? ''));
  /**
   * 这个节点的授权组：自己声明了就用自己（**工序**），否则继承父工序（**子层**）。
   * 父工序自己也没写 group 时，按父角色的组提示兜底（否则老片子的子节点会全掉进 story）。
   */
  const grp = raw?.group ? String(raw.group) : String(parentGroup || groupHintForRole(parentRole));
  /** 层级角色（R47）：画布靠它过滤 ＋ 菜单。 */
  const nodeRole = roleOfNode(raw, grp);
  /*
   * 节点模板 + 下位白名单（R57）。
   *
   * 画布不再自己拼"能建什么"：宿主按 `TEMPLATE_CHILDREN` 算好 `canAdd` 一起下发，
   * 菜单只负责显示。落盘校验（placementIssue）用的是同一个函数，所以不可能漂移。
   * `template` 一并带出去：旧节点没有落盘 template，但按标题认出来的 id 要让画布知道。
   */
  const tplList = readTemplates();
  const tplId = templateIdOf(raw, tplList) || '';
  const canAdd = canAddUnder(raw, tplList, { roleIndex: roleIndexOfTemplates(), group: grp });

  const outputs = (Array.isArray(raw?.out) ? raw.out : []).map((g) => {
    const r = resolveGlob(root, g);
    return { glob: String(g), count: r.count, files: r.files };
  });

  const checks = (Array.isArray(raw?.checks) ? raw.checks : []).map((g) => {
    const r = resolveGlob(root, g);
    return { glob: String(g), count: r.count, files: r.files };
  });

  const children = (Array.isArray(raw?.children) ? raw.children : []).map((c, i) =>
    buildStage(root, c, id + '/' + i, dp + '/children/' + i, grp, nodeRole),
  );

  // 内容：**本节点自己的正文** + 它下面的子节点（用户：所有节点的正文都要能在图上改）
  const body = buildContent(root, raw, id);
  const content = body.children;
  const countNodes = (list) => list.reduce((n, c) => n + 1 + countNodes(c.children || []), 0);

  /*
   * ★ 文件里的 markdown 小节**不是节点**（2026-10-21 用户定的规矩）
   *
   * 原话：「人物节点的任务就是在下游列出人物的名字，仅此而已。我没允许不要在下游乱加节点」
   *       「"世界观"也应该是一个大节点，下游的每条设定都是"伪节点"，
   *        而"世界观"三个字本身下面是不应该有其他东西的」
   *
   * `buildContent` 会把一个文件里的每个 `##`/`###` 切成一个"内容节点" ——
   * 那是**同一份文档的小节**，不是工序，更不是能随便往里加东西的节点 ✗
   * ⇒ 画布只画 `children`（真节点）；这些小节只作为正文的一部分显示。
   *   为了编辑不丢结构，这里把**整份文件原文**带出去（fileText），
   *   客户端把它当这个节点的正文显示与编辑，写回时整份重写。
   */
  let fileText = '';
  if (body.src) {
    try {
      fileText = readFileSync(join(root, ...String(body.src).split('/')), 'utf8');
    } catch { fileText = ''; }
  }

  const own = statusOf(outputs);
  const status = own === 'na' && children.length > 0 ? aggregate(children) : own;

  return {
    id,
    /** 这个节点在 project.json 里的位置（`stages/2/children/1`）—— 就地改要靠它定位。 */
    declPath: dp,
    no,
    /**
     * 节点的**稳定身份**（`k1-3` 这种）。
     *
     * 为什么不能拿编号当身份（2026-10-21 用户要"画布上增删节点"）：
     *   编号是会变的 —— 在 1.2 和 1.3 之间插一个节点，后面全部重编号，
     *   于是 `dependsOn: ["1.3"]` 指向的东西悄悄换了人，过期判定跟着错。
     *
     * ⇒ `key` 一旦写进 project.json 就**永不改**；`no` 降级成"给人看的显示编号"。
     *   依赖声明、同步记录、工具参数都认 key（同时兼容老的编号写法）。
     */
    key: String(raw?.key || deriveKey(no)),
    title: String(raw?.title ?? '(未命名)'),
    doctrine: normDoctrine(root, raw?.doctrine),
    note: raw?.note ? String(raw.note) : '',
    // 子层没有自己的 group 就**继承父工序的** —— 不然跨组闸门对子层形同虚设
    group: grp,
    dependsOn: Array.isArray(raw?.dependsOn) ? raw.dependsOn.map(String) : [],
    status,
    outTotal: outputs.reduce((n, o) => n + o.count, 0),
    checkTotal: checks.reduce((n, c) => n + c.count, 0),
    contentTotal: countNodes(content),
    /**
     * 节点的**层级角色**（story / board / prompt-video / model-audio / gen-video…）
     * —— 画布据此决定 ＋ 菜单里能出现哪些节点（R47）。
     * 注意和下面 `role`（正文在内容树里的角色）不是同一个东西。
     */
    nodeRole,
    /**
     * 主从层身份（R52 / R54 / R56）：`character` / `character-one` / `identity` / `costume-top`…
     * 画布靠它把「＋」菜单收窄到"这个节点名下真正能建的下位"，
     * 不至于出现"菜单里点得到、落盘被拒"。
     */
    identity: (identityOfTemplate({ id: tplId }) || identityOfTitle(raw?.title) || {}).id || '',
    /**
     * 节点认出来的模板 id（R57）。旧节点没落盘 `template` 时按标题认；
     * 认不出是空串 —— 画布据此判断"这个节点是不是已知模板的叶子"。
     */
    template: tplId,
    /**
     * 这个节点下面能建哪些模板（R57，宿主算好的白名单）。
     * 空数组 = 叶子（画布不显示 ＋）；画布菜单只列这些 id。
     */
    canAdd,
    /**
     * 节点**自己的正文** —— 每个节点都有，都能在图上直接改。
     * `src` + `line` 说明它落在哪个文件的哪一行（`line: 0` 表示文件还没建）。
     */
    role: body.role,
    text: body.text,
    /** 节点类型：aggregate=成品 / downstream=下游（其内容一条条摊成伪节点）/ 空=默认 */
    kind: String(raw?.kind || ''),
    /** 媒体节点（kind='media'）的生成配置：type/model/prompt/... （不含 latest，那是运行时补的） */
    media: raw && raw.media ? { ...raw.media } : null,
    /** 这个节点的条目怎么显示：'title'=只列名字（人物这种）/ 空=名字+正文 */
    items: String(raw?.items || ''),
    /** 整份文件原文 —— 文件内的小节当「伪节点」显示、编辑时整份回写（不丢结构） */
    fileText,
    src: body.src,
    line: body.line,
    via: body.via,
    /** 整份文件归这个节点（声明了非 text 形态时）—— 写回时整份重写 */
    whole: !!body.whole,
    /** 编辑形态：text / list / table / matrix（见 形态规范.md） */
    shape: body.shape,
    /** 解析出来的结构化内容；为 null 表示退回纯文本框 */
    doc: body.doc,
    shapeOk: body.shapeOk,
    shapeHint: body.shapeHint,
    // 声明的原始字段也带上 —— 就地编辑器要用它们填初始值（缺了就会被误删）
    md: Array.isArray(raw?.md) ? raw.md.map(String) : [],
    files: [].concat(raw?.files || []).map((x) => String(x)).filter(Boolean),
    outputs,
    checks,
    content,
    children,
  };
}

/**
 * 读一个项目的 .film/project.json 并算出完整状态。
 * @param projectRoot 项目根绝对路径
 */
/* ------------------------------------------------------------------ *
 * 依赖与过期 —— 核心功能的「粗」那一层
 *
 * 用户的核心要求：「Agent 要根据任意节点中任意内容的改动自动改其他节点的内容」。
 * 这件事必须分两层做：
 *
 *   粗（这里）：哪些节点**可能**受影响 —— 依据声明里的 dependsOn，确定性、零 token。
 *   细        ：具体改哪几句 —— 只有 Agent 读得懂语义，交给它。
 *
 * 让 Agent 自己猜"哪些节点受影响"会漏、会贵；让插件做细的又做不到。
 *
 * 怎么判过期：
 *   · 每个节点有一个**内容指纹**（它自己的正文 + 整棵子树）
 *   · `.film/sync.json` 记着"我上次跟依赖对齐时，它们长什么样"
 *   · 依赖的指纹跟记录不一致 → 我过期了
 *   · **依赖自己过期了，我也过期** —— 我的依据已经不可信了。这条会自然级联。
 * ------------------------------------------------------------------ */

/** 同步记录（每个节点最后一次跟依赖对齐时的快照）。跟项目一起走。 */
const SYNC = join('.film', 'sync.json');

/**
 * 指纹算法的版本号。
 *
 * ⚠️ 为什么需要它（2026-10-14 实测踩到）：
 *   指纹是"节点正文 + 整棵子树"的 sha1。**正文是怎么算出来的**由解析模型决定 ——
 *   v13 改了模型（声明了非 text 形态的节点从"标题下那段"变成"整份文件"），
 *   于是同一个文件、同样的内容，算出来的指纹变了。
 *
 *   结果是：**所有旧的同步记录都被误读成「上游被改过」**，而真相是"我换了算法、
 *   这两个指纹根本不可比"。前者会让人去查一个并不存在的改动 —— 是误导。
 *
 *   所以记录里存一个算法版本：对不上就判 `unknown`（"没法比，去对齐一次"），
 *   绝不判 `stale`（"内容变了"）。
 *
 * 改 hashOf 或改"节点 text 怎么来"的时候，**必须把这个号加一**。
 */
const HASH_MODEL = 'h3';

/**
 * 这个节点（含整棵子树）是不是**还没写过任何东西**。
 *
 * ⚠️ 不能用"hash === EMPTY_HASH"来判断：一个子节点全空的父节点，
 *    它的 hash 是 sha1(各个子节点的指纹)，**不等于空指纹** ——
 *    于是 `2 写剧本`（依赖 ①）会被误判成"有内容、且未同步"。
 *    必须递归往底下看。
 */
function isBlank(n) {
  if (String(n?.text ?? '').trim() !== '') return false;
  for (const c of n?.content || []) if (!isBlank(c)) return false;
  for (const c of n?.children || []) if (!isBlank(c)) return false;
  return true;
}


function readSync(root) {
  const p = join(root, SYNC);
  if (!existsSync(p)) return {};
  try {
    const o = JSON.parse(readFileSync(p, 'utf8'));
    return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
  } catch {
    // 读不了就当没有 —— 过期检测退化成"未同步"，宁可少报不可误报
    return {};
  }
}

/** 一个节点内容的指纹：它自己的正文 + 整棵子树。上游变一点，下游就该重算。 */
function hashOf(node) {
  const h = createHash('sha1');
  h.update(String(node?.text ?? ''));
  for (const c of node?.content || []) h.update(hashOf(c));
  for (const c of node?.children || []) h.update(hashOf(c));
  return h.digest('hex').slice(0, 12);
}

/** 建 编号 → 节点 的索引。`dependsOn` 里写的是编号（"1" / "1.3"）。 */
function indexByNo(stages) {
  const byNo = new Map();
  const walk = (n) => {
    if (n.no) byNo.set(String(n.no), n);
    for (const c of n.children || []) walk(c);
  };
  for (const s of stages) walk(s);
  return byNo;
}

/**
 * 由编号派生一个稳定 key：`1.3` → `k1-3`。
 *
 * 只在**文件里还没写 key** 的时候兜底用（迁移前的旧数据）。
 * 命名刻意朴素：短、能在工具参数里直接敲、不会和中文标题打架。
 * @param no - 显示编号
 * @returns key
 */
function deriveKey(no) {
  const s = String(no ?? '').trim();
  if (!s) return 'k';
  return 'k' + s.replace(/[^\w\u4e00-\u9fa5]+/g, '-').replace(/^-+|-+$/g, '');
}

/** 建 key → 节点 的索引。 */
function indexByKey(stages) {
  const m = new Map();
  const walk = (n) => {
    if (n.key) m.set(String(n.key), n);
    for (const c of n.children || []) walk(c);
  };
  for (const s of stages) walk(s);
  return m;
}

/**
 * 把每个节点的 `dependsOn` 统一成 **key**。
 *
 * 兼容两种写法（老数据写编号 `"1.3"`、新数据写 key `"k1-3"`）：
 * 能对上 key 的原样保留，否则按编号查表换成 key。
 * 查不到的**留原样** —— 让错别字在画布上显形，而不是被静默吞掉。
 * @param stages - 工序树
 */
function resolveDepKeys(stages) {
  const byNo = indexByNo(stages);
  const byKey = indexByKey(stages);
  const fix = (n) => {
    const out = [];
    for (const d of Array.isArray(n.dependsOn) ? n.dependsOn : []) {
      const s = String(d);
      if (byKey.has(s)) { out.push(s); continue; }
      const t = byNo.get(s);
      out.push(t && t.key ? String(t.key) : s);
    }
    n.dependsOn = out;
    for (const c of n.children || []) fix(c);
  };
  for (const s of stages) fix(s);
}

/**
 * 给每个节点打上过期状态。
 *
 * `stale` 取值：
 *   `none`    没有声明依赖（源头节点）
 *   `unknown` 有依赖，但从来没同步过
 *   `ok`      依赖跟上次同步时一致
 *   `stale`   依赖变了，或依赖自己过期了
 */
function markStale(stages, sync) {
  const byNo = indexByNo(stages);
  const byKey = indexByKey(stages);
  /** 依赖标识 → 节点：先按 key 找，找不到再按老编号找（兼容迁移前的数据）。 */
  const nodeOf = (d) => byKey.get(String(d)) || byNo.get(String(d));

  // 摊平成一张表，后面分遍处理
  const all = [];
  const collect = (n) => {
    all.push(n);
    for (const c of n.children || []) collect(c);
  };
  for (const s of stages) collect(s);

  /*
   * ⚠️ 必须**分三遍**，不能一遍到底 —— 这是自测抓出来的真 bug：
   *   一遍的时候，判第 2 段时第 7 段的指纹还没算出来（`undefined`），
   *   一对比就永远"过期"，闭环合不上。
   */

  // 第一遍：把所有指纹算出来（依赖的指纹必须在判定之前就位）
  for (const n of all) n.hash = hashOf(n);

  // 第二遍：按指纹判过期（只看直接依赖的指纹，先不管级联）
  for (const n of all) {
    const deps = Array.isArray(n.dependsOn) ? n.dependsOn.map(String) : [];
    // 同步记录优先按 key 找；老记录是按编号存的，回退一次（迁移时会被改写）
    const rec = sync[String(n.key)] || sync[String(n.no)];
    n.dependsOn = deps;
    n.syncedAt = rec && rec.at ? String(rec.at) : '';
    if (deps.length === 0) {
      n.stale = 'none';
      continue;
    }

    /*
     * 两边都还空着 → 无所谓同步，判 `none`。
     *
     * 为什么要有这条：空白模板上每个节点都没内容，若一律判 `unknown`，
     * 一打开就是 7 个「未同步」—— 那是噪音不是信息。**内容还没写的时候，
     * 不存在"对不对得上"这回事。**
     */
    if (isBlank(n) && deps.every((d) => isBlank(nodeOf(d)))) {
      n.stale = 'none';
      continue;
    }

    if (!rec || !rec.deps) {
      n.stale = 'unknown';
      continue;
    }
    // 指纹算法版本对不上 → 两个指纹不可比，判"未同步"而不是"过期"
    if (rec.model !== HASH_MODEL) {
      n.stale = 'unknown';
      n.staleWhy = '这份记录是旧算法（' + (rec.model || '更早') + '）写的，现在算的是 ' + HASH_MODEL + '，没法比。';
      continue;
    }
    /*
     * 记下**到底是哪些上游变了** —— 这一条是"agent 自动同步"的前提。
     *
     * 用户 2026-10-21：「上游改了 agent 可以直接同步下游；下游改了 agent 需要请示」。
     * 要让它自动做，就不能只告诉它"你过期了"，得告诉它"因为 1.2 世界观 改了"。
     * 这是纯确定性计算（比指纹），零 token。
     */
    const changedDeps = [];
    for (const d of deps) {
      const dep = nodeOf(d);
      if (dep && rec.deps[d] !== dep.hash) changedDeps.push(String(d));
    }
    n.changedDeps = changedDeps;
    n.stale = changedDeps.length > 0 ? 'stale' : 'ok';
    if (changedDeps.length) {
      n.staleWhy = '这些上游改过了：' + changedDeps.map((d) => labelOf(nodeOf(d))).join('、');
    }
  }

  // 第三遍：级联 —— **依赖自己过期了，我也过期**（我的依据已经不可信了）。
  // 反复扫到不动为止，因为过期会顺着依赖链一路传下去。
  for (let round = 0; round <= all.length; round++) {
    let moved = false;
    for (const n of all) {
      if (n.stale !== 'ok') continue;
      for (const d of n.dependsOn) {
        const dep = nodeOf(d);
        if (dep && dep.stale === 'stale') {
          n.stale = 'stale';
          // 级联过期：直接把"源头"指出来，别让 agent 自己去追
          n.staleWhy = '上游 ' + labelOf(dep) + ' 过期了，我的依据也不可信';
          n.viaDep = String(dep.key || dep.no || '');
          moved = true;
          break;
        }
      }
    }
    if (!moved) break;
  }
}

/** 人读的节点标签：`1.2 世界观`。 */
function labelOf(n) {
  if (!n) return '（未知节点）';
  return String(n.no || n.key || '') + ' ' + String(n.title || '');
}

/**
 * 在一部片的所有节点正文里检索一段文字（**只读**）。
 *
 * 为什么要它：用户 2026-10-21 决定不给正文加词条标注，那"改一个字要同步哪些地方"
 * 就全靠 agent 读。它读到多少算多少 —— 漏一处是静默的。
 * 这个函数把"哪几个文件、第几行、那句话"机械地列出来，保证 agent **不漏看**。
 *
 * @param root 片子根
 * @param q 要检索的文字（大小写不敏感）
 * @returns {{总命中:number, 节点数:number, hits:Array}}
 */
function searchInProject(root, q) {
  const p = buildProject(root);
  if (!p.ok) throw new Error(p.error || '项目读不了，没法检索');
  const needle = String(q).toLowerCase();
  const hits = [];
  let total = 0;

  const walk = (n) => {
    if (n.src) {
      const abs = join(root, ...String(n.src).split('/'));
      let text = '';
      try { text = readFileSync(abs, 'utf8'); } catch { text = ''; }
      const lines = text.split(/\r?\n/);
      const matches = [];
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].toLowerCase().includes(needle)) continue;
        matches.push({ line: i + 1, text: lines[i].trim().slice(0, 160) });
        total++;
      }
      if (matches.length) {
        hits.push({
          no: n.no || '',
          title: n.title || '',
          key: n.key || '',
          src: n.src,
          matches: matches.slice(0, 12),
        });
      }
    }
    for (const c of n.children || []) walk(c);
  };
  for (const s of p.stages) walk(s);
  return { 总命中: total, 节点数: hits.length, hits: hits.slice(0, 40) };
}

/**
 * 跟依赖对齐 —— 把"现在依赖长什么样"记下来，于是这个节点不再过期。
 * Agent 把下游改完之后应当调它。
 *
 * @param onlyNo 只对齐这一个节点（编号或 key 都认）；不给就对齐全项目
 */
function syncNodes(root, onlyNo) {
  const p = buildProject(root);
  if (!p.ok) throw new Error(p.error || '项目读不了，无法对齐');

  const sync = readSync(root);
  const now = new Date().toISOString();
  const byNo = indexByNo(p.stages);
  const byKey = indexByKey(p.stages);
  const nodeOf = (d) => byKey.get(String(d)) || byNo.get(String(d));
  const done = [];

  const doOne = (n) => {
    const deps = Array.isArray(n.dependsOn) ? n.dependsOn.map(String) : [];
    const wanted = !onlyNo || String(n.no) === String(onlyNo) || String(n.key) === String(onlyNo);
    if (deps.length && wanted) {
      const rec = { at: now, model: HASH_MODEL, deps: {} };
      for (const d of deps) {
        const dep = nodeOf(d);
        if (dep) rec.deps[d] = dep.hash;
      }
      // 按 **key** 存（老的按编号存的记录一并留着，读的时候有回退）
      sync[String(n.key)] = rec;
      delete sync[String(n.no)];
      done.push(String(n.key));
    }
    for (const c of n.children || []) doOne(c);
  };
  for (const s of p.stages) doOne(s);

  const abs = join(root, SYNC);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, JSON.stringify(sync, null, 2) + '\n', 'utf8');
  return { synced: done, at: now };
}

/**
 * 提案 / 确认 —— 把「改之前先问」从**软规矩**变成**硬机制**。
 *
 * 用户 2026-10-15 的原话：
 *   「我更改画布上内容时插件会先向 Agent 发送一次调用……我的更改有些时候可能是不太
 *     合理或者是不太清晰的，所以 **Agent 收到插件发送的请求后，要先对我进行询问，
 *     我确认之后，他再写进画布**。」
 *
 * 之前这只是 `AGENTS.md` §12 里的一条规矩 —— 靠我（LLM）自觉。**软约束，会忘、会自作主张。**
 *
 * 现在改成机制：
 *   · Agent **不能**直接写内容（`filmflow_write` 被闸死，调用即报错并指路）
 *   · 它只能 `filmflow_propose` —— 把"我想这么改、为什么"写进 `.film/proposals.json`
 *   · 用户在图上看到提案，点【确认】→ **宿主**才走 `applyEdit` 落盘（三道护栏原样复用）
 *
 * 关键点：**落盘这个动作是宿主替用户做的，不是 Agent 做的。** 所以它结构上做不到偷偷改。
 */

const PROPOSALS = join('.film', 'proposals.json');

function readProposals(root) {
  const p = join(root, PROPOSALS);
  if (!existsSync(p)) return [];
  try {
    const o = JSON.parse(readFileSync(p, 'utf8'));
    return Array.isArray(o) ? o : [];
  } catch {
    return [];
  }
}

function writeProposals(root, list) {
  const abs = join(root, PROPOSALS);
  mkdirSync(dirname(abs), { recursive: true });
  // 只留最近 200 条，别让这个文件无限长
  writeFileSync(abs, JSON.stringify(list.slice(-200), null, 2) + '\n', 'utf8');
}

/** 取某个节点"当前正文"的开头，用来给用户看改了什么。 */
function previewOf(root, node) {
  if (!node || !node.src) return '';
  const abs = join(root, ...String(node.src).split('/'));
  if (!existsSync(abs)) return '（文件还不存在）';
  try {
    const t = readFileSync(abs, 'utf8');
    return t.length > 800 ? t.slice(0, 800) + '\n…（已截断）' : t;
  } catch {
    return '（读不了）';
  }
}

/* ================================================================== *
 * 阶段 B：项目的常驻 Agent —— 把"谁给 Agent 那个回合"这一环接上
 *
 * 用户的设计原话：
 *   「我更改画布上内容时**插件会先向 Agent 发送一次调用**对吧？」
 *   「一个项目打开就是一个独立的 Agent。」
 *
 * 之前这一环是空的：你保存 → 插件落盘 + 标过期 → **没人去处理**。
 * Agent 只在你开口说话时才动。所以插件看起来"什么都没发生"。
 *
 * 现在接上：保存 → 插件叫醒那个项目的 agent → 它自己看板、判断、提提案。
 *
 * ── 机制（全部实测过，见 entry-v24/v25 的 trace）────────────────────
 *   · `ctx.agents.requireFactory()` 返回的是 **cordis 追踪代理**，
 *     真对象在 **`.target`** 后面（代理上读 `createAgent` 是 undefined）
 *   · `factory.createAgent(ownerCtx, { sessionId, meta:{cwd}, agentOptions, setup })`
 *     → `Promise<{ agent, dispose }>`
 *   · `setup(agentCtx)` 会被调到；`agentCtx.tools` / `systemPrompt` / `llm` 可读
 *   · **新起的 run 只有全局注册的工具** —— 没有 bash / pwsh / write / edit / read。
 *     所以它天生改不了文件，只能走 `filmflow_propose`。这是白送的安全边界。
 *
 * ── 这一版故意做的取舍 ──────────────────────────────────────────
 *   · `meta.cwd` 给**工作区根**（不是片目录）—— 因为 `dsh-agent-instructions`
 *     从 cwd 往上找 `.git` 定项目根，给片目录会让它读不到工作区那份 `AGENTS.md`，
 *     那里面正写着两条硬规矩。这个 Agent 的"系统提示词"就是它。
 *   · `followup` 的消息形状**不确定** —— 所以两种都试（纯字符串 / {role,content}），
 *     哪个成记哪个。包在 try/catch 里，形状不对也不连累插件。
 * ================================================================== */

/** 一个项目一个 agent run。key = 项目根（小写）。 */
const agentRuns = new Map();

/**
 * agentPreset 的名字。由 `apply()` 从插件配置读出来写进来。
 *
 * ⚠️ **这里是 v33 一个 bug 的现场**：我在 `ensureAgent()` 里直接写了
 *    `config?.agentPreset` —— 但 `ensureAgent` 是**模块级函数**，
 *    `config` 只存在于 `apply(ctx, config)` 的作用域里。
 *    结果：每次叫醒都抛 `ReferenceError: config is not defined`，
 *    **Agent 从来没被创建过** —— 而界面上看起来只是"没反应"。
 *
 *    `node --check` **查不出这种错**（语法合法，只有运行时才知道标识符不存在）。
 *    所以另加了 `tools/verify-wake.mjs`：用桩 factory 真的走一遍叫醒路径。
 */
let AGENT_PRESET = '';   // ★ 默认**不传**预设 —— 见 ensureAgent 里那段注释

/**
 * 全局注册的那四把工具的定义（`apply()` 里 `reg()` 时收集）。
 * 每个项目的 agent 会在 `setup` 里拿到**绑死自己项目**的同名副本。
 */
const AGENT_TOOLS = [];

/**
 * 片场 Agent 的**独立工作目录** —— 由 `apply()` 设成 `<工作区>/.film-agent`。
 *
 * ★ 为什么要有它（用户 2026-10-16 的方案，比我原来的想法便宜得多）：
 *
 * 原来 `meta.cwd` 给的是**工作区根**，于是 `dsh-agent-instructions` 注入的是
 * **工作区根那份 `AGENTS.md`** —— 那里面写着「本工作区的每部片（新片/、赛博故事/ …）」，
 * **等于一睁眼就告诉它有哪些别的片** ✗
 *
 * 而 `dsh-agent-instructions` 是**从 cwd 往上找项目根**的（没有 `.git` 时 cwd 就是根）
 * ⇒ **只要把 cwd 指到一个放着自己那份 `AGENTS.md` 的目录，注入的就换成它** ✓
 *
 * ⇒ **一片都不用搬。** 而且那个 agent 手里现在只有四把 filmflow 工具、
 *   **没有任何文件工具**，所以 cwd 唯一还起作用的就是"读哪份规矩" ✓
 *
 * ⚠️ 这里之前漏了 `let`，而 `apply()` 里有 `AGENT_CWD = …` ——
 *    ESM 严格模式下那是**未声明赋值 → ReferenceError → 整个插件起不来** ✗
 *    （`node --check` 查不出这种错，它就是那种"语法合法、运行时才炸"的类型。）
 */
let AGENT_CWD = '';

/**
 * ══ ★★ 写操作的令牌 —— 用户 2026-10-20：「它的能力/工具一定要限制死」 ══
 *
 * 审查发现：13 个路由里 7 个能**写**（edit / sync / approve / scope / newproject / say / agent），
 * 而**没有任何鉴权** ✗。端口虽然只绑 127.0.0.1 ✓，但**任何网页都能 POST 过来**
 * （CSRF 打 localhost 是经典手法）⇒ 你随便打开一个页面，它就能偷偷改你的剧本 ✗✗✗
 *
 * 修法：进程启动时生成一个随机令牌 ✓
 *   · 嵌进两个页面的 HTML 里（`var WRITE_TOKEN = "…"`）
 *   · 写操作必须带 `x-filmflow-token` 头
 *   · 另加一道 Origin 校验：带了 Origin 且不是本机 ⇒ 直接拒
 *
 * **为什么这能防 CSRF**：跨域的攻击者**读不到你的 HTML**（同源策略 ✓）
 * ⇒ 它拿不到令牌 ⇒ 写不进来 ✓
 */
let WRITE_TOKEN = '';

/** 只给自测脚本用（同一个信任边界内的代码才能 import 到）。 */
export function __getWriteToken() {
  return WRITE_TOKEN;
}

/**
 * 插件被 `apply()` 的时刻 —— 用来给懒唤醒**加一个启动延迟**。
 *
 * ★ 为什么需要：实测（2026-10-16）新片那份会话 resume 失败，报
 *
 *     session "filmflow-9ebda…" contains event type "side-answer/interjection"
 *     (seq 119) **unknown to this harness and not marked ignorable**; refusing to …
 *
 * 而**同一台机器、同一时刻**，赛博故事那份 resume 成功 ✓ ——
 * 差别就是**新片那份会话里被 `side-answer` 插件写进了那个事件**。
 *
 * 会话加载器不认识那个类型就**拒绝加载整个会话**。而那个类型本该由
 * `side-answer` 插件注册成"已知/可忽略" —— **注册得比我的懒唤醒晚** ✗
 *
 * ⇒ **时序问题**。所以懒唤醒推迟到插件都起来之后再跑。
 */
let PLUGIN_LOADED_AT = 0;
/** 懒唤醒的启动延迟：等别的插件把事件类型注册完。 */
const WAKE_DELAY_MS = 0;   // ★ 实测：延迟**没用**（见上）—— 那个事件类型是真的没被注册。留 0 = 不延迟。

/**
 * `ctx.agents` 的**同步快照**。由 `apply()` 在进入时立刻取好。
 *
 * ⚠️ 为什么不能等到异步回调里再取 `ctx.agents`：
 *    会抛 `cannot get required service "agents" in inactive context` ——
 *    cordis 的上下文在异步边界之后就不活跃了，取不到服务。
 *
 *    这是 2026-10-15 在 `plugins/_agentprobe` 里实测到的：
 *    探针**同步取**的那个 agent 建起来了、拿到了回复（HTTP 200 + assistant "收到了"）；
 *    而同一个探针里跑到后面才取 ctx 的那个直接抛 `inactive context`。
 *    **所以这不是理论风险，是实测过的分水岭。**
 */
let AGENTS = null;

/** 哪些项目已经试过懒唤醒了 —— 只试一次，免得每次轮询都重试。 */
const wakeTried = new Set();

/**
 * 这个 agent run 用哪个模型。由 `apply()` 从配置写进来。
 *
 * ⚠️ 为什么怀疑这一层：v33/v35 的现象是 **turn 36 毫秒就结束、会话 0 条消息**。
 *    `agentOptions: {}` —— 没给 provider/model。虽然 profile 里装了
 *    `agent-default-model`（deepseek-official / deepseek-flash），
 *    但那个默认是给"正常路径"建的 agent 用的，插件自己 createAgent 未必吃得到。
 *    所以这里显式给上，跟 profile 里的默认保持一致。
 */
let AGENT_PROVIDER = 'deepseek-official';
let AGENT_MODEL = 'deepseek-flash';

/**
 * 片场 agent 的**全局工具白名单**（2026-10-28 用户定）。
 *
 * 「不要有跨任务的知识库检索/历史会话搜索；但要保留网络能力和文件读写能力，
 *   很多知识需要学习/总结成文件或 skill；但也一定不要有完整的 shell 能力」
 *
 * 规则（2026-10-28 两轮实测后）：
 * · 文件读写 / 上网**由 preset-filmflow 挂进 agent 作用域**。profile 级挂的它们
 *   不进 agent 的可见表（restrict 里"name unknown"），所以改装到 preset 里。
 * · 挂上之后它们**受这张 allow 表管**（实测：不在表里就不进请求头），
 *   所以这里必须和 preset 的插件列表同步点名。
 * · ⚠️ 表里写不存在的名字会让 `tools.restrict` 整体抛错（unknown names fail）。
 */
const AGENT_ALLOWED_TOOLS = [
  // 片场 8 把
  'filmflow_board', 'filmflow_node', 'filmflow_propose', 'filmflow_search',
  'filmflow_sync', 'filmflow_apply', 'filmflow_set_media', 'filmflow_templates',
  // 用户自建节点（R58，2026-10-30）
  'filmflow_template_save',
  // 文件读写 + 上网：2026-10-28 做成片场自己的三把（DSH 的 read/write/web_* 进不了
  // agent 的可见表 —— preset 子插件在 setup 之后才到；详见 filmflow_read/write/web 的注释）
  'filmflow_read', 'filmflow_write', 'filmflow_web',
  // 提示词写法速查（D18）
  'filmflow_model_guide',
];

/**
 * 造一条**合法的 `UserMessage`**。
 *
 * ★ 2026-10-15 实测纠正：原来我只给 `{ role:'user', content:[{type:'text',text}] }` ——
 *   而 `dsh-llm/lib/types/message.d.ts` 里 `UserMessage extends MessageBase`，必须有：
 *
 *     readonly id: MessageId;              // 稳定身份
 *     readonly content: readonly ContentBlock[];   // 块数组（这个我给对了）
 *     readonly source: MessageSource;      // ★ 我漏了
 *
 *   而 `MessageSourceMap.user = { kind: 'user' }`（同文件 101-104 行）。
 *   官方工厂是 `createUserMessage({ content, source })` —— **id 由它生成**，
 *   但它导不进来（插件目录没有 node_modules，DSH 的包不是祖先目录），
 *   所以这里**手搓一个等价对象**。
 *
 *   缺 id/source 的后果不是报错，而是**驱动把它丢掉** —— turn 立刻结束、
 *   会话里一条消息都没有。**最难查的那种失败：不报错，只是没反应。**
 */
function userMessage(text) {
  return {
    id: 'ffm-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
    role: 'user',
    content: [{ type: 'text', text: String(text) }],
    source: { kind: 'user' },
  };
}

/** 这个项目已经有 agent 了吗；没有就起一个。 */
async function ensureAgent(ctx, projectRoot, cwd, log) {
  const key = String(projectRoot).toLowerCase();
  const cur = agentRuns.get(key);
  if (cur && cur.handle && cur.handle.agent) return cur;

  const reg = AGENTS; // ★ 用 apply() 里同步取好的那份，不在异步回调里现取
  if (!reg || typeof reg.requireFactory !== 'function') {
    log('ctx.agents 不可用，起不了 agent');
    return null;
  }
  const fac = reg.requireFactory().target; // ★ 必须 .target
  if (!fac || typeof fac.createAgent !== 'function') {
    log('factory.target.createAgent 不是函数');
    return null;
  }

  /*
   * ★ 2026-10-15 实测修正：**必须传 `agentPreset`。**
   *
   * 症状：不传预设时 createAgent 成功、followup 也"成功"（用 blocks 形式），
   *       但 **6 毫秒后 whenIdle 就返回了，agentMsgs = 0** —— 那次 turn 什么都没干。
   * 原因：预设（`~/.dsh\.agent-presets\liangshen\`）才是**模型 + 人格 + 工具**
   *       的来源。没有它，那个 agent 是个空壳。
   *
   * 代价：预设带进来一堆危险工具（tool-bash / tool-pwsh / tool-fs / str-replace-editor…），
   *       **"天生干净的工具集"就没了** —— 所以 `setup` 里必须真的 restrict 掉它们，
   *       否则那个 Agent 可以直接 `echo > 文件`，绕过"只能提案"的硬闸门。
   */
  /*
   * ★★ **默认不传 agentPreset** —— 2026-10-16 实测确认可行。
   *
   * 为什么：预设（`liangshen`）会把**一整套 scoped 工具**（bash / pwsh / read / ls /
   * glob / grep / write / edit / str_replace）请进那个 agent 手里，而
   * `restrict` **只管全局工具**（"scoped registrations remain visible"），
   * **挡不住它们** ✗ —— 那意味着那个 agent 能读能改**任何项目的文件**，
   * 我做的提案闸门 / 白名单 / 备份在它面前全是纸糊的。
   *
   * 实测（headless + 探针，2026-10-16 08:31）：
   *     不传预设 → createAgent 成功 → followup 成功
   *     [+4s] 角色={"system":1,"user":4,"assistant":1}
   *     ★★★ 拿到回复了：收到了　总耗时 6 秒
   * **而且 `system:1` 还在** —— 系统提示词来自 `AGENTS.md`（dsh-agent-instructions），
   * **不依赖预设** ✓
   *
   * 代价：丢掉「梁神模式」的附加件（tool-bootstrap / instruction-hint /
   * custom-bash / skill-search）。对一个专给片场干活的 agent 来说，
   * **四把工具 + AGENTS.md 才是对的**。
   *
   * 配置里显式写 `agentPreset` 就能恢复旧行为。
   */
  /*
   * ★★★ **这里必须是模块级变量，不能写 `config`。**
   *
   *   2026-10-16 我又犯了一次：把 `AGENT_PRESET` 改成 `String(config?.agentPreset || '')`
   *   —— 而 `ensureAgent` 是**模块级函数**，`config` 只存在于 `apply(ctx, config)` 的
   *   作用域里 ⇒ `ReferenceError: config is not defined`，
   *   **每次叫醒都崩，Agent 从来没被创建过**。
   *
   *   而 `node --check` **查不出这种错**（语法合法，运行时才知道标识符不存在），
   *   界面上只表现为"没反应"。**v33 就是栽在这上面，v47 又栽了一次。**
   *
   *   配置由 `apply()` 读进 `AGENT_PRESET`（模块级），这里只读它。
   */
  const preset = AGENT_PRESET;

  /*
   * ★★ **稳定的 sessionId** —— 用户 2026-10-16 问「为什么我重新打开，以前的会话就没有了？」
   *
   * 原来这里是 `'filmflow-' + Date.now().toString(36)` —— **时间戳，每次重启都不一样**。
   * 所以每次重启 = 换一个新的会话，以前的对话就不在当前会话里了。
   * （它的会话其实**是持久化的** —— 只是我从来没去接回来。）
   *
   * 现在：**由项目根算一个稳定 id**，重启后还是同一个 —— 然后优先 `resume` 接回来。
   * 必须纯 ASCII：sessionId 会进 HTTP header，中文会让 fetch 抛 ByteString。
   */
  /*
   * ══ ★★★ 会话 id：**跟 DSH 原版一样，存下来，不要算出来** ══
   *
   * 用户 2026-10-16 定的原则：「**按照 dsh 原版为蓝本做减法**（一些地方添加东西）
   * 不容易出问题。」—— 我自造的两样东西正是问题来源：
   *
   *   ✗ **自造 ①：`sha1(项目路径)` 当 id**（v40 起）
   *      · 实测证明我**根本算不出插件自己用的值**：
   *        我按 `sha1(lower(路径))` 算 `<工作区>\新片` 得 `e058ce85a0ad5e44`，
   *        而 trace 里插件实际用的是 `9ebda212ae73c70d` —— 对不上 ✗
   *      · 更糟：**路径一变 id 就变**。2026-10-16 我把片子搬到 `<片库根>\`
   *        —— 顺手把每部片的历史又切断了一次（我搬之前没检查，是疏漏）。
   *
   *   ✗ **自造 ②：resume 失败就建 `-<时间戳>` 新会话**
   *      · 实测后果（`session_projcache\sessions` 实况）：
   *            新片     → 1 个 base + **8 个孤儿**
   *            赛博故事 → 1 个 base + **6 个孤儿**
   *        而 `resume` **永远只找 base id** ⇒ 那些孤儿**永远读不回来** ✗✗✗
   *      · 我那个"保护历史"的 fallback，实际在**制造碎片**。
   *
   * ── 改法（原版的形状 + 一处添加）──
   *
   *   · id 形状用**原版那种** `session-<uuid>`（实测原版就是 `session-682adc1d-…`）
   *   · **把它存进项目目录** `.film/session.json` —— 这就是那处"添加"：
   *       DSH 原版靠会话列表让用户挑，「继续哪个」是**存下来的**，不是算出来的 ✓
   *   · ⇒ 好处：**路径变了不影响**（id 在项目里，跟着项目走）；搬家时
   *     `robocopy` 会把 `.film/session.json` 一起带过去 ⇒ **历史不断** ✓
   *   · resume 失败**不再偷偷建新的** —— 只有项目从没开过（没有 session.json）才新建 ✓
   *
   * ⚠️ 副作用：已在跑的片子的老会话（`filmflow-…`）**接不上了** ——
   *    因为 id 换形状了。但那些本来也大多读不回来（见 ②）。
   *    **这是最后一次换 id 形状**，之后它就跟着项目走了。
   */
  const sessFile = join(projectRoot, '.film', 'session.json');
  let stableId = '';
  try {
    if (existsSync(sessFile)) {
      const j = JSON.parse(readFileSync(sessFile, 'utf8'));
      stableId = String((j && j.sessionId) || '');
    }
  } catch (e) {
    log('读 .film/session.json 失败（当没有处理）: ' + String((e && e.message) || e).slice(0, 120));
  }
  /** 这个项目是不是第一次开（从没有过会话 id）。 */
  const firstRun = !stableId;
  if (firstRun) stableId = 'session-' + randomUUID();

  const sharedOpts = {
    // cwd 用片场那个独立目录（它自己的 AGENTS.md），不用工作区根。
    // 2026-10-28 起**默认带 preset-filmflow**：文件读写 / 上网 / 时间上下文都挂在它
    // 的 plugins 里，不传 preset 时这些工具根本不会进 agent 的作用域（实测 restric 报 unknown）。
    meta: (() => {
      const c = AGENT_CWD || cwd;
      return { cwd: c, ...(preset ? { agentPreset: preset } : {}) };
    })(),
    agentOptions: { provider: AGENT_PROVIDER, model: AGENT_MODEL },
    /*
     * 危险工具的名单。跟预设里那些对不上时 `restrict` 会抛，
     * 而**那个错误信息里就带着真实工具表** —— 所以下面把错误原文记进 trace，
     * 一看就知道该 deny 什么。
     */
    setup(agentCtx) {
      /*
       * ══ ★★★ 把四把工具**绑死到这个项目** ══
       *
       * 用户 2026-10-16 报的串台：agent 调 `filmflow_board` 不带参数
       * → 拿到【全部项目】的报告 → 它就聊别的片 ✗
       *
       * 做法：用同名注册一份 **scoped 副本**，`project` **写死**、忽略调用方传的值。
       * 工具文档原话："**Scoped tools shadow**" —— scoped 会遮盖同名的全局工具 ✓
       * 所以它实际上只能碰到自己那部片。
       *
       * 顺带：scoped 副本还有个好处 —— **它连"别的项目叫什么"都看不到**，
       * 因为 `pickProjects` 永远只拿到一个项目。
       */
      for (const def of AGENT_TOOLS) {
        /*
         * ⚠️ **跳过 `filmflow_write`** —— 它是停用的直写口。
         *
         * 实测（2026-10-16 08:39）：绑定循环收了 5 把（含 filmflow_write），
         * 于是模型收到的工具变成 5 个 —— **因为它成了 scoped 工具，
         * 而 `restrict` 的 allow 名单管不着 scoped 的**（"scoped registrations
         * remain visible"）→ 那个停用的口子又露出来了 ✗
         *
         * 它的 execute 仍然会抛"已停用"（无害），但**可见就是脏** —— 不绑它。
         */
        if (!def || def.name === 'filmflow_write') continue;
        try {
          agentCtx.tools.register({
            ...def,
            description:
              def.description +
              '　⚠️ **这个工具已经绑死在《' +
              String(projectRoot).split(/[\\/]/).pop() +
              '》这一部片上** —— 传 project 参数会被忽略，你只能看/改这一部。',
            // 薄壳：把 project 强行钉死，其余原样转发
            execute: (args, exec) => def.execute({ ...(args || {}), project: projectRoot }, exec),
          });
        } catch (e) {
          log('绑项目工具 ' + (def && def.name) + ' 失败: ' + String((e && e.message) || e).slice(0, 120));
        }
      }
      log('★ 已把 ' + AGENT_TOOLS.length + ' 把工具绑死到 ' + projectRoot);

      try {
        if (agentCtx.tools && typeof agentCtx.tools.restrict === 'function') {
          /*
           * ★★★ 2026-10-28 改：**放上网 + 文件读写，挡掉 shell 与跨会话能力**
           *
           * 用户原话：「不要有跨任务的知识库检索/历史会话搜索等；但是要保留网络能力和
           * 文件读写能力，毕竟 deepseek 不是影视专用大模型，很多知识需要学习/总结成
           * 文件或 skill」「但也一定不要有完整的 shell 能力等命令能力，要不然容易给自己搞坏」。
           *
           * `allow` 是"只保留" ⇒ 名单即白名单：
           *   · 留：片场 8 把（preset 另挂 read/write/edit/read_image/glob/grep
           *         与 web_search/web_fetch —— 它们是 scoped 注册，allow 挡不住也不用挡）
           *   · 挡：bash / pwsh（命令行）、str_replace_editor（编辑口也一并从简）
           *          skill（跨会话技能库）、kb_* / session_search（跨任务记忆）
           *          subagent / workflow / jobs / schedule / goal / plan / todo …
           *
           * 写文件由沙箱兜底：`sandbox-policy` 的 workspace-write 只允许写会话 cwd
           * （= 片库根 `roots[0]`，例如 <片库根>）之下 —— 出不了片库，但片库内
           * 仍是"所有片子都能写"，所以要靠宪法规则再收一层（只写自己这部片、不碰 `.film/`）。
           * 读不限（DSH 的 fs 读不设围栏）。shell 不给，所以没有"整台机器随便动"的能力。
           */
          /*
           * 名单里只要有一个**不存在**的名字，restrict 整体抛错（unknown names fail），
           * 于是一把都限制不住。所以失败时退回 8 把，并**明确记下来**。
           */
          /*
           * ★ 2026-10-28 实测定论：**preset 模式下不要 restrict。**
           *
           * preset 的子插件（tool-fs/tool-web）是在 setup **之后**才挂上来的，
           * 而 restrict 在 setup 里执行时它们还是"未知名字" ⇒ 整个 allow 抛错，
           * 退回"只留 8 把"⇒ 后到的 fs/web 正好被这份限制挡在门外
           * （实测：模型只收到 8 把，日志里 unknown tools read/write/…）。
           *
           * 现在工具集**由 preset 的插件列表决定**：preset 只挂
           * tool-fs / tool-fs-search / tool-web（+ time-context），
           * 加上插件自己注册的 8 把 —— 没有 bash / pwsh / skill / kb / session，
           * 不需要（也不该）再用 restrict 去筛。
           * 只有没配 preset 的旧模式才走 restrict。
           */
          if (preset) {
            log('★ preset 模式：工具集由 preset 决定（8 片场 + 文件 6 + 上网 2），跳过 restrict');
          } else {
            try {
              agentCtx.tools.restrict({ allow: AGENT_ALLOWED_TOOLS });
              log('★ 已 restrict：全局工具只剩片场 ' + AGENT_ALLOWED_TOOLS.length + ' 把');
            } catch (e) {
              log('✗ restrict 失败（名单里有不存在的名字？）: '
                + String((e && e.message) || e).slice(0, 300));
              agentCtx.tools.restrict({
                allow: ['filmflow_board', 'filmflow_node', 'filmflow_propose', 'filmflow_sync',
                  'filmflow_search', 'filmflow_apply', 'filmflow_set_media', 'filmflow_templates',
                  'filmflow_read', 'filmflow_write', 'filmflow_web',
                  'filmflow_model_guide'],
              });
              log('★ 已 restrict：只剩片场 12 把（同名单，只保证不抛）');
            }
          }

          /*
           * ★★ **把"它实际剩下什么工具"打出来** —— 这是"限制死了吗"的唯一硬证据。
           *
           * 不再靠"我以为限制过了"（那个错我今天犯过：名单里混进不存在的名字，
           * 整份 restrict 静默失效，而我只 log 了一行就继续跑）。
           */
          try {
            const t = agentCtx.tools;
            let names = null;
            for (const fn of ['schemas', 'sdkSchemas', 'wireSchemas']) {
              if (typeof t[fn] !== 'function') continue;
              try {
                const r = t[fn]();
                const arr = Array.isArray(r) ? r : r && Array.isArray(r.tools) ? r.tools : null;
                if (arr) {
                  names = arr.map((x) => (x && (x.name || (x.function && x.function.name))) || '?');
                  break;
                }
              } catch {
                /* 换下一个 */
              }
            }
            if (names) log('  它实际拿到的工具（' + names.length + ' 个）: ' + names.join(', '));
            else log('  （拿不到工具清单 —— schemas/view 的形状跟我猜的不一样）');
          } catch (e) {
            log('  读工具清单抛: ' + String((e && e.message) || e).slice(0, 120));
          }
        }
      } catch (e) {
        // ★ 这个错误里带着**真实工具表** —— 一抛就说明名单里有不存在的名字
        log('✗✗ restrict 失败（名单里有不存在的名字？）: ' + String((e && e.message) || e).slice(0, 900));
      }

      /*
       * ══ ★★★ 把「片场宪法」注册成这个 agent 的**完整**系统提示词 ══
       *
       * 用户 2026-10-19 让我分析《测试》那个 agent：「它对自己的职责 / 整个工具的用途 /
       * 设计理念都并不太了解」。根因是：
       *
       * **它收到的是 DSH 默认的 coding-agent 系统提示词。** 实测（解会话事件日志）：
       *   · 系统提示词 3392 字符，开头是 `You are a coding agent powered by the deepseek-flash model.`
       *   · 里面写着「全局记忆使用规则 / kb_search / session_search」—— **它没有那些工具**
       *     （它自己的 reasoning：I don't have kb_search tool in my function list!）
       *   · 关于片子、工序、两条硬规矩：「片场」0 次、"AGENTS.md" 0 次、「两条硬规矩」0 次
       *   · `<片库根>\AGENTS.md` **从头到尾一次都没注入过**
       *     （注入标记 `Instructions from` × 0；而对照的主会话里是 × 1）
       *
       * 为什么 AGENTS.md 没进来：它靠 `dsh-agent-instructions` 在**会话首次请求**注入一次，
       * 而当时用的 preset 明确写了 `suppressedContextSources: [agent-instructions, skill-catalog]`
       * ⇒ 从第一步起就被抑制，且**永不补发**。
       *
       * 为什么不用 agent preset：**web profile 里没有 agent preset 注册表** ——
       * 它的 `cordis.patch.yml` 搜 `dsh-agent-preset` 零匹配，`meta.agentPreset` 没人接。
       * （`liangshen` 只存在于 dsh-tui 那个 profile 的 node_modules 里。）
       *
       * 所以走设计文档早就写过的正路：**`setup(agentCtx)` 里注册 prompt section**。
       * 做法照抄 `@deepseek-ai/dsh-persona` 的源码。
       *
       * **实测（2026-10-19 独立探针）：系统提示词 2729 → 130 字符，
       * `coding agent` 消失、我们的内容在位。**
       *
       * 宪法正文在 `CONSTITUTION.md`（运行时读，**唯一真源**）—— 改文件 + 重启即可，不动代码。
       */
      try {
        const sp = agentCtx.systemPrompt;
        if (!sp || typeof sp.section !== 'function') {
          log('✗ agentCtx.systemPrompt.section 不可用 —— 宪法没注入，那个 agent 会退回默认提示词');
        } else {
          let text = '';
          let src = '';
          try {
            const file = join(dirname(fileURLToPath(import.meta.url)), 'CONSTITUTION.md');
            text = readFileSync(file, 'utf8');
            src = file;
          } catch (e) {
            log('✗ 读 CONSTITUTION.md 失败: ' + String((e && e.message) || e).slice(0, 160));
          }
          if (text.trim()) {
            const order =
              typeof sp.getSectionOrder === 'function' ? sp.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX') : 0;
            sp.section({
              name: 'deployment:persona-prefix',
              order,
              text,
              complete: true, // ★ 成为唯一段落 ⇒ 抑制 DSH 默认那套身份 / 工具指南 / 记忆规则
            });
            if (typeof sp.suppressRuntimeContext === 'function') sp.suppressRuntimeContext();
            log('★★ 片场宪法已注入（' + text.length + ' 字符，来自 ' + src + '）');
          }
        }
      } catch (e) {
        log('✗✗ 注入片场宪法抛: ' + String((e && e.message) || e).slice(0, 400));
      }
    },
  };

  /*
   * ★★ **优先 resume** —— 把这个项目**以前那个会话接回来**。
   *
   * 用户 2026-10-16：「为什么我重新打开，以前的会话就没有了？」
   * 因为原来每次都用新的时间戳 sessionId。现在 sessionId 稳定了，
   * 重启之后 `resume` 就能把持久化的那个会话重新打开 —— 对话、上下文都还在。
   *
   * `dsh-agent/lib/types/index.d.ts:184` 的原文：
   *   `resume(ownerCtx, options): Promise<AgentHandle>`
   *   "Resume an agent on a persisted session. … opens the persisted session for write,
   *    reads and repairs the log, publishes it …"
   *   并且 **"must be called after `ctx.sessionPersistence` exists"** ——
   *   所以 `inject` 里加了 `sessionPersistence`。
   *
   * resume 失败（第一次跑、会话不存在、持久化层没装）就退回 createAgent ✓
   */
  let handle = null;
  let how = '';
  if (!firstRun && typeof fac.resume === 'function') {
    try {
      handle = await fac.resume(ctx, { resumeSessionId: stableId, ...sharedOpts });
      how = 'resume（接回了老会话）';
    } catch (e) {
      const msg = String((e && e.message) || e);
      log('resume 没成：' + msg.slice(0, 260));
      if (/unknown to this harness|not marked ignorable/i.test(msg)) {
        log('⇒ 这份会话被别的事件类型挡住了（见 side-answer 那条）。**保留原文件，不覆盖。**');
      }
    }
  }
  if (!handle) {
    /*
     * ★ **撞到"已存在"就换 id，并把 session.json 改指过去。**
     *
     * 用户 2026-10-16：「为什么又没有回复？」—— trace 原文：
     *     resume 没成：contains "side-answer/interjection"（会话读不回来）
     *     ✗ 叫醒 agent 失败: SessionAlreadyExistsError: session "session-…" already exists
     *
     * 这是**我自己造的死锁**：v52 把 fallback 改成"resume 失败也用同一个 id"，
     * 于是会话文件在、但读不回来时 —— resume 失败 ✗，create 也失败 ✗
     * ⇒ 那个项目**永远起不了 agent** ⇒ 不回复 ✓
     *
     * 修：create 撞"已存在"⇒ 换一个新 id 再 create，**并把 .film/session.json
     * 改指新 id** ✓ —— 于是"一个项目只有一个当前会话 id"这条仍然成立 ✓，
     * 而读不回来的老文件**原地留着**（哪天能读了还能捞）✓
     */
    const mk = (id) =>
      fac.createAgent(ctx, { sessionId: id, ...sharedOpts });
    try {
      handle = await mk(stableId);
      how = firstRun ? 'createAgent（这个项目第一次开）' : 'createAgent（原 id 重建）';
    } catch (e) {
      const msg = String((e && e.message) || e);
      if (/already exists/i.test(msg)) {
        stableId = 'session-' + randomUUID();
        handle = await mk(stableId);
        how = 'createAgent（原 id 读不回来 ⇒ 换新 id ' + stableId + '）';
        log('⇒ 用新 id 起了 agent，并把 .film/session.json 改指它');
      } else {
        throw e;
      }
    }
    // ★ 把 id 存进项目目录 —— 之后它跟着项目走，路径变了也不断
    try {
      mkdirSync(join(projectRoot, '.film'), { recursive: true });
      writeFileSync(sessFile, JSON.stringify({ sessionId: stableId, at: new Date().toISOString() }, null, 2));
      log('★ 会话 id 已存进 .film/session.json（以后跟着项目走，搬家/改名都不会断）');
    } catch (e) {
      log('写 .film/session.json 失败: ' + String((e && e.message) || e).slice(0, 140));
    }
  }
  log('会话 id = ' + stableId + '　方式 = ' + how + '　（重启后还是同一个 id）');

  const rec = { handle, busy: false, startedAt: new Date().toISOString() };
  agentRuns.set(key, rec);
  log(
    '已为项目起了一个 agent：' +
      projectRoot +
      '　agent=' +
      typeof handle.agent +
      '　followup=' +
      typeof (handle.agent && handle.agent.followup),
  );
  return rec;
}

/**
 * 给某个项目的 agent 送一条消息（叫醒它）。
 * **fire-and-forget** —— 不 await，不阻塞用户的保存动作。
 */
function wakeAgent(ctx, projectRoot, cwd, text, log, opts) {
  // silent：懒唤醒（只是接回会话，不是叫它干活）—— 不记进 feed，免得污染对话记录
  if (!opts || !opts.silent) pushFeed(projectRoot, 'plugin', text);
  (async () => {
    try {
      const rec = await ensureAgent(ctx, projectRoot, cwd, log);
      if (!rec) return;
      const a = rec.handle.agent;

      /*
       * `followup(message: UserMessage)` —— UserMessage 的确切形状我没验过，
       * 所以两种都试。哪个成，trace 里就记哪个。
       */
      /*
       * `followup(message: UserMessage)` —— 查 `dsh-llm/lib/types/message.d.ts`：
       *   `UserMessage extends MessageBase { role:'user' }`
       *   `MessageBase { id, content: readonly ContentBlock[], source }`
       *   `MessageSourceMap.user = { kind: 'user' }`
       * ⇒ 完整的那种排第一（缺 id/source 会被静默丢掉，就是这个 bug）。
       */
      const tries = [
        ['完整 UserMessage（id + role + content 块 + source）', () => a.followup(userMessage(text))],
        ['只有 role+content', () => a.followup({ role: 'user', content: [{ type: 'text', text }] })],
        ['纯字符串', () => a.followup(text)],
      ];
      let ok = '';
      let lastErr = '';
      for (const [name, fn] of tries) {
        try {
          fn();
          ok = name;
          break;
        } catch (e) {
          lastErr = name + ': ' + String((e && e.message) || e);
        }
      }
      if (ok) log('已叫醒 agent（followup 用 ' + ok + ' 形式）');
      else log('✗ 三种 followup 形式都失败：' + lastErr);

      rec.busy = true;
      /*
       * ⚠️ 原来这里只信 `whenIdle()`。实测：不传 agentPreset 时它 **6 毫秒就返回**，
       *    看起来"干完了"，其实那次 turn 什么都没干 —— **光看 whenIdle 会骗人**。
       *    所以加一个 12 秒后的复核：看 status、看会话里到底有没有消息。
       */
      if (typeof a.whenIdle === 'function') {
        a.whenIdle()
          .then(() => {
            rec.busy = false;
            log('whenIdle 返回');
          })
          .catch(() => {
            rec.busy = false;
          });
      }
      setTimeout(() => {
        try {
          const st = JSON.stringify(a.status || '');
          const msgs = typeof a.session?.deriveMessages === 'function' ? a.session.deriveMessages() : [];
          const nAsst = (msgs || []).filter((m) => m && m.role === 'assistant').length;
          let inboxInfo = '';
          try {
            const ib = a.inbox;
            if (ib) {
              const k = Object.keys(ib).filter((x) => x[0] !== '_');
              const pend = typeof ib.pending === 'function' ? ib.pending() : undefined;
              inboxInfo =
                '　inbox 键=[' +
                k.slice(0, 8).join(',') +
                ']' +
                (pend !== undefined ? ' pending=' + JSON.stringify(pend).slice(0, 120) : '');
            } else {
              inboxInfo = '　inbox=无';
            }
          } catch (e) {
            inboxInfo = '　读 inbox 抛: ' + String((e && e.message) || e).slice(0, 60);
          }
          log(
            '12 秒复核：status=' +
              st +
              '　会话消息 ' +
              (msgs || []).length +
              ' 条（其中 assistant ' +
              nAsst +
              ' 条）' +
              inboxInfo,
          );
          if (!(msgs || []).length) {
            log(
              '⇒ 会话里一条消息都没有 —— 那条 followup 没进会话。' +
                '要么消息形状还不对（缺 id/source？），要么这个 run 根本没驱动起来。',
            );
          }

          /*
           * ★★★ **量出模型实际收到的工具清单** —— 唯一的 ground truth。
           *
           * 为什么不能信 `agentCtx.tools.schemas()`：实测（2026-10-16 08:35）
           * 它返回的清单里 `kb_*` / `wps_*` / `practice_*` 一个不少 ——
           * 但那**可能只是因为 `schemas()` 给的是全局注册表、不是限制之后的视图** ✗
           * 我没法用它判断 `restrict` 到底生没生效。
           *
           * 而 `request/header` 事件里带着**真正发给模型的那些工具** ✓ ——
           * 那才是"它手里有什么"的事实。
           */
          try {
            const evs = typeof a.session?.snapshotEvents === 'function' ? a.session.snapshotEvents() : [];
            const rh = (evs || []).filter((ev) => String(ev && ev.type) === 'request/header').pop();
            if (!rh || !rh.data || !rh.data.header) {
              log('  （没找到 request/header 事件）');
            } else {
              const h = rh.data.header;
              const keys = Object.keys(h);
              log('  request/header 的键 = [' + keys.join(', ') + ']');
              // 找那个"工具数组"：任意一个元素带 name 的数组
              let found = null;
              for (const k of keys) {
                const v = h[k];
                if (Array.isArray(v) && v.length && v[0] && typeof v[0] === 'object' && v[0].name) {
                  found = { key: k, names: v.map((x) => x.name) };
                  break;
                }
              }
              if (found) {
                log('★★★ **模型实际收到的工具**（' + found.names.length + ' 个，字段 ' + found.key + '）: ' + found.names.join(', '));
              } else {
                log('  没在 header 里找到工具数组；各字段类型: ' + keys.map((k) => k + ':' + (Array.isArray(h[k]) ? 'array(' + h[k].length + ')' : typeof h[k])).join(' '));
              }
            }
          } catch (e) {
            log('  读 request/header 抛: ' + String((e && e.message) || e).slice(0, 140));
          }
        } catch (e) {
          log('12 秒复核抛: ' + String((e && e.message) || e));
        }
      }, 12000);
    } catch (e) {
      log('✗ 叫醒 agent 失败: ' + String((e && e.stack) || e));
    }
  })();
}

/**
 * 插件叫醒 Agent 时说的那段话。
 *
 * 用户的设计：**「插件会先向 Agent 发送一次调用」**。这就是那次调用。
 * 它必须自足 —— 那个 Agent 不知道刚才发生了什么，也不知道规矩（虽然 AGENTS.md
 * 会注入，但这里点明一次更稳）。
 */
function composeWake(project, changedDesc, staleList) {
  const L = [];
  L.push('【片场插件】用户在画布上改了一处内容并保存了。');
  L.push('');
  L.push('项目：' + project.title + '（' + project.root + '）');
  L.push('改的是：' + changedDesc);
  if (staleList.length) {
    L.push('');
    L.push('受影响的节点（' + staleList.length + ' 个）：');
    for (const x of staleList) {
      // 带上"为什么过期"（哪个上游改了）—— agent 就不用再猜，直接能判断方向
      const why = x.staleWhy ? '　← ' + x.staleWhy : '';
      L.push('  · ' + (x.no ? x.no + ' ' : '') + x.title + (x.group ? '　[组 ' + x.group + ']' : '') + why);
    }
  } else {
    L.push('没有下游节点受影响。');
  }
  L.push('');
  L.push('按规矩办：');
  L.push('1. 先调 filmflow_board 看全貌（它列出过期节点，也写着"因为哪个上游改的"）。');
  L.push('2. 逐个判断：**没有内容要改就直接 filmflow_sync 对齐**（别让过期挂着，也别问用户）。');
  L.push('3. **确实要改内容**：用 filmflow_propose 提交你的判断、打算改成什么、为什么；');
  L.push('   你手里没有能写文件的工具，落盘由用户在图上点确认时由宿主执行。');
  L.push('4. 用户的改动可能不清楚甚至不合理 —— 拿不准就在提案的 why 里直说，别猜着改。');
  L.push('5. 方向：**上游改了 → 下游可以直接改**（改完 sync + 一句变更摘要）；');
  L.push('   **下游改了 → 要改成上游，必须先问**（先用 filmflow_search 查清影响面再请示）。');
  return L.join('\n');
}

/**
 * 这个项目的 agent 现在什么状态（给界面上那个「暂停」条用）。
 *
 * 用户的设计：「**插话都不用，但是我可以暂停。**」
 */
function agentStatusOf(projectRoot) {
  const rec = agentRuns.get(String(projectRoot).toLowerCase());
  if (!rec || !rec.handle || !rec.handle.agent) return { running: false, busy: false, status: '' };
  /*
   * ★★ **以 agent 的真实状态为准，不信那个手工维护的 rec.busy。**
   *
   * 用户 2026-10-16：「好像有些时候明明在运行，它却显示待命」
   *
   * 成因：rec.busy 是**手工设/清**的（followup 时置 true、几个地方置 false）——
   * 它跟现实会脱节 ✗：turn 还在跑，而某条路径已经把它清成 false，界面就显示「待命」✗
   *
   * 而 agent **自己就有真实状态**。实测（2026-10-16 从 /filmflow/state 读到）：
   *     status = "\"idle\""     ← ★ 注意：原来用 JSON.stringify 包了一层引号 ✗
   * 所以：① 别包引号，直接读原始值 ✓  ② 用它判断忙不忙 ✓
   */
  let st = '';
  let readOk = false;
  try {
    const raw = rec.handle.agent.status;
    st = raw == null ? '' : String(raw);
    readOk = true;
  } catch (e) {
    st = '';
  }
  const realBusy = /running|busy|working|thinking/i.test(st);
  // 读到了真实状态就用它；读不到才退回那个手工标志
  const busy = readOk && st ? realBusy : !!rec.busy;
  return { running: true, busy, status: st, startedAt: rec.startedAt || '', flagBusy: !!rec.busy };
}

/** 暂停这个项目的 agent（中断当前 turn，保留队列）。 */
function pauseAgent(projectRoot, log) {
  const rec = agentRuns.get(String(projectRoot).toLowerCase());
  if (!rec || !rec.handle || !rec.handle.agent) {
    log('没有在跑的 agent，暂停无意义');
    return { ok: false, error: '这个项目还没有 agent 在跑' };
  }
  const a = rec.handle.agent;
  if (typeof a.cancel !== 'function') return { ok: false, error: 'agent.cancel 不是函数' };

  /*
   * `cancel(cause, options)` —— `AgentCancelCause` 的确切形状我没验过，
   * 所以几种都试，哪个成记哪个（跟 followup 一样的打法）。
   */
  const tries = [
    ['string', () => a.cancel('user', { keepInbox: true })],
    ['object', () => a.cancel({ reason: 'user' }, { keepInbox: true })],
    ['bare', () => a.cancel({ keepInbox: true })],
  ];
  let ok = '';
  let lastErr = '';
  for (const [name, fn] of tries) {
    try {
      fn();
      ok = name;
      break;
    } catch (e) {
      lastErr = name + ': ' + String((e && e.message) || e);
    }
  }
  rec.busy = false;
  if (ok) {
    log('已暂停 agent（cancel 用 ' + ok + ' 形式）');
    return { ok: true, how: ok };
  }
  log('✗ 三种 cancel 形式都失败：' + lastErr);
  return { ok: false, error: lastErr };
}

/**
 * 独立应用的第一页 —— **项目资产**（用户 2026-10-15 的设计）。
 *
 *   「做一个独立的UI……第一页是项目资产以及新建项目，以后在这一页还可以拓展其他资产管理。」
 *
 * 这是一个**自足的页面**（原生 JS，不用 React、不依赖 DSH 的浏览器运行时）——
 * 因为它要能在独立窗口里打开。数据全走插件自己的 HTTP 路由。
 *
 * ⚠️ 目前"点进项目"是**跳到 DSH 里的工序页**，不是内嵌大画布。
 *    内嵌画布要么把画布用原生 JS 重写一遍，要么逆向 `__DSH_BOOT__` 那套模块清单 ——
 *    两条都是独立的大工程，没做。
 */
function appPageHtml(token) {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>片场 · 项目资产</title>
<style>
  :root{--bg:#fbfbfc;--fg:#1b1c1f;--dim:rgba(27,28,31,.55);--line:rgba(0,0,0,.14);
        --blue:rgba(37,99,196,.9);--warn:#b26a00}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);
       font:14px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
  header{display:flex;align-items:baseline;gap:12px;padding:22px 28px 10px}
  h1{margin:0;font-size:22px;font-weight:600;letter-spacing:.5px}
  header .sub{color:var(--dim);font-size:12px}
  .wrap{padding:8px 28px 40px;max-width:1100px}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:14px;margin-top:14px}
  .card{border:1px solid var(--line);border-radius:10px;padding:14px;cursor:pointer;
        background:rgba(0,0,0,.025);transition:border-color .12s,background .12s;text-decoration:none;color:inherit;display:block}
  .card:hover{border-color:var(--blue);background:rgba(74,143,231,.08)}
  .card h3{margin:0 0 6px;font-size:15px;font-weight:600}
  .card .path{font:11px/1.5 ui-monospace,Consolas,monospace;color:var(--dim);word-break:break-all}
  .card .tags{display:flex;gap:6px;flex-wrap:wrap;margin-top:9px}
  .tag{font-size:11px;padding:1px 7px;border-radius:4px;border:1px solid var(--line);color:var(--dim)}
  .tag.warn{border-color:var(--warn);color:var(--warn)}
  .tag.ok{border-color:rgba(63,169,106,.8);color:rgba(63,169,106,.95)}
  .new{border-style:dashed;display:flex;align-items:center;justify-content:center;
       min-height:104px;color:var(--dim);font-size:13px}
  .row{display:flex;gap:8px;margin-top:18px;align-items:center}
  input{background:rgba(0,0,0,.05);border:1px solid var(--line);color:var(--fg);
        border-radius:6px;padding:7px 10px;font:inherit;font-size:13px;min-width:240px}
  button{background:rgba(74,143,231,.22);border:1px solid var(--blue);color:var(--fg);
         border-radius:6px;padding:7px 16px;font:inherit;font-size:13px;cursor:pointer}
  button[disabled]{opacity:.4;cursor:default}
  #msg{margin-top:12px;font-size:12px;color:var(--dim);white-space:pre-wrap}
  header .sp{flex:1 1 auto}
  /* ★ 全局设置弹窗 */
  #cfgbox{position:fixed;left:0;top:0;right:0;bottom:0;background:rgba(0,0,0,.32);
          display:flex;align-items:center;justify-content:center;z-index:9999}
  .cfgm{background:#fff;border:1px solid rgba(0,0,0,.14);border-radius:10px;
        padding:18px 20px;min-width:420px;max-width:540px;box-shadow:0 10px 40px rgba(0,0,0,.18);
        color:#1b1c1f;font-size:13px}
  .cfgm h3{margin:0 0 14px;font-size:15px}
  .cfgm label{display:block;font-size:12px;color:rgba(27,28,31,.55);margin:10px 0 4px}
  .cfgm input{width:100%;box-sizing:border-box;padding:7px 9px;border:1px solid rgba(0,0,0,.14);
              border-radius:6px;background:rgba(0,0,0,.03);color:#1b1c1f;font-size:13px;
              font-family:ui-monospace,Consolas,monospace}
  .cfgm input:focus,.cfgm select:focus{outline:none;border-color:rgba(37,99,196,.9)}
  .cfgm select{width:100%;box-sizing:border-box;padding:7px 9px;border:1px solid rgba(0,0,0,.14);
               border-radius:6px;background:rgba(0,0,0,.03);color:#1b1c1f;font-size:13px}
  .cfghint{font-size:11.5px;color:rgba(27,28,31,.55);margin-top:6px;line-height:1.6;white-space:pre-wrap}
  .cfgrow{display:flex;gap:8px;margin-top:14px}
  .cfgm .btn{display:inline-block;padding:6px 14px;border:1px solid rgba(0,0,0,.14);
             border-radius:6px;cursor:pointer;font-size:12.5px;background:rgba(0,0,0,.03)}
  .cfgm .btn.p{background:rgba(74,143,231,.22);border-color:rgba(37,99,196,.9)}
  .cfgmsg{margin-top:10px;font-size:12px;min-height:16px;white-space:pre-wrap}
  .cfgmsg.err{color:#c0392b}
  .cfgmsg.ok{color:#1e7d32}
  .err{color:#e5707e}
</style></head><body>
<header>
  <h1>片场</h1>
  <span class="sub">影片制作工序工作台 · 项目资产</span>
  <span class="sp"></span>
  <button id="cfg" style="display:none;padding:5px 12px;font-size:12px">⚙ 设置</button>
</header>
<!-- ★ 全局设置弹窗 —— 必须放在脚本标签之前（脚本里 getElementById 要用它） -->
<div id="cfgbox" style="display:none">
  <div class="cfgm">
    <h3>设置</h3>
    <label>API key</label>
    <input id="cfgkey" type="password" placeholder="sk-…（留空表示不改）">
    <label>协议</label>
    <select id="cfgapi">
      <option value="anthropic-messages">anthropic-messages（DeepSeek / Claude 那类）</option>
      <option value="openai-completions">openai-completions（OpenAI / vLLM / 大多数自建）</option>
      <option value="openai-responses">openai-responses</option>
    </select>
    <label>Base URL（留空 = 官方 https://api.deepseek.com/anthropic）</label>
    <input id="cfgbase" placeholder="https://api.deepseek.com/anthropic　或 https://你的网关/v1">
    <label>模型名（留空 = deepseek-flash）</label>
    <input id="cfgmodel" placeholder="deepseek-flash">
    <div class="cfghint" id="cfginfo">读取中…</div>
    <div class="cfgrow">
      <span class="btn p" id="cfgsave">保存</span>
      <span class="btn" id="cfgtest">测试连接</span>
      <span class="btn" id="cfgclose">关闭</span>
    </div>
    <div class="cfgmsg" id="cfgmsg"></div>
  </div>
</div>
<div class="wrap">
  <div class="grid" id="grid"></div>
  <div class="row">
    <input id="newName" placeholder="新片名，例如：夜班">
    <button id="mk">新建项目</button>
  </div>
  <div id="msg"></div>
</div>
<script>
var TOKEN = ${JSON.stringify(token || '')};
function q(url){
  return fetch(url, {headers:{'Accept':'application/json'}}).then(function(r){return r.json()});
}
function render(st){
  var g = document.getElementById('grid');
  g.innerHTML = '';
  (st.projects||[]).forEach(function(p){
    var stale = 0, total = 0;
    (p.stages||[]).forEach(function walk(s){
      total++;
      if (s.stale === 'stale' || s.stale === 'unknown') stale++;
      (s.children||[]).forEach(walk);
    });
    var a = document.createElement('a');
    a.className = 'card';
    a.href = '/filmflow/project?root=' + encodeURIComponent(p.root || '');
    var tags = '<span class="tag">' + (p.stages||[]).length + ' 道工序</span>';
    if (p.pendingProposals) tags += '<span class="tag warn">' + p.pendingProposals + ' 条待确认提案</span>';
    if (stale) tags += '<span class="tag warn">' + stale + ' 个节点待处理</span>';
    else tags += '<span class="tag ok">没有待处理</span>';
    if (p.agent && p.agent.running) tags += '<span class="tag ok">Agent 在跑</span>';
    a.innerHTML = '<h3>' + (p.title||p.id||'（未命名）') + '</h3>' +
                  '<div class="path">' + (p.root||'') + '</div>' +
                  '<div class="tags">' + tags + '</div>';
    g.appendChild(a);
  });
  var n = document.createElement('div');
  n.className = 'card new';
  n.textContent = '＋ 在上面输入片名，新建一个项目';
  g.appendChild(n);
}
function load(){
  q('/filmflow/state').then(render).catch(function(e){
    document.getElementById('msg').className = 'err';
    document.getElementById('msg').textContent = '取状态失败：' + e.message;
  });
}
document.getElementById('mk').addEventListener('click', function(){
  var name = document.getElementById('newName').value.trim();
  var msg = document.getElementById('msg');
  if (!name) { msg.className='err'; msg.textContent='先写个片名'; return; }
  this.disabled = true;
  var self = this;
  fetch('/filmflow/newproject', {method:'POST', headers:{'Content-Type':'application/json','x-filmflow-token':TOKEN},
       body: JSON.stringify({ title: name })})
    .then(function(r){ return r.json().then(function(j){ return {ok:r.ok, j:j}; }); })
    .then(function(x){
      self.disabled = false;
      if (!x.ok || !x.j.ok) throw new Error(x.j.error || '失败');
      msg.className=''; msg.textContent = '已创建：' + x.j.root;
      document.getElementById('newName').value = '';
      load();
    })
    .catch(function(e){ self.disabled=false; msg.className='err'; msg.textContent = String(e.message||e); });
});
load();

/* ══ ★ 全局设置（只有独立版有）══════════════════════════════════════════════
 *  API key 是**这个程序的**配置，不是某部片的 ⇒ 放在首页（资产页）✓
 *  （原来放在画布页里，位置就错了；而且弹窗 DOM 在 <script> 之后 ⇒
 *    getElementById 拿到 null ⇒ 按钮永远没有处理器 ⇒ "摆设" ✗）
 */
(function(){
  var btn = document.getElementById('cfg');
  var box = document.getElementById('cfgbox');
  var key = document.getElementById('cfgkey');
  var baseEl = document.getElementById('cfgbase');
  var apiEl = document.getElementById('cfgapi');
  var modelEl = document.getElementById('cfgmodel');
  var info = document.getElementById('cfginfo');
  var msg = document.getElementById('cfgmsg');
  if (!btn || !box || !key || !info || !msg) return;

  function say(t, cls){ msg.className = 'cfgmsg' + (cls ? ' ' + cls : ''); msg.textContent = t || ''; }

  function loadCfg(){
    fetch('/filmflow/config').then(function(r){ return r.json(); }).then(function(j){
      btn.style.display = '';
      key.value = '';
      if (!key.value) key.placeholder = j.hasKey ? ('当前：' + j.keyMasked + '（留空表示不改）') : 'sk-…';
      baseEl.value = j.baseUrl || '';
      modelEl.value = j.model || '';
      apiEl.value = j.api || 'anthropic-messages';
      info.textContent =
        '当前：' + (j.hasKey ? 'key ' + j.keyMasked : '✗ 还没配 key') + '　' +
        '端点 ' + (j.baseUrl || '官方默认') + '　模型 ' + (j.model || 'deepseek-flash') + '\\n' +
        '片子目录：' + (j.roots || []).join('  ;  ') + '　端口：' + j.port + '\\n' +
        '⚠️ 要 Anthropic 兼容的端点（不是 OpenAI 那种 /v1/chat/completions）。' +
        '官方是 https://api.deepseek.com/anthropic。填错会报 HTTP_404。保存后立刻生效。';
    }).catch(function(){ btn.style.display = 'none'; });
  }
  loadCfg();

  btn.onclick = function(){ box.style.display = 'flex'; key.focus(); say(''); };
  document.getElementById('cfgclose').onclick = function(){ box.style.display = 'none'; };
  box.onclick = function(e){ if (e.target === box) box.style.display = 'none'; };
  document.addEventListener('keydown', function(e){ if (e.key === 'Escape') box.style.display = 'none'; });

  document.getElementById('cfgsave').onclick = function(){
    /* 三项都只在"填了"的时候提交 —— 留空表示不动这一项 ✓ */
    var payload = {};
    var v = String(key.value || '').trim();
    if (v) payload.apiKey = v;
    payload.baseUrl = String(baseEl.value || '').trim();
    payload.model = String(modelEl.value || '').trim();
    payload.api = String(apiEl.value || 'anthropic-messages');
    if (!v && !payload.baseUrl && !payload.model) { say('三项都空着，没什么可保存的', 'err'); return; }
    say('保存中…');
    fetch('/filmflow/config', {method:'POST',
      headers:{'Content-Type':'application/json','x-filmflow-token':TOKEN},
      body: JSON.stringify(payload)}
    ).then(function(r){ return r.json().then(function(j){ return {ok:r.ok, j:j}; }); })
     .then(function(x){
       if (!x.ok || !x.j.ok) throw new Error(x.j.error || '失败');
       key.value = '';
       say('✓ 已保存 —— 下一次叫醒 agent 就用新 key', 'ok');
       loadCfg();
     }).catch(function(e){ say('保存失败：' + e.message, 'err'); });
  };

  document.getElementById('cfgtest').onclick = function(){
    say('真跑一次很小的任务，验证这把 key 能用…（最多 60 秒）');
    fetch('/filmflow/config/test', {method:'POST',
      headers:{'Content-Type':'application/json','x-filmflow-token':TOKEN},
      body: JSON.stringify({})}
    ).then(function(r){ return r.json().then(function(j){ return {ok:r.ok, j:j}; }); })
     .then(function(x){
       if (!x.ok || !x.j.ok) throw new Error(x.j.error || '失败');
       say('✓ 能用。它回了：' + (x.j.reply || '（空）'), 'ok');
     }).catch(function(e){ say('✗ ' + e.message, 'err'); });
  };
})();

/* ── 把自己报的错送回宿主 ────────────────────────────────────────────────
 *  页面空白的时候，浏览器控制台里的东西我在外面看不到 ⇒ 主动上报。
 */
window.addEventListener('error', function(ev){
  try {
    fetch('/filmflow/diag', {method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({
        msg: String((ev && ev.message) || '') + '  @ ' + String((ev && ev.filename) || '') + ':' + String((ev && ev.lineno) || ''),
        stack: String((ev && ev.error && ev.error.stack) || ''),
        src: 'window.onerror'
      })
    }).catch(function(){});
  } catch (e) {}
});
window.addEventListener('unhandledrejection', function(ev){
  try {
    fetch('/filmflow/diag', {method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ msg: 'unhandledrejection: ' + String((ev && ev.reason && ev.reason.message) || ev && ev.reason || ''), src: 'promise' })
    }).catch(function(){});
  } catch (e) {}
});

/* ── 独立版心跳 ──────────────────────────────────────────────────────────
 *  片场的独立进程靠它判断『还有人在看』：15 秒收不到就自己退出（关窗口 = 关服务）。
 *  DSH 插件版没有这个路由 ⇒ 先问 /filmflow/ping，不是 standalone 就完全不发。
 */
(function(){
  fetch('/filmflow/ping').then(function(r){ return r.json(); }).then(function(j){
    if (!j || j.plugin !== 'filmflow-standalone') return;
    var beat = function(){ fetch('/filmflow/keepalive', {method:'POST'}).catch(function(){}); };
    beat();
    setInterval(beat, 3000);
  }).catch(function(){});
})();
</script>
</body></html>`;
}

/*
 * 2026-10-29 用户决定：**撤掉 story/board 授权分组机制**。
 * 原来的 `.film/scope.json` + 组锁 +「一次任务只准动一组」全部移除；
 * 数据里的 `group` 字段保留兼容（不再读写、不再作为权限）。
 * 以后按实际需要再设计更有用的推进机制。
 */

/**
 * 独立应用的第二页 —— **大画布**（用户 2026-10-15 的设计）。
 *
 *   「点进项目之后就是一个大画布（画布），Agent 在左边栏默认占据小比例，剩下的都是画布。」
 *
 * ── 为什么用 flex 排树，而不是把 DSH 那版的绝对定位搬过来 ──────────
 *   DSH 那版画布是**手算坐标**的（`layout()` 递归 tidy-tree + 贝塞尔曲线）。
 *   搬到原生 JS 里意味着把 ~200 行坐标数学原样重写一遍 —— 那是最容易出 bug、
 *   也最花时间的部分。**这里改用 CSS flex 直接排横向树**：
 *   父节点在左，子节点一列在右，连接靠边框。看着就是一张横向画布，
 *   而**一行坐标计算都不需要**。外面套一层 transform 做拖动/缩放。
 *
 *   代价：没有曲线连接、节点不能自由摆位。**这是有意的取舍** ——
 *   先用可靠的方式把"大画布"给你，曲线那层之后再调。
 *
 * ── 编辑 ──────────────────────────────────────────────────────
 *   点节点 → 右侧出卡片：作用 + 正文（**一个 textarea**，存的是原始 markdown）
 *   ⚠️ 这里**没有**五种形态的编辑器 —— 那是 DSH 那版才有的。这一版是纯文本框，
 *      但**内容一个字不少**（写回走同一个 `/filmflow/edit`，只是不当结构化解析）。
 *      五种形态搬过来是下一步。
 */
function projectPageHtml(writeToken) {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>片场 · 画布</title>
<style>
  :root{--bg:#fbfbfc;--fg:#1b1c1f;--dim:rgba(27,28,31,.55);--line:rgba(0,0,0,.14);
        --blue:rgba(37,99,196,.9);--warn:#b26a00}
  *{box-sizing:border-box}
  html,body{height:100%;margin:0}
  body{background:var(--bg);color:var(--fg);font:14px/1.5 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;
       display:flex;overflow:hidden}
  /*
   * ══ 左侧 Agent 栏 —— 照搬 DSH 会话框（用户 2026-10-15：「可以基本照搬UI的，我比较习惯」）══
   *
   * 设计令牌全部来自 DSH 自己的设计系统（从 dsh-client-ui-chat / -conversation 的
   * bundle 里挖出来的真值，不是我自己配的颜色）：
   *
   *   LIGHT_BACKGROUND = #fff          （DSH 自己那个常量）
   *   用户气泡底  --dsw-specific-bubble        = deepseek-50  #edf3fe
   *   气泡高亮    --dsw-specific-bubble-highlight = deepseek-200 #d3e2ff
   *   圆角        radius-xl 20 / lg 16 / md 12 / sm 8 / xs 4
   *   侧栏底      neutral-bluish-50  #f9fafb      悬停 75 #f1f3f5    激活 100 #ebeef2
   *   主文字      #0f1115   次要 #61666b   三级 #81858c   caption #adb2b8
   *   边框        l1 #0000000a  l2 #0000001a  l3 #0000001f  l4 #00000029
   *   业务/链接   deepseek-500 #4176e6    警告 amber-500 #f59e0b   错误 red-600
   *
   * 结构也照搬它：转录是**阅读列**（chat-content-width），用户消息**右对齐气泡**
   * （原样式 .Sixlwa_userRow{flex-direction:column;align-items:flex-end}、
   *  .Sixlwa_userStack{max-width:min(content*.702, 82%)}），
   * 助手的回答**左对齐、不加气泡**（DSH 用 AssistantMarkdown 直接渲染 markdown），
   * 输入是一个**卡片**（composer-card = 内容宽 + 32px）。
   */
  #left{flex:none;width:340px;display:flex;flex-direction:column;min-height:0;
        border-right:1px solid var(--line);background:#f9fafb}
  #lhead{flex:none;display:flex;align-items:center;gap:8px;padding:9px 14px 4px;
         font-size:13px;font-weight:600;color:var(--fg);border-bottom:1px solid var(--line);
         flex-wrap:wrap}
  #lstatus{margin-left:auto;font-size:11px;font-weight:400;color:var(--dim);white-space:nowrap}
  /*
   * ★ 自检行单独占一行 —— 用户 2026-10-19 截图：它和标题挤在一行，
   *   把「片场助手」挤成了「片场助 手」✗。现在 flex:1 1 100% 强制换行，
   *   宽度不够就省略，绝不挤压标题 ✓
   */
  #ldiag{flex:1 1 100%;font-size:10.5px;line-height:1.4;color:#adb2b8;
         overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding-bottom:5px}
  #lfeed{flex:1 1 auto;overflow-y:auto;padding:12px 12px 4px;display:flex;flex-direction:column;gap:10px}
  /* 工具调用：一行灰色小字（照官方 UI 的 tool row 做法） */
  .lrow-tool{display:flex;align-items:baseline;gap:6px;font-size:12px;color:#8a8f96;
             padding:1px 2px;font-family:ui-monospace,Consolas,monospace}
  .lrow-tool .tico{font-size:11px;opacity:.8}
  .lrow-tool .tico.err{color:#c0392b;opacity:1}
  .lrow-tool .ttx{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}
  /* 系统提示：更淡 */
  .lrow-sys{font-size:11.5px;color:#adb2b8;padding:1px 2px;line-height:1.5}
  /* 用户消息：右对齐气泡（照 DSH 的 userRow/userStack） */
  .lrow-u{display:flex;flex-direction:column;align-items:flex-end;gap:4px;max-width:82%;align-self:flex-end}
  .lrow-u .bub{background:#edf3fe;border-radius:20px;padding:9px 14px;font-size:14px;line-height:1.55;
               white-space:pre-wrap;word-break:break-word;color:#0f1115}
  /* 助手回答：左对齐、裸 markdown（照 DSH 的 AssistantMarkdown） */
  .lrow-a{display:flex;flex-direction:column;align-items:flex-start;gap:4px}
  .lrow-a .md{font-size:14px;line-height:1.62;color:#0f1115;word-break:break-word;max-width:100%}
  .md p{margin:0 0 8px}.md p:last-child{margin-bottom:0}
  .md h1,.md h2,.md h3{font-size:14px;font-weight:600;margin:10px 0 6px}
  .md ul,.md ol{margin:0 0 8px;padding-left:20px}
  .md li{margin:2px 0}
  .md code{background:#f1f3f5;border-radius:4px;padding:1px 5px;font-size:12.5px;
           font-family:ui-monospace,Consolas,monospace}
  .md pre{background:#f9fafb;border:1px solid var(--line);border-radius:8px;padding:9px 11px;overflow-x:auto;margin:0 0 8px}
  .md pre code{background:none;padding:0}
  .md strong{font-weight:600}
  /* 思考链 —— 照官方 ReasoningRow：次要色 #81858c、默认折叠、点击展开 */
  .think{margin:0 0 7px;border-left:2px solid rgba(0,0,0,.12);padding-left:9px}
  .thinkh{font-size:11.5px;color:#81858c;cursor:pointer;user-select:none;display:flex;gap:7px;align-items:baseline}
  .thinkn{opacity:.6;font-size:10.5px}
  .thinkb{display:none;font-size:12.5px;line-height:1.6;color:#81858c;white-space:pre-wrap;
          margin-top:5px;max-height:260px;overflow-y:auto}
  .think.open .thinkb{display:block}
  /* 提案卡 —— 画在交互框里，不占画布（用户 2026-10-16） */
  .prop{border:1px solid rgba(240,160,60,.55);border-radius:10px;padding:9px 11px;
        background:rgba(240,160,60,.07);display:flex;flex-direction:column;gap:6px}
  .prop .ph{display:flex;gap:8px;align-items:baseline;font-size:12px;color:#b26a00;font-weight:600}
  .prop .ph b{color:#0f1115;font-weight:600}
  .prop .pw{font-size:12.5px;line-height:1.65;color:#43454a;white-space:pre-wrap;word-break:break-word}
  .prop .pf{display:flex;gap:8px}
  .md hr{border:none;border-top:1px solid var(--line);margin:10px 0}
  .md table{border-collapse:collapse;margin:0 0 8px;font-size:13px}
  .md th,.md td{border:1px solid var(--line);padding:3px 8px}
  /* 系统/插件的动作行：折叠成一行小字（照 DSH 的 context injection row / tool row） */
  .lrow-s{display:flex;align-items:baseline;gap:6px;font-size:11.5px;line-height:1.5;color:var(--dim);
          padding:1px 0}
  .lrow-s .dot{flex:none;width:5px;height:5px;border-radius:50%;background:#adb2b8;margin-top:5px}
  .lrow-s .tx{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer}
  .lrow-s.open .tx{white-space:pre-wrap}
  .lwho{font-size:10px;color:#adb2b8}
  /* 空态 */
  .lempty{font-size:12px;line-height:1.7;color:var(--dim);padding:6px 2px}
  /* 输入区：一个卡片（照 DSH 的 composer-card） */
  #lcomposer{flex:none;padding:8px 12px 12px}
  #lcard{border:1px solid rgba(0,0,0,.1);border-radius:16px;background:#fff;
         box-shadow:0 1px 2px rgba(0,0,0,.04);display:flex;flex-direction:column;
         transition:border-color .12s}
  #lcard:focus-within{border-color:rgba(65,118,230,.55)}
  #lsay{border:none;outline:none;background:none;color:#0f1115;resize:none;
        font:14px/1.55 inherit;padding:11px 13px 4px;min-height:46px;max-height:180px}
  #lsay::placeholder{color:#adb2b8}
  #lbar{display:flex;align-items:center;gap:8px;padding:4px 8px 7px 13px}
  #lhint{font-size:10.5px;color:#adb2b8;flex:1 1 auto}
  #lbusy{display:none;font-size:10.5px;color:#4176e6}
  #lcard.busy #lbusy{display:inline}
  #lcard.busy #lhint{display:none}
  #lsend{flex:none;border:none;border-radius:12px;padding:5px 15px;font:13px/1.4 inherit;
         cursor:pointer;background:#4176e6;color:#fff;transition:opacity .12s}
  #lsend:disabled{background:#ebeef2;color:#adb2b8;cursor:default}
  #lsend.stop{background:#fff;color:#0f1115;border:1px solid rgba(0,0,0,.17)}
  #right{flex:1 1 auto;display:flex;flex-direction:column;min-width:0;min-height:0}
  header{flex:none;display:flex;align-items:center;gap:12px;padding:9px 14px;border-bottom:1px solid var(--line)}
  header h1{margin:0;font-size:15px;font-weight:600}
  header .back{font-size:12px;color:var(--dim);cursor:pointer;text-decoration:none}
  header .sp{flex:1 1 auto}
  .bar{flex:none;display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:4px 14px;font-size:11px;
       border-bottom:1px solid var(--line);background:rgba(0,0,0,.025)}
  .bar.warn{background:rgba(240,160,60,.10);border-bottom-color:rgba(240,160,60,.5)}
  .btn{font-size:11px;padding:1px 9px;border-radius:4px;cursor:pointer;border:1px solid var(--line);opacity:.9}
  .btn.p{border-color:var(--blue);background:rgba(74,143,231,.22)}
  .btn.w{border-color:var(--warn);background:rgba(240,160,60,.18)}
  #stage{flex:1 1 auto;position:relative;overflow:hidden;cursor:grab}
  #stage.drag{cursor:grabbing}
  #world{position:absolute;left:0;top:0;transform-origin:0 0;padding:40px}
  /*
   * ══ ★★ 画布连线：让"谁是谁的子节点"一眼可辨 ══
   *
   * 用户 2026-10-20：「画布的结构表示不太明确 / 不太容易使人看懂」
   *
   * 原来只有子列的一条**淡竖线**（border-left:1px solid var(--line)）✗ ——
   * 而兄弟节点各自的子列会**落在同一列**（1.1 的两个子和 1.2 的七个子对齐在一起），
   * ⇒ 只能靠垂直位置猜，看不出来 ✗
   *
   * 改成标准横向树：
   *   · 每个子节点左侧一条**横线**（从竖线连到它）
   *   · 子列一条**贯穿竖线**
   *   · 两者交点就是"肘"⇒ 读起来就是经典的 ⊢ 形状 ✓
   *   · 兄弟之间的间距从 6px 拉到 14px，让"子树成品"更清楚 ✓
   *   · 线色比 --line 深一点（.22 而不是 .14），不然投影上几乎看不见 ✓
   */
  /*
   * ══ ★★ 画布连线：重画（用户 2026-10-20：「完全让人看不懂结构」）══
   *
   * 原来缺的是最关键那一段：**父节点到它自己子列的连线** ✗
   *   ⇒ 整张图看起来是"一堆竖线挂着一些框"，分不清哪条竖线属于哪个父节点 ✗
   *
   * 现在的画法（经典横向树）：
   *
   *        ┌── 1.1 人物 ──┬── 周衍
   *        │              └── 苏晚
   *   ─────┤
   *        │              ┌── 记忆校验是强制的
   *        └── 1.2 世界观 ─┼── 与备份对不上…
   *                       └── …
   *
   *   · **父节点右侧一条短横线**（.tree > .node::after）→ 接上它子列的竖脊 ✓
   *   · **子列的竖脊**（.kids::before）贯穿这一列 ✓
   *   · **每个子节点的圆角肘**（.kids > .tree::before）从竖脊弯进来 ✓
   *
   * ⇒ 三层下来，"谁是谁的孩子"一眼可辨 ✓
   */
  .tree{display:flex;align-items:center;gap:16px;position:relative}
  /* 父节点 → 自己的子列：短横线（**原来就是缺这条**） */
  .tree:has(> .kids) > .node{position:relative}
  .tree:has(> .kids) > .node::after{
    content:'';position:absolute;right:-16px;top:50%;width:16px;height:1.5px;
    background:rgba(86,110,104,.5);pointer-events:none;
  }
  /* 子列：竖脊 + 每个子节点的圆角肘 */
  .kids{position:relative;display:flex;flex-direction:column;gap:13px;padding-left:30px}
  /* 竖脊：贯穿这一列（只在这一列的范围内，不会伸到别的子树） */
  .kids::before{
    content:'';position:absolute;left:0;top:-6px;bottom:-6px;width:1.5px;
    background:rgba(86,110,104,.5);border-radius:1px;pointer-events:none;
  }
  /* （这里原来画"整列竖脊"—— 画满整列会像一根独立竖线 ✗，已删除；
     竖线改由每个子节点自己画"上方那一段" ⇒ 天然从第一个连到最后一个 ✓） */
  .kids > .tree{position:relative}
  /*
   * ★ 照参照图：从竖脊**弯进**子节点，用大半径圆角画成四分之一圆弧
   *   （border-left 竖段 + border-bottom 横段 + border-bottom-left-radius）
   *   高度 = 半个间距 ⇒ 弯得开、像真正的曲线 ✓
   */
  /*
   * ★ 每个子节点画"它上方那一段竖线 + 拐进来的圆弧"
   *   top = -gap（盖住自己上方的间距）／bottom = 50%（收在自己的中线）
   *   ⇒ 第一个子节点没有上半段 ⇒ top:50% ✓
   *   ⇒ 最后一个子节点下方没有竖线 ✓（它只盖自己上方）
   *   结果：竖线正好从第一个子节点的中点连到最后一个的中点 ✓
   */
  /*
   * ★ 小圆弧：从竖脊弯进子节点（照参照图那种**短促的圆拐**）
   *   盒子只有 30×18、圆角 9px
   *   （之前写成 34×半行高 + 圆角 100% ⇒ 变成大抛物线 ✗）
   */
  .kids > .tree::before{
    content:'';position:absolute;left:-30px;top:50%;width:30px;height:18px;
    box-sizing:border-box;pointer-events:none;
    border-left:1.5px solid rgba(86,110,104,.5);
    border-bottom:1.5px solid rgba(86,110,104,.5);
    border-bottom-left-radius:9px;
    transform:translateY(-100%);
  }
  /* 第一个/最后一个不用特殊处理 —— 竖脊由 .kids::before 画，这里只负责"拐进来" ✓ */
  /* 竖脊两端收口：第一个往上、最后一个往下各留半个间距，看起来就是「从父节点分出来的」 */

  .kids > .tree::after{content:none}
  /* ★ 照参照图：默认是**纯文字**（叶子），中间层才有框 */
  /* 参照图：**所有节点都是纯文字**，没有边框和背景 */
  .node{border:none;border-radius:4px;padding:1px 2px;background:transparent;
        cursor:pointer;max-width:230px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .node:hover{border-color:var(--blue)}
  /* 叶子节点（条目 / 文件）稍微轻一点，让层级的轻重看得出来 */
  /* 叶子：纯文字、略小、次要色 */
  .node.leaf,.node.content{font-size:12.5px;background:transparent;border:none;color:rgba(27,28,31,.72);padding:1px 2px}
  /* 中间层（工序/子层）：有框、字号更大 —— 这是参照图的层级感来源 */
  .node.stage{font-weight:600;font-size:13.5px;border:none;background:transparent;padding:1px 2px}
  /* ★ 设置弹窗 */
  #cfgbox{position:fixed;left:0;top:0;right:0;bottom:0;background:rgba(0,0,0,.32);
          display:flex;align-items:center;justify-content:center;z-index:9999}
  .cfgm{background:var(--bg);border:1px solid var(--line);border-radius:10px;
        padding:18px 20px;min-width:420px;max-width:520px;box-shadow:0 10px 40px rgba(0,0,0,.18)}
  .cfgm h3{margin:0 0 14px;font-size:15px}
  .cfgm label{display:block;font-size:12px;color:var(--dim);margin:10px 0 4px}
  .cfgm input{width:100%;box-sizing:border-box;padding:7px 9px;border:1px solid var(--line);
              border-radius:6px;background:rgba(0,0,0,.03);color:var(--fg);font-size:13px;
              font-family:ui-monospace,Consolas,monospace}
  .cfgm input:focus{outline:none;border-color:var(--blue)}
  .cfghint{font-size:11.5px;color:var(--dim);margin-top:6px;line-height:1.6;white-space:pre-wrap}
  .cfgrow{display:flex;gap:8px;margin-top:14px}
  .cfgmsg{margin-top:10px;font-size:12px;min-height:16px;white-space:pre-wrap}
  .cfgmsg.err{color:#c0392b}
  .cfgmsg.ok{color:#1e7d32}
  .node.root{font-size:15px;font-weight:700;padding:1px 2px;border:none;background:transparent}
  /* 参照图里中间层也只是**纯文字**，靠字号和字重区分层级 */
  .node.stage{font-weight:600;border:none;background:transparent;padding:1px 2px}
  .node.sel{border-color:var(--blue);background:rgba(74,143,231,.18)}
  .node .sub{font-size:10px;color:var(--dim);font-weight:400}
  .node.warn{border-color:var(--warn);color:var(--warn)}
  #card{position:absolute;right:12px;top:12px;width:380px;max-height:calc(100% - 24px);overflow:auto;
        border:1px solid var(--blue);border-radius:10px;background:rgba(255,255,255,.985);
        box-shadow:0 10px 30px rgba(0,0,0,.16);padding:10px;display:none;flex-direction:column;gap:6px}
  #card.on{display:flex}
  #card h3{margin:0;font-size:13px}
  #card .meta{font:10px/1.5 ui-monospace,Consolas,monospace;color:var(--dim)}
  #card label{font-size:10px;color:var(--dim)}
  #card input,#card textarea{width:100%;background:rgba(0,0,0,.05);border:1px solid var(--line);
        color:var(--fg);border-radius:5px;padding:5px 7px;font:inherit;font-size:12px}
  #card textarea{min-height:220px;resize:vertical}
  #msg{font-size:11px;color:var(--dim);white-space:pre-wrap}
  .err{color:#e5707e}
</style></head><body>
<div id="main" style="display:flex;flex:1 1 auto;min-height:0;width:100%">
  <div id="left">
    <div id="lhead">
      <span>片场助手</span>
      <span id="lstatus"></span>
      <span id="lpause" class="btn w" style="display:none">暂停</span>
      <span id="ldiag"></span>
    </div>
    <div id="lfeed"></div>
    <div id="lcomposer">
      <div id="lcard">
        <textarea id="lsay" rows="1" placeholder="对这个项目说点什么…"></textarea>
        <div id="lbar">
          <span id="lhint">Enter 发送 · Shift+Enter 换行</span>
          <span id="lbusy">正在干活…（Esc Esc 停）</span>
          <button id="lsend" disabled>发送</button>
        </div>
      </div>
    </div>
  </div>
  <div id="right">
<header>
  <a class="back" href="/filmflow/app">← 项目资产</a>
  <h1 id="t">…</h1>
  <span class="sp"></span>
  <span class="btn" id="fit">适应窗口</span>
  <span class="btn" id="reload">刷新</span>
</header>
<div id="bars" style="display:none"></div>
<div id="stage"><div id="world"></div>
  <div id="card">
    <h3 id="ct">—</h3>
    <div class="meta" id="cm"></div>
    <label>作用</label><input id="crole">
    <!-- ★ 结构化条目（list 形态拆出来的子节点）→ 每个字段一个框，给人看、给人改 -->
    <div id="cfields"></div>
    <label id="ctextlab">正文（原始 markdown）</label><textarea id="ctext"></textarea>
    <div style="display:flex;gap:6px;align-items:center">
      <span class="btn p" id="csave">保存到文件</span>
      <span class="btn" id="cclose">关闭</span>
    </div>
    <div id="msg"></div>
  </div>
</div>
<script>
var Q = new URLSearchParams(location.search);
var ROOT = Q.get('root') || '';
var S = null, SEL = null, VIEW = {x:40,y:40,s:1};

function el(tag, cls, txt){ var e=document.createElement(tag); if(cls)e.className=cls; if(txt!=null)e.textContent=txt; return e; }
/* ★ 写操作令牌（服务端启动时生成、由页面注进来）—— 见 requireToken 的注释 */
var WT = ${JSON.stringify(writeToken || '')};
function post(url, body){ return fetch(url,{method:'POST',headers:{'Content-Type':'application/json','x-filmflow-token':WT},body:JSON.stringify(body)})
  .then(function(r){ return r.json().then(function(j){ if(!r.ok||!j.ok) throw new Error(j.error||('HTTP '+r.status)); return j; }); }); }
function applyView(){ document.getElementById('world').style.transform =
  'translate('+VIEW.x+'px,'+VIEW.y+'px) scale('+VIEW.s+')'; }

function nodeEl(n){
  var d = el('div','node '+(n.kind||''));
  var label = (n.no ? n.no+' ' : '') + (n.title || '');
  d.appendChild(document.createTextNode(label));
  if (n.stale === 'stale'){ d.className += ' warn'; d.appendChild(el('span','sub','　⚠ 过期')); }
  else if (n.stale === 'unknown'){ d.appendChild(el('span','sub','　· 未对齐')); }
  else if (n.group){ d.appendChild(el('span','sub','　['+n.group+']')); }
  d.addEventListener('click', function(ev){ ev.stopPropagation(); openCard(n); });
  return d;
}
function branch(n){
  var wrap = el('div','tree');
  wrap.appendChild(nodeEl(n));
  var kids = [];
  (n.children||[]).forEach(function(c){ kids.push(c); });
  (n.content||[]).forEach(function(c){ kids.push(c); });
  if (kids.length){
    var col = el('div','kids');
    kids.forEach(function(k){ col.appendChild(branch(k)); });
    wrap.appendChild(col);
  }
  return wrap;
}
var SIG = { tree: '', feed: '' };
/*
 * ★ 哪些思考块是展开的 —— 按内容指纹记。
 *
 * 不加这个，drawFeed 每次重建转录就会把用户展开的思考块折回去，
 * 看起来像"点了没用 / 没法展开" —— **用户 2026-10-16 报的就是这个。**
 */
var OPEN_THINK = {};
function draw(){
  if (!S) return;
  var p = S.projects.filter(function(x){ return x.root === ROOT; })[0] || S.projects[0];
  if (!p) return;
  /*
   * ★★ **内容没变就不重建 DOM** —— 用户 2026-10-16：
   *    「一直在不断地闪，是在刷新吗？不要这样刷」
   *
   * 原因：轮询每 600ms 调一次 draw()，而 draw() 一上来就 innerHTML = '' 把整棵树
   * 和整个转录重建一遍 —— 即使内容一个字都没变。看着就是在闪。
   *
   * 修：**分别给树和转录算签名，只有真的变了才重建。**
   * （转录单独一路，是因为 Agent 流式输出时树根本没变，不该跟着重建。）
   */
  var treeSig = JSON.stringify([p.title, p.stages, p.scope]);
  var feedSig = JSON.stringify([p.feed, p.agentMsgs, p.agent && p.agent.busy, p.agent && p.agent.running]);
  var needTree = treeSig !== SIG.tree;
  var needFeed = feedSig !== SIG.feed;
  if (!needTree && !needFeed) return;   // ★ 什么都没变 → 一个字节都不动
  SIG.tree = treeSig;
  SIG.feed = feedSig;

  document.getElementById('t').textContent = p.title || p.id;
  var w = document.getElementById('world');
  if (needTree) {
    w.innerHTML = '';
    var rootNode = { kind:'root', title:p.title, ref:p, isRoot:true };
    var top = el('div','tree');
    top.appendChild(nodeEl(rootNode));
    var col = el('div','kids');
    (p.stages||[]).forEach(function(s){ col.appendChild(branch(s)); });
    top.appendChild(col);
    w.appendChild(top);
    applyView();
    /* 第一次画完自动适应窗口 —— 树朝右长、窗口窄的时候，
       不 fit 的话工序全在屏幕外，用户看到的是"画布是空的"。 */
    if (!window.__ffFitted) {
      window.__ffFitted = true;
      setTimeout(function(){ try { fit(); } catch (e) {} }, 0);
    }
  }
  drawHead(p);
  drawFeed(p);
  drawExtras(p);   // ★ 必须在 drawFeed 之后 —— 它往 lfeed 末尾追加
  setBusy(!!(p.agent && p.agent.busy));
}
/** 左侧栏的消息流 —— 插件对它说过的 + 你对它说过的。**没有它的回话**（读不到）。 */
/* ── 转录渲染 ──────────────────────────────────────────────────────
 * 三类行，照 DSH 会话的规矩：
 *   user      → 右对齐气泡（DSH: .Sixlwa_userRow / userStack / bubble）
 *   assistant → 左对齐裸 markdown（DSH 用 AssistantMarkdown，不加气泡）
 *   plugin    → 折叠成一行小字（DSH 的 context injection row / tool row 那种）
 */
function esc2(s){
  return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
/** 极简 markdown。只覆盖会话里真会出现的东西 —— 认不出来就原样输出，绝不吞内容。 */
function md(src){
  var lines = String(src || '').split('\\n');
  var out = [], i = 0;
  function inline(t){
    return esc2(t)
      .replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>')
      .replace(/\`([^\`]+)\`/g, '<code>$1</code>');
  }
  while (i < lines.length) {
    var L = lines[i];
    if (/^\\s*$/.test(L)) { i++; continue; }
    if (/^\\s*\`\`\`/.test(L)) {                       // 代码块
      i++; var code = [];
      while (i < lines.length && !/^\\s*\`\`\`/.test(lines[i])) { code.push(lines[i]); i++; }
      i++;
      out.push('<pre><code>' + esc2(code.join('\\n')) + '</code></pre>');
      continue;
    }
    var h = L.match(/^#{1,6}\\s+(.*)$/);            // 标题（会话里最多到三级，统一按 h3 排）
    if (h) { out.push('<h3>' + inline(h[1]) + '</h3>'); i++; continue; }
    if (/^\\s*([-*_])\\1{2,}\\s*$/.test(L)) { out.push('<hr>'); i++; continue; }
    if (/^\\s*\\|/.test(L)) {                       // 表格
      var rows = [];
      while (i < lines.length && /^\\s*\\|/.test(lines[i])) { rows.push(lines[i]); i++; }
      var cells = function(r){ return r.replace(/^\\s*\\||\\|\\s*$/g,'').split('|').map(function(x){return x.trim();}); };
      var html = ['<table>'];
      rows.forEach(function(r, ri){
        if (/^[\\s|:-]+$/.test(r)) return;           // 分隔行
        var tag = ri === 0 ? 'th' : 'td';
        html.push('<tr>' + cells(r).map(function(c){ return '<'+tag+'>' + inline(c) + '</'+tag+'>'; }).join('') + '</tr>');
      });
      html.push('</table>');
      out.push(html.join(''));
      continue;
    }
    if (/^\\s*([-*·]|\\d+[.)])\\s+/.test(L)) {        // 列表
      var li = [];
      while (i < lines.length && /^\\s*([-*·]|\\d+[.)])\\s+/.test(lines[i])) {
        li.push('<li>' + inline(lines[i].replace(/^\\s*([-*·]|\\d+[.)])\\s+/, '')) + '</li>');
        i++;
      }
      out.push('<ul>' + li.join('') + '</ul>');
      continue;
    }
    var buf = [];                                    // 段落
    while (i < lines.length && !/^\\s*$/.test(lines[i]) &&
           !/^(#{1,6}\\s|\\s*\`\`\`|\\s*\\||\\s*([-*·]|\\d+[.)])\\s)/.test(lines[i])) { buf.push(lines[i]); i++; }
    out.push('<p>' + inline(buf.join('\\n')).replace(/\\n/g, '<br>') + '</p>');
  }
  return out.join('');
}
function drawFeed(p){
  var host = document.getElementById('lfeed');
  /*
   * ★★ **重建前记住"用户是不是贴着底看"** —— 用户 2026-10-16 报：
   *    「有bug，我发的信息都会出现在最顶部」
   *
   * 查下来 feed 本身是**按时间**排的（pushFeed 带 at，/filmflow/say 推到末尾）✓，
   * 但 drawFeed 一上来 innerHTML = '' **把滚动位置也清了** ✗ ——
   * 重建之后视图停在**最顶上**，也就是**最老的内容**，
   * 而用户刚发的那条在**最下面、看不见** ⇒ 看起来"我发的话跑到顶上去了"。
   *
   * 规矩跟官方对话页一样：
   *   · 原本贴着底（或几乎贴着）→ 重建后**继续贴底**（新消息自然可见）
   *   · 用户往上翻着看历史 → **别抢他的位置**，保持不动
   */
  var nearBottom = host.scrollHeight - host.scrollTop - host.clientHeight < 60;
  var hadScroll = host.scrollHeight > host.clientHeight;
  host.__hadScroll = hadScroll; host.__nearBottom = nearBottom;   // ★ 挂到元素上，供函数外的恢复代码用
  host.innerHTML = '';
  var fs = (p.feed || []).slice();
  /*
   * ★★★ Agent 说过什么 + 你说过什么 —— 走 session.deriveMessages()，
   * 并进同一条时间线。
   *
   * 用户 2026-10-16 报的：「会话框依然没有历史」「我发的信息还是依然会跑到最上面」
   *
   * 真凶就是这一行（原来的写法）：
   *     fs.push({ who: m.role === 'assistant' ? 'agent' : 'told', … });
   * ⇒ 会话里 role: 'user' 的消息（真人说的话）全被当成 'told' ✗
   * ⇒ 'told' 画出来是「你刚说的：…」那种截断到 90 字的灰色注解行 ✗
   * ⇒ 于是整个面板看起来是"一堆你刚说的 + 思考过程"，
   *   既看不到自己的气泡、也看不出对话 ⇒ 用户读成"没历史""我的话跑到上面去了" ✓
   *
   * 一处 bug、两个症状。
   *
   * 修法：把 user 角色再分两种 ——
   *   · 插件自己的叫醒词（【片场插件】… / 运行时上下文）⇒ 'told'（注解行）✓
   *   · 真人说的话（被包成【用户在对你说】\n<原话>\n\n（按规矩办：…））⇒ 'user'（气泡）✓
   *     并且把那层包装剥掉，只显示他真正打的那句 ✓
   */
  (p.agentMsgs || []).forEach(function (m) {
    var role = String(m.role || '');
    if (role === 'assistant') {
      fs.push({ who: 'agent', at: '', text: m.text, reasoning: m.reasoning });
      return;
    }
    /*
     * ★ 官方那套角色名是 user / assistant / tool / system。
     *   原来这里**没有 user 分支** —— 用户消息是靠 【用户在对你说】 前缀认的
     *   （DSH 侧边栏那半的写法）✗ ⇒ 换成标准 role 之后，用户消息掉进了 told ✗
     */
    if (role === 'user') {
      fs.push({ who: 'user', at: '', text: m.text });
      return;
    }
    if (role === 'tool') {
      fs.push({ who: 'tool', at: '', text: m.text, status: m.status });
      return;
    }
    if (role === 'system') {
      fs.push({ who: 'sys', at: '', text: m.text });
      return;
    }
    var t = String(m.text || '');
    var PREFIX = '【用户在对你说】';
    if (t.indexOf(PREFIX) === 0) {
      /* 剥掉插件包的两层壳，只留他真正打的那句。
       * ⚠️ **不能用正则、不能写反斜杠转义** —— 页面 HTML 是外层模板字符串，
       *    里面的反斜杠-n 会被外层先解释成真换行，正则当场断掉
       *    （实测：Invalid regular expression: missing /）。
       *    所以这里全用 indexOf / slice 的朴素写法。 */
      var body = t.slice(PREFIX.length).trim();
      var cut = body.indexOf('（按规矩办');
      if (cut > 0) body = body.slice(0, cut).trim();
      fs.push({ who: 'user', at: '', text: body || t });
      return;
    }
    fs.push({ who: 'told', at: '', text: t });
  });
  if (!fs.length){
    var z = el('div','lempty',
      '这个项目的助手还没被叫醒过。' + '\\n' +
      '· 在下面说一句，或者\\n· 在画布上改一处内容并保存 —— 插件会自己叫它，这里会记下叫它的原因。');
    z.style.whiteSpace = 'pre-wrap';
    host.appendChild(z);
    return;
  }
  fs.forEach(function(m){
    if (m.who === 'user'){
      var row = el('div','lrow-u');
      var b = el('div','bub'); b.textContent = m.text;
      row.appendChild(b);
      if (m.at) row.appendChild(el('div','lwho', String(m.at).slice(11,19)));
      host.appendChild(row);
    } else if (m.who === 'agent'){
      var r2 = el('div','lrow-a');
      /*
       * ★ **思考链** —— 照官方 UI（dsh-client-ui-chat 的 ReasoningRow）的规矩：
       *   用次要文字色（--dsw-alias-label-tertiary = #81858c）、默认**折叠**成一行、
       *   点一下展开。跟回答分开，别混在一起。
       */
      if (m.reasoning){
        var tid = String(m.at || '') + '|' + String(m.text || '').slice(0, 24) + '|' + m.reasoning.length;
        var isOpen = !!OPEN_THINK[tid];
        var rb = el('div','think' + (isOpen ? ' open' : ''));
        var rh = el('div','thinkh');
        rh.appendChild(el('span',null, isOpen ? '▾ 思考过程' : '▸ 思考过程'));
        rh.appendChild(el('span','thinkn', String(m.reasoning.length) + ' 字'));
        rb.appendChild(rh);
        var rbody = el('div','thinkb'); rbody.textContent = m.reasoning;
        rb.appendChild(rbody);
        rh.onclick = function(){
          var on = rb.className.indexOf('open') >= 0;
          rb.className = on ? 'think' : 'think open';
          rh.firstChild.textContent = on ? '▸ 思考过程' : '▾ 思考过程';
          OPEN_THINK[tid] = !on;   // ★ 记住 —— 下次重建时还原
        };
        r2.appendChild(rb);
      }
      var d = el('div','md'); d.innerHTML = md(m.text);
      r2.appendChild(d);
      host.appendChild(r2);
    } else if (m.who === 'tool') {
      /* 工具调用 —— 照官方 UI 的做法：一行、灰色、不抢注意力 ✓ */
      var rt = el('div','lrow-tool');
      var isErr = String(m.status || '') === 'error';
      rt.appendChild(el('span','tico' + (isErr ? ' err' : ''), '⚙'));
      var ttx = el('span','ttx', String(m.text || ''));
      rt.appendChild(ttx);
      host.appendChild(rt);
    } else if (m.who === 'sys') {
      /* 系统提示（会话号 / 跑完了 / 出错）—— 最淡的一行 */
      var rs = el('div','lrow-sys');
      rs.textContent = String(m.text || '');
      host.appendChild(rs);
    } else {
      // 插件叫它 / 它被告知 —— 折叠成一行，点开看全文
      var r3 = el('div','lrow-s');
      r3.appendChild(el('span','dot'));
      var tx = el('span','tx');
      tx.textContent = (m.who === 'told' ? '你刚说的：' : '叫它干活：') + String(m.text).replace(/\\s+/g,' ').slice(0, 90);
      tx.title = m.text;
      tx.onclick = function(){ r3.className = r3.className.indexOf('open') < 0 ? 'lrow-s open' : 'lrow-s'; };
      r3.appendChild(tx);
      host.appendChild(r3);
    }
  });
  host.scrollTop = host.scrollHeight;
}

/* ── 输入区 ────────────────────────────────────────────────────────
 * 交互照 DSH 的 composer：
 *   · Enter 发送、Shift+Enter 换行（DSH：「普通 Enter 使用已配置的投递模式……Shift+Enter 插入换行」）
 *   · 纯空白草稿不能发（DSH：「没有附件的纯空白草稿无法发送」）
 *   · 空闲时按钮是「发送」，运行时同一个位置变「停止」（DSH：「可提交的文字或附件会把同一位置切换为 Send」）
 *   · Esc Esc 停止当前轮次（DSH：「连续独立按下两次 Esc，可停止当前运行轮次并保留排队消息」，默认 500ms）
 *   · 乐观提交：按下就清空草稿（DSH：「Enter 在同一事务里清空草稿」）
 */
var SAY = document.getElementById('lsay');
var BTN = document.getElementById('lsend');
var CARD = document.getElementById('lcard');
var BUSY = false, lastEsc = 0;

function autosize(){
  SAY.style.height = 'auto';
  SAY.style.height = Math.min(180, Math.max(46, SAY.scrollHeight)) + 'px';
}
function syncBtn(){
  var has = SAY.value.trim().length > 0;
  if (BUSY){ BTN.className = 'stop'; BTN.textContent = '停止'; BTN.disabled = false; }
  else { BTN.className = ''; BTN.textContent = '发送'; BTN.disabled = !has; }
  CARD.className = BUSY ? 'busy' : '';
}
function setBusy(v){ BUSY = !!v; syncBtn(); }
function stopTurn(){
  post('/filmflow/agent', { root: ROOT, action: 'pause' })
    .then(function(){ setBusy(false); return load(); })
    .catch(function(e){ alert('停不下来：' + e.message); });
}
function sendSay(){
  var t = SAY.value.trim();
  if (!t) return;
  SAY.value = ''; autosize();          // 乐观提交
  setBusy(true);
  post('/filmflow/say', { root: ROOT, text: t })
    .then(function(){ return load(); })
    .catch(function(e){ setBusy(false); SAY.value = t; autosize(); syncBtn(); alert('送不出去：' + e.message); });
}
SAY.addEventListener('input', function(){ autosize(); syncBtn(); });
SAY.addEventListener('keydown', function(e){
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing){ e.preventDefault(); sendSay(); return; }
  if (e.key === 'Escape'){
    // DSH：「连续独立按下两次 Esc，可停止当前运行轮次」，默认 500ms 内
    var now = Date.now();
    if (now - lastEsc < 500){ lastEsc = 0; e.preventDefault(); stopTurn(); }
    else lastEsc = now;
  }
});
BTN.addEventListener('click', function(){ if (BUSY) stopTurn(); else sendSay(); });
autosize(); syncBtn();
/*
 * 面板头部：Agent 状态 + 暂停。
 * 用户 2026-10-16：「确认内容直接在与 Agent 的交互框中输出，在交互框中确认，
 * **不要占用画布空间**。」⇒ 状态挪到面板头部，画布只剩画布。
 */
/*
 * ★ 恢复滚动 —— **自包含**，不依赖任何函数的局部变量。
 *   原来写成 if (!hadScroll || nearBottom) …，被放在 drawFeed 外面 ⇒
 *   ReferenceError: hadScroll is not defined（用户 2026-10-16 截图报的）。
 *   现在状态挂在 #lfeed 元素上，谁都能读。
 */
(function(){
  var f = document.getElementById('lfeed'); if (!f) return;
  if (!f.__hadScroll || f.__nearBottom) f.scrollTop = f.scrollHeight;
})();

function drawHead(p){
  var ag = p.agent || {};
  var st = document.getElementById('lstatus');
  var pb = document.getElementById('lpause');
  /*
   * ★★ **面板自检行** —— 把"它到底拿到了什么"直接显示在界面上。
   *
   * 用户 2026-10-16：「重启之后会话框里依然没有加载出之前的会话」
   * —— 而我在服务端和 DOM 桩里**都验过是对的**：
   *      服务端 12 条历史 ✓
   *      真入口 load() → draw() 画出 23 个节点 ✓
   *      CSS 正常（#lfeed flex:1 overflow-y:auto）✓
   *      Cache-Control: no-store 本来就有 ✓
   * ⇒ **我看不见他浏览器里那一层发生了什么** ✓
   *
   * 与其反复猜、反复改错地方，**不如让它自己说话**：
   *      项目名 · 会话 N 条 · 通知 M 条 · 更新时间
   * 数字为 0 或项目名不对，一眼就能看出是哪一环断的 ✓
   */
  var diag = document.getElementById('ldiag');
  if (diag) {
    var cntMsg = (p.agentMsgs || []).length;
    var cntFeed = (p.feed || []).length;
    diag.textContent =
      String(p.title || p.id || '?') + ' · 会话 ' + cntMsg + ' 条 · 通知 ' + cntFeed + ' 条 · ' +
      new Date().toTimeString().slice(0, 8);
    diag.style.color = cntMsg ? '#adb2b8' : '#c0392b';
  }
  if (!ag.running){ st.textContent = ''; pb.style.display = 'none'; return; }
  st.textContent = ag.busy ? '正在干活…' : '待命';
  st.style.color = ag.busy ? '#4176e6' : '#adb2b8';
  pb.style.display = ag.busy ? '' : 'none';
  pb.onclick = function(){
    post('/filmflow/agent', { root: ROOT, action: 'pause' })
      .then(load)
      .catch(function(e){ alert('停不下来：' + e.message); });
  };
}

/*
 * 授权条 + 提案卡 —— **画进交互框**，不占画布。
 *
 * 用户 2026-10-16 的截图：提案卡原来横在画布上方，把画布挤掉了。
 * 而它本质上是"跟 Agent 的交互" —— 该待在对话流里。
 *
 * 所以：**插在转录末尾**（也就是"最新一条"的位置），跟消息同一条时间线。
 */
function drawExtras(p){
  var host = document.getElementById('lfeed');

  // ① 授权分组已撤（2026-10-29）；这里只剩待确认提案

  // ② 待确认的提案 —— 对话流里的卡片，确认/驳回都在框里点
  fetch('/filmflow/proposals').then(function(r){ return r.json(); }).then(function(j){
    var mine = (j.proposals || []).filter(function(x){
      return String(x.root || '').toLowerCase() === ROOT.toLowerCase();
    });
    if (!mine.length) return;
    mine.forEach(function(pr){
      var card = el('div','prop');
      var hd = el('div','ph');
      hd.appendChild(el('span',null,'✎ 修改建议'));
      hd.appendChild(el('b',null,(pr.node ? pr.node + ' ' : '') + (pr.nodeTitle || pr.src)));
      card.appendChild(hd);
      var why = el('div','pw'); why.textContent = '它说：' + (pr.why || '（没写理由）');
      card.appendChild(why);
      var ft = el('div','pf');
      var ok = el('span','btn p','确认，写进画布');
      ok.onclick = function(){
        post('/filmflow/approve', { root: pr.root, id: pr.id, action: 'approve' })
          .then(load).catch(function(e){ alert(e.message); });
      };
      var no = el('span','btn','驳回');
      no.onclick = function(){
        post('/filmflow/approve', { root: pr.root, id: pr.id, action: 'reject' })
          .then(load).catch(function(e){ alert(e.message); });
      };
      ft.appendChild(ok); ft.appendChild(no);
      card.appendChild(ft);
      host.appendChild(card);
    });
    host.scrollTop = host.scrollHeight;
  }).catch(function(){});
  /*
   * ★ 恢复滚动：第一次画（还没有滚动条）也直接到底 —— 打开就该看见最新的。
   *   （官方对话页也是这个行为。）
   */
}
function openCard(n){
  SEL = n;
/*
   * ★★★ **整对象回填** —— 不再逐个字段打补丁。
   *
   * 这个坑我踩了三次：先只补 src（卡片头好了、正文还空），再补 line，第三次才发现
   * **text 也没补** ⇒ 卡片正文永远是空的 ✗（用户 2026-10-19 截图：agent 说"1.1 正文 867 字"，
   * 卡片里却是空白 ✗）
   *
   * 成因：全页面只有**根节点**被塞了 ref（ref: p），工序/子层节点走
   * branch(n) → nodeEl(n)，n.ref 是 undefined ⇒ c = {} ⇒ **所有字段都是空的** ✗
   *
   * 而节点自己**什么都有**（服务端实测：src / text / role / title / line / via / whole …）。
   * 所以直接整对象合并：n.ref 打底（根节点要靠它），节点自身字段覆盖。
   * ⇒ 一次解决 src / line / text / role / title / via / whole，不再漏字段 ✓
   */
  var c = Object.assign({}, n.ref || {}, n);
  /*
   * ★★★ **补 src：工序节点的源文件挂在【节点自己】身上，不在 n.ref 里。**
   *
   * 用户 2026-10-16 报的：「1.3 事实层 → 保存到文件 → 写回失败：
   *   这个文件没在 project.json 的 md / files 里声明过，拒绝写入:」（冒号后面是空的）
   * 而且卡片头上写着「（无源文件 · 这个节点没有正文可写）」
   *
   * 根因：全页面**只有根节点**被塞了 ref（另一处 ref: p），
   * 工序/子层节点走 branch(n) → nodeEl(n)，n.ref 是 undefined
   * ⇒ c = {} ⇒ c.src 空 ⇒ 头上显示"无源文件" ✗
   * ⇒ 保存时 src: c.src 送出去也是空 ✗ ⇒ 宿主护栏拒绝写入 ✗
   *
   * **一处 bug、两个症状** ✓
   *
   * 而服务端给的节点**自己是有 src 的**（实测 /filmflow/state：
   *   {"no":"1.3","title":"事实层","src":"设定/事实层.md", …}）✓
   * 所以这里回填一下就行 —— c.src / c.line 是下游所有读取的唯一入口，
   * 补这一处，**显示和保存同时修好** ✓
   */
  document.getElementById('ct').textContent = (n.no ? n.no+' ' : '') + (n.title || '');
  var cm = n.isRoot ? '.film/project.json　(root)' : (c.src ? c.src + (c.line ? '　第 '+c.line+' 行' : '') : '（无源文件 · 这个节点没有正文可写）');
  document.getElementById('cm').textContent = cm;
  document.getElementById('crole').value = c.role || '';
  /*
   * ══ ★★ 条目节点（list 形态的一个条目）→ **每个字段一个框** ══
   *
   * 用户 2026-10-19：「每个节点两个框，一个是人物名，一个是人物的简单介绍，
   * 给人看，给人改的，一个人物新建一个节点。」
   *
   * 数据来源：\`c.doc.kind === 'item'\`（服务端在 buildContent 里为每个 list 条目建的，
   * 带 \`fields\`（声明）和 \`values\`（值））。
   * ⇒ 按 fields 逐个渲染：\`type: 'line'\` 用单行 input，其余用多行 textarea ✓
   * ⇒ 同时**藏起原始 markdown 那个大框**（它的内容会从这些框拼出来）✓
   */
  var boxHost = document.getElementById('cfields');
  var lab = document.getElementById('ctextlab');
  var ta = document.getElementById('ctext');
  boxHost.innerHTML = '';
  var isItem = !!(c.doc && c.doc.kind === 'item' && Array.isArray(c.doc.fields));
  if (isItem) {
    lab.style.display = 'none';
    ta.style.display = 'none';
    for (var fi = 0; fi < c.doc.fields.length; fi++) {
      var f = c.doc.fields[fi];
      var w = el('div');
      var lb = el('label', null, String(f.label || f.key));
      var val = String((c.doc.values && c.doc.values[f.key]) || '');
      var inp;
      if (String(f.type) === 'line') {
        inp = el('input');
        inp.value = val;
      } else {
        inp = el('textarea');
        inp.rows = 3;
        inp.value = val;
      }
      inp.setAttribute('data-field', String(f.key));
      inp.setAttribute('data-quote', f.quote ? '1' : '');
      inp.setAttribute('data-type', String(f.type || 'text'));
      inp.setAttribute('data-label', String(f.label || f.key));
      w.appendChild(lb);
      w.appendChild(inp);
      boxHost.appendChild(w);
    }
  } else {
    lab.style.display = '';
    ta.style.display = '';
  }
  document.getElementById('ctext').value = n.isRoot ? (c.note || '') : (c.text || '');
  document.getElementById('crole').disabled = !!n.isRoot;
  document.getElementById('ctext').disabled = !!n.isRoot;
  document.getElementById('csave').style.display = n.isRoot ? 'none' : '';
  document.getElementById('msg').textContent = '';
  document.getElementById('card').className = 'on';
  Array.prototype.forEach.call(document.querySelectorAll('.node.sel'), function(x){ x.className = x.className.replace(' sel',''); });
}
document.getElementById('cclose').onclick = function(){ document.getElementById('card').className=''; };
document.getElementById('csave').onclick = function(){
  var n = SEL; if (!n) return;
/*
   * ★★★ **整对象回填** —— 不再逐个字段打补丁。
   *
   * 这个坑我踩了三次：先只补 src（卡片头好了、正文还空），再补 line，第三次才发现
   * **text 也没补** ⇒ 卡片正文永远是空的 ✗（用户 2026-10-19 截图：agent 说"1.1 正文 867 字"，
   * 卡片里却是空白 ✗）
   *
   * 成因：全页面只有**根节点**被塞了 ref（ref: p），工序/子层节点走
   * branch(n) → nodeEl(n)，n.ref 是 undefined ⇒ c = {} ⇒ **所有字段都是空的** ✗
   *
   * 而节点自己**什么都有**（服务端实测：src / text / role / title / line / via / whole …）。
   * 所以直接整对象合并：n.ref 打底（根节点要靠它），节点自身字段覆盖。
   * ⇒ 一次解决 src / line / text / role / title / via / whole，不再漏字段 ✓
   */
  var c = Object.assign({}, n.ref || {}, n);
  /*
   * ★★★ 跟 openCard 里同一处回填 —— 少了这两行，"保存"送出去的 src 就是空的。
   *
   * 上轮我只修了 openCard 里的 c，于是：卡片头正确地显示出文件名 ✓，
   * 一点保存却仍然报「这个文件没在 project.json 的 md / files 里声明过，拒绝写入:」
   * （冒号后空）✗ —— 因为**保存处理器是另一个闭包，它自己又 n.ref || {} 了一遍** ✗
   *
   * 工序/子层节点没有 ref（全页面只有根节点有），src 挂在**节点自己**身上。
   */
  var msg = document.getElementById('msg'); msg.className=''; msg.textContent='保存中…';
  /*
   * ★ **条目节点：正文从字段框拼出来。**
   *
   * 用户 2026-10-19：「每个节点两个框…给人看，给人改的」
   * ⇒ 卡片上是独立的小框（姓名 / 简介…），保存时按该条目的格式拼回一段 markdown，
   *   连 itemTitle 一起发给宿主 —— 宿主按 ## 标题 定位、**只替换那一段** ✓
   *   （不整份重写文件，免得把别人手动写的部分冲掉）
   */
  var saveText = document.getElementById('ctext').value;
  var itemTitle = '';
  var fieldsBox = document.getElementById('cfields');
  if (c.doc && c.doc.kind === 'item' && fieldsBox && fieldsBox.children.length) {
    var L = [];
    var kids = fieldsBox.children;
    for (var bi = 0; bi < kids.length; bi++) {
      var inp = kids[bi].children[kids[bi].children.length - 1];
      var v = String((inp && inp.value) || '').trim();
      if (!v) continue;
      var lb = String(inp && inp.getAttribute && inp.getAttribute('data-label') || '').trim();
      var isQuote = !!(inp && inp.getAttribute && inp.getAttribute('data-quote'));
      var ftype = String((inp && inp.getAttribute && inp.getAttribute('data-type')) || 'text');
      if (ftype === 'line') L.push(isQuote && lb ? '> ' + lb + '：' + v : v);
      else L.push(v);
      L.push('');
    }
    saveText = L.join('\\n').trim();
    itemTitle = String((c.doc.values && c.doc.values.title) || c.title || n.title || '').trim();
  }
  post('/filmflow/edit', { root: ROOT, src: c.src, line: c.line, whole: !!c.whole,
      title: c.title, kind: n.kind, via: c.via, itemTitle: itemTitle,
      role: document.getElementById('crole').value, text: saveText })
    .then(function(){ msg.textContent='已写回 '+c.src; return load(); })
    .catch(function(e){ msg.className='err'; msg.textContent='写回失败：'+e.message; });
};
document.getElementById('reload').onclick = function(){ load(); };
document.getElementById('fit').onclick = function(){ fit(); };
function fit(){
  var st = document.getElementById('stage'), w = document.getElementById('world');
  var r = w.getBoundingClientRect(), s0 = VIEW.s;
  var bw = r.width/s0, bh = r.height/s0;
  var s = Math.min((st.clientWidth-50)/bw, (st.clientHeight-50)/bh, 1.2);
  VIEW.s = s; VIEW.x = 25; VIEW.y = 25; applyView();
}
/* 拖动 + 滚轮缩放 */
(function(){
  var st = document.getElementById('stage'), drag = null;
  st.addEventListener('mousedown', function(e){
    if (e.target.closest('#card')) return;
    drag = { x:e.clientX-VIEW.x, y:e.clientY-VIEW.y }; st.className='drag'; e.preventDefault();
  });
  window.addEventListener('mousemove', function(e){
    if (!drag) return; VIEW.x = e.clientX-drag.x; VIEW.y = e.clientY-drag.y; applyView();
  });
  window.addEventListener('mouseup', function(){ drag=null; st.className=''; });
  st.addEventListener('wheel', function(e){
    if (e.target.closest('#card')) return;
    e.preventDefault();
    var k = e.deltaY < 0 ? 1.1 : 1/1.1, ns = Math.max(.25, Math.min(2.5, VIEW.s*k));
    var r = st.getBoundingClientRect(), mx = e.clientX-r.left, my = e.clientY-r.top;
    VIEW.x = mx - (mx-VIEW.x)*(ns/VIEW.s); VIEW.y = my - (my-VIEW.y)*(ns/VIEW.s); VIEW.s = ns; applyView();
  }, {passive:false});
  st.addEventListener('mousedown', function(e){ if (e.target === st) document.getElementById('card').className=''; });
})();
function load(){
  return fetch('/filmflow/state').then(function(r){return r.json();}).then(function(j){
    S = j; draw();
  }).catch(function(e){
    /*
     * ★ 以前这里没有 catch ⇒ draw() 一抛就变成未处理的 rejection ⇒ **静默吞掉** ✗
     *   （实测：页面全白、标题还是 "…"、控制台什么都没报）
     * 现在：把错误送回宿主（/filmflow/diag），外面就能查到 ✓
     */
    try {
      fetch('/filmflow/diag', {method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ msg: 'canvas load/draw failed: ' + String((e && e.message) || e),
                               stack: String((e && e.stack) || ''), src: 'canvas.load' })}).catch(function(){});
    } catch (x) {}
    throw e;
  });
}
load();
/*
 * ★★ **轮询** —— 用户 2026-10-16 的第 2 条抱怨就是缺这个：
 *   「每发一句，都不知道它有没有思考好，需要一直手动点刷新。」
 *
 *   原来这一页**只在用户操作时** load() 一次（发送 / 保存 / 改授权 / 点刷新按钮），
 *   没有任何定时轮询 —— 所以 Agent 在后台想出来了，界面永远不知道。
 *
 *   现在：**空闲 1.5 秒一轮，Agent 在干活时 600 毫秒一轮** ——
 *   思考状态和它的输出基本是"跟着走"的。
 *   （真正的 token 级流式要 assistant/live-chunk，那是 API 层
 *    dsh-api-session-controller 发给官方前端的，插件这边够不着 ——
 *    所以这是**准实时**，不是逐字流。）
 */
var POLL_IDLE = 1500, POLL_BUSY = 600, pollTimer = null;
function schedulePoll(){
  if (pollTimer) clearTimeout(pollTimer);
  var busy = false;
  try {
    var p = (S && S.projects || []).filter(function(x){ return x.root === ROOT; })[0];
    busy = !!(p && p.agent && p.agent.busy);
  } catch (e) { /* ignore */ }
  pollTimer = setTimeout(function(){
    load().then(schedulePoll, schedulePoll);
  }, busy ? POLL_BUSY : POLL_IDLE);
}
schedulePoll();

/* ── 把自己报的错送回宿主 ────────────────────────────────────────────────
 *  页面空白的时候，浏览器控制台里的东西我在外面看不到 ⇒ 主动上报。
 */
window.addEventListener('error', function(ev){
  try {
    fetch('/filmflow/diag', {method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({
        msg: String((ev && ev.message) || '') + '  @ ' + String((ev && ev.filename) || '') + ':' + String((ev && ev.lineno) || ''),
        stack: String((ev && ev.error && ev.error.stack) || ''),
        src: 'window.onerror'
      })
    }).catch(function(){});
  } catch (e) {}
});
window.addEventListener('unhandledrejection', function(ev){
  try {
    fetch('/filmflow/diag', {method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ msg: 'unhandledrejection: ' + String((ev && ev.reason && ev.reason.message) || ev && ev.reason || ''), src: 'promise' })
    }).catch(function(){});
  } catch (e) {}
});

/* ── 独立版心跳 ──────────────────────────────────────────────────────────
 *  片场的独立进程靠它判断『还有人在看』：15 秒收不到就自己退出（关窗口 = 关服务）。
 *  DSH 插件版没有这个路由 ⇒ 先问 /filmflow/ping，不是 standalone 就完全不发。
 */
(function(){
  fetch('/filmflow/ping').then(function(r){ return r.json(); }).then(function(j){
    if (!j || j.plugin !== 'filmflow-standalone') return;
    var beat = function(){ fetch('/filmflow/keepalive', {method:'POST'}).catch(function(){}); };
    beat();
    setInterval(beat, 3000);
  }).catch(function(){});
})();
</script>



  </div>
</div>
</body></html>`;
}

/**
 * 每个项目的**消息流** —— 左侧 Agent 栏要显示的东西。
 *
 *   「你对它说过什么」+「插件对它说过什么」
 *
 * ⚠️ **读不到 Agent 的回复文本** —— 它自己的会话日志没有已知的读取接口。
 *    所以这一栏里**不会有它的回话**。它的产出（提案）显示在提案条上，
 *    那本来就是它该出现的地方。用户在栏里输入 → `followup` → 它干活 → 出提案。
 *
 * 内存里存，进程重启就清空（这些都是过程性信息，不值得落盘）。
 */
const agentFeed = new Map();

function pushFeed(root, who, text) {
  const k = String(root).toLowerCase();
  const a = agentFeed.get(k) || [];
  a.push({ at: new Date().toISOString(), who: String(who), text: String(text).slice(0, 4000) });
  while (a.length > 60) a.shift();
  agentFeed.set(k, a);
}

function readFeed(root) {
  return agentFeed.get(String(root).toLowerCase()) || [];
}

/**
 * 读这个项目的 agent 说过什么。
 *
 * ★ **2026-10-15 实测纠正**：我一开始以为"读不到 Agent 的回复文本"——
 *   那是没查到底。`dsh-session/lib/types/index.d.ts:303` 有：
 *
 *     deriveMessages(): Message[];      // Message = dsh-llm 的 UserMessage|AssistantMessage|…
 *
 *   `Message.content` 是 **`readonly ContentBlock[]`**（块数组，不是字符串），
 *   所以要把每块的文字拼起来。**块数组也是 `followup()` 要的形状** ——
 *   同一份类型定义两边都用。
 *
 * 全包在 try/catch 里：这是个探测性调用（`deriveMessages` 是新发现，
 * 运行时行为没验过），读不到就当作没有，不连累页面。
 */
function readAgentMessages(projectRoot, limit) {
  const rec = agentRuns.get(String(projectRoot).toLowerCase());
  if (!rec || !rec.handle || !rec.handle.agent) return [];
  try {
    const s = rec.handle.agent.session;
    if (!s || typeof s.deriveMessages !== 'function') return [];
    const msgs = s.deriveMessages();
    if (!Array.isArray(msgs)) return [];
    const out = [];
    for (const m of msgs) {
      const role = String((m && m.role) || '');
      // 只看对话双方；developer(工具增删) 和 tool(工具结果) 是噪音
      if (role !== 'assistant' && role !== 'user') continue;
      let text = '';
      let reasoning = '';
      const blocks = (m && m.content) || [];
      if (Array.isArray(blocks)) {
        for (const b of blocks) {
          if (!b) continue;
          /*
           * ★ **思考链和回答是两种不同的块** —— 必须分开收。
           *   证据：`dsh-llm/lib/types/assistant-stream.d.ts` 里有
           *   `reasoning-delta` / `reasoning-chunks`；`dsh-session` 的 assembler
           *   文档说 "open **text/reasoning** blocks with non-whitespace content, in stream order"。
           *
           *   原来我把所有块的 `.text` 拼在一起 → **思考链和回答混成一坨**，
           *   界面上就看不出哪句是"它在想"哪句是"它在答"。用户 2026-10-16 提的就是这个。
           *
           *   官方 UI（`dsh-client-ui-chat` 的 ReasoningRow）把思考渲染成
           *   `color: var(--dsw-alias-label-tertiary)` 的次要文字 —— 也就是 #81858c。
           */
          const t = String(b.type || '');
          const s = typeof b.text === 'string' ? b.text : typeof b.content === 'string' ? b.content : '';
          if (!s) continue;
          if (t === 'reasoning' || t === 'thinking' || /reason/i.test(t)) reasoning += s;
          else text += s;
        }
      }
      text = text.trim();
      reasoning = reasoning.trim();
      // 有回答就按回答算；只有思考也算一条（让用户看见它在想什么）
      if (!text && !reasoning) continue;
      out.push({ role, text: text.slice(0, 4000), reasoning: reasoning.slice(0, 6000) });
    }
    return out.slice(-(limit || 30));
  } catch {
    return [];
  }
}

function buildProject(projectRoot) {
  const declPath = join(projectRoot, DECL);

  if (!existsSync(declPath)) {
    return { ok: false, root: projectRoot, error: '找不到工序声明：' + declPath, stages: [] };
  }

  const { decl, error: parseError } = readDecl(declPath);
  if (parseError) {
    return { ok: false, root: projectRoot, error: parseError, stages: [] };
  }

  let stages = [];
  let error = '';
  try {
    stages = (Array.isArray(decl?.stages) ? decl.stages : []).map((s, i) =>
      buildStage(projectRoot, s, 's' + i, 'stages/' + i, '', 'root'),
    );
  } catch (e) {
    error = String((e && e.stack) || e);
  }

  // 依赖与过期（核心功能的「粗」层）。算不出来不算致命，只记错误。
  if (error === '') {
    try {
      // 先把依赖统一成 key（老数据写的是编号，兼容换成 key），再判过期
      resolveDepKeys(stages);
      markStale(stages, readSync(projectRoot));
    } catch (e) {
      error = '过期检测失败：' + String((e && e.message) || e);
    }
  }

  return {
    ok: error === '',
    root: projectRoot,
    declPath,
    id: String(decl?.id ?? ''),
    title: String(decl?.title ?? decl?.id ?? projectRoot),
    error,
    // 这个项目的 agent 在不在跑（界面上那个「暂停」条要用）
    agent: agentStatusOf(projectRoot),
    // 待确认的提案数（画布上那个提案栏要用）
    pendingProposals: readProposals(projectRoot).filter((x) => x.status === 'pending').length,
    // 左侧 Agent 栏要显示的消息流
    feed: readFeed(projectRoot),
    // ★ Agent 自己说过什么（走 session.deriveMessages()）
    agentMsgs: readAgentMessages(projectRoot, 30),
    stages,
  };
}

/* ------------------------------------------------------------------ *
 * HTTP
 * ------------------------------------------------------------------ */

/** 发一段 JSON，禁缓存（状态要即时）。 */
/**
 * ★★ 写操作的闸门。返回 true = 放行；返回 false = 已经回过响应，调用方直接 return。
 *
 * 两道：
 *   ① `x-filmflow-token` 必须等于本进程的 WRITE_TOKEN（防 CSRF —— 跨域读不到页面就抄不到令牌）
 *   ② 带了 `Origin` 且不是本机 ⇒ 直接拒（双保险；curl 之类的无 Origin 请求靠令牌拦）
 */
function requireToken(req, res) {
  const h = (req && req.headers) || {};
  const tok = String(h['x-filmflow-token'] || '');
  if (tok !== WRITE_TOKEN) {
    sendJson(res, 403, {
      ok: false,
      error: '写操作需要令牌。请从画布/资产页发起（页面上会带上），不要直接 POST 这个地址。',
    });
    return false;
  }
  const origin = String(h['origin'] || '');
  if (origin && !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(origin)) {
    sendJson(res, 403, { ok: false, error: '跨站写请求已拒绝：' + origin });
    return false;
  }
  return true;
}

function sendJson(res, code, value) {
  const body = JSON.stringify(value, null, 2);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

/** GET/HEAD-only 守卫；不是就自己回 405 并返回 true。 */
function rejectNonGet(req, res) {
  if (req.method === 'GET' || req.method === 'HEAD') return false;
  res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8', Allow: 'GET' });
  res.end('只支持 GET');
  return true;
}

/**
 * 读请求体（有上限）。读不到就返回空串，绝不抛。
 * @param req node:http 请求
 * @returns 请求体文本
 */
function readBody(req) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size <= MAX_BODY) chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(''));
  });
}

/* ------------------------------------------------------------------ *
 * 插件入口
 * ------------------------------------------------------------------ */

export function apply(ctx, config) {
  /*
   * ★ 规则表自检（2026-10-29）：菜单必须 ⊆ 法定、生成节点的父必须能当依赖。
   * 表写歪了不会崩，只会悄悄放行/多列一项，所以启动就打一行日志；
   * 真出问题在 `node tools/selftest.mjs` 里会红（它把这两条当断言）。
   */
  try {
    const warns = ruleWarnings();
    if (warns.length) {
      for (const w of warns) trace('[规则] ✗ ' + w);
    } else {
      trace('[规则] 层级表自检通过（菜单 ⊆ 法定，生成节点的父都能当依赖）');
    }
    /* 下位白名单（R57）：每个模板声明的下位必须存在、角色合法、与身份表一致 */
    const kidsWarns = childrenWarnings(readTemplates());
    if (kidsWarns.length) {
      for (const w of kidsWarns) trace('[规则] ✗ ' + w);
    } else {
      trace('[规则] 下位表自检通过（每个模板的 ＋ 菜单 = 落盘判据）');
    }
  } catch (e) {
    trace('[规则] 自检脚本本身出错：' + (e && e.message));
  }

  /*
   * ★ roots 的来源（按优先级）：
   *   ① 配置里的 roots 数组
   *   ② 环境变量 FILMFLOW_ROOTS（多个用 ; 隔开）
   * 为什么加 ②：打包后的 profile 里**不能用 !!js 生成数组** ——
   *   实测 YAMLException: unknown tag !!js（标量行，数组不行）。
   *   所以 profile 里干脆不写 roots，改由 spawn 时传环境变量 ✓
   */
  const envRoots = String(process.env.FILMFLOW_ROOTS || '')
    .split(';')
    .map((x) => x.trim())
    .filter(Boolean);
  const roots = Array.isArray(config?.roots) && config.roots.length
    ? config.roots.map((p) => String(p)).filter(Boolean)
    : envRoots;
  /** 用户保存后自动叫醒这个项目的 agent？默认开 —— 这就是用户要的「随叫随到」。 */
  const autoWake = config?.autoAgent !== false;

  /*
   * ★★ **当前正在做的片**（2026-10-20，新架构必需）
   *
   * 片场现在就是**一个** dsh web 进程：左边一栏是官方对话，右边一块是工序画布。
   * 画布上有选片下拉 —— 用户选哪部片，agent 的四把工具就必须只认那部片。
   *
   * 不给这个状态会出什么事（已经踩过一次）：`pickProjects()` 拿不到 `want`
   * 就返回**全部项目**，于是问《测试2》的时候它把《新片》的人物一起端出来
   * —— 串台，而且是设计级的入口。
   *
   * 取值优先级：
   *   ① 用户在画布上点的（`POST /filmflow/select` 写这里）
   *   ② 启动时 `FILMFLOW_PROJECT`（一条快捷方式绑死一部片的情形）
   *   ③ 都没有 ⇒ 空 ⇒ `pickProjects` 会明确报错并列出可用项目，而不是瞎猜
   */
  let CURRENT = String(process.env.FILMFLOW_PROJECT || '').trim();

  /*
   * ★ 启动时生成写操作令牌（每个进程一个，重启就换）。
   *   嵌进两个页面，写操作必须带回它 —— 见 WRITE_TOKEN 的注释。
   */
  if (!WRITE_TOKEN) {
    try {
      WRITE_TOKEN = randomBytes(18).toString('base64url');
    } catch {
      WRITE_TOKEN = String(Date.now()) + String(Math.random()).slice(2);
    }
  }

  /*
   * ★ 把配置里的 preset 交给模块级函数用。
   *   模块级函数拿不到 `config`（那是 apply 的形参）—— v33 就是栽在这上面。
   */
  /*
   * 2026-10-28：默认用 preset-filmflow。文件读写与上网挂在 preset 的 plugins 里，
   * 不传 agentPreset 时它们不会进 agent 作用域（restrict 报 unknown 就是这么来的）。
   * 想回到"只有 8 把片场工具"的旧行为，把 agentPreset 显式配成空字符串即可。
   */
  AGENT_PRESET = String(config?.agentPreset ?? 'filmflow');
  PLUGIN_LOADED_AT = Date.now();
  // ★ 片场 Agent 的独立工作目录（见 AGENT_CWD 那段）—— 一片都不用搬
  try {
    AGENT_CWD = roots[0];   // ★ 2026-10-16：片场有了独立工作区（<片库根>），它就是 cwd
    //（原来是 join(roots[0], '.film-agent') —— 那个临时目录已完成使命）
    trace('agent cwd = ' + AGENT_CWD + '（它的 AGENTS.md 从这里读）');
  } catch (e) {
    trace('设 AGENT_CWD 失败: ' + String((e && e.message) || e));
  }
  // ★ 同步抓住 agents 服务 —— 异步回调里再取会 "inactive context"（实测过）
  AGENTS = ctx.agents;
  AGENT_PROVIDER = String(config?.agentProvider || 'deepseek-official');
  AGENT_MODEL = String(config?.agentModel || 'deepseek-flash');
  /*
   * 用户在「API 设置」里填的模型名优先于叠加层默认值。
   * baseURL 不在这里读 —— 那个是 DSH 的 llm provider 配置，改完要重启。
   */
  try {
    const u = readAgentApi();
    if (u && typeof u.model === 'string' && u.model.trim()) {
      AGENT_MODEL = u.model.trim();
      trace('agent model ← 用户配置：' + AGENT_MODEL);
    }
  } catch { /* 没配过就用默认 */ }
  trace(
    'agent 配置：preset=' + AGENT_PRESET + '　model=' + AGENT_PROVIDER + '/' + AGENT_MODEL + '　autoWake=' + autoWake,
  );

  const explicit = Array.isArray(config?.projects)
    ? config.projects.map((p) => String(p)).filter(Boolean)
    : [];

  /*
   * ★ 旧片层级迁移（R47）：只处理还没打过 `.film/structure-v2.json` 的片子。
   * 用户 2026-10-28：「旧片违规的全都改，现在的旧片全都是测试用途的，没有成本」。
   */
  try {
    const migrated = migrateAllProjects(roots, explicit);
    const changed = migrated.filter((r) => r && r.ok && r.changed);
    if (changed.length) trace('[迁移] 完成：' + changed.length + ' 部片有改动');
  } catch (e) {
    trace('[迁移] 整体失败：' + String((e && e.stack) || e));
  }

  trace(
    'apply() 进入; ctx.webServer=' + typeof (() => { try { return ctx?.get('webServer'); } catch { return null; } })() +
      '; roots=' + roots.length + '; explicit=' + explicit.length,
  );
  for (const r of roots) trace('  root: ' + r + '  存在=' + existsSync(r));

  /*
   * ── 探针：插件能不能注册"模型可见的工具" ──────────────────────────
   *
   * 这是"插件 ↔ Agent 协作"的主路候选。为什么重要：
   *   · 客户端那条（`remote.commands.execute`）是**推**，只有用户点按钮才触发，
   *     帮不了一个已经在干活的 Agent。
   *   · 宿主注册工具是**拉**，Agent 干到一半想知道"1.3 要什么格式"就能自己调。
   *
   * 已知：`piano-practice` 用了 `inject: ['tools']`，说明服务大概率存在，
   * 但 **API 我完全不知道** —— 所以先探，不先写实现。
   *
   * ⚠️ 现在是走 inject 拿到的（`export const inject = ['webServer','tools']`），
   *    所以这次应该能读到真的 API。上一版没 inject，报的是
   *    `cannot get property "tools" without inject` —— 那条错误本身就是"名字对"的证据。
   */
  try {
    const t = ctx?.tools;
    const proto = t ? Object.getOwnPropertyNames(Object.getPrototypeOf(t)) : [];
    trace(
      '[工具探针] ' +
        JSON.stringify({
          hasTools: !!t,
          keys: t ? Object.keys(t).slice(0, 60) : [],
          proto: proto.slice(0, 60),
          candidates: t
            ? ['register', 'registerTool', 'add', 'define', 'tool', 'create', 'list', 'get'].filter(
                (k) => typeof t[k] === 'function',
              )
            : [],
        }),
    );
  } catch (e) {
    trace('[工具探针] 读 ctx.tools 抛了：' + String((e && e.message) || e));
  }

  /*
   * ── 探针：插件能不能**自己起一个 agent run** ────────────────────────
   *
   * 为什么要探这个：用户要的是「一个独立的 Agent，既能传统对话、也能驱动画布，
   * 不依赖原厂会话」。而这套东西的机制死结是「谁给 Agent 回合」。
   * 如果插件能自己 createAgent，触发器就在插件手里，死结自解。
   *
   * 类型声明里已经读到（dsh-agent / dsh-agent-loop）：
   *   · AgentFactory.createAgent(ownerCtx, options) → Promise<AgentHandle>
   *   · options.setup(agentCtx) 里可以注册 **scoped tools / prompt sections /
   *     restrict()** —— 也就是说"定制系统提示词 + 限定工具集"都能做到
   *   · ownerCtx 决定**作用域归属**（"carrying the create() caller's fiber and scope"）
   * 但那是 E2（读文档），这里要的是 E1（跑起来看）。
   */
  try {
    const A = ctx.agents;
    const proto = A ? Object.getOwnPropertyNames(Object.getPrototypeOf(A)) : [];
    trace(
      '[agent 探针] ' +
        JSON.stringify({
          has: !!A,
          keys: A ? Object.keys(A).filter((k) => k[0] !== '_').slice(0, 40) : [],
          proto: proto.filter((k) => k !== 'constructor').slice(0, 40),
          createAgent: A ? typeof A.createAgent : 'n/a',
          create: A ? typeof A.create : 'n/a',
        }),
    );
  } catch (e) {
    trace('[agent 探针] 读 ctx.agents 抛了：' + String((e && e.message) || e));
  }
  /*
   * ══ agent 实验（阶段 B 的第一步：只验能不能跑，不做功能）════════════
   *
   * 为什么先做这个而不是先做 UI（用户 2026-10-15 纠正，他是对的）：
   *   独立页面是**零信息增量**的活 —— 搬位置、放大。而全部未知都在这儿：
   *     · 插件的 fiber 起不起得来 createAgent？
   *     · setup(agentCtx) 真能拿到吗？restrict() 真挡得住 bash 吗？
   *     · followup() 送一句话，回复从哪儿收？
   *   先做 UI = 围着假设搭壳。跑不通，壳全废。
   *
   * 只验四件事，一个字节的功能都不做：
   *   ① factory 拿得到吗（requireFactory / .factory）
   *   ② createAgent 起得来吗（用 config 里的开关，别每次启动都跑）
   *   ③ setup(agentCtx) 给到什么（prompt / tools / restrict 是不是真在）
   *   ④ followup 之后有没有回复进来（听 session 事件或看 whenIdle 之后的状态）
   *
   * ⚠️ 只在 config.probeAgent === true 时跑 —— 它要花真 token。
   */
  if (config?.probeAgent === true) {
    const seen = [];
    const say = (m) => {
      seen.push(m);
      trace('[agent 实验] ' + m);
    };
    try {
      const reg = ctx.agents;
      say('registry 有 requireFactory = ' + typeof reg.requireFactory + ' / .factory = ' + typeof reg.factory);
      const fac = typeof reg.requireFactory === 'function' ? reg.requireFactory() : reg.factory;
      say('factory = ' + typeof fac + ' / createAgent = ' + (fac ? typeof fac.createAgent : 'n/a'));
      /*
       * ⚠️ 实测（2026-10-15）：`requireFactory()` 返回一个 object，但它的
       *    `createAgent` 是 **undefined** —— 那个带 `setup(agentCtx)` 的接口
       *    **不在 ctx.agents 暴露的 factory 上**。
       *    而 `ctx.agents.create` 是函数，签名 `create(id, AgentOptions, meta)`，
       *    偏偏 `AgentOptions` 只有 provider/model/reasoningEffort/maxTokens —— 没有 setup。
       *    所以这一轮先把 factory 的**真实方法表** dump 出来，找 setup 到底从哪进。
       */
      try {
        say('factory 自有键: ' + Object.keys(fac).filter((k) => k[0] !== '_').slice(0, 40).join(','));
        const proto = Object.getOwnPropertyNames(Object.getPrototypeOf(fac));
        say('factory 原型方法: ' + proto.filter((k) => k !== 'constructor').slice(0, 60).join(','));
        say('registry 自有键: ' + Object.keys(reg).filter((k) => k[0] !== '_').slice(0, 40).join(','));
        say(
          'factory 关键方法: ' +
            ['createAgent', 'create', 'setup', 'withSetup']
              .map((k) => {
                let t = 'n/a';
                try {
                  t = typeof fac[k];
                } catch (e) {
                  t = 'throw:' + String(e.message).slice(0, 30);
                }
                return k + '=' + t;
              })
              .join(' '),
        );
      } catch (e) {
        say('dump factory 抛: ' + String(e.message));
      }
      /*
       * ★ 实测（2026-10-15）：requireFactory() 返回的是 **cordis 的追踪代理** ——
       *   自有键只有 `target`，原型上只有 Object.prototype 那一套，所有业务方法
       *   都读成 undefined。真对象在 **`.target`** 后面。
       *   （追踪代理会记录"这个插件读了哪些属性"，用来算依赖 —— 所以方法名读不到。）
       *   下面把 target 也 dump 一遍，找 setup 到底从哪进。
       */
      try {
        const real = fac && fac.target ? fac.target : null;
        say('fac.target = ' + typeof real);
        if (real) {
          say('  target 自有键: ' + Object.keys(real).filter((k) => k[0] !== '_').slice(0, 50).join(','));
          const p2 = Object.getOwnPropertyNames(Object.getPrototypeOf(real));
          say('  target 原型方法: ' + p2.filter((k) => k !== 'constructor').slice(0, 70).join(','));
          say(
            '  target 关键方法: ' +
              ['createAgent', 'create', 'setup', 'withSetup', 'resume']
                .map((k) => {
                  let t = 'n/a';
                  try {
                    t = typeof real[k];
                  } catch (e) {
                    t = 'throw';
                  }
                  return k + '=' + t;
                })
                .join(' '),
          );
        }
      } catch (e) {
        say('dump target 抛: ' + String(e.message));
      }

      /*
       * ★★ 真正调一次 createAgent —— 前面的 dump 只证明"方法在"，
       *     这一步才证明"调得通、setup 会被调到"。
       *
       * 关键：走 **`.target`**（cordis 追踪代理后面的真对象）。
       *
       * 不调 followup —— 那会花真 token。createAgent 本身只是建 agent，
       * 发消息才触发模型调用。验完立刻 dispose，不留一个空跑的 agent。
       */
      try {
        const realFac = fac && fac.target ? fac.target : null;
        if (realFac && typeof realFac.createAgent === 'function') {
          const sid = 'filmflow-probe-' + Date.now();
          say('★★ 开始真的 createAgent, sessionId = ' + sid);
          realFac
            .createAgent(ctx, {
              sessionId: sid,
              meta: { cwd: roots[0] },
              agentOptions: {},
              setup(agentCtx) {
                say('★★★ setup 被调到了！agentCtx = ' + typeof agentCtx);
                try {
                  say('  agentCtx 顶层键: ' + Object.keys(agentCtx).slice(0, 40).join(','));
                } catch (e) {
                  say('  读 agentCtx 键抛: ' + String(e.message));
                }
                for (const k of ['prompt', 'tools', 'systemPrompt', 'session', 'agent', 'llm']) {
                  try {
                    say('  agentCtx.' + k + ' = ' + typeof agentCtx[k]);
                  } catch (e) {
                    say('  agentCtx.' + k + ' 抛: ' + String(e.message));
                  }
                }
                try {
                  if (agentCtx.tools && typeof agentCtx.tools.restrict === 'function') {
                    agentCtx.tools.restrict({ deny: ['bash', 'pwsh'] });
                    say('★★ restrict({deny:[bash,pwsh]}) 调用成功（能不能真挡住，另行验）');
                  } else {
                    say('  agentCtx.tools.restrict 不可用');
                  }
                } catch (e) {
                  say('  restrict 抛: ' + String(e.message));
                }
              },
            })
            .then((h) => {
              say('★★★ createAgent 成功！handle 键 = ' + Object.keys(h).join(','));
              say('  agent = ' + typeof h.agent);
              try {
                say('  status = ' + JSON.stringify(h.agent && h.agent.status));
              } catch (e) {
                say('  读 status 抛');
              }
              say(
                '  followup=' +
                  typeof (h.agent && h.agent.followup) +
                  ' cancel=' +
                  typeof (h.agent && h.agent.cancel) +
                  ' whenIdle=' +
                  typeof (h.agent && h.agent.whenIdle) +
                  ' inbox=' +
                  typeof (h.agent && h.agent.inbox),
              );
              return typeof h.dispose === 'function' ? h.dispose() : null;
            })
            .then(() => say('  已 dispose（不留空跑的 agent）'))
            .catch((e) => say('✗ createAgent 抛: ' + String((e && e.stack) || e)));
        } else {
          say('✗ target.createAgent 不是函数，调用这一步跳过');
        }
      } catch (e) {
        say('✗ createAgent 实验外层抛: ' + String((e && e.stack) || e));
      }
      if (fac && typeof fac.createAgent === 'function') {
        const sid = 'filmflow-probe-' + Date.now();
        say('开始 createAgent, sessionId = ' + sid);
        fac
          .createAgent(ctx, {
            sessionId: sid,
            meta: { cwd: roots[0] },
            agentOptions: {},
            setup(agentCtx) {
              say('★ setup 被调到了，agentCtx = ' + typeof agentCtx);
              try {
                say('agentCtx 顶层键: ' + Object.keys(agentCtx).slice(0, 40).join(','));
              } catch (e) {
                say('读 agentCtx 键抛: ' + String(e.message));
              }
              for (const k of ['prompt', 'tools', 'systemPrompt', 'session', 'agent']) {
                try {
                  say('  agentCtx.' + k + ' = ' + typeof agentCtx[k]);
                } catch (e) {
                  say('  agentCtx.' + k + ' 抛: ' + String(e.message));
                }
              }
              try {
                if (agentCtx.tools && typeof agentCtx.tools.restrict === 'function') {
                  agentCtx.tools.restrict({ deny: ['bash', 'pwsh'] });
                  say('★ restrict({deny:[bash,pwsh]}) 调用成功（能不能真挡住还没验）');
                } else {
                  say('agentCtx.tools.restrict 不可用');
                }
              } catch (e) {
                say('restrict 抛: ' + String(e.message));
              }
            },
          })
          .then((h) => {
            say('★★ createAgent 成功！handle 键 = ' + Object.keys(h).join(','));
            say('  agent = ' + typeof h.agent + ' / status = ' + JSON.stringify(h.agent && h.agent.status));
            say('  agent.ctx = ' + typeof (h.agent && h.agent.ctx) + ' / followup = ' + typeof (h.agent && h.agent.followup));
            say('  session = ' + typeof (h.agent && h.agent.session));
            return h;
          })
          .catch((e) => say('✗ createAgent 抛了: ' + String((e && e.stack) || e)));
      }
    } catch (e) {
      say('✗ 实验外层抛了: ' + String((e && e.stack) || e));
    }
  }

  if (!ctx || typeof ctx.effect !== 'function') {
    trace('中止：ctx.effect 不是函数');
    return;
  }
  /*
   * ══ ★★ 在 agent 作用域里自绑工具集（独立版 / headless 形态）══
   *
   * 发现（2026-10-20 实测）：`dsh --profile headless` 里 agent 拿到的是**核心默认工具**
   * （read / write / edit / glob / grep / pwsh / working_directory / read_image）——
   * 它们来自 `dsh-base`，**不受 agent preset 的 `plugins` 列表影响** ✗
   * ⇒ 用户要的「能力限制死」在这个形态下**不成立** ✗（它能 pwsh 改任意文件）
   *
   * 真正的闸门是 `ctx.tools.restrict()` —— 而它必须在 **agent 作用域** 调。
   * 本插件被 preset 加载时，`ctx` 就是 agent 作用域 ✓
   * 判据：**没有 webServer 服务** ⇒ 不是 profile 级（web 里一定有）
   * ⇒ 这时把可见工具**限定成四把片场工具**，核心工具全部挡掉 ✓
   */
  const webServer = (() => {
    /*
     * 先看 `ctx.webServer`（DSH 的正常形态，也是自测脚本里假 ctx 的形态），
     * 再退回 `ctx.get('webServer')`（不注入时的惰性获取）。
     * ⚠️ 顺序不能反：自测的假 ctx 没有 `get` 方法，反了就是"路由一个都没注册" ✗
     */
    try {
      if (ctx.webServer && typeof ctx.webServer.register === 'function') return ctx.webServer;
    } catch {
      /* 忽略 */
    }
    try {
      const real = ctx.get('webServer');
      if (real && typeof real.register === 'function') return real;
    } catch {
      /* 没这个服务 */
    }
    /*
     * ★★ **没有 webServer 时给一个空壳** —— 这是让插件在 headless 里也能用的关键。
     *
     * 2026-10-20 实测（`~/.dsh\filmflow-trace.log`）：
     *     apply() 进入; ctx.webServer=undefined
     *     中止：webServer.register 不可用
     * ⇒ **早退把后面的四个工具注册全跳过了** ✗ ⇒ headless 的 agent 拿不到片场工具 ✗
     *
     * 现在：register 变成无操作（返回空 disposer）⇒ 13 个路由在这里等于不存在，
     * 但代码**继续往下走**，四个工具照常注册 ✓✓✓
     * （headless 本来就不需要 HTTP 路由 —— 画布是独立进程那边的事）
     */
    return { register: () => () => {} };
  })();
  const isAgentScope = !webServer;
  if (isAgentScope && ctx.tools && typeof ctx.tools.restrict === 'function') {
    try {
      /*
       * 2026-10-28：用户要求 agent 保留**上网**与**读写文件**，但要挡掉 shell 与跨片/跨会话能力。
       * 全量名单见下面 AGENT_ALLOWED_TOOLS；这里只放列表里确实起了作用的那几把。
       */
      ctx.tools.restrict({ allow: ['filmflow_board', 'filmflow_node', 'filmflow_propose', 'filmflow_sync'] });
      trace('★★ agent 作用域：已把可见工具限定成四把片场工具');
    } catch (e) {
      trace('★★ restrict 失败: ' + String((e && e.message) || e));
    }
  }
  // （早退已删除 —— 见上面 webServer 空壳的注释）

  /** 每次请求现发现 + 现算，所以加文件、改声明、建新片都只需刷新。 */
  function currentState() {
    const out = { ok: true, generatedAt: new Date().toISOString(), roots, current: CURRENT, projects: [] };

    let roots0 = [];
    try {
      roots0 = discoverProjects(roots, explicit);
    } catch (e) {
      out.error = '发现项目失败：' + String((e && e.message) || e);
      return out;
    }

    for (const root of roots0) {
      try {
        const p = buildProject(root);
        // 声明里写 hidden: true 就不列出来。比改全局配置合理 —— 局部决定。
        let hidden = false;
        if (existsSync(join(root, DECL))) {
          const { decl } = readDecl(join(root, DECL));
          hidden = decl?.hidden === true;
        }
        if (!hidden) {
          /*
           * 媒体节点：把「该节点最新的一条素材 + 当前任务状态」补进去。
           * 用户定的：画布上一个节点只展示**最新**生成的素材（历史都在素材库里）。
           */
          try {
            MEDIA.attachLatest(root, p.stages || []);
          } catch (e) {
            trace('[媒体] 补 latest 失败：' + String((e && e.message) || e));
          }
          out.projects.push(p);
        }
      } catch (e) {
        out.projects.push({ ok: false, root, error: String((e && e.stack) || e), stages: [] });
      }
    }
    /*
     * 新项目排最前（用户 2026-10-23）。
     * 排序依据：`.film/project.json` 的创建时间（没有就退到文件 mtime）——
     * 这样**新建的片一定在最前面**，老片之间保持相对顺序不变。
     */
    const stampOf = (p) => {
      try {
        const f = join(p.root, ".film", "project.json");
        return statSync(f).birthtimeMs || statSync(f).mtimeMs || 0;
      } catch {
        return 0;
      }
    };
    out.projects.sort((a, b) => stampOf(b) - stampOf(a));
    return out;
  }

  /*
   * ══ 页面心跳 + 空闲自退 ═══════════════════════════════════════════════
   *
   * 用户 2026-10-20 的要求：「双击一个快捷方式即开前端 + 启动服务；
   * **关掉前端，服务也自己停**。」
   *
   * 为什么不用"端口有没有连接"来判断：
   *   dsh 只是被浏览器连过一次，断开之后进程照旧活着 —— 关掉窗口它不会退。
   *
   * 为什么不用"精确的断开事件"：
   *   `connection` 服务没有对外暴露"最后一个客户端走了"的事件（查过 d.ts）。
   *   硬去 hook 它的内部 Peer 表，等于把自己的稳定性绑在别人的私有实现上。
   *
   * ⇒ 用**心跳 + 长超时**：
   *   · 页面每 20 秒打一次 `/filmflow/keepalive`（画布/资产页有请求也会更新）
   *   · 超过 `FILMFLOW_IDLE_EXIT_MIN` 分钟（默认 20）没有心跳 ⇒ 退出进程
   *
   * 为什么是 20 分钟，不是 2 分钟：
   *   Chrome 会把**后台标签页**的定时器压到约 1 分钟一次，甚至冻结。
   *   超时设短了，"切到别的窗口干会儿活"就会被误判成"人走了"而自杀
   *   —— 这个坑我踩过（独立版 15 秒看门狗，用户当时报的就是"一会说没连接"）。
   *   20 分钟足够长，只收掉真正被关掉的窗口。
   */
  let LAST_SEEN = 0;
  const touch = () => { LAST_SEEN = Date.now(); };

  try {
    ctx.effect(
      () =>
        webServer.register({
          kind: 'exact',
          path: '/filmflow/keepalive',
          handler: (req, res) => {
            touch();
            sendJson(res, 200, { ok: true, seen: new Date(LAST_SEEN).toISOString() });
          },
        }),
      'filmflow: POST /filmflow/keepalive',
    );
    trace('已注册路由 /filmflow/keepalive');
  } catch (e) {
    trace('注册 /filmflow/keepalive 抛出: ' + String((e && e.stack) || e));
  }

  const IDLE_EXIT_MIN = Number(process.env.FILMFLOW_IDLE_EXIT_MIN || 0);
  if (IDLE_EXIT_MIN > 0) {
    /*
     * ★ 休眠/时钟跳变保护（2026-10-28 实测踩到）：
     *   笔记本合盖过夜/休眠后，本进程和页面**同时**被冻住；醒来时定时器先跳，
     *   页面还没来得及发心跳 ⇒ 21 分钟"没心跳"被误判成"人走了"，服务自退、
     *   窗口留在那儿，用户点「新建片子」只看到 `Failed to fetch`。
     * 判据：本定时器自己的间隔是 60s；若两次 tick 之间实际过了 >90s，
     *   说明机器被挂起过 —— 把这段空白从"空闲"里扣掉，重置心跳，不退出。
     */
    let prevTick = Date.now();
    const timer = setInterval(() => {
      const now = Date.now();
      const gap = now - prevTick;
      prevTick = now;
      if (gap > 90000) {
        if (LAST_SEEN) LAST_SEEN = now;
        trace('[空闲自退] 时钟跳变 ' + Math.round(gap / 1000) + ' 秒（疑似休眠/挂起），已重置心跳');
        return;
      }
      // 从来没有页面连过 ⇒ 不动。可能是后台预启，也可能是有人在用别的方式访问。
      if (!LAST_SEEN) return;
      const idleMs = now - LAST_SEEN;
      if (idleMs < IDLE_EXIT_MIN * 60000) return;
      trace('[空闲自退] ' + Math.round(idleMs / 60000) + ' 分钟没有页面心跳，退出进程');
      process.exit(0);
    }, 60000);
    if (typeof timer.unref === 'function') timer.unref();
    ctx.effect(() => () => clearInterval(timer), 'filmflow: idle watchdog');
    trace('空闲自退已启用：' + IDLE_EXIT_MIN + ' 分钟');
  }

  /* ---- GET /filmflow/ping ---- */
  try {
    ctx.effect(
      () =>
        webServer.register({
          kind: 'exact',
          path: '/filmflow/ping',
          handler: (req, res) => {
            if (rejectNonGet(req, res)) return;
            touch();
            /* 诊断字段（2026-10-30）：用户模板文件在哪、读到了几条 —— 排查"存了没生效"用 */
            sendJson(res, 200, {
              ok: true,
              plugin: name,
              t: new Date().toISOString(),
              userTemplates: userTemplatesPath(),
              userCount: readUserTemplates().length,
              tplCount: readTemplates().length,
            });
          },
        }),
      'filmflow: GET /filmflow/ping',
    );
    trace('已注册路由 /filmflow/ping');
  } catch (e) {
    trace('注册 /filmflow/ping 抛出: ' + String((e && e.stack) || e));
  }

  /* ---- GET /filmflow/token ----
   *
   * 把写操作令牌发给**同源的片场页面**。
   *
   * 为什么需要这个路由：画布现在是官方 Web UI 里的一个客户端插件（浏览器半边），
   * 它拿不到插件启动时内联进 HTML 的 `var WRITE_TOKEN = "…"`。
   *
   * 为什么不降低安全性：令牌本来就是「跨站拿不到」的东西 ——
   *   · 浏览器发同源请求时一定带 `Sec-Fetch-Site: same-origin`
   *   · 跨站页面哪怕是 <script> / <img> / fetch，带的都是 cross-site
   *   · 无 Sec-Fetch-* 的老客户端（curl 之类）必须没有 Origin，或 Origin 是本机
   * ⇒ 与"内联进页面"等价：别的站点读不到，本机页面读得到。
   */
  try {
    ctx.effect(
      () =>
        webServer.register({
          kind: 'exact',
          path: '/filmflow/token',
          handler: (req, res) => {
            if (rejectNonGet(req, res)) return;
            const h = req.headers || {};
            const sfs = String(h['sec-fetch-site'] || '');
            const origin = String(h['origin'] || '');
            const localOrigin = !origin || /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(origin);
            if (!(sfs === 'same-origin' || sfs === 'none' || (!sfs && localOrigin))) {
              sendJson(res, 403, { ok: false, error: '跨站取令牌已拒绝' });
              return;
            }
            sendJson(res, 200, { ok: true, token: WRITE_TOKEN });
          },
        }),
      'filmflow: GET /filmflow/token',
    );
    trace('已注册路由 /filmflow/token');
  } catch (e) {
    trace('注册 /filmflow/token 抛出: ' + String((e && e.stack) || e));
  }

  /* ---- POST /filmflow/select ----
   *
   * 画布上换了片 ⇒ 告诉宿主"现在做的是这部"。
   * 之后 agent 的四把工具不传 project 也只会认这一部 —— 见 CURRENT 那段注释。
   *
   * 只接受**已经发现到的项目**（按 root 精确匹配），不接受任意路径：
   * 否则一个手滑的路径就能让 agent 去别的目录读写。
   */
  try {
    ctx.effect(
      () =>
        webServer.register({
          kind: 'exact',
          path: '/filmflow/select',
          handler: async (req, res) => {
            if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '只接受 POST' });
            if (!requireToken(req, res)) return;
            let body = {};
            try {
              body = JSON.parse((await readBody(req)) || '{}');
            } catch {
              return sendJson(res, 400, { ok: false, error: '请求体不是 JSON' });
            }
            const norm = (s) => String(s || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
            const want = norm(body.root || body.id || '');
            if (!want) return sendJson(res, 400, { ok: false, error: '要给我 root 或 id' });
            let hit = null;
            try {
              for (const r of discoverProjects(roots, explicit)) {
                const p = buildProject(r);
                if (!p.ok) continue;
                if (norm(p.root) === want || norm(p.id) === want) { hit = p; break; }
              }
            } catch (e) {
              return sendJson(res, 500, { ok: false, error: String((e && e.message) || e) });
            }
            if (!hit) return sendJson(res, 404, { ok: false, error: '没有这个项目：' + String(body.root || body.id) });
            CURRENT = hit.root;
            trace('当前项目切换为 ' + CURRENT);
            return sendJson(res, 200, { ok: true, current: CURRENT, title: hit.title });
          },
        }),
      'filmflow: POST /filmflow/select',
    );
    trace('已注册路由 /filmflow/select');
  } catch (e) {
    trace('注册 /filmflow/select 抛出: ' + String((e && e.stack) || e));
  }

  /* ---- GET/POST /filmflow/session ----
   *
   * 「一个项目绑定一个会话」：每部片记一个 DSH SessionId，存在片子的
   * `.film/session.json` 里（跟着项目走，换机器/搬家都还在）。
   *
   * 为什么存在片上、而不是插件内存里：
   *   重启片场、换一台机器打开同一个项目，都该接回**同一条会话** ——
   *   这是"一个项目一条会话"的物理含义。内存里丢一次就等于换了个新会话。
   *
   * 宿主不认识 SessionId 的语义，只当它是个字符串存着 —— 会话存不存在由客户端判断：
   * 客户端 `openSession` 失败时会自己重建一条，然后回写这里覆盖陈旧的 id。
   */
  try {
    ctx.effect(
      () =>
        webServer.register({
          kind: 'exact',
          path: '/filmflow/session',
          handler: async (req, res) => {
            const norm = (s) => String(s || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
            let body = {};
            if (req.method === 'POST') {
              if (!requireToken(req, res)) return;
              try {
                body = JSON.parse((await readBody(req)) || '{}');
              } catch {
                return sendJson(res, 400, { ok: false, error: '请求体不是 JSON' });
              }
            } else if (req.method !== 'GET') {
              return sendJson(res, 405, { ok: false, error: '只接受 GET / POST' });
            }

            let want = '';
            if (req.method === 'GET') {
              const u = new URL(req.url || '/', 'http://127.0.0.1');
              want = norm(u.searchParams.get('root') || '');
            } else {
              want = norm(body.root || '');
            }
            if (!want) return sendJson(res, 400, { ok: false, error: '要给我 root' });

            let root = null;
            try {
              for (const r of discoverProjects(roots, explicit)) {
                if (norm(r) === want) { root = r; break; }
              }
            } catch (e) {
              return sendJson(res, 500, { ok: false, error: String((e && e.message) || e) });
            }
            if (!root) return sendJson(res, 404, { ok: false, error: '没有这个项目' });

            const file = join(root, '.film', 'session.json');
            if (req.method === 'GET') {
              let sessionId = '';
              try {
                sessionId = String(JSON.parse(readFileSync(file, 'utf8')).sessionId || '');
              } catch { /* 还没绑过 */ }
              return sendJson(res, 200, { ok: true, root, sessionId });
            }

            const sessionId = String(body.sessionId || '').trim();
            if (!sessionId) return sendJson(res, 400, { ok: false, error: '要给我 sessionId' });
            try {
              mkdirSync(dirname(file), { recursive: true });
              writeFileSync(file, JSON.stringify({ sessionId, at: new Date().toISOString() }, null, 2) + '\n', 'utf8');
            } catch (e) {
              return sendJson(res, 500, { ok: false, error: '写不进去：' + String((e && e.message) || e) });
            }
            trace('[会话绑定] ' + root + ' -> ' + sessionId);
            return sendJson(res, 200, { ok: true, root, sessionId });
          },
        }),
      'filmflow: /filmflow/session',
    );
    trace('已注册路由 /filmflow/session');
  } catch (e) {
    trace('注册 /filmflow/session 抛出: ' + String((e && e.stack) || e));
  }

  /* ---- GET /filmflow/state ---- */
  try {
    ctx.effect(
      () =>
        webServer.register({
          kind: 'exact',
          path: '/filmflow/state',
          handler: (req, res) => {
            if (rejectNonGet(req, res)) return;
            touch();   // 画布每 2 秒读一次状态，本身也是一次心跳
            try {
              const st = currentState();
              sendJson(res, 200, st);

              /*
               * ★ 懒唤醒已删除（2026-10-22，用户：「为什么每次打开都有这个」）。
               *
               * 这里原来在**每次读 state** 时，给每个还没有 agent 的项目发一条
               * 「【片场插件】用户打开了这个项目……不要为此调用工具」的唤醒消息，
               * 想借 resume 把历史接回来。但它是一条**真的对话消息**：
               *   · 每开一次片，历史里就多一对「你打开了这个项目 / 在。」
               *   · 一次启动把四部片全唤醒一遍，白烧 token
               *   · silent 只是不进 feed，仍然会进会话历史
               * 现在会话接回由客户端 `openSession(bound)` 直接打开（实测有效），
               * 根本不需要往对话里塞话 ⇒ 整段删掉。
               */
            } catch (e) {
              trace('构造状态抛出: ' + String((e && e.stack) || e));
              sendJson(res, 500, { ok: false, error: String((e && e.message) || e) });
            }
          },
        }),
      'filmflow: GET /filmflow/state',
    );
    trace('已注册路由 /filmflow/state');
  } catch (e) {
    trace('注册 /filmflow/state 抛出: ' + String((e && e.stack) || e));
  }

  /* ---- POST /filmflow/diag ---- */
  try {
    ctx.effect(
      () =>
        webServer.register({
          kind: 'exact',
          path: '/filmflow/diag',
          handler: async (req, res) => {
            if (req.method !== 'POST') {
              res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8', Allow: 'POST' });
              res.end('只支持 POST');
              return;
            }
            const raw = await readBody(req);
            let parsed;
            try {
              parsed = JSON.parse(raw);
            } catch {
              parsed = { raw: raw.slice(0, 500) };
            }
            trace('[浏览器侧] ' + JSON.stringify(parsed));
            sendJson(res, 200, { ok: true });
          },
        }),
      'filmflow: POST /filmflow/diag',
    );
    trace('已注册路由 /filmflow/diag');
  } catch (e) {
    trace('注册 /filmflow/diag 抛出: ' + String((e && e.stack) || e));
  }

  /* ---- POST /filmflow/edit ---- 唯一会改用户文件的入口，三道护栏见文件上部 */
  try {
    ctx.effect(
      () =>
        webServer.register({
          kind: 'exact',
          path: '/filmflow/edit',
          handler: async (req, res) => {
            /* ★ 写操作闸门 —— 见 requireToken 的注释 */
            if (!requireToken(req, res)) return;
            if (req.method !== 'POST') {
              res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8', Allow: 'POST' });
              res.end('只支持 POST');
              return;
            }

            let body;
            try {
              body = JSON.parse(await readBody(req));
            } catch {
              sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' });
              return;
            }

            // 项目必须是已发现的那几个之一，不能由客户端随便指一个目录
            const wanted = String(body?.root || '').replace(/[\\/]+$/, '').toLowerCase();
            const root = discoverProjects(roots, explicit).find(
              (r) => r.toLowerCase() === wanted,
            );
            if (!root) {
              sendJson(res, 400, { ok: false, error: 'root 不在已发现的项目里：' + String(body?.root || '') });
              return;
            }

            // ---- 改声明（工序节点 / 子层 / 片名）----
            if (body?.target === 'decl') {
              try {
                const r = editDecl(root, body.declPath, body.fields);
                trace('[写声明] ' + JSON.stringify(r));
                sendJson(res, 200, { ok: true, ...r });
              } catch (e) {
                trace('[写声明失败] ' + String((e && e.message) || e));
                sendJson(res, 500, { ok: false, error: String((e && e.message) || e) });
              }
              return;
            }

            /*
             * ══ ★★ itemTitle：只替换文件里 `## <标题>` 那一段 ══
             *
             * 用户 2026-10-19：「每个节点两个框…给人看，给人改的」——
             * 一个角色一个节点（list 形态拆出来的条目节点）。卡片上是独立的小框，
             * 保存时按条目的格式拼回一段 markdown 送过来，**带 itemTitle 说明是哪一条**。
             *
             * 这里**只动那一段**，不整份重写文件 —— 免得把用户手动写的其他部分冲掉。
             */
            if (body?.itemTitle) {
              const rel2 = String(body?.src || '').replace(/\\/g, '/');
              const abs2 = rel2 ? join(root, ...rel2.split('/')) : '';
              if (!abs2 || !existsSync(abs2)) {
                sendJson(res, 404, { ok: false, error: '文件还不存在：' + rel2 });
                return;
              }
              const want = String(body.itemTitle).trim();
              const raw2 = readFileSync(abs2, 'utf8');
              const ls2 = raw2.split(/\r?\n/);
              // 找 `## <want>`（标题可能带前后缀，用包含匹配）
              let s0 = -1;
              for (let i = 0; i < ls2.length; i++) {
                const m2 = ls2[i].match(/^(#{2,6})\s+(.*)$/);
                if (m2 && String(m2[2]).trim().indexOf(want) >= 0) {
                  s0 = i;
                  break;
                }
              }
              if (s0 < 0) {
                sendJson(res, 404, {
                  ok: false,
                  error: '文件里找不到 `## ' + want + '` 这一段：' + rel2 + '（可能是刚刚改名了，刷新后再试）',
                });
                return;
              }
              // 结束位置：下一个 **同级或更高级** 标题
              const lvl = (ls2[s0].match(/^(#{2,6})/) || ['', '##'])[1].length;
              let e0 = ls2.length;
              for (let i = s0 + 1; i < ls2.length; i++) {
                const m3 = ls2[i].match(/^(#{2,6})\s+/);
                if (m3 && m3[1].length <= lvl) {
                  e0 = i;
                  break;
                }
              }
              const head2 = ls2[s0];
              const newBody = String(body.text || '');
              const out2 = [...ls2.slice(0, s0), head2, '', newBody, ''];
              const rest2 = ls2.slice(e0);
              if (rest2.length) out2.push(...rest2);
              const backup2 = abs2 + '.bak-' + Date.now().toString(36);
              try {
                writeFileSync(backup2, raw2, 'utf8');
              } catch {
                /* 备份失败不拦 */
              }
              writeFileSync(abs2, out2.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '') + '\n', 'utf8');
              trace('[改条目] ' + rel2 + ' §' + want + ' → ' + newBody.length + ' 字符');
              sendJson(res, 200, { ok: true, mode: 'item', src: rel2, item: want, backup: backup2 });
              return;
            }
            const { decl, error: declErr } = readDecl(join(root, DECL));
            if (declErr) {
              sendJson(res, 500, { ok: false, error: declErr });
              return;
            }

            const rel = String(body?.src || '').replace(/\\/g, '/');
            const abs = join(root, ...rel.split('/'));
            if (!isWritable(root, decl, abs)) {
              trace('[写回被拒] 不在声明白名单里: ' + abs);
              sendJson(res, 403, {
                ok: false,
                error: '这个文件没在 project.json 的 md / files 里声明过，拒绝写入：' + rel,
              });
              return;
            }

            try {
              /*
               * 注意：**正文改动不做自动传播**（用户 2026-10-22：
               * 「我说的自动不是全自动，之前规定的必须先有提案手动确认的，就保持」）。
               * 正文是内容 ⇒ 走 propose + 人工确认；
               * 只有**改名**（确定性替换）才自动统一，见 structureOp 里的 autoUnify。
               */
              const r = applyEdit(root, body);
              trace('[写回] ' + JSON.stringify(r));
              sendJson(res, 200, { ok: true, ...r });

              // ★ 「插件先向 Agent 发送一次调用」—— 就是这儿
              if (autoWake) {
                try {
                  const p0 = buildProject(root);
                  wakeAgent(
                    ctx,
                    root,
                    roots[0],
                    composeWake(p0, String(body?.src || '') + '（' + r.mode + '）', staleOf(p0)),
                    trace,
                  );
                } catch (e) {
                  trace('[叫醒失败] ' + String((e && e.message) || e));
                }
              }
            } catch (e) {
              trace('[写回失败] ' + String((e && e.message) || e));
              sendJson(res, 500, { ok: false, error: String((e && e.message) || e) });
            }
          },
        }),
      'filmflow: POST /filmflow/edit',
    );
    trace('已注册路由 /filmflow/edit');
  } catch (e) {
    trace('注册 /filmflow/edit 抛出: ' + String((e && e.stack) || e));
  }

  /* ---- POST /filmflow/apply ---- 下游直写（上游改动引起过期时，agent 可直接写） */
  try {
    ctx.effect(
      () =>
        webServer.register({
          kind: 'exact',
          path: '/filmflow/apply',
          handler: async (req, res) => {
            if (req.method !== 'POST') {
              res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8', Allow: 'POST' });
              res.end('只支持 POST');
              return;
            }
            let body;
            try {
              body = JSON.parse(await readBody(req));
            } catch {
              sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' });
              return;
            }
            const wanted = String(body?.root || '').replace(/[\\/]+$/, '').toLowerCase();
            const root = discoverProjects(roots, explicit).find((r) => r.toLowerCase() === wanted);
            if (!root) {
              sendJson(res, 400, { ok: false, error: 'root 不在已发现的项目里' });
              return;
            }
            try {
              const r = applyDownstream(root, body || {});
              sendJson(res, 200, r);
            } catch (e) {
              const msg = String((e && e.message) || e);
              trace('[下游直写被拒] ' + msg);
              sendJson(res, 409, { ok: false, error: msg });
            }
          },
        }),
      'filmflow: POST /filmflow/apply',
    );
    trace('已注册路由 /filmflow/apply');
  } catch (e) {
    trace('注册 /filmflow/apply 抛出: ' + String((e && e.stack) || e));
  }

  /* ---- 媒体生成：模型 / 提交 / 状态 / 取消 ---- */
  try {
    ctx.effect(
      () =>
        webServer.register({
          kind: 'exact',
          path: '/filmflow/media',
          handler: async (req, res) => {
            let body = {};
            let action = 'models';
            try {
              const u = new URL(req.url || '/', 'http://127.0.0.1');
              action = String(u.searchParams.get('action') || 'models');
              if (req.method === 'POST') {
                body = JSON.parse(await readBody(req));
                action = String(body.action || action);
              }
              const wantRoot = String(
                req.method === 'POST' ? body.root : new URL(req.url, 'http://x').searchParams.get('root') || '',
              ).replace(/[\\/]+$/, '').toLowerCase();
              const root = wantRoot
                ? discoverProjects(roots, explicit).find((r) => r.toLowerCase() === wantRoot)
                : '';

              if (action === 'models') {
                const isArk = MEDIA.providerName() === "ark";
                sendJson(res, 200, {
                  ok: true,
                  provider: isArk ? "ark" : "pippit",
                  image: isArk ? MEDIA.ARK_IMAGE_MODELS : MEDIA.IMAGE_MODELS,
                  video: isArk ? MEDIA.ARK_VIDEO_MODELS : MEDIA.VIDEO_MODELS,
                  // 音频：豆包语音《音频生成》（2026-10-28 接入，同步返回 base64）
                  audio: isArk ? MEDIA.ARK_AUDIO_MODELS : {},
                  credit: isArk ? "" : await MEDIA.credit(),
                  hasKey: MEDIA.hasKey(),
                });
                return;
              }
              if (action === 'credit') {
                sendJson(res, 200, { ok: true, credit: await MEDIA.credit() });
                return;
              }
              if (action === 'usage') {
                /* 画布右上角要显示：实时余额 + 最近生成记录（本地记的，官方没有用量接口） */
                const wantRoot2 = String(body.root || '').replace(/[\\/]+$/, '').toLowerCase();
                const root2 = discoverProjects(roots, explicit).find((r) => r.toLowerCase() === wantRoot2) || '';
                sendJson(res, 200, {
                  ok: true,
                    credit: MEDIA.providerName() === "ark" ? "" : await MEDIA.credit(),
                  usage: root2 ? MEDIA.readUsage(root2, 20) : [],
                });
                return;
              }
              if (!root) {
                if (action === 'usage') {
                  sendJson(res, 200, { ok: true, credit: await MEDIA.credit(), usage: [] });
                  return;
                }
                sendJson(res, 400, { ok: false, error: 'root 不在已发现的项目里' });
                return;
              }
              if (action === 'jobs') {
                sendJson(res, 200, { ok: true, jobs: MEDIA.listJobs(root) });
                return;
              }
              /* 下面这些都是**写**操作：用户点按钮才会走到；带写令牌 */
              if (!requireToken(req, res)) return;
              if (action === 'gen') {
                const p = buildProject(root);
                const r = MEDIA.startJob(root, p.stages || [], String(body.key || ''));
                trace('[媒体] 用户点了生成：' + String(body.key || ''));
                sendJson(res, 200, r);
                return;
              }
              if (action === 'cancel') {
                sendJson(res, 200, MEDIA.cancelJob(root, String(body.key || '')));
                return;
              }
              if (action === 'set') {
                /* 只改**配置**（提示词/模型/参数），不触发生成 —— agent 也走这条。 */
                const declPathAbs = join(root, DECL);
                const { decl } = readDecl(declPathAbs);
                const ch = structureOp(root, {
                  type: 'setMedia',
                  key: String(body.key || ''),
                  fields: body.fields || {},
                });
                sendJson(res, 200, ch);
                return;
              }
              sendJson(res, 400, { ok: false, error: '不认识的 action：' + action });
            } catch (e) {
              const msg = String((e && e.message) || e);
              trace('[媒体] 失败：' + msg);
              sendJson(res, 400, { ok: false, error: msg });
            }
          },
        }),
      'filmflow: /filmflow/media',
    );
    trace('已注册路由 /filmflow/media');
  } catch (e) {
    trace('注册 /filmflow/media 抛出: ' + String((e && e.stack) || e));
  }

  /* ---- 设置：API Key（开箱即用必需 —— 用户自己填，不回显） ---- */
  try {
    ctx.effect(
      () =>
        webServer.register({
          kind: 'exact',
          path: '/filmflow/keys',
          handler: async (req, res) => {
            try {
              const home = process.env.DSH_HOME || join(process.env.USERPROFILE || '', '.dsh');
              const file = join(home, '.credentials.yaml');
              const read = () => { try { return readFileSync(file, 'utf8'); } catch { return ''; } };
              /*
               * 凭据文件两种写法都要认（2026-10-28 实测：DSH 设置页写出的是**流式**
               * `refs: { DEEPSEEK_API_KEY: sk-… }`，不是块式缩进）：
               *   · 流式：refs: { KEY: value, KEY2: value2 }
               *   · 块式：refs:\n  KEY: value\n  KEY2: value2
               * 只认块式的话 GET 会误报"未配置"，upsert 还会写出重复的 refs 段（YAML 直接坏）。
               */
              const keyRe = (k) => new RegExp('(^|[\\s{,])\\s*' + k + '\\s*:\\s*("[^"]*"|[^,}\\r\\n]*)');
              const has = (raw, k) => {
                const m = keyRe(k).exec(String(raw || ''));
                return !!m && String(m[2] || '').trim().replace(/^"|"$/g, '') !== '';
              };
              const upsert = (raw, k, v) => {
                const val = /^[\w.-]+$/.test(v) ? v : JSON.stringify(v);
                const re = new RegExp('(^|[\\s{,])(\\s*' + k + '\\s*:\\s*)("[^"]*"|[^,}\\r\\n]*)');
                if (re.test(raw)) return raw.replace(re, (m0, pre) => pre + k + ': ' + val);
                if (/refs:\s*\{/.test(raw)) {
                  if (/refs:\s*\{\s*\}/.test(raw)) {
                    return raw.replace(/refs:\s*\{\s*\}/, 'refs: { ' + k + ': ' + val + ' }');
                  }
                  return raw.replace(/refs:\s*\{([^}]*)\}/, (m0, inner) => {
                    const body = String(inner || '').trim().replace(/,\s*$/, '');
                    return 'refs: { ' + (body ? body + ', ' : '') + k + ': ' + val + ' }';
                  });
                }
                if (/^refs:\s*$/m.test(raw)) return raw.replace(/^refs:\s*$/m, 'refs:\n  ' + k + ': ' + val);
                return raw.replace(/\s*$/, '\n') + 'refs:\n  ' + k + ': ' + val + '\n';
              };
              const drop = (raw, k) => {
                let out = raw.replace(new RegExp('(^|[\\s{,])\\s*' + k + '\\s*:\\s*("[^"]*"|[^,}\\r\\n]*)\\s*,?', 'g'), '$1');
                out = out.replace(new RegExp('^\\s*' + k + '\\s*:.*\\r?\\n?', 'm'), '');
                out = out.replace(/,\s*\}/g, ' }').replace(/\{\s*,/g, '{ ');
                // 块式删空后会剩下一个光秃秃的 `refs:`（null）—— 那正是 B15 的 YAML 报错形态
                out = out.replace(/^refs:\s*\r?\n(?=\S|$)/m, 'refs: {}\n');
                return out;
              };

              if (req.method === 'GET') {
                const raw = read();
                sendJson(res, 200, {
                  ok: true,
                  deepseek: has(raw, 'DEEPSEEK_API_KEY'),
                  ark: has(raw, 'ARK_API_KEY'),
                  pippit: has(raw, 'PIPPIT_ACCESS_KEY'),
                  provider: MEDIA.providerName(),
                });
                return;
              }
              if (!requireToken(req, res)) return;
              const body = JSON.parse(await readBody(req));
              let raw = read();
              /* 只接受 ark- 开头的方舟 key；空字符串表示"删除这把 key" */
              const ark = String(body.ark == null ? '' : body.ark).trim();
              const pippit = String(body.pippit == null ? '' : body.pippit).trim();
              /*
               * 模型 API Key（DeepSeek）。用户 2026-10-28 要求「设置都固化，只留 API 更改项」，
               * 官方设置菜单去掉之后，这是改模型 key 的唯一入口。
               * provider 在启动时读凭据 ⇒ 保存后要重启片场才生效（界面会明说）。
               */
              const deepseek = String(body.deepseek == null ? '' : body.deepseek).trim();
              if (deepseek) {
                if (/\s/.test(deepseek) || deepseek.length < 8) {
                  sendJson(res, 400, { ok: false, error: '模型 Key 不能有空格，且至少 8 位' });
                  return;
                }
                raw = upsert(raw, 'DEEPSEEK_API_KEY', deepseek);
              }
              if (ark) {
                if (!/^ark-[\w-]{20,}$/.test(ark)) { sendJson(res, 400, { ok: false, error: '方舟 key 应该以 ark- 开头' }); return; }
                raw = upsert(raw, 'ARK_API_KEY', ark);
              }
              if (pippit) raw = upsert(raw, 'PIPPIT_ACCESS_KEY', pippit);
              if (body.clearDeepseek === true) raw = drop(raw, 'DEEPSEEK_API_KEY');
              if (body.clearArk === true) raw = drop(raw, 'ARK_API_KEY');
              if (body.clearPippit === true) raw = drop(raw, 'PIPPIT_ACCESS_KEY');
              mkdirSync(dirname(file), { recursive: true });
              writeFileSync(file, raw, 'utf8');
              trace('[设置] key 已更新（不记内容）');
              const raw2 = read();
              sendJson(res, 200, {
                ok: true,
                deepseek: has(raw2, 'DEEPSEEK_API_KEY'),
                ark: has(raw2, 'ARK_API_KEY'),
                pippit: has(raw2, 'PIPPIT_ACCESS_KEY'),
              });
            } catch (e) {
              sendJson(res, 400, { ok: false, error: String((e && e.message) || e) });
            }
          },
        }),
      'filmflow: /filmflow/keys',
    );
    trace('已注册路由 /filmflow/keys');
  } catch (e) {
    trace('注册 /filmflow/keys 抛出: ' + String((e && e.stack) || e));
  }

  /* ---- /filmflow/agent-api ---- Agent 的 key / baseURL / model（用户自己填） ---- */
  try {
    ctx.effect(
      () =>
        webServer.register({
          kind: 'exact',
          path: '/filmflow/agent-api',
          handler: async (req, res) => {
            try {
              const home = agentHome();
              const credFile = join(home, '.credentials.yaml');
              const profileFile = join(home, 'profiles', 'filmflow', 'cordis.patch.yml');
              const rd = (f) => { try { return readFileSync(f, 'utf8'); } catch { return ''; } };
              const curBase = () => {
                const m = /-\s*id:\s*llm-deepseek[\s\S]*?baseURL:\s*(\S+)/.exec(rd(profileFile));
                return m ? String(m[1]).replace(/^["']|["']$/g, '') : 'https://api.deepseek.com/anthropic';
              };
              if (req.method === 'GET') {
                const cfg = readAgentApi();
                const rawCred = rd(credFile);
                sendJson(res, 200, {
                  ok: true,
                  key: credHas(rawCred, 'DEEPSEEK_API_KEY'),
                  // 用户 2026-10-28：「已配置的要写出来」→ 界面直接显示这把 key（本机、不回传别处）
                  keyValue: credGet(rawCred, 'DEEPSEEK_API_KEY'),
                  baseURL: curBase(),
                  model: String(cfg.model || AGENT_MODEL || 'deepseek-flash'),
                  provider: AGENT_PROVIDER,
                  savedAt: String(cfg.savedAt || ''),
                });
                return;
              }
              if (!requireToken(req, res)) return;
              const body = JSON.parse(await readBody(req));
              const key = String(body.key == null ? '' : body.key).trim();
              const url = String(body.baseURL == null ? '' : body.baseURL).trim();
              const model = String(body.model == null ? '' : body.model).trim();
              const changed = [];
              if (key) {
                if (/\s/.test(key) || key.length < 8) throw new Error('Key 不能有空格，且至少 8 位');
                const raw = rd(credFile);
                try { if (existsSync(credFile)) copyFileSync(credFile, credFile + '.bak-' + Date.now()); } catch { /* 备份失败不拦 */ }
                mkdirSync(dirname(credFile), { recursive: true });
                writeFileSync(credFile, credUpsert(raw, 'DEEPSEEK_API_KEY', key), 'utf8');
                changed.push('key');
              }
              if (body.clearKey === true) {
                const raw = rd(credFile);
                if (raw) {
                  try { copyFileSync(credFile, credFile + '.bak-' + Date.now()); } catch { /* 忽略 */ }
                  writeFileSync(credFile, credDrop(raw, 'DEEPSEEK_API_KEY'), 'utf8');
                  changed.push('key:cleared');
                }
              }
              if (url) {
                if (!/^https?:\/\/\S+$/i.test(url)) throw new Error('Base URL 必须是 http(s):// 开头');
                if (!existsSync(profileFile)) throw new Error('找不到 profile 文件：' + profileFile);
                writeProfileBaseURL(profileFile, url);
                changed.push('baseURL');
              }
              if (model) {
                if (/\s/.test(model)) throw new Error('模型名不能有空格');
                writeAgentApi({ model, baseURL: url || curBase() });
                changed.push('model');
              }
              trace('[Agent API] 已更新：' + changed.join(','));
              sendJson(res, 200, { ok: true, changed, needsRestart: changed.length > 0 });
            } catch (e) {
              sendJson(res, 400, { ok: false, error: String((e && e.message) || e) });
            }
          },
        }),
      'filmflow: /filmflow/agent-api',
    );
    trace('已注册路由 /filmflow/agent-api');
  } catch (e) {
    trace('注册 /filmflow/agent-api 抛出: ' + String((e && e.stack) || e));
  }

  /* ---- /filmflow/aigc ----
   * AIGC 生成用的**火山引擎**凭据（2026-10-30 用户要求）。
   *
   * 用户原话：「在 agent 的 api 设置下面再创建一个 aigc 的 api 设置，只让填火山的，
   * 保证接上后程序能正常使用」。
   * ⇒ 只认两家（其实都是火山）：方舟 Ark（Seedance 视频 / Seedream 图片）、
   *   豆包语音（音频生成）。别的厂商一律不做入口。
   *
   * 和 agent 那把 key 的区别：
   *   · 它走 DSH 的模型 provider，改完要重启；
   *   · 这两把是**每次生成时现读**（见 MEDIA 的 readArkKey / readSpeechKey）⇒ 保存即生效。
   */
  try {
    ctx.effect(
      () =>
        webServer.register({
          kind: 'exact',
          path: '/filmflow/aigc',
          handler: async (req, res) => {
            try {
              const credFile = join(agentHome(), '.credentials.yaml');
              const rd = (f) => { try { return readFileSync(f, 'utf8'); } catch { return ''; } };
              if (req.method === 'GET') {
                const raw = rd(credFile);
                sendJson(res, 200, {
                  ok: true,
                  provider: MEDIA.providerName(),
                  ark: { configured: credHas(raw, 'ARK_API_KEY'), value: credGet(raw, 'ARK_API_KEY') },
                  speech: { configured: credHas(raw, 'SPEECH_API_KEY'), value: credGet(raw, 'SPEECH_API_KEY') },
                });
                return;
              }
              if (!requireToken(req, res)) return;
              const body = JSON.parse(await readBody(req));
              let raw = rd(credFile);
              const changed = [];
              const ark = String(body.ark == null ? '' : body.ark).trim();
              const speech = String(body.speech == null ? '' : body.speech).trim();
              if (ark) {
                if (!/^ark-[\w-]{20,}$/.test(ark)) throw new Error('火山方舟 API Key 应该以 ark- 开头（控制台 → 方舟 → API Key）');
                raw = credUpsert(raw, 'ARK_API_KEY', ark);
                changed.push('ark');
              }
              if (speech) {
                if (/\s/.test(speech) || speech.length < 8) throw new Error('豆包语音 API Key 不能有空格，且至少 8 位');
                raw = credUpsert(raw, 'SPEECH_API_KEY', speech);
                changed.push('speech');
              }
              if (body.clearArk === true) { raw = credDrop(raw, 'ARK_API_KEY'); changed.push('ark:cleared'); }
              if (body.clearSpeech === true) { raw = credDrop(raw, 'SPEECH_API_KEY'); changed.push('speech:cleared'); }
              if (changed.length) {
                try { if (existsSync(credFile)) copyFileSync(credFile, credFile + '.bak-' + Date.now()); } catch { /* 备份失败不拦 */ }
                mkdirSync(dirname(credFile), { recursive: true });
                writeFileSync(credFile, raw, 'utf8');
                trace('[AIGC] 已更新：' + changed.join(','));
              }
              sendJson(res, 200, {
                ok: true,
                changed,
                needsRestart: false,
                ark: { configured: credHas(raw, 'ARK_API_KEY') },
                speech: { configured: credHas(raw, 'SPEECH_API_KEY') },
              });
            } catch (e) {
              sendJson(res, 400, { ok: false, error: String((e && e.message) || e) });
            }
          },
        }),
      'filmflow: /filmflow/aigc',
    );
    trace('已注册路由 /filmflow/aigc');
  } catch (e) {
    trace('注册 /filmflow/aigc 抛出: ' + String((e && e.stack) || e));
  }

  /* ---- 素材库：列表 / 收藏 / 删除 / 取文件 ---- */
  try {
    ctx.effect(
      () =>
        webServer.register({
          kind: 'exact',
          path: '/filmflow/assets',
          handler: async (req, res) => {
            try {
              const u = new URL(req.url || '/', 'http://127.0.0.1');
              let body = {};
              if (req.method === 'POST') body = JSON.parse(await readBody(req));
              const rawRoot = String(
                req.method === 'POST' ? body.root : u.searchParams.get('root') || '',
              ).replace(/[\\/]+$/, '').toLowerCase();
              const action = String(req.method === 'POST' ? body.action : u.searchParams.get('action') || 'list');
              const root = discoverProjects(roots, explicit).find((r) => r.toLowerCase() === rawRoot);
              /*
               * 素材库要能**跨片**列（用户 2026-10-23：「素材库里面没有我生成的素材」——
               * 素材在另一部片里）。所以 list 在没有 root 时不报错，直接聚合所有片子。
               */
              if (!root && action !== 'list') {
                sendJson(res, 400, { ok: false, error: 'root 不在已发现的项目里' });
                return;
              }

              if (action === 'file') {
                const rel = req.method === 'POST' ? String(body.p || '') : String(u.searchParams.get('p') || '');
                const abs = MEDIA.assetPath(root, rel);
                const type = contentTypeOf(abs);
                if (!type) {
                  sendJson(res, 400, { ok: false, error: '只伺服媒体文件' });
                  return;
                }
                const buf = readFileSync(abs);
                res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'private, max-age=86400' });
                res.end(buf);
                return;
              }
              if (action === "list") {
                /*
                 * 素材库是**全局**的（用户 2026-10-22：「所有生成内容全都存进那个库」）。
                 * 不带 root ⇒ 合并所有片子的素材，每条带 film/root；
                 * 带 root ⇒ 只列那部片（保留"只看本片"的能力）。
                 */
                const wantOne = String((req.method === "POST" ? body.root : u.searchParams.get("root")) || "").trim();
                if (!wantOne) {
                  const all = [];
                  for (const r0 of discoverProjects(roots, explicit)) {
                    const base = r0.split(/[\\\\/]/).pop();
                    for (const it of MEDIA.listAssets(r0)) all.push({ ...it, film: base, root: r0 });
                  }
                  all.sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")));
                  sendJson(res, 200, { ok: true, all: true, items: all });
                  return;
                }
                sendJson(res, 200, { ok: true, root, items: MEDIA.listAssets(root) });
                return;
              }
              if (!requireToken(req, res)) return;
              if (action === 'star') {
                sendJson(res, 200, MEDIA.starAsset(root, String(body.id || ''), !!body.star));
                return;
              }
              if (action === 'remove') {
                sendJson(res, 200, MEDIA.removeAsset(root, String(body.id || '')));
                return;
              }
              sendJson(res, 400, { ok: false, error: '不认识的 action：' + action });
            } catch (e) {
              sendJson(res, 400, { ok: false, error: String((e && e.message) || e) });
            }
          },
        }),
      'filmflow: /filmflow/assets',
    );
    trace('已注册路由 /filmflow/assets');
  } catch (e) {
    trace('注册 /filmflow/assets 抛出: ' + String((e && e.stack) || e));
  }

  /* ---- fs 根目录闸门（没装成会 trace；装了会打印一行证据）----
   *
   * 结论（2026-10-28 查源码后）：
   *   · 写/改 已经天然被沙箱挡住 —— `fs-sandbox` + `sandbox-policy(mode=workspace-write)`
   *     只允许写「会话 cwd 之下」，而片场 agent 的 cwd 就是这部片
   *     （`AGENT_CWD`，由 meta.cwd 传进去）。所以它写不到别的片、也动不了系统。
   *   · **读**是敞的：README 原文「File reads follow the composed filesystem's read
   *     access, including paths outside the workspace」。
   * ⇒ 这里找一遍 `ctx.fs` 有没有可用的读限制钩子；`dsh-api-workspace-files` 没有
   *   `guard()`（查过 lib/index.js），所以多半找不到 —— 那就如实记一行，不假装装上了。
   *   真要收紧读，办法是：不注册 tool-fs（只留 web），或给 agent 换 fs 后端。
   */
  try {
    const fsSvc = (() => {
      try { if (ctx.fs) return ctx.fs; } catch { /* 忽略 */ }
      try { return ctx.get('fs') || null; } catch { return null; }
    })();
    const hooks = ['guard', 'restrict', 'setGuard', 'allowRead'];
    const found = fsSvc ? hooks.filter((k) => typeof fsSvc[k] === 'function') : [];
    if (found.length) {
      trace('★ fs 服务上发现可用钩子: ' + found.join(', ') + '（尚未接线，需先确认语义）');
    } else {
      trace('★ fs 读限制钩子不可用（fs 服务键: '
        + (fsSvc ? Object.keys(fsSvc).slice(0, 12).join(',') : '无') + '）'
        + ' —— 写由 workspace-write 沙箱限定在片目录；读不限。'); 
    }
  } catch (e) {
    trace('★ fs 钩子探测抛出: ' + String((e && e.message) || e));
  }

  /* ---- GET /filmflow/changes ---- 最近的变更留痕（B6） */
  try {
    ctx.effect(
      () =>
        webServer.register({
          kind: 'exact',
          path: '/filmflow/changes',
          handler: async (req, res) => {
            if (rejectNonGet(req, res)) return;
            let root = '';
            try {
              const u = new URL(req.url || '/', 'http://127.0.0.1');
              const want = String(u.searchParams.get('root') || '').replace(/[\\/]+\$/, '').toLowerCase();
              root = discoverProjects(roots, explicit).find((r) => r.toLowerCase() === want) || '';
            } catch { root = ''; }
            if (!root) {
              root = discoverProjects(roots, explicit)[0] || '';
            }
            if (!root) { sendJson(res, 404, { ok: false, error: '没有可用的项目' }); return; }
            sendJson(res, 200, { ok: true, root, changes: readChanges(root, 30) });
          },
        }),
      'filmflow: GET /filmflow/changes',
    );
    trace('已注册路由 /filmflow/changes');
  } catch (e) {
    trace('注册 /filmflow/changes 抛出: ' + String((e && e.stack) || e));
  }

  /* ---- GET /filmflow/templates ---- 画布「新建节点」+ 节点库页面
   *
   * `?full=1` 时多给 shape / doctrine / 出现在哪些预设里 ——
   * 节点库页面要标注「这个节点干什么、怎么用」，光有标题不够（2026-10-28 用户要求）。
   */
  try {
    ctx.effect(
      () =>
        webServer.register({
          kind: 'exact',
          path: '/filmflow/templates',
          handler: async (req, res) => {
            if (req.method !== 'GET') {
              res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8', Allow: 'GET' });
              res.end('只支持 GET');
              return;
            }
            let full = false;
            try {
              const u = new URL(req.url || '/', 'http://127.0.0.1');
              full = String(u.searchParams.get('full') || '') === '1';
            } catch { /* 参数坏了就当普通列表 */ }

            // 预设 → 每个模板出现在哪些预设里（节点库的「在哪能用」）
            const packList = readPacks();
            const packOf = new Map();
            const walkTree = (items, pid, ptitle) => {
              for (const it of (Array.isArray(items) ? items : [])) {
                const tid = String((it && it.t) || '');
                if (tid) {
                  if (!packOf.has(tid)) packOf.set(tid, []);
                  const arr = packOf.get(tid);
                  const label = ptitle || pid;
                  if (!arr.some((x) => x.id === pid)) arr.push({ id: pid, title: label });
                }
                walkTree(it && it.children, pid, ptitle);
              }
            };
            for (const p of packList) walkTree(p.tree, String(p.id || ''), String(p.title || p.id || ''));

            // 只给画布需要的字段；full 才带 doctrine（长）
            const list = readTemplates().map((t) => {
              const base = {
                id: String(t.id || ''),
                title: String(t.title || ''),
                group: String(t.group || ''),
                feed: String(t.feed || 'up'),
                note: String(t.note || ''),
                kind: String(t.kind || ''),
                mediaType: String(t.mediaType || ''),
                model: String(t.model || ''),
                /** 层级角色：画布靠它过滤「＋」菜单（R47）。 */
                role: roleOfTemplate(t),
              };
              if (!full) return base;
              return {
                ...base,
                shape: t.shape && typeof t.shape === 'object' ? t.shape : null,
                files: t.files ? String(t.files) : '',
                doctrine: String(t.doctrine || ''),
                packs: packOf.get(base.id) || [],
              };
            });

            const countTree = (items) => {
              let n = 0;
              for (const it of (Array.isArray(items) ? items : [])) {
                n += 1 + countTree(it && it.children);
              }
              return n;
            };
            const packs = packList.map((p) => ({
              id: String(p.id || ''),
              title: String(p.title || ''),
              note: String(p.note || ''),
              // tree 型预设按树数；老的 `add` 型按数组长度
              count: Array.isArray(p.tree) ? countTree(p.tree) : (Array.isArray(p.add) ? p.add.length : 0),
            }));
            /*
             * 层级规则也一起下发：画布用 `menu` 过滤「＋」菜单、
             * 用 `labels` 写提示；不让浏览器再抄一份矩阵（抄了就会不同步）。
             */
            const roleLabels = {};
            for (const r of Object.keys(ROLE_PARENTS)) roleLabels[r] = roleLabel(r);
            const roles = {
              labels: roleLabels,
              /* 逆表（子 → 父）= 校验真源；正向表（父 → 子）由它算出来，方便人读。 */
              parents: ROLE_PARENTS,
              children: roleChildrenTable(),
              /* 菜单 = 法定 ∩ 展示白名单（见 node-rules.menuTable）：不手抄，所以不会越界。 */
              menu: menuTable(),
              /* 主从层（R52/R54/R56）：节点身份 + 它名下只收谁。画布用 parent.identity 查这张表 */
              identity: identityTable(),
              /* 顶层能建什么（R57）：画布的「＋ 工序」用它过滤 */
              rootCanAdd: rootCanAddTemplates(readTemplates()),
              terminal: [...TERMINAL_ROLES],
            };
            sendJson(res, 200, { ok: true, templates: list, packs, roles });
          },
        }),
      'filmflow: GET /filmflow/templates',
    );
    trace('已注册路由 /filmflow/templates');
  } catch (e) {
    trace('注册 /filmflow/templates 抛出: ' + String((e && e.stack) || e));
  }

  /* ---- POST /filmflow/structure ---- 画布上的增 / 删 / 改名 / 移动
   *
   * 为什么这些不进 agent 的工具（2026-10-21 用户的设计）：
   *   「结构归宿主、正文归 agent」—— 增删节点是确定性操作（改 JSON + 建空文件 + 查依赖），
   *   交给 agent 只会让结构变得不可预测。用户直接在画布上操作。
   */
  try {
    ctx.effect(
      () =>
        webServer.register({
          kind: 'exact',
          path: '/filmflow/structure',
          handler: async (req, res) => {
            if (!requireToken(req, res)) return;
            if (req.method !== 'POST') {
              res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8', Allow: 'POST' });
              res.end('只支持 POST');
              return;
            }
            let body;
            try {
              body = JSON.parse(await readBody(req));
            } catch {
              sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' });
              return;
            }
            const wanted = String(body?.root || '').replace(/[\\/]+$/, '').toLowerCase();
            const root = discoverProjects(roots, explicit).find((r) => r.toLowerCase() === wanted);
            if (!root) {
              sendJson(res, 400, { ok: false, error: 'root 不在已发现的项目里：' + String(body?.root || '') });
              return;
            }
            try {
              const r = structureOp(root, body?.op || {});
              trace('[结构] ' + JSON.stringify({ op: body?.op?.type, key: r.key, ok: r.ok }));
              sendJson(res, 200, r);
              /*
               * ★ 结构改动也要叫醒 agent（用户 2026-10-22：「人物名字改了后其他层没有同步」）。
               *
               * 改正文早就会叫醒（/filmflow/edit 里的 autoWake），但改**名字**走的是这个路由 ——
               * 于是下游节点变成了"过期"，却**没人去改**。现在补上：
               *   · renameSection（改文件里的小节标题）=> 一定要叫
               *   · 其它结构操作（增删移/改名）=> 也叫
               * changed === false（"名字没变"这种）不叫。
               */
              try {
                const opType = String(body?.op?.type || '');
                const meaningful = r && r.ok !== false && r.changed !== false
                  && ['renameSection', 'rename', 'delete', 'add', 'move', 'expand'].includes(opType);
                if (meaningful) {
                  const p0 = buildProject(root);
                  const what = opType === 'renameSection'
                    ? '「' + String(r.before || '') + '」改名为「' + String(r.title || '') + '」（' + String(r.src || '') + '）'
                    : '结构变更：' + opType;
                  wakeAgent(ctx, root, roots[0], composeWake(p0, what, staleOf(p0)), trace);
                }
              } catch (e) {
                trace('[结构-叫醒失败] ' + String((e && e.message) || e));
              }
            } catch (e) {
              const msg = String((e && e.message) || e);
              trace('[结构失败] ' + msg);
              sendJson(res, 400, { ok: false, error: msg });
            }
          },
        }),
      'filmflow: POST /filmflow/structure',
    );
    trace('已注册路由 /filmflow/structure');
  } catch (e) {
    trace('注册 /filmflow/structure 抛出: ' + String((e && e.stack) || e));
  }

  /* ---- POST /filmflow/sync ---- 跟依赖对齐（Agent 传播完之后调它） */
  try {
    ctx.effect(
      () =>
        webServer.register({
          kind: 'exact',
          path: '/filmflow/sync',
          handler: async (req, res) => {
            /* ★ 写操作闸门 —— 见 requireToken 的注释 */
            if (!requireToken(req, res)) return;
            if (req.method !== 'POST') {
              res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8', Allow: 'POST' });
              res.end('只支持 POST');
              return;
            }
            let body;
            try {
              body = JSON.parse(await readBody(req));
            } catch {
              sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' });
              return;
            }
            const wanted = String(body?.root || '').replace(/[\\/]+$/, '').toLowerCase();
            const root = discoverProjects(roots, explicit).find((r) => r.toLowerCase() === wanted);
            if (!root) {
              sendJson(res, 400, { ok: false, error: 'root 不在已发现的项目里' });
              return;
            }
            try {
              const r = syncNodes(root, body?.no);
              trace('[对齐] ' + JSON.stringify(r));
              sendJson(res, 200, { ok: true, ...r });
            } catch (e) {
              trace('[对齐失败] ' + String((e && e.message) || e));
              sendJson(res, 500, { ok: false, error: String((e && e.message) || e) });
            }
          },
        }),
      'filmflow: POST /filmflow/sync',
    );
    trace('已注册路由 /filmflow/sync');
  } catch (e) {
    trace('注册 /filmflow/sync 抛出: ' + String((e && e.stack) || e));
  }

  /* ---- GET /filmflow/proposals ---- 看有哪些待确认的提案 */
  try {
    ctx.effect(
      () =>
        webServer.register({
          kind: 'exact',
          path: '/filmflow/proposals',
          handler: (req, res) => {
            if (req.method !== 'GET') {
              res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8', Allow: 'GET' });
              res.end('只支持 GET');
              return;
            }
            const u = new URL(req.url, 'http://x');
            const want = String(u.searchParams.get('root') || '').replace(/[\\/]+$/, '').toLowerCase();
            const out = [];
            for (const r of discoverProjects(roots, explicit)) {
              if (want && r.toLowerCase() !== want) continue;
              for (const pr of readProposals(r)) {
                if (pr.status === 'pending') out.push({ ...pr, root: r });
              }
            }
            sendJson(res, 200, { ok: true, proposals: out });
          },
        }),
      'filmflow: GET /filmflow/proposals',
    );
    trace('已注册路由 /filmflow/proposals');
  } catch (e) {
    trace('注册 /filmflow/proposals 抛出: ' + String((e && e.stack) || e));
  }

  /* ---- POST /filmflow/approve ---- 用户点【确认】/【驳回】→ **宿主**落盘 */
  try {
    ctx.effect(
      () =>
        webServer.register({
          kind: 'exact',
          path: '/filmflow/approve',
          handler: async (req, res) => {
            /* ★ 写操作闸门 —— 见 requireToken 的注释 */
            if (!requireToken(req, res)) return;
            if (req.method !== 'POST') {
              res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8', Allow: 'POST' });
              res.end('只支持 POST');
              return;
            }
            let body;
            try {
              body = JSON.parse(await readBody(req));
            } catch {
              sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' });
              return;
            }
            const wanted = String(body?.root || '').replace(/[\\/]+$/, '').toLowerCase();
            const root = discoverProjects(roots, explicit).find((r) => r.toLowerCase() === wanted);
            if (!root) {
              sendJson(res, 400, { ok: false, error: 'root 不在已发现的项目里' });
              return;
            }
            const list = readProposals(root);
            const pr = list.find((x) => x.id === body?.id);
            if (!pr) {
              sendJson(res, 404, { ok: false, error: '没有这条提案：' + String(body?.id || '') });
              return;
            }
            if (pr.status !== 'pending') {
              sendJson(res, 409, { ok: false, error: '这条提案已经处理过了（' + pr.status + '）' });
              return;
            }

            // ---- 驳回：只改状态 ----
            if (body?.action === 'reject') {
              pr.status = 'rejected';
              pr.handledAt = new Date().toISOString();
              writeProposals(root, list);
              trace('[提案驳回] ' + pr.id + ' ' + pr.src);
              sendJson(res, 200, { ok: true, action: 'rejected', id: pr.id });
              return;
            }

            /*
             * ---- 确认：**宿主**落盘。
             * 这里就是原来 filmflow_write 的那段施工逻辑 —— 三道护栏原样复用，
             * 只是触发者从"Agent 调用"换成了"用户点确认"。
             */
            /*
             * 结构提案（kind='struct'）：用户点确认后，由宿主执行结构操作。
             * 走的是和画布按钮同一个 structureOp —— 护栏（备份/编号/依赖/拒绝）全一样。
             */
            if (pr.kind === 'struct' && pr.struct) {
              try {
                /*
                 * 提案里存的是 `op`（给人读的语义），`structureOp` 认的是 `type` ——
                 * 这里做一次归一，别让两边叫法不同就把整条执行链卡死（实测踩过：
                 * 报「不认识的结构操作：」空字符串）。
                 */
                const s = pr.struct;
                const r = structureOp(root, { ...s, type: String(s.type || s.op || ''), by: 'agent', why: String(pr.why || '') });
                pr.status = 'approved';
                pr.handledAt = new Date().toISOString();
                pr.result = r;
                writeProposals(root, list);
                trace('[结构提案确认] ' + pr.id + ' ' + JSON.stringify(pr.struct));
                sendJson(res, 200, { ok: true, action: 'approved', kind: 'struct', id: pr.id, result: r });
              } catch (e) {
                const msg = String((e && e.message) || e);
                trace('[结构提案执行失败] ' + pr.id + ' ' + msg);
                /*
                 * 「没有这个节点」= 提案目标已经不在了（被删/被改名重编号）⇒ 永远执行不了，作废。
                 * 其它错误（例如"还有下游依赖"）属于**可以解决的前提条件**，保留待确认并显示原因。
                 */
                if (/没有这个节点/.test(msg)) {
                  pr.status = 'invalid';
                  pr.handledAt = new Date().toISOString();
                  pr.invalidReason = msg;
                  writeProposals(root, list);
                  trace('[提案作废] ' + pr.id + ' ' + msg);
                  sendJson(res, 200, { ok: true, action: 'invalid', id: pr.id, reason: msg });
                  return;
                }
                sendJson(res, 400, { ok: false, error: msg, id: pr.id });
              }
              return;
            }

            try {
              const { decl } = readDecl(join(root, DECL));
              const abs = join(root, ...String(pr.src).split('/'));
              if (!isWritable(root, decl, abs)) {
                /*
                 * 这条提案指向的文件已经**不属于任何节点**（典型：节点被删了、
                 * 或文件被移出了声明）⇒ 它永远不可能执行成功，留着只会让人反复点。
                 * ⇒ 作废并写明原因，返回 ok 让界面把它从"待确认"里拿掉。
                 */
                pr.status = 'invalid';
                pr.handledAt = new Date().toISOString();
                pr.invalidReason = pr.src + ' 已经不属于任何节点了（节点可能被删了）';
                writeProposals(root, list);
                trace('[提案作废] ' + pr.id + ' ' + pr.invalidReason);
                sendJson(res, 200, { ok: true, action: 'invalid', id: pr.id, reason: pr.invalidReason });
                return;
              }
              const p = buildProject(root);
              const n = findNode(p, pr.node || pr.src);
              const r = applyEdit(root, {
                src: pr.src,
                line: n ? n.line : 0,
                whole: n ? !!n.whole : false,
                title: n ? n.title : pr.nodeTitle,
                kind: 'node',
                via: n ? n.via : 'md',
                text: String(pr.after ?? ''),
              });
              pr.status = 'approved';
              pr.handledAt = new Date().toISOString();
              pr.result = r;
              writeProposals(root, list);

              const after = buildProject(root);
              const st = staleOf(after);
              trace('[提案确认] ' + pr.id + ' → ' + JSON.stringify(r));
              // 落盘之后下游又会变 —— 也叫醒一次，让它接着往下想
              if (autoWake) {
                try {
                  wakeAgent(
                    ctx,
                    root,
                    roots[0],
                    composeWake(after, '（你刚提的提案被用户确认了）' + pr.src, st),
                    trace,
                  );
                } catch (e) {
                  trace('[叫醒失败] ' + String((e && e.message) || e));
                }
              }
              sendJson(res, 200, {
                ok: true,
                action: 'approved',
                id: pr.id,
                mode: r.mode,
                backup: r.backup,
                staleDownstream: st.map((x) => ({ no: x.no, title: x.title })),
              });
            } catch (e) {
              trace('[提案确认失败] ' + String((e && e.message) || e));
              sendJson(res, 500, { ok: false, error: String((e && e.message) || e) });
            }
          },
        }),
      'filmflow: POST /filmflow/approve',
    );
    trace('已注册路由 /filmflow/approve');
  } catch (e) {
    trace('注册 /filmflow/approve 抛出: ' + String((e && e.stack) || e));
  }

  /* ---- POST /filmflow/agent ---- 暂停（用户：「插话都不用，但是我可以暂停」） */
  try {
    ctx.effect(
      () =>
        webServer.register({
          kind: 'exact',
          path: '/filmflow/agent',
          handler: async (req, res) => {
            /* ★ 写操作闸门 —— 见 requireToken 的注释 */
            if (!requireToken(req, res)) return;
            if (req.method !== 'POST') {
              res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8', Allow: 'POST' });
              res.end('只支持 POST');
              return;
            }
            let body;
            try {
              body = JSON.parse(await readBody(req));
            } catch {
              sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' });
              return;
            }
            const wanted = String(body?.root || '').replace(/[\\/]+$/, '').toLowerCase();
            const root = discoverProjects(roots, explicit).find((r) => r.toLowerCase() === wanted);
            if (!root) {
              sendJson(res, 400, { ok: false, error: 'root 不在已发现的项目里' });
              return;
            }
            const action = String(body?.action || 'status');
            if (action === 'pause') {
              const r = pauseAgent(root, trace);
              sendJson(res, r.ok ? 200 : 500, r);
              return;
            }
            sendJson(res, 200, { ok: true, agent: agentStatusOf(root) });
          },
        }),
      'filmflow: POST /filmflow/agent',
    );
    trace('已注册路由 /filmflow/agent');
  } catch (e) {
    trace('注册 /filmflow/agent 抛出: ' + String((e && e.stack) || e));
  }

  /* ---- GET /filmflow/app ---- 独立应用的第一页（项目资产） */
  try {
    ctx.effect(
      () =>
        webServer.register({
          kind: 'exact',
          path: '/filmflow/app',
          handler: (req, res) => {
            const u = new URL(req.url, 'http://x');
            const html = appPageHtml(WRITE_TOKEN);
            res.writeHead(200, {
              'Content-Type': 'text/html; charset=utf-8',
              'Cache-Control': 'no-store',
            });
            res.end(html);
          },
        }),
      'filmflow: GET /filmflow/app',
    );
    trace('已注册路由 /filmflow/app');
  } catch (e) {
    trace('注册 /filmflow/app 抛出: ' + String((e && e.stack) || e));
  }

  /* ---- GET /filmflow/project ---- 独立应用的第二页（大画布） */
  try {
    ctx.effect(
      () =>
        webServer.register({
          kind: 'exact',
          path: '/filmflow/project',
          handler: (req, res) => {
            res.writeHead(200, {
              'Content-Type': 'text/html; charset=utf-8',
              'Cache-Control': 'no-store',
            });
            res.end(projectPageHtml(WRITE_TOKEN));
          },
        }),
      'filmflow: GET /filmflow/project',
    );
    trace('已注册路由 /filmflow/project');
  } catch (e) {
    trace('注册 /filmflow/project 抛出: ' + String((e && e.stack) || e));
  }

  /* ---- POST /filmflow/newproject ---- 新建项目（复制模板） */
  try {
    ctx.effect(
      () =>
        webServer.register({
          kind: 'exact',
          path: '/filmflow/newproject',
          handler: async (req, res) => {
            /* ★ 写操作闸门 —— 见 requireToken 的注释 */
            if (!requireToken(req, res)) return;
            if (req.method !== 'POST') {
              res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8', Allow: 'POST' });
              res.end('只支持 POST');
              return;
            }
            let body;
            try {
              body = JSON.parse(await readBody(req));
            } catch {
              sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' });
              return;
            }
            try {
              const name = String(body?.title || '').trim();
              if (!name) throw new Error('片名不能为空');
              if (/[\\/:*?"<>|]/.test(name)) throw new Error('片名里不能有 \\ / : * ? " < > |');
              if (name.length > 40) throw new Error('片名太长了');

              const dest = join(roots[0], name);
              if (existsSync(dest)) throw new Error('已经有一个叫「' + name + '」的了');

              // 以「新片」那份通用模板为底；模板目录不存在时用内置骨架（打包不带项目数据，2026-10-29）
              const tpl = join(roots[0], '新片', DECL);
              const decl = existsSync(tpl)
                ? JSON.parse(readFileSync(tpl, 'utf8'))
                : defaultProject();
              /*
               * 片名后缀 / 项目说明跟着**选的预设**走。
               * 原来无论选什么包都写「对白悬疑片」，做纪录片时标题和 note 都是错的
               * （2026-10-28 用户实测：新建「纪录片1」得到「纪录片1 · 对白悬疑片」）。
               */
              const packIdEarly = String(body?.pack || '').trim();
              const packMeta = (packIdEarly && packIdEarly !== 'plain')
                ? readPacks().find((p) => String(p.id) === packIdEarly) || null
                : null;
              decl.id = name;
              decl.title = name + ' · ' + (packMeta ? String(packMeta.title || '') : '对白悬疑片');
              const baseFirst = String(decl.note || '').split('\n')[0];
              decl.note = (packMeta
                ? '【这是什么项目】' + String(packMeta.title || '') + '（预设：' + String(packMeta.id || '') + '）'
                  + (packMeta.note ? '\n【整体流程】' + String(packMeta.note) : '')
                : baseFirst)
                + '\n【这一部】' + name;

              mkdirSync(join(dest, '.film'), { recursive: true });
              writeFileSync(join(dest, DECL), JSON.stringify(decl, null, 2) + '\n', 'utf8');
              for (const d of ['设定', '剧本', '音频提示词', '视频提示词', 'tools']) {
                mkdirSync(join(dest, d), { recursive: true });
              }
              /*
               * 骨架包：新建时选一套，就在标准五道工序之上再铺节点。
               * 用 structureOp 逐个加（自带备份 / 编号重算 / 依赖连线），不是手写 JSON。
               */
              let packResult = null;
              const packId = String(body?.pack || '').trim();
              if (packId && packId !== 'plain') {
                try {
                  packResult = applyPack(dest, packId);
                } catch (e) {
                  trace('[骨架包失败] ' + String((e && e.message) || e));
                  packResult = { pack: packId, error: String((e && e.message) || e) };
                }
              }
              trace('[新建项目] ' + dest + (packResult ? ' pack=' + packResult.pack : ''));
              sendJson(res, 200, { ok: true, root: dest, title: decl.title, pack: packResult });
            } catch (e) {
              trace('[新建项目失败] ' + String((e && e.message) || e));
              sendJson(res, 500, { ok: false, error: String((e && e.message) || e) });
            }
          },
        }),
      'filmflow: POST /filmflow/newproject',
    );
    trace('已注册路由 /filmflow/newproject');
  } catch (e) {
    trace('注册 /filmflow/newproject 抛出: ' + String((e && e.stack) || e));
  }

  /* ---- POST /filmflow/say ---- 用户在左侧栏对 Agent 说话 */
  try {
    ctx.effect(
      () =>
        webServer.register({
          kind: 'exact',
          path: '/filmflow/say',
          handler: async (req, res) => {
            /* ★ 写操作闸门 —— 见 requireToken 的注释 */
            if (!requireToken(req, res)) return;
            if (req.method !== 'POST') {
              res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8', Allow: 'POST' });
              res.end('只支持 POST');
              return;
            }
            let body;
            try {
              body = JSON.parse(await readBody(req));
            } catch {
              sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' });
              return;
            }
            const wanted = String(body?.root || '').replace(/[\\/]+$/, '').toLowerCase();
            const root = discoverProjects(roots, explicit).find((r) => r.toLowerCase() === wanted);
            if (!root) {
              sendJson(res, 400, { ok: false, error: 'root 不在已发现的项目里' });
              return;
            }
            const text = String(body?.text || '').trim();
            if (!text) {
              sendJson(res, 400, { ok: false, error: '没说话' });
              return;
            }
            pushFeed(root, 'user', text);
            // 用户说的话原样送进去，前面加一句上下文（那个 Agent 不知道是谁在说）
            wakeAgent(ctx, root, roots[0], '【用户在对你说】\n' + text + '\n\n（按规矩办：先 filmflow_board 看全貌；没内容要改就直接 sync，要改内容再用 filmflow_propose 提案。）', trace);
            sendJson(res, 200, { ok: true });
          },
        }),
      'filmflow: POST /filmflow/say',
    );
    trace('已注册路由 /filmflow/say');
  } catch (e) {
    trace('注册 /filmflow/say 抛出: ' + String((e && e.stack) || e));
  }

  /* ================================================================== *
   * 给 Agent 的工具 —— 插件 ↔ Agent 协作的**唯一活路**
   *
   * 为什么是这条路（2026-10-14 实测）：
   *   · 客户端 `ctx.remote.commands.execute` 存在且可用，但只能跑 6 个斜杠命令
   *     （compact/export/feedback/goal/permission/plan）—— **没有"往对话里送任意
   *     文字"的能力**，所以"插件主动推消息给 Agent"是死的。
   *   · `ctx.tools.register` 可用 → Agent **主动拉**。
   *
   * 为什么手写对象而不是 `defineTool`：`defineTool` 从 `@deepseek-ai/dsh-tools` 导出，
   * 而本插件目录没有 node_modules、那个包也不在祖先路径上，import 解析不到。
   * 好在 `defineTool` 干的只是"把一套 DSL 编译成标准 JSON Schema 再拼出对象"，
   * **拼出来的形状用的就是标准 JSON Schema** —— 手写一份完全等价，还保持零依赖。
   *
   * 用户的核心要求是「Agent 要根据任意节点中任意内容的改动自动改其他节点的内容」。
   * 这四个工具就是它的手脚：
   *   filmflow_board  —— 看整张图 + **哪些节点过期了**（每一步开头先调它）
   *   filmflow_node   —— 看一个节点的完整指令、读什么、写到哪、谁依赖它
   *   filmflow_write  —— 把内容写回源文件（走同一套护栏）
   *   filmflow_sync   —— 把下游改完之后对齐，清掉过期标记
   * ================================================================== */

  const OUT_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: { report: { type: 'string' } },
    required: ['report'],
  };
  const OUT_RENDER = (_args, value) => [
    { type: 'text', text: String((value && value.report) || '') },
  ];
  const params = (properties, required) => ({
    type: 'object',
    additionalProperties: false,
    properties: properties || {},
    required: required || [],
  });
  const pStr = (desc) => ({ type: 'string', description: desc });
  /** 对象型参数（用于 struct 这种结构化入参）。 */
  const pObj = (desc) => ({ type: 'object', description: desc, additionalProperties: true });
  const pNum = (desc) => ({ type: 'number', description: desc });

  /** 按名字/路径挑项目；不给就全部。 */
  const pickProjects = (want) => {
    const all = [];
    for (const r of discoverProjects(roots, explicit)) {
      const p = buildProject(r);
      if (p.ok) all.push(p);
    }
    /*
     * ★ **没传 project 时的默认项目**（2026-10-20，独立版必需）
     *
     * 在 DSH 里，四把工具是 **scoped 副本**、`project` 被写死（见 setup）。
     * 但在 headless 形态下没有 `ensureAgent`/`setup` ⇒ 用的是这些**全局**工具、
     * `project` 参数没人填 ⇒ `want` 是空的 ⇒ 返回**全部项目** ✗
     * ⇒ 实测后果：独立版问《测试2》，它却把《新片》《测试》混在一起答，
     *   答出"在项目「新片」里…陈默、江屹、医生"（那是《测试》的人物）✗
     *
     * 所以：独立版 spawn headless 时带 `FILMFLOW_PROJECT=<项目根>`，
     * 这里兜底取它 ⇒ 工具就只认这一部片 ✓
     */
    if (!want) want = CURRENT || process.env.FILMFLOW_PROJECT || '';
    if (!want) return all;
    const w = String(want).trim().toLowerCase();
    /*
     * ★★ **找不到就报错，不再静默返回全部项目。**
     *
     * 原来这行是 `return keep.length ? keep : all;` ✗ ——
     * 传错项目名（大小写、正斜杠/反斜杠、少一层目录）都会**悄悄拿到全部项目**，
     * 然后 agent 就在别的片子上干活 —— **这是串台的设计级入口** ✗
     * （实测：我用 `E:/filmflow/测试`（正斜杠）打过去，它返回了三部片，
     *   我只看了前 42 行，还误以为它"硬编码了新片" ✗）
     *
     * 现在：先按明确 id 找；再按包含匹配找；**都不中 → 抛错并列出可用项目** ✓
     */
    /*
     * ★★ **匹配顺序（2026-10-19 实测补的一条）**
     *
     * 原来只有「包含匹配」✗ —— 实测踩到：请求 `<片库根>\测试`，
     * 而 `<片库根>\测试2` **包含** `<片库根>\测试` ⇒ **两个都命中**，
     * 报告里《测试2》排在了《测试》前面 ✗
     *
     * 所以顺序必须是：
     *   ① **root 精确相等**（规范化斜杠、去尾斜杠、忽略大小写）
     *   ② 标题或 root **完全相等**
     *   ③ 才退到包含匹配；且**命中多个时取 root 最短的那个**（最具体）
     */
    const norm = (s) => String(s || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    const nw = norm(want);
    const exactRoot = all.filter((p) => norm(p.root) === nw);
    if (exactRoot.length) return exactRoot.slice(0, 1);
    const exactName = all.filter((p) => p.title.toLowerCase() === w || norm(p.title) === nw);
    if (exactName.length) return exactName.slice(0, 1);
    const exactId = all.filter((p) => String(p.id).toLowerCase() === w);
    if (exactId.length) return exactId.slice(0, 1);
    const keep = all.filter((p) => p.title.toLowerCase().includes(w) || norm(p.root).includes(nw));
    if (keep.length) {
      // 命中多个 ⇒ 取 root 最短的（最具体，避开「测试」被「测试2」裹住的情况）
      return keep.slice().sort((a, b) => norm(a.root).length - norm(b.root).length).slice(0, 1);
    }
    const avail = all.map((p) => '「' + p.title + '」' + p.root).join('　');
    throw new Error(
      '找不到这个项目：' + String(want) + '　可用的有：' + (avail || '（一个都没有）'),
    );
  };

  /**
   * 按**编号 / 源文件路径 / 标题**找一个节点。
   *
   * 为什么不能只按编号找：④⑤ 那两步是「一个任务一个文件」，图上的叶子是
   * `audio-001.txt` 这类**内容节点，没有编号**。只认编号的话 Agent 够不着它们，
   * 只能绕开插件用自己的 write 工具 —— 白名单护栏就白设了。
   *
   * 找不到返回 null，调用方负责给出可用清单。
   */
  const findNode = (p, key) => {
    const k = String(key == null ? '' : key).trim();
    if (!k) return null;
    const all = [];
    const walk = (n) => {
      all.push(n);
      for (const c of n.children || []) walk(c);
      for (const c of n.content || []) walk(c);
    };
    for (const s of p.stages) walk(s);

    const norm = (x) => String(x || '').replace(/\\/g, '/').toLowerCase().replace(/^\.\//, '');
    return (
      // key 优先：它是稳定身份，插入/重编号之后依然指得准
      all.find((n) => n.key && String(n.key) === k) ||
      all.find((n) => n.no !== undefined && String(n.no) === k) ||
      all.find((n) => n.src && norm(n.src) === norm(k)) ||
      all.find((n) => n.src && norm(n.src).endsWith('/' + norm(k))) ||
      all.find((n) => String(n.title || '') === k) ||
      null
    );
  };

  /**
   * 把依赖标识渲染成人能读的样子：`k1-3` → `1.3 事实层`。
   * 依赖现在存的是 key（稳定身份），但人读的是编号和标题。
   * @param p - 项目
   * @param ds - 依赖标识数组
   * @returns 一段可读文本
   */
  const depLabel = (p, ds) => {
    const all = [];
    const walk = (n) => {
      all.push(n);
      for (const c of n.children || []) walk(c);
      for (const c of n.content || []) walk(c);
    };
    for (const s of p.stages) walk(s);
    const one = (d) => {
      const t = all.find((n) => String(n.key) === String(d) || String(n.no) === String(d));
      if (!t) return String(d) + '（找不到这个节点）';
      return String(t.no) + ' ' + String(t.title);
    };
    return (ds || []).map(one).join(' / ');
  };

  /** 报「找不到」时给一份可用的钥匙清单，别让 Agent 干猜。 */
  const nodeKeys = (p) => {
    const nos = [];
    const srcs = [];
    const walk = (n) => {
      // 编号带上 key —— key 是稳定身份，重编号之后仍然指得准
      if (n.no !== undefined && String(n.no) !== '') {
        nos.push(n.key && String(n.key) !== deriveKey(n.no) ? String(n.no) + '(' + n.key + ')' : String(n.no));
      }
      if (n.src) srcs.push(String(n.src));
      for (const c of n.children || []) walk(c);
      for (const c of n.content || []) walk(c);
    };
    for (const s of p.stages) walk(s);
    return (
      '编号：' +
      nos.join(' / ') +
      (srcs.length ? '\n或源文件路径（前面任意一段可省）：' + srcs.slice(0, 40).join(' / ') : '')
    );
  };

  /** 哪些节点过期了（图上标 ⚠ 的那些）。 */
  const staleOf = (p) => {
    const out = [];
    const walk = (n) => {
      if (n.stale === 'stale') out.push(n);
      for (const c of n.children || []) walk(c);
    };
    for (const s of p.stages) walk(s);
    return out;
  };

  /** 整张图的文字报告。 */
  const boardReport = (projects) => {
    const L = [];
    for (const p of projects) {
      L.push('【' + p.title + '】' + p.root);
      const st = staleOf(p);
      if (st.length) {
        L.push('');
        L.push('⚠ **' + st.length + ' 个节点过期** —— 它们的上游改过了，内容可能已经不对：');
        for (const n of st) {
          /*
           * 每个过期节点都带上**为什么过期**（哪几个上游改了）。
           * 用户 2026-10-21：「上游改了 agent 可以直接同步下游；下游改了要请示」——
           * 要让它敢自动做，就得把"因为谁"摆出来，而不是让它自己猜。
           */
          const why = n.staleWhy ? '　← ' + n.staleWhy : '';
          L.push('     · ' + n.no + ' ' + n.title + why);
        }
        L.push('   → 用 filmflow_node 看详情：**要改就按 §二·五 处理**（同方向可直接改，反向先问）。');
        L.push('   → **没内容要改就直接 filmflow_sync 对齐**；别把「过期」当成人要处理的待办。');
      } else {
        L.push('✓ 没有过期节点。');
      }
      if (p.note) {
        L.push('');
        L.push('【项目说明】' + p.note);
      }
      const dump = (n, depth) => {
        const pad = '  '.repeat(depth);
        const bits = [];
        if (n.dependsOn && n.dependsOn.length) bits.push('读←' + depLabel(p, n.dependsOn));
        /*
         * ★ **状态就地释义** —— 用户 2026-10-19 那个 agent 的原话：
         *   "board said 状态 na for 1.1-1.5 which might mean 未开始... but contents
         *    are there. Hmm, maybe na = 状态 not applicable? Let me not over-interpret"
         * ⇒ `na` 的真实含义是**「没声明产物」**（见 outputStatus 的注释），
         *   跟「正文写没写」完全无关。不解释它，agent 只能瞎猜。
         */
        const ST_TXT = {
          ok: 'ok（产物齐全）',
          partial: 'partial（产物不全）',
          missing: 'missing（产物都没建）',
          na: 'na（未声明产物，不是没开工）',
        };
        bits.push('状态 ' + (ST_TXT[n.status] || n.status || 'na'));
        /*
         * ★ **正文有没有内容** —— 这是 agent 判断"这一步做完没有"真正该看的。
         *   原来只有一个含义不明的 `内容 N`，而且 contentTotal 为 0 时干脆不显示 ✗
         */
        const bodyLen = String(n.text || '').replace(/\s+/g, '').length;
        bits.push('正文 ' + (bodyLen ? '有（' + bodyLen + ' 字）' : '无'));
        if (n.md && n.md.length) bits.push('写 ' + n.md.join(' '));
        if (n.files && n.files.length) bits.push('写 ' + n.files.join(' '));
        if (n.stale === 'stale') bits.push('⚠过期（去看一眼，不一定要改）');
        else if (n.stale === 'unknown') bits.push('未同步（从没跟上游对齐过）');
        L.push('');
        L.push(pad + (n.no ? n.no + ' ' : '') + n.title + '　[' + bits.join(' · ') + ']');
        if (n.doctrine) for (const ln of String(n.doctrine).split('\n')) L.push(pad + '  ' + ln);
        for (const c of n.children || []) dump(c, depth + 1);
        // ★ list 形态拆出来的条目节点在 content 里（画布的 branch() 两个都遍历）
        for (const c of n.content || []) dump(c, depth + 1);
      };
      L.push('');
      /*
       * ★ **词汇表** —— 一次说清，省得它每次猜。
       *   用户 2026-10-19 那个 agent 就在 `状态 na` 上卡住过（原话见上面 dump 里的注释）。
       */
      L.push('==== 怎么读这份报告 ====');
      L.push('  状态 ok / partial / missing = 声明的【产物文件】齐全 / 不全 / 都没建');
      L.push('  状态 na                      = 这个节点【没声明产物】—— **不是"没开工"**，与正文无关');
      L.push('  正文 有（N 字）/ 无           = 它的源文件里**有没有内容** ← 判断"这一步做完没有"看这个');
      L.push('  ⚠过期                        = 上游被改过，内容**可能**对不上 → **去看一眼**，不一定要改');
      L.push('  未同步                        = 从没跟上游对齐过');
      L.push('');
      L.push('==== 工序 ====');
      for (const s of p.stages) dump(s, 0);
      /*
       * ★ **"下一步"** —— 用户 2026-10-19 问「如何让他明白工具的使用方法」。
       *   官方文档说得明白：模型只看得见 name/description/parameters，
       *   **没有"工具手册"这种通道**。所以"教用法"只能落在两处：
       *     ① description 里写决策表（已做）
       *     ② **返回值里带"下一步"** ← 这就是 ②
       *   ② 比 ① 更强：它永远跟当前状态一致，不会像文档那样腐烂。
       */
      L.push('');
      L.push('==== 下一步 ====');
      L.push('  挑一个要紧的节点（⚠过期 的优先，或者用户点名的那一步）');
      L.push('  → filmflow_node({node:"1.3"})   读它的指令和当前正文');
      L.push('  → 判断：到底要不要改？改哪几句？');
      L.push('  → 要改就 filmflow_propose({node, text, why})   等用户在图点确认');
      L.push('  → 不用改（核对过一致）就 filmflow_sync({node})  把标记对齐');
    }
    if (!projects.length) L.push('没有找到任何项目。检查 .film/project.json 是否存在。');
    return L.join('\n');
  };

  /** 一个节点的详细报告。`key` 可以是编号、源文件路径或标题。 */
  const nodeReport = (p, key) => {
    const n = findNode(p, key);
    if (!n) {
      return '【' + p.title + '】里找不到「' + key + '」。可用的钥匙：\n' + nodeKeys(p);
    }
    const L = [];
    L.push('【' + p.title + '】' + (n.no ? n.no + ' ' : '') + n.title);
    L.push('');
    L.push('指令：');
    L.push(n.doctrine || '（这个节点没有写指令 —— 那是个缺陷，别自己猜，问用户）');
    if (n.note) {
      L.push('');
      L.push('注：' + n.note);
    }
    L.push('');
    L.push('读 ← ' + ((n.dependsOn || []).length ? depLabel(p, n.dependsOn) : '（没有声明上游）'));
    L.push('写 → ' + (n.md && n.md.length ? n.md.join(' / ') : n.files && n.files.length ? n.files.join(' / ') : '（没声明产物路径）'));
    L.push('形态：' + ((n.shape && n.shape.kind) || 'text'));
    L.push(
      '同步状态：' +
        (n.stale === 'stale'
          ? '⚠ 过期 —— 上游改过了'
          : n.stale === 'unknown'
            ? '未同步（还没跟依赖对齐过）'
            : n.stale === 'ok'
              ? '与依赖一致'
              : '不适用（没有依赖）'),
    );
    const kids = (p.stages || []).length ? [] : [];
    L.push('');
    /*
     * ★ 子节点要**两处都算**：`children` 是 project.json 里声明的，
     *   `content` 是文件解析出来的（list 形态一个条目一个节点就在这儿）。
     *   画布的 `branch()` 本来就两个都遍历 ✓，这里之前只算 children ✗
     *   ⇒ agent 在报告里看不到「周衍」「陈默」这些条目节点，以为没有。
     */
    const allKids = [...(n.children || []), ...(n.content || [])];
    L.push(
      '子节点：' +
        (allKids.length
          ? allKids.map((c) => (c.no ? c.no + ' ' : '') + c.title).join(' / ')
          : '（无）'),
    );
    void kids;
    L.push('');
    L.push('当前正文（原样 markdown）：');
    L.push(String(n.text || '（空）'));
    /* ★ 下一步（同上：返回值里教学，永远跟状态一致） */
    L.push('');
    L.push('==== 下一步 ====');
    if (n.stale === 'stale') L.push('  这个节点标着 ⚠过期 —— 先判断它的内容跟上游是否真的对不上。');
    L.push('  要改 → filmflow_propose({node:"' + (n.no || n.title) + '", text:<完整正文>, why:<一句话为什么>})');
    L.push('         提案**不会立刻生效**，等用户在图上的卡片里点「确认，写进画布」。');
    L.push('  核对过其实一致 → filmflow_sync({node:"' + (n.no || n.title) + '"}) 把 ⚠过期 清掉，正文不用动。');
    return L.join('\n');
  };

  try {
    if (!ctx.tools || typeof ctx.tools.register !== 'function') {
      trace('[工具] ctx.tools.register 不可用，跳过注册');
    } else {
      /*
       * 注册一个工具，并把注销函数收起来。
       * `register` 返回的是**精确的注销器** —— apply 退出时要还回去，
       * 否则插件卸载后会在工具表里留下幽灵工具（跟路由那边 ctx.effect 是一个道理）。
       */
      const toolDisposers = [];
      const reg = (def) => {
        toolDisposers.push(ctx.tools.register(def));
        /*
         * ★★ **把定义记下来** —— 每个项目的 agent 要拿到"绑死自己项目"的副本。
         *
         * 用户 2026-10-16 报的串台：那个 agent 调 `filmflow_board` **不带参数**
         * → 拿到【全部项目】的报告 → 赛博故事内容多 → 它就聊赛博故事 ✗
         * 而这个口子在"工具限制死"之后**仍然开着**（那四把工具本来就在它手里）。
         */
        AGENT_TOOLS.push(def);
      };

      reg({
        name: 'filmflow_board',
        description: [
          '看这部片的全片工序图：每道工序的任务、产物路径、**正文有没有内容**、**哪些节点过期**。',
          '',
          '**必须调**：每次任务的第一步（先看全貌再动手）；你准备改任何内容之前；用户问"做到哪了"时。',
          '**不必调**：本轮已经调过、且期间没人改过画布 —— 内容不会变。',
          '',
          '**返回**一张树状报告。先读开头的「怎么读这份报告」—— 那里解释 `状态 na` / `正文` / `⚠过期` 各是什么意思。',
        ].join('\n'),
        parameters: params({ project: pStr('已绑死到当前项目，传了也会被忽略') }),
        output: { schema: OUT_SCHEMA, render: OUT_RENDER },
        async execute(args) {
          return { report: boardReport(pickProjects(args && args.project)) };
        },
      });

      reg({
        name: 'filmflow_node',
        description: [
          '读**一个节点**的完整说明：这一步做什么、从哪读、写到哪、按什么格式、有什么规矩、完成判据，以及它当前的正文。',
          '',
          '**必须调**：要动哪个节点之前 —— 它的任务/格式/规矩只在这份说明里，**别凭猜测写**。',
          '**不必调**：只是回答"做到哪了"（看 board 就够，省 token）。',
          '',
          '**返回**指令全文 + 当前正文。**写法必须照抄它的「格式」那一段** —— 图上的编辑器按它解析。',
        ].join('\n'),
        parameters: params(
          {
            project: pStr('已绑死到当前项目，传了也会被忽略'),
            node: pStr('节点编号，例如 "1.3" 或 "3"'),
          },
          ['node'],
        ),
        output: { schema: OUT_SCHEMA, render: OUT_RENDER },
        async execute(args) {
          const ps = pickProjects(args && args.project);
          if (!ps.length) return { report: '没找到项目。' };
          return { report: nodeReport(ps[0], String((args && args.node) || '')) };
        },
      });

      /*
       * ★ 唯一的写入入口：**提案**，不是落盘。
       *   用户 2026-10-15：「你的改动有些时候可能是不太合理或者是不太清晰的，
       *   所以你要先对我进行询问，我确认之后，他再写进画布。」
       */
      reg({
        name: 'filmflow_propose',
        description: [
          '提交一处修改建议。**这是唯一能改内容的途径** —— 你没有写文件的工具，不要试图直接写。',
          '',
          '**调它之前**：先用 board 看全貌、用 node 读那个节点的指令，并且已经想清楚"改哪几句、为什么"。',
          '**不该调**：还在判断中（先读 node）；或者核对后发现内容其实不用改（那就直接 filmflow_sync）。',
          '',
          '**写法**：',
          '· `text` 给**完整正文**（不是 diff、不是"建议加一句"），格式照该节点「格式」那段',
          '· `why` 一句话说清"为什么这么改" —— 用户不看你的思考过程，只看这一句',
          '· 拿不准就把"拿不准"写进 `why`，别猜着改',
          '',
          '**返回**提案 id。**它还没生效** —— 等用户在图上的卡片里点「确认，写进画布」。',
        ].join('\n'),
        parameters: params(
          {
            project: pStr('已绑死到当前项目，传了也会被忽略'),
            node: pStr('节点编号 / key / 源文件路径，例如 "1.4" 或 "k1-4" 或 "设定/认知层.md"'),
            text: pStr('你建议改成的正文（markdown，按该节点指令里的格式写）。改结构时可不填'),
            why: pStr('为什么这么改 —— 用户要看的就这一句，说人话，别复述指令'),
            struct: pObj(
              '要**改结构**时填它（用户 2026-10-21：agent 也可以提议增删节点）。'
              + ' 形如 {"op":"delete","key":"k5"} / {"op":"add","at":"k1","template":"facts"}'
              + ' / {"op":"move","key":"k1-3","dir":"up"} / {"op":"rename","key":"k1-3","title":"事实列"}。'
              + ' add 也可以自建：title（节点名）、doctrine（五段指令）、'
              + ' shape（{"kind":"list|table|matrix|text",…}；list/matrix 要 fields，table 要 columns）、'
              + ' md（产物路径，如 "设定/人物关系.md"；不填就落在 工艺/<标题>.md，'
              + ' doctrine 的【写】必须和它一致）、dependsOn（数组，只写真正读的节点 key）。'
              + ' 新建前先调 filmflow_templates 看有没有现成的，别重复造。'
              + ' **父子组合有硬约束**：生成节点只能挂同类型提示词或顶层且依赖它；'
              + '模型节点只能挂同类型提示词/分镜/顶层；模型与生成节点是叶子。'
              + ' 非法组合会在提案时被拒（报错会写"只能放在…"），先看清再提。'
              + ' 与 text 二选一；用户确认后由宿主执行。',
            ),
          },
          ['why'],
        ),
        output: { schema: OUT_SCHEMA, render: OUT_RENDER },
        async execute(args) {
          const ps = pickProjects(args && args.project);
          if (!ps.length) throw new Error('没找到项目');
          const p = ps[0];

          /*
           * ★ 结构提案（2026-10-21 用户报"agent 只能拒绝，不能删节点"）。
           *
           * 用户的设计从来是「agent 出提案 → 人确认 → 宿主执行」。改内容走这条路，
           * 改**结构**也该走同一条路：agent 能说"我建议删掉 ⑤"，但不能自己删。
           * 宿主在这里只**记**提案，真正动手在 /filmflow/approve 里。
           */
          const struct = args && args.struct;
          if (struct && typeof struct === 'object') {
            const op = String(struct.op || '');
            const allowed = ['add', 'delete', 'move', 'rename', 'expand'];
            if (!allowed.includes(op)) throw new Error('struct.op 只认：' + allowed.join(' / '));
            /* 结构合法性：在提案时就挡住（R47）。改内容不经过这里。 */
            if (op === 'add') validateAddProposal(p.root, struct);
            const label = (() => {
              if (op === 'add') return '在「' + String(struct.at || '') + '」下新建' + (struct.template ? '（模板 ' + struct.template + '）' : '');
              if (op === 'delete') return '删除节点「' + String(struct.key || '') + '」';
              if (op === 'move') return '把「' + String(struct.key || '') + '」' + (struct.dir === 'up' ? '上移' : '下移');
              if (op === 'rename') return '把「' + String(struct.key || '') + '」改名为「' + String(struct.title || '') + '」';
              return '按文件展开「' + String(struct.key || '') + '」';
            })();
            const list = readProposals(p.root);
            const id = 'p' + Date.now().toString(36);
            list.push({
              id,
              at: new Date().toISOString(),
              project: p.title,
              node: String(struct.key || struct.at || ''),
              nodeTitle: label,
              src: '',
              group: '',
              why: String(args.why || ''),
              kind: 'struct',
              struct: { ...struct, op },
              before: '',
              after: '',
              status: 'pending',
            });
            writeProposals(p.root, list);
            trace('[结构提案] ' + id + ' ' + label);
            return {
              report:
                '结构提案已提交（id ' + id + '）：' + label + '\n'
                + '理由：' + String(args.why || '（没写）') + '\n'
                + '**还没生效** —— 等用户在画布上点「确认」。\n'
                + '在用户确认之前不要重复提交同一条，也不要试图绕过它。',
            };
          }

          const n = findNode(p, args && args.node);
          if (!n) throw new Error('找不到「' + (args && args.node) + '」这个节点。可用的钥匙：\n' + nodeKeys(p));
          if (!n.src) throw new Error('节点「' + (n.no || n.title) + '」没有声明源文件，没法提案');

          const { decl } = readDecl(join(p.root, DECL));
          const abs = join(p.root, ...String(n.src).split('/'));
          if (!isWritable(p.root, decl, abs)) {
            throw new Error('拒绝：' + n.src + ' 没在 project.json 的 md / files 里声明过');
          }

          const list = readProposals(p.root);
          const id = 'p' + Date.now().toString(36);
          list.push({
            id,
            at: new Date().toISOString(),
            project: p.title,
            node: String(n.no || ''),
            nodeTitle: String(n.title || ''),
            src: String(n.src),
            group: String(n.group || ''),
            why: String(args.why || ''),
            before: previewOf(p.root, n),
            after: String(args.text ?? ''),
            status: 'pending',
          });
          writeProposals(p.root, list);
          return {
            report:
              '提案已提交（id ' +
              id +
              '），**现在等用户在图上确认**。\n' +
              '目标：' +
              (n.no ? n.no + ' ' : '') +
              n.title +
              '　→ ' +
              n.src +
              '\n' +
              '你写的理由：' +
              String(args.why || '（没写）') +
              '\n' +
              '在用户点确认之前，**不要重复提交同一条提案**，也不要试图绕过它去写文件。' +
              '你可以继续用 filmflow_node / filmflow_board 读，或者告诉用户你在等什么。',
          };
        },
      });

      /*
       * ⛔ 这里原来还注册过一个 `filmflow_write`（直接落盘的施工口）。
       *    2026-10-15 按用户要求闸死，2026-10-20 干脆**整个删掉**：
       *
       *      · 它已经不接受任何写入，调用只会抛错
       *      · 但 agent 在工具清单里看得见它，于是每轮都要花一句话解释"这个停用了"
       *        （实测：第一次自检它就主动补了一句「filmflow_write 已停用，不把它算作可用工具」）
       *      · 而 CONSTITUTION.md 写的是"四把工具"，多一把死的就自相矛盾
       *
       *    ⇒ 少一把没用的工具，比多一句解释便宜。
       *    路由 `/filmflow/edit` **保留**：画布上的卡片保存走它，不经过 agent。
       */

      reg({
        name: 'filmflow_sync',
        description: [
          '把节点跟它依赖的上游对齐 —— 记录当前指纹、清掉「⚠ 过期」标记。',
          '',
          '**什么时候调**：你已经**逐一核对过**这个节点的内容和它的上游一致（哪怕一个字没改）。',
          '**什么时候不要调**：还没核对、或者你打算改但还没改 —— 那会**把真的不一致盖掉**，以后再也看不出来。',
          '',
          '**⚠ 它不改内容**，只改"已对齐"这个标记。改内容只能用 filmflow_propose。',
          '',
          '**返回**哪些节点被对齐了。对齐之后**再调一次 board** 确认没有 ⚠ 过期 了。',
        ].join('\n'),
        parameters: params({
          project: pStr('已绑死到当前项目，传了也会被忽略'),
          node: pStr('只对齐这一个节点编号；省略=整部片'),
        }),
        output: { schema: OUT_SCHEMA, render: OUT_RENDER },
        async execute(args) {
          const ps = pickProjects(args && args.project);
          if (!ps.length) throw new Error('没找到项目');
          const r = syncNodes(ps[0].root, args && args.node);
          return {
            report:
              '已对齐：' +
              (r.synced.length ? r.synced.join(' / ') : '（没有需要对齐的节点）') +
              '\n时间：' +
              r.at +
              /* ★ 下一步（返回值里教学，永远跟状态一致） */
              '\n\n==== 下一步 ====' +
              '\n  调一次 filmflow_board 确认没有 ⚠过期 了。' +
              '\n  如果还有，说明那条链路你还没处理完 —— 回到 filmflow_node 读它。' +
              '\n  如果全干净了，把这次做完的事**用一句人话**告诉用户（改了什么、为什么），别只报"已对齐"。',
          };
        },
      });

      /*
       * ★ 第五把工具：filmflow_search —— 给 agent 的"检索清单"。
       *
       * 用户 2026-10-21 决定**不给正文加词条标注**（"2026 年了 agent 处理文本够可靠"）。
       * 那就必须换一种方式防漏改：把「这串字出现在哪些节点、哪一行」机械地列出来。
       *
       * 它**不改任何东西**，只供料 —— 与"agent 驱动同步"完全一致：
       * agent 判断要不要改，宿主保证它不漏看。
       */
      /*
       * 第六把工具：**下游直写**。
       *
       * 用户 2026-10-21 定了"上游改→下游可直接改，下游改→上游必须先问"，
       * 但之前只给了 propose ⇒ 两个方向都被迫走提案，那条授权等于没有。
       * 这个工具就是那条授权的入口，判据由宿主算（节点必须真的因上游改动而过期），
       * agent 自己声明的方向不算数。
       */
      reg({
        name: 'filmflow_apply',
        description: [
          '把内容**直接写进下游节点**（不需要提案、不需要用户点确认）。',
          '',
          '**什么时候用**：`board` 里某个节点标着 `⚠ 过期`，且原因是「上游改过了」——',
          '也就是**上游改、下游跟着改**这个方向（用户已授权）。改完它自动对齐，不用再 sync。',
          '',
          '**什么时候不能用**：节点不是"上游改动导倒的过期"（比如它根本没依赖，或者过期是别的来源）。',
          '这种情况下宿主会拒绝，并让你去 `filmflow_propose` 提案 —— 那是**下游改、上游跟着改**的方向，',
          '必须先问用户。别试图绕过。',
          '',
          '**写法**：`text` 给**完整正文**（不是 diff），格式照该节点 `filmflow_node` 里的「格式」那段。',
        ].join('\n'),
        parameters: params(
          {
            project: pStr('已绑死到当前项目，传了也会被忽略'),
            node: pStr('节点编号 / key / 源文件路径，例如 "1.4" 或 "k1-4"'),
            text: pStr('完整正文（markdown，按该节点指令里的格式写）'),
            why: pStr('一句话说清依据：上游哪一处改了、所以这里跟着改什么'),
          },
          ['node', 'text', 'why'],
        ),
        output: { schema: OUT_SCHEMA, render: OUT_RENDER },
        async execute(args) {
          const ps = pickProjects(args && args.project);
          if (!ps.length) throw new Error('没找到项目');
          const p = ps[0];
          const r = applyDownstream(p.root, args || {});
          return {
            report:
              '已直接写入「' + r.node + '」' + '　→ ' + r.src + '\n'
              + '依据：' + String(args.why || '（没写）') + '\n'
              + '这是"上游改→下游"的授权方向，不需要提案；记得在回话里说一句改了哪几处。',
          };
        },
      });
      /*
       * 第七把工具：**填提示词**（不生成）。
       *
       * 用户 2026-10-22：「程序有填入提示词的权限，没请求生成的权限，
       * 确认生成由用户手动点击生成节点上的按钮完成。」
       * ⇒ 这个工具只能改媒体节点的提示词/模型/参数；**没有任何参数能让它发起生成**。
       */
      reg({
        name: 'filmflow_set_media',
        description: [
          '把提示词（和模型/分辨率等参数）写进一个**媒体节点**。',
          '',
          '**只写提示词，不会生成。** 生成必须由用户在画布上点节点里的「生成」按钮 ——',
          '这是用户定的：花钱的动作只能人按。',
          '',
          '写完之后，在回话里告诉用户：我在「节点名」里写好了提示词，你点「生成」就会出图。',
          '',
          '**写提示词前先看 docs/提示词-按模型规范.md**：视频按 Seedance 2.0 的进阶公式',
          '（主体+动作+场景+光影+运镜+风格+画质+约束），有参考素材用「参考<图片N>中的<主体N>」句式；',
          'Seedance 2.5 用整数秒时间轴（≤30s）；Seedance 2.0 只认镜头序号、不认时间戳；',
          'Seedream 图片提示词要简洁（官方：简洁精确优于堆词），要渲染的文字放双引号。',
          '写 2.5 的提示词请按 docs/sd25-pe-SKILL.md 的模板重组；画幅/时长/分辨率不要写进提示词正文。',
        ].join('\n'),
        parameters: params(
          {
            project: pStr('已绑死到当前项目，传了也会被忽略'),
            node: pStr('媒体节点的编号 / key / 标题'),
            prompt: pStr('要写进去的提示词（完整、可直接发给模型）'),
            model: pStr('可选：图片 seedream_5.0_pro；视频 Seedance_2.5 / seedance2.0_vision 等'),
            resolution: pStr('可选：图片 1K/2K/4K；视频 480p/720p/1080p'),
            durationSec: pNum('可选：视频时长（秒）'),
            why: pStr('为什么这么写 —— 用户要看的那一句'),
          },
          ['node', 'prompt', 'why'],
        ),
        output: { schema: OUT_SCHEMA, render: OUT_RENDER },
        async execute(args) {
          const ps = pickProjects(args && args.project);
          if (!ps.length) throw new Error('没找到项目');
          const p = ps[0];
          const r = structureOp(p.root, {
            type: 'setMedia',
            key: String(args.node || ''),
            by: 'agent',
            why: String(args.why || ''),
            fields: {
              prompt: String(args.prompt || ''),
              ...(args.model ? { model: String(args.model) } : {}),
              ...(args.resolution ? { resolution: String(args.resolution) } : {}),
              ...(args.durationSec ? { durationSec: Number(args.durationSec) } : {}),
            },
          });
          return {
            report:
              '提示词已写进「' + String(args.node || '') + '」（改了：' + (r.changed || []).join('/') + '）。\n'
              + '**没有生成** —— 生成要用户自己在画布上点那个节点里的「生成」按钮。\n'
              + '依据：' + String(args.why || '（没写）'),
          };
        },
      });
      reg({
        name: 'filmflow_search',
        description: [
          '在一部片的所有节点正文里检索一段文字，列出**出现位置**（节点 / 文件 / 行号 / 那句话）。',
          '',
          '**什么时候用**（这是同步改动的必备动作）：',
          '· 用户改了下游的某个说法（人名、术语、规则），你要同步上游 —— 先用它查清上游**哪些地方**提到了它',
          '· 你要改某个概念，先查它散落在哪些节点里，避免只改一处',
          '· 核对某段描述是否还有残留（改完再查一次，结果应为空）',
          '',
          '**它只读**，不改任何文件。大小写不敏感；一次最多返回 40 条。',
          '**注意**：它按**字面**检索，所以同义词、代词查不到 —— 那些要靠你读 filmflow_node。',
          '',
          '**下一步**：拿到清单后逐个 filmflow_node 读上下文，再决定改哪几处（改内容只能 filmflow_propose）。',
        ].join('\n'),
        parameters: params({
          project: pStr('已绑死到当前项目，传了也会被忽略'),
          text: pStr('要检索的文字（必填）'),
        }),
        output: { schema: OUT_SCHEMA, render: OUT_RENDER },
        async execute(args) {
          const ps = pickProjects(args && args.project);
          if (!ps.length) throw new Error('没找到项目');
          const q = String((args && args.text) || '').trim();
          if (!q) throw new Error('要给我要检索的文字（text）');
          const r = searchInProject(ps[0].root, q);
          const L = [];
          L.push('检索「' + q + '」：' + r.总命中 + ' 处，分布在 ' + r.节点数 + ' 个节点。');
          if (!r.总命中) {
            L.push('');
            L.push('一个字都没找到。可能是：① 已经改干净了 ② 你查的词和正文里的写法不一样（同义词/简写）');
            L.push('→ 换个更短的词再查一次（比如只查人名的一部分）。');
          }
          for (const hit of r.hits) {
            L.push('');
            L.push('· ' + hit.no + ' ' + hit.title + '　（' + hit.src + '）');
            for (const m of hit.matches) {
              L.push('    第 ' + m.line + ' 行：' + m.text);
            }
          }
          if (r.hits.length < r.节点数) L.push('\n（只列了前 40 条命中）');
          L.push('');
          L.push('==== 下一步 ====');
          L.push('  ① 对每一处 filmflow_node({node:"…"}) 读上下文');
          L.push('  ② 决定改哪几句 → filmflow_propose({node, text, why})');
          L.push('  ③ 改完**再调一次本工具**，确认该改的都改了（结果应为空或只剩故意保留的）');
          L.push('  ④ 最后 filmflow_sync 对齐');
          return { report: L.join('\n') };
        },
      });

      /*
       * 模板库（只读）：让 agent 在自建节点前先看清"已经有什么"。
       * 用户 2026-10-27：「片厂的 agent 要和你一样清楚，才能自己设计新节点不出问题」。
       */
      reg({
        name: 'filmflow_templates',
        description: [
          '列出本机模板库：**已有节点模板**（按类别）和**项目预设**。只读，不改任何东西。',
          '',
          '**什么时候调**：准备 `filmflow_propose {struct:{op:"add",…}}` 新建节点之前 —— 先看有没有现成的，别重复造。',
          '也可以不传参数；传 `category` 只看一类（如「人物」「视觉」「流程」）。',
          '',
          '**返回**每行：`id | 标题 | 形态 | 组 | feed | 角色 | 说明`。',
          '新建时把 `template` 设成这个 id；确实没有合适的，再给 title/shape/doctrine 自建。',
          '**父子组合有硬约束**：生成节点只能挂同类型提示词（或顶层且依赖它）；模型节点只能挂同类型提示词/分镜/顶层；',
          '模型与生成节点是叶子。非法组合会在提案时被拒，报错里会写"只能放在…"。',
        ].join('\n'),
        parameters: params({
          category: pStr('可选：只看某一类（流程/人物/世界/视觉/类型/剧集/广告/纪录片/MV/企业/风格/模型/媒体）'),
        }),
        output: { schema: OUT_SCHEMA, render: OUT_RENDER },
        async execute(args) {
          const cat = String((args && args.category) || '').trim();
          const tpls = readTemplates();
          const shapeOf = (t) => {
            const s = t && t.shape;
            if (!s) return (t && t.files) ? 'files' : 'text';
            return String(s.kind || 'text');
          };
          const tag = (t) => {
            if (t.kind === 'media') return '媒体';
            if (/-model$/.test(String(t.id || ''))) return '模型';
            const id = String(t.id || '');
            if (['facts', 'script', 'script-series', 'storyboard', 'audio-prompt', 'video-prompt', 'video-gen', 'blank'].includes(id)) return '流程';
            if (/^(character|identity|personality|appearance|costume)/.test(id)) return '人物';
            if (/^(worldview|cognition|timeline|scene|props|emotion-curve)$/.test(id)) return '世界';
            if (/^(visual|art-style|color|lighting|camera|aspect)$/.test(id)) return '视觉';
            if (/^(scifi-setting|theme-image|factions|power-system|comedy-beat)$/.test(id)) return '类型';
            if (/^(project-brief|drama-outline|episode-outline|foreshadow|arc)$/.test(id)) return '剧集';
            if (/^(brand-brief|selling-points|creative-concept|version-matrix)$/.test(id)) return '广告';
            if (/^(topic-thesis|interviewees|interview-outline|footage|narration)$/.test(id)) return '纪录片';
            if (/^(song-structure|beat-map|visual-motif)$/.test(id)) return 'MV';
            if (/^(company-facts|audience|structure-script)$/.test(id)) return '企业';
            if (/^(style|model|audio-style|animation-style)$/.test(id)) return '风格';
            return '其它';
          };
          const list = tpls.filter((t) => !cat || tag(t) === cat || String(t.title || '').includes(cat));
          const L = [];
          L.push('模板库：共 ' + tpls.length + ' 个节点模板、' + readPacks().length + ' 套项目预设。');
          L.push('');
          let last = '';
          for (const t of list) {
            const g = tag(t);
            if (g !== last) { L.push('【' + g + '】'); last = g; }
            L.push('  ' + String(t.id) + ' | ' + String(t.title || '') + ' | ' + shapeOf(t)
              + ' | ' + String(t.group || '') + ' | ' + String(t.feed || 'up')
              + ' | ' + roleLabel(roleOfTemplate(t))
              + ' | ' + String(t.note || '').slice(0, 40));
          }
          if (!cat) {
            L.push('');
            L.push('【项目预设】（新建片子时用，不是节点）');
            for (const p of readPacks()) {
              L.push('  ' + String(p.id) + ' | ' + String(p.title || '') + ' | ' + String(p.note || '').slice(0, 60));
            }
          }
          L.push('');
          L.push('新建节点前先在这里找：能复用就填 template；确实要自建，再给 title/shape/doctrine。');
          return { report: L.join('\n') };
        },
      });

      /*
       * ══ 2026-10-28：文件读写 + 上网，做成片场自己的三把工具 ══
       *
       * 为什么不用官方 read/write/glob/web_*：实测两轮 ——
       *   · 挂 profile 级：agent 的可见工具表里不出现（restrict 报 unknown）
       *   · 挂 preset 子插件：setup 之后才到，且请求头里仍然只有 8 把
       *   ⇒ 与其继续猜 DSH 的装配顺序，不如把这三种能力做成**自己的工具**：
       *     一定可见（和 board/propose 同一套注册）、路径由宿主校验、语义可控。
       *   · 写之前自动备份；`.film/` 一律不许碰；只在本片目录内
       *   · 节点正文仍然必须走 filmflow_propose（这里不提供"直接改节点"的捷径）
       */
      /*
       * ★ 文件工具**必须带 project**（scoped 副本会注入）。
       *   不许走 pickProjects 的 CURRENT 兜底 —— 2026-10-28 实测踩到：
       *   用户在 UI 切到另一部片后，全局副本用了 CURRENT，
       *   结果「写 资料/写入测试.md」写进了别的片。
       */
      const boundProject = (args) => {
        const want = String((args && args.project) || '').trim();
        if (!want) {
          throw new Error('这个工具必须绑在某部片上（project 参数缺失）——'
            + '请从画布进入这部片后再让我做，别直接调用。');
        }
        const ps = pickProjects(want);
        if (ps.length !== 1) throw new Error('项目不唯一：' + want);
        return ps[0];
      };

      /*
       * ══ 2026-10-30（R58）：用户自建节点 —— 写进模板库 ══
       *
       * 用户定的流程（原话）：「节点加号里都有一个"自定义节点"，点击那个节点后
       * 侧边栏 agent 就会主动发一句"想建什么节点？"，然后用户自然语言描述，
       * agent 判断合理性（可以给任何建议），然后由 agent 来编写节点，
       * 然后自动存入节点模板库。」
       *
       * 为什么"存模板"和"挂实例"合成一把工具：用户点的是某个节点的 ＋，
       * 他要的是"这一步多一个节点"；模板只是让它以后还能复用。传了 at 就一起做。
       */
      reg({
        name: 'filmflow_template_save',
        description: [
          '把**一个新节点**存进片厂模板库（用户以后能在 ＋ 菜单里反复用）。用户点了「自定义节点」之后用它。',
          '',
          '**先问清楚再存**：用户描述完，先判断"现有节点能不能干这个活"；能就别新建，直接建议。',
          '真要新建，按下面五项填全（缺一项会被拒）：',
          '1. `title`：节点名（≤24 字，画布上显示的就是它）。',
          '2. `note`：一句话用途（节点库卡片和搜索都用它）。',
          '3. `doctrine`：五段不能少 —— 【任务】【读】【写】【格式】【规矩】，最后补完成判据。',
          '4. `shape`：正文形态。{kind:"text"} / {kind:"list",fields:[…]} / {kind:"table",columns:[…]} /',
          '   {kind:"matrix",fields:[…]} / {kind:"select",options:[…]}。字段名写中文、短。',
          '5. `at`：挂在哪个父节点下（父节点 key）。不传就只存模板、不建实例。',
          '',
          '可选：`role` 默认 content（内容节点）；`usableUnder` 它以后能出现在哪些父节点下',
          '（父模板 id 数组；不传就自动 = 当前这个父；顶层写 "root"）；`children` 它下面能建什么（默认叶子）。',
          '',
          '**存完必须回报**：模板名、它现在能在哪些节点的 ＋ 里出现、挂在哪个位置。',
          '**不许**自己给 id（自动生成 u-xxx）；**不许**建模型/生成节点（会花钱，走内置模板）。',
        ].join('\n'),
        parameters: params({
          title: pStr('必填：节点名（画布上显示的名字，≤24 字）'),
          note: pStr('必填：一句话用途（节点库卡片用）'),
          doctrine: pStr('必填：五段【任务】【读】【写】【格式】【规矩】，末尾补完成判据'),
          shape: pObj('必填：正文形态，见工具说明（text/list/table/matrix/select）'),
          at: pStr('可选：挂到哪个父节点下（父节点 key）；不填只存模板'),
          role: pStr('可选：content（默认）/ style / prompt-video / prompt-audio / other'),
          usableUnder: {
            type: 'array',
            items: { type: 'string' },
            description: '可选：以后能出现在哪些父模板下（父模板 id 数组，或 "root"）；不填=当前父',
          },
          children: {
            type: 'array',
            items: { type: 'string' },
            description: '可选：它下面能建哪些模板 id（默认空=叶子）',
          },
        }, ['title', 'note', 'doctrine', 'shape']),
        output: { schema: OUT_SCHEMA, render: OUT_RENDER },
        async execute(args) {
          const project = boundProject(args);
          const tpls = readTemplates();
          const at = String((args && args.at) || '').trim();
          let usableUnder = Array.isArray(args && args.usableUnder) ? args.usableUnder : [];
          if (!usableUnder.length) {
            if (at) {
              let parentTpl = '';
              try {
                const decl = JSON.parse(readFileSync(join(project.root, DECL), 'utf8'));
                const loc = locateNode(decl.stages, at);
                parentTpl = loc ? (templateIdOf(loc.node, tpls) || '') : '';
              } catch { /* 交给后面 structureOp 报 */ }
              usableUnder = [parentTpl || 'root'];
            } else {
              usableUnder = ['root'];
            }
          }
          const saved = saveUserTemplate({ ...(args || {}), usableUnder }, tpls);
          const L = [];
          L.push('已存进模板库：' + saved.id + '（' + saved.title + '）');
          L.push('  形态：' + String((saved.shape && saved.shape.kind) || 'text')
            + '　角色：' + roleLabel(saved.role)
            + '　可用位置：' + saved.usableUnder.join(' / '));
          if (at) {
            try {
              const r = structureOp(project.root, { type: 'add', at, template: saved.id });
              L.push('  已挂在这一步下面：' + (r.no ? r.no + ' ' : '') + r.title + '（key=' + r.key + '）');
            } catch (e) {
              L.push('  ⚠ 模板已存，但挂到这一步失败：' + String((e && e.message) || e));
              L.push('  可以换个父节点再试；模板已经能用。');
            }
          } else {
            L.push('  （没有建实例；用户要的是模板）');
          }
          L.push('下一步：告诉用户"这个节点以后会出现在哪些 ＋ 里、怎么用"。');
          return { report: L.join('\n') };
        },
      });

      const fsWithin = (root, rel) => {
        let s = String(rel == null ? '' : rel).trim().replace(/\\/g, '/');
        if (!s) throw new Error('要给我文件路径（相对片目录，例如 资料/参考.md）');
        const lowRoot = String(root).replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
        const absLike = /^[a-zA-Z]:\//.test(s) || s.startsWith('/');
        const segs = absLike ? [] : s.split('/').filter(Boolean);
        if (segs.some((x) => x === '..')) throw new Error('路径里不许有 ..（只能在本片目录里）');
        if (segs.some((x) => x.toLowerCase() === '.film')) throw new Error('.film/ 是宿主的账本，不许读写');
        const abs = absLike ? s : join(root, ...segs);
        const low = abs.replace(/\\/g, '/').toLowerCase();
        if (!(low === lowRoot || low.startsWith(lowRoot + '/'))) {
          throw new Error('只能在本片目录（' + root + '）里读写');
        }
        if (/\/\.film(\/|$)/.test(low)) throw new Error('.film/ 是宿主的账本，不许读写');
        return abs;
      };

      /*
       * 这个文件是不是某个节点的产物（project.json 里声明的 md）。
       * 是的话，`filmflow_write` 拒绝 —— 节点正文必须走 propose（用户点确认才落盘），
       * 文件工具只写「资料/」这类非节点文件。这样提案闸门在物理上也关得住。
       */
      const isNodeArtifact = (root, abs) => {
        let decl;
        try { decl = readDecl(join(root, DECL)).decl; } catch { return false; }
        if (!decl || !Array.isArray(decl.stages)) return false;
        const low = abs.replace(/\\/g, '/').toLowerCase();
        const walk = (n) => {
          for (const m of [].concat((n && n.md) || []).map(String)) {
            const a = join(root, ...m.split('/')).replace(/\\/g, '/').toLowerCase();
            if (a === low) return true;
          }
          for (const c of (n && n.children) || []) {
            if (walk(c)) return true;
          }
          return false;
        };
        return decl.stages.some(walk);
      };

      const webSvc = (() => {
        try { if (ctx.web) return ctx.web; } catch { /* 忽略 */ }
        try { return (typeof ctx.get === 'function' ? ctx.get('web') : null) || null; } catch { return null; }
      })();

      reg({
        name: 'filmflow_read',
        description: [
          '读这部片目录里的一个文本文件（相对路径，如 资料/参考.md、剧本/第1集.md）。',
          '',
          '**什么时候用**：要看素材、笔记、别的节点写下的文件原文；`filmflow_node` 已经给了节点正文，',
          '读节点正文优先用 `filmflow_node`（它带那一步的指令和格式）。',
          '',
          '**返回**带行号的内容；文件不存在会明确说。大文件从 `from` 行开始读，`lines` 控制行数（默认 400）。',
        ].join('\n'),
        parameters: params({
          project: pStr('已绑死到当前项目，传了也会被忽略'),
          path: pStr('相对片目录的路径，例如 "资料/参考.md"'),
          from: pStr('可选：从第几行开始（1 起）'),
          lines: pStr('可选：最多读多少行（默认 400）'),
        }),
        output: { schema: OUT_SCHEMA, render: OUT_RENDER },
        async execute(args) {
          const root = boundProject(args).root;
          const abs = fsWithin(root, args && args.path);
          if (!existsSync(abs)) throw new Error('文件不存在：' + String(args && args.path));
          const st = statSync(abs);
          if (!st.isFile()) throw new Error('不是文件：' + String(args && args.path));
          const raw = readFileSync(abs, 'utf8');
          const all = raw.split(/\r?\n/);
          const from = Math.max(1, Number(args && args.from) || 1);
          const take = Math.max(1, Math.min(2000, Number(args && args.lines) || 400));
          const slice = all.slice(from - 1, from - 1 + take);
          const body = slice.map((ln, i) => String(from + i).padStart(5) + '  ' + ln).join('\n');
          return {
            report:
              '文件：' + String(args && args.path) + '（' + all.length + ' 行，' + raw.length + ' 字符）\n'
              + '----\n' + body
              + (from - 1 + take < all.length ? '\n…（后面还有，用 from=' + (from + take) + ' 继续）' : ''),
          };
        },
      });

      reg({
        name: 'filmflow_write',
        description: [
          '在本片目录里新建或覆盖一个文本文件（相对路径）。**自动备份旧文件**。',
          '',
          '**什么时候用**：把学到/查到的东西落成文件（例如 `资料/行业考据.md`，带来源 URL），',
          '或者写图片说明、素材清单。',
          '',
          '**什么时候不要用**：不要用它改节点正文 —— 节点正文走 `filmflow_propose`；',
          '更不要碰 `.film/`（project.json / 提案 / 备份，那是宿主的账本）。',
          '',
          '`append: true` 表示追加到文件末尾（不存在就新建）。',
        ].join('\n'),
        parameters: params(
          {
            project: pStr('已绑死到当前项目，传了也会被忽略'),
            path: pStr('相对片目录的路径，例如 "资料/参考.md"'),
            text: pStr('要写入的完整文本（append 时这段会追加到末尾）'),
            append: pStr('可选：true = 追加；省略或 false = 覆盖'),
            why: pStr('可选：一句话说明为什么写这个文件（会进变更留痕）'),
          },
          ['path', 'text'],
        ),
        output: { schema: OUT_SCHEMA, render: OUT_RENDER },
        async execute(args) {
          const root = boundProject(args).root;
          const abs = fsWithin(root, args && args.path);
          if (isNodeArtifact(root, abs)) {
            throw new Error('「' + String(args && args.path) + '」是节点产物文件 —— '
              + '改节点正文请用 filmflow_propose（用户点确认后由宿主落盘）；'
              + '文件工具只写 资料/ 笔记这类非节点文件。');
          }
          const text = String(args && args.text != null ? args.text : '');
          const append = String((args && args.append) || '') === 'true' || (args && args.append) === true;
          mkdirSync(dirname(abs), { recursive: true });
          let bak = '';
          if (existsSync(abs)) {
            try {
              bak = backup(root, abs);
            } catch { /* 备份失败不拦 */ }
          }
          if (append) writeFileSync(abs, (existsSync(abs) ? readFileSync(abs, 'utf8') : '') + text, 'utf8');
          else writeFileSync(abs, text, 'utf8');
          trace('[文件写] ' + String(args && args.path) + ' ' + text.length + ' 字'
            + (append ? '（追加）' : '') + (bak ? ' 备份 ' + bak : ''));
          return {
            report:
              '已写入：' + String(args && args.path) + '（' + text.length + ' 字符'
              + (append ? '，追加' : '，覆盖') + '）'
              + (bak ? '\n备份：' + bak : '')
              + '\n\n==== 下一步 ====\n  在回复里告诉用户你写了哪个文件；'
              + '如果这是查资料得来的结论，记得在文件里注明来源 URL。',
          };
        },
      });

      reg({
        name: 'filmflow_web',
        description: [
          '上网：`mode:"search"` 搜索，`mode:"fetch"` 抓一个网页的正文。',
          '',
          '**什么时候用**：需要片外的真实知识（行业、道具、史实、技术、片名考据）时；',
          '先 search 看来源，再 fetch 读关键页。',
          '',
          '**规矩**：查到的东西要**落成文件**（`filmflow_write` 到 `资料/`），并在回复里给出 URL；',
          '不要把长段原文直接倒进对话。',
          '',
          '**返回**：search 给摘要 + 来源列表；fetch 给 HTTP 状态 + 正文（可能被截断）。',
        ].join('\n'),
        parameters: params(
          {
            mode: pStr('search 或 fetch'),
            query: pStr('mode=search 时的检索词（1–4 条，用 | 分隔）'),
            url: pStr('mode=fetch 时的网址'),
          },
          ['mode'],
        ),
        output: { schema: OUT_SCHEMA, render: OUT_RENDER },
        async execute(args) {
          const mode = String((args && args.mode) || '').trim();
          if (!webSvc) throw new Error('这个环境没装上网服务（ctx.web 不可用）');
          if (mode === 'search') {
            const qs = String((args && args.query) || '').split('|').map((s) => s.trim()).filter(Boolean);
            if (!qs.length) throw new Error('search 要给 query');
            const lines = [];
            for (const q of qs.slice(0, 4)) {
              const r = await webSvc.search({ query: q, maxResults: 6 });
              lines.push('## ' + q);
              if (r.content) lines.push(String(r.content).slice(0, 4000));
              for (const s of r.sources || []) {
                lines.push('- [' + String(s.title || s.url) + '](' + s.url + ')'
                  + (s.snippet ? '　' + String(s.snippet).slice(0, 200) : ''));
              }
              lines.push('');
            }
            return {
              report: lines.join('\n')
                + '\n==== 下一步 ====\n  把有用的结论写成 资料/*.md（filmflow_write），注明来源 URL，再回复用户。',
            };
          }
          if (mode === 'fetch') {
            const url = String((args && args.url) || '').trim();
            if (!url) throw new Error('fetch 要给 url');
            const r = await webSvc.fetch({ url });
            const body = r.body && typeof r.body.content === 'string' ? r.body.content : '';
            return {
              report: 'URL：' + r.url + '\nHTTP ' + r.statusCode + '（' + (r.body && r.body.kind) + '）'
                + (r.truncated ? '　已截断' : '') + '\n----\n' + body.slice(0, 60000),
            };
          }
          throw new Error('mode 只能是 search 或 fetch');
        },
      });

      /*
       * ══ 2026-10-28：把「每个模型的提示词写法」配给 agent ══
       * 用户：「上网找每个模型的提示词 Skill（有些已经给过你了）并配给片厂 agent」。
       * 现有 sd2-pe / sd25-pe 是 69KB/22KB 的完整 skill，塞进人格或工具描述都不现实；
       * 折成每人一份速查（guides/*.md，1–3KB），按模型名/ID 取。
       */
      reg({
        name: 'filmflow_model_guide',
        description: [
          '查某个生成模型的**提示词写法**（Seedance 2.5 / 2.0 系列、Seedream 5/4 系列、音频模型）。',
          '',
          '**必须什么时候调**：写或改任何视频/图片提示词**之前** —— 先确认这部片「视频模型 / 图片模型」节点选的是谁，',
          '再按那个模型的写法写。2.0 与 2.5 的规则冲突（时间戳、运镜、兜底约束），混用会出错。',
          '',
          '`model` 可以给模型 id（`doubao-seedance-2-5-260628`）或名字（`Seedance 2.5` / `Seedream 5.0` / `音频`）。',
          '返回：该模型的硬指标、结构公式、可用句式、负向控制、常见坑。',
        ].join('\n'),
        parameters: params({
          model: pStr('模型 id 或名字，例如 "Seedance 2.5"、"doubao-seedream-5-0-pro-260628"、"音频"'),
        }),
        output: { schema: OUT_SCHEMA, render: OUT_RENDER },
        async execute(args) {
          const raw = String((args && args.model) || '').trim();
          if (!raw) throw new Error('要给我模型名或 id');
          const s = raw.toLowerCase();
          let file = '';
          if (/audio|音频|seed-audio|音频生成/.test(s)) file = 'seed-audio-1.md';
          else if (/seedance|视频|视频生成/.test(s)) {
            file = /2[.\-]?5/.test(s) ? 'seedance-2.5.md' : 'seedance-2.0.md';
          } else if (/seedream|图片|图片生成/.test(s)) {
            file = /4[.\-]?[05]/.test(s) ? 'seedream-4.md' : 'seedream-5.md';
          } else {
            file = '';
          }
          if (!file) {
            throw new Error('不认识这个模型：' + raw
              + '\n可用：Seedance 2.5 / Seedance 2.0（含 fast、mini）/ Seedream 5.0 系列 / Seedream 4.5、4.0 / 音频（Seed-Audio 1.0）');
          }
          const GDIR = join(dirname(fileURLToPath(import.meta.url)), 'guides');
          let text = '';
          try {
            text = readFileSync(join(GDIR, file), 'utf8');
          } catch (e) {
            throw new Error('指南文件读不到（' + file + '）：' + String((e && e.message) || e));
          }
          return {
            report: '【' + raw + '】提示词写法速查（来自片厂 guides/' + file + '）\n\n'
              + text.slice(0, 12000)
              + '\n\n==== 下一步 ====\n  按这份写法改提示词；画幅/时长/分辨率/声音开关写进节点参数，不要写进正文。',
          };
        },
      });

      trace('[工具] 已注册 ' + AGENT_TOOLS.length + ' 把：'
        + AGENT_TOOLS.map((d) => String(d && d.name).replace(/^filmflow_/, '')).join(' / '));

      // 还回去：插件卸载时把这四个工具注销掉
      return () => {
        for (const d of toolDisposers) {
          try {
            if (typeof d === 'function') d();
          } catch (e) {
            trace('[工具] 注销抛了: ' + String((e && e.message) || e));
          }
        }
      };
    }
  } catch (e) {
    trace('注册工具抛出: ' + String((e && e.stack) || e));
  }
}
/* ------------------------------------------------------------------ *
 * ★ 独立版复用出口（2026-10-20）
 *
 * 用户决定：片场要能装在没有 DSH 的机器上。
 * ⇒ 用一个独立进程当"画布 + 数据层"，Agent 用 `dsh --profile headless`（已实测跑通）。
 *
 * 这个独立进程**不重写**任何数据逻辑 —— 它 import 的就是这里的函数。
 * （用户原话：「能从dsh上拿/改的东西就不要自己重头写」。）
 *
 * 注意：本文件被 import 时**没有任何副作用** —— `apply()` 只由 DSH 调用。
 * ------------------------------------------------------------------ */
export {
  discoverProjects,
  buildProject,
  applyEdit,
  projectPageHtml,
  appPageHtml,
  readProposals,
  writeProposals,
  syncNodes,
  readDecl,
  isWritable,
  requireToken,
  sendJson,
  readBody,
};
/** 独立版启动时设置写令牌（等价于 apply() 里那次生成）。 */
export function setWriteToken(t) {
  WRITE_TOKEN = String(t || '');
}

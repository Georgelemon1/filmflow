/**
 * 节点层级规则（R47，用户 2026-10-28）
 *
 * 用户的原话：
 *   「一个节点的下游是不是并不一定能建任何节点？比如音频模型节点就不应该建在
 *     视频提示词生成下面／视频生成节点不应该建在剧本下面，是不是？」
 *
 * 结论：**能挂什么，由"子节点的类型"和"父节点的类型"共同决定**。
 * 这份文件是唯一真源 —— 宿主校验（结构操作 / 提案）、画布菜单过滤、旧片迁移
 * 都读这里，避免三处各写一套矩阵。
 *
 * 设计取舍（用户已拍板）：
 *   · 生成节点（视频/图片/音频）允许作为**同类型提示词**的子节点，也允许在顶层；
 *     但必须依赖一个同类型的提示词/素材节点（否则它读什么？）。
 *   · 模型节点只能挂在自己那类提示词、分镜/视觉节点或顶层 ——
 *     音频模型挂在视频提示词下面 = 非法（用户的例子）。
 *   · 模型节点和生成节点是**叶子**：它们下面不能再挂任何东西。
 *   · 其余内容节点（故事/设定/分镜/提示词）互相组合基本无害，宽进。
 *
 * 注意：这里是"结构合法性"，不是"内容优先级"。宽严标准以用户的例子为锚，
 * 不为了严而严。
 */

/** 角色 → 中文名（报错、节点库、界面提示共用）。 */
export const ROLE_LABELS = {
  /*
   * 2026-10-29 用户要求撤掉 story/board 这套分组。
   * 角色矩阵里原来 story/board 的合法父子完全一样（都是内容互挂），
   * 所以合并成一个技术角色 `content`；旧数据里的 story/board 由 normalizeRole 兼容。
   */
  content: '内容节点',
  story: '内容节点',
  board: '内容节点',
  /*
   * 风格锚点（2026-10-29）：画风/色彩/光影/风格。
   * 用户：「画风/色彩/光影 这种还是相对有用的，适合挂在 prompt 节点下面；
   * 预设里默认不建，用户觉得需要自己再往上挂就是了。」
   * ⇒ 单独给一个窄角色，允许挂在提示词节点下面，不必挤进 content 的大篮子。
   */
  style: '风格设定',
  'prompt-video': '视频提示词',
  'prompt-audio': '音频提示词',
  'model-video': '视频模型',
  'model-image': '图片模型',
  'model-audio': '音频模型',
  'gen-video': '视频生成',
  'gen-image': '图片生成',
  'gen-audio': '音频生成',
  other: '通用节点',
};

/**
 * 子角色 → 允许的父角色列表（'root' 表示挂在项目顶层）。
 *
 * 只列"确实有意义"的组合；没列的 = 非法。
 */
export const ROLE_PARENTS = {
  /*
   * `other` = 空白/自建节点（模板 blank、agent 自己设计的工序）。
   *
   * 2026-10-29 修：它原来在菜单里声称"什么都能装"，但法定表里没有任何角色允许挂在
   * `other` 下 ⇒ 菜单点得出来、落盘全被拒（7 项全是越界，selftest 抓到）。
   * 这里按"它确实是个通用容器"补齐：非生成类都能放进去；**生成类不放**，
   * 因为 `other` 当不了生成节点的依赖（父必须能当依赖，见 ruleWarnings ②）。
   */
  content: ['root', 'content', 'other'],
  /* 风格锚点：能挂顶层、能挂内容节点、**关键**能挂在视频提示词下面（提示词直接读它） */
  style: ['root', 'content', 'prompt-video'],
  /*
   * 提示词节点可以套自己：文件型提示词「按文件展开」出来的子节点（v1/b1…）
   * 就是同一类的分段，不是另一类节点。没有这条，展开一次就会被迁移当成违规搬走。
   */
  'prompt-video': ['root', 'content', 'prompt-video', 'other'],
  'prompt-audio': ['root', 'content', 'prompt-audio', 'other'],
  'model-video': ['root', 'content', 'prompt-video', 'other'],
  'model-image': ['root', 'content', 'other'],
  'model-audio': ['root', 'content', 'prompt-audio', 'other'],
  'gen-video': ['root', 'prompt-video'],
  'gen-image': ['root', 'content', 'prompt-video'],
  'gen-audio': ['root', 'prompt-audio'],
  other: ['root', 'content', 'prompt-video', 'prompt-audio', 'other'],
};

/**
 * 旧角色名 → 新角色名。
 * 现有 project.json 里还是 story/board；不重写数据，读取时一律当 content。
 */
export function normalizeRole(role) {
  const r = String(role || '');
  if (r === 'story' || r === 'board') return 'content';
  return r;
}

/**
 * 画布「＋」菜单里**展示**的子角色（比宿主允许的更聚焦）。
 *
 * 为什么菜单比校验严：校验要兼容旧片和 agent 自建节点（比如历史项目里
 * 「风格 / 模型」挂在提示词下面，本身无害）；但用户点 ＋ 时不该看到
 * 三十个分镜模板，只给他这一步真正会用的那几类。
 */
export const MENU_CHILDREN = {
  root: ['content', 'style', 'prompt-video', 'prompt-audio', 'model-video', 'model-image', 'model-audio', 'gen-image', 'other'],
  content: ['content', 'style', 'prompt-video', 'prompt-audio', 'model-video', 'model-image', 'model-audio', 'gen-image', 'other'],
  /* 提示词下面能挂：同类型模型 / 同类型生成 / **风格锚点** / 空白 */
  'prompt-video': ['style', 'model-video', 'gen-video', 'other'],
  'prompt-audio': ['model-audio', 'gen-audio', 'other'],
  'model-video': [],
  'model-image': [],
  'model-audio': [],
  'gen-video': [],
  'gen-image': [],
  'gen-audio': [],
  /*
   * 空白/自建节点：它是"什么都能装"的通用容器，但**能装的不等于能当依赖**。
   * 2026-10-29 实测漂移：这里原来还列着 `gen-image`，而 `gen-image` 的法定父里没有
   * `other`（它也当不了图片生成的依赖）⇒ 菜单能点、落盘被拒。菜单求交后已不可能
   * 出现这种越界，这条也一并从表里删掉，别再靠求交兜。
   */
  other: ['content', 'prompt-video', 'prompt-audio', 'model-video', 'model-image', 'model-audio', 'other'],
};

/** 这些角色是叶子节点：下面不能再挂任何东西。 */
export const TERMINAL_ROLES = new Set([
  'model-video', 'model-image', 'model-audio',
  'gen-video', 'gen-image', 'gen-audio',
]);

/* ── 正向表（父 → 子）：校验用逆表，人看着别扭，这里翻过来 ──────────────
 *
 * 用户 2026-10-29：「添加节点一定是在某个节点之下添加，只要给所有节点都标注上
 * 它们的下游能建哪些节点（不标注的就是不能建）就行了是吗？」
 *
 * 意思对：这就是同一张矩阵，只是从父节点那一侧读。翻过来有两个用处：
 *   · 写规则时按"这个节点下面能建什么"想，比按"这个子类型能挂哪"直观；
 *   · 以后换人维护，看一张表就能回答"＋ 里为什么会/不会出现某项"。
 * 但**校验仍然以 ROLE_PARENTS 为准**（它是唯一真源，正向表由它算出来，不手写）。
 */

/** 某个父角色下**法定**能建的全部子角色（含 root=项目顶层）。 */
export function roleChildrenOf(parentRole) {
  const parent = normalizeRole(parentRole) || 'root';
  const out = [];
  for (const [child, parents] of Object.entries(ROLE_PARENTS)) {
    if (parents.includes(parent) || (parent === 'content' && parents.includes('content'))) out.push(child);
  }
  return out;
}

/** 全部父角色的法定子表（下发给画布/供人查）。 */
export function roleChildrenTable() {
  const out = {};
  for (const parent of ['root', ...Object.keys(ROLE_PARENTS)]) {
    const list = roleChildrenOf(parent);
    if (list.length) out[parent] = list;
  }
  return out;
}

/**
 * 菜单 = 「法定可挂」∩「只展示有用的」。
 *
 * 为什么要求交（2026-10-29 实测踩到的漂移）：菜单是手写的窄表、法定表是校验用的宽表，
 * 两张表各自演进就会对不上 —— `other`（空白节点）的菜单里列过「图片生成」，
 * 而 `gen-image` 的父白名单里没有 `other` ⇒ 点 ＋ 能选中、落盘被拒。
 * 求交之后菜单永远是法定的子集，写死也不可能越界。
 */
export function menuChildrenOf(parentRole) {
  const parent = normalizeRole(parentRole) || 'root';
  const listed = MENU_CHILDREN[parent];
  if (!Array.isArray(listed)) return [];
  const legal = roleChildrenOf(parent);
  return listed.filter((child) => legal.includes(normalizeRole(child)));
}

/** 全部角色的菜单（下发给画布，替掉原来直接甩 MENU_CHILDREN 的做法）。 */
export function menuTable() {
  const out = {};
  for (const role of Object.keys(MENU_CHILDREN)) out[role] = menuChildrenOf(role);
  return out;
}

/**
 * 规则表自检：返回问题清单（空数组 = 一致）。
 *
 * 两条不变量，任何一条破了都说明表写歪了：
 *   ① 菜单 ⊆ 法定：菜单里列出的子类型，必须真的允许挂在这个父下面；
 *   ② 父能当依赖：生成节点的**非顶层**父角色，必须出现在它的依赖类型里 ——
 *      否则"建在这里却读不到这里"，正是用户 2026-10-29 质疑的那种情况。
 * selftest 会调它；启动时也会打一行日志。
 */
export function ruleWarnings() {
  const out = [];
  for (const parent of Object.keys(MENU_CHILDREN)) {
    const legal = roleChildrenOf(parent);
    for (const child of MENU_CHILDREN[parent] || []) {
      if (!legal.includes(normalizeRole(child))) {
        out.push('菜单越界：' + parent + ' 的菜单列了 ' + child + '，但 ' + child + ' 不允许挂在它下面');
      }
    }
  }
  for (const [role, rule] of Object.entries(DEP_RULES)) {
    for (const parent of ROLE_PARENTS[role] || []) {
      if (parent === 'root') continue;
      if (!rule.roles.includes(normalizeRole(parent))) {
        out.push('父不能当依赖：' + role + ' 可以挂在 ' + parent + ' 下，但它的依赖类型只有 ' + rule.roles.join(' / '));
      }
    }
  }
  /*
   * ③ 主从层表自洽（R56）：主节点/子节点都得真的存在，且两边说法一致。
   *    只看单边的话，"children 写了但 masters 没写"这种半截改动会静默放行。
   */
  for (const [id, info] of Object.entries(TEMPLATE_IDENTITY)) {
    for (const m of info.masters || []) {
      if (!TEMPLATE_IDENTITY[m]) out.push('主从层表：' + id + ' 的主节点 ' + m + ' 不在表里');
      /* 主节点不一定是聚合节点：`服装` 自己是人物·单人的描述节点，同时又是上装/下装/鞋的主节点 */
      else if (Array.isArray(TEMPLATE_IDENTITY[m].children) && !TEMPLATE_IDENTITY[m].children.includes(id)) {
        out.push('主从层表：' + id + ' 说挂在 ' + m + ' 下，但 ' + m + ' 的下位里没有它');
      }
    }
    for (const c of info.children || []) {
      if (!TEMPLATE_IDENTITY[c]) {
        out.push('主从层表：' + id + ' 声明的下位 ' + c + ' 不在表里');
        continue;
      }
      const childMasters = TEMPLATE_IDENTITY[c].masters || [];
      if (!childMasters.includes(id)) {
        out.push('主从层表：' + id + ' 说能装 ' + c + '，但 ' + c + ' 的主节点是 ' + (childMasters.join(' / ') || '（无）'));
      }
    }
    // 环：顺着 masters 往上走，走回自己就是死锁
    let cur = id;
    for (let i = 0; i < 8; i++) {
      const m = (TEMPLATE_IDENTITY[cur] && TEMPLATE_IDENTITY[cur].masters) || [];
      if (!m.length) break;
      cur = m[0];
      if (cur === id) { out.push('主从层表：' + id + ' 的主从链成环'); break; }
    }
  }
  return out;
}


/**
 * 生成节点必须依赖什么。
 * `roles`：依赖节点允许的角色；`label`：报错时给人看的说法。
 */
export const DEP_RULES = {
  'gen-video': { roles: ['prompt-video'], label: '视频提示词' },
  'gen-audio': { roles: ['prompt-audio'], label: '音频提示词' },
  'gen-image': { roles: ['content', 'prompt-video'], label: '内容节点' },
};

/** 提示词模板 id → 角色。 */
const PROMPT_IDS = new Set(['video-prompt', 'audio-prompt']);
/** 风格锚点模板 id → 角色（2026-10-29 用户：画风/色彩/光影 适合挂在 prompt 节点下）。 */
const STYLE_IDS = new Set(['art-style', 'color', 'lighting', 'style']);
/** 模型模板 id → 角色。 */
const MODEL_ROLE = {
  'video-model': 'model-video',
  'image-model': 'model-image',
  'audio-model': 'model-audio',
};

/**
 * 模板 → 角色。
 *
 * 不往 templates.json 里写死 role：模板库还会被另一个会话/预设扩充，
 * 角色从 **kind / mediaType / id / group** 推出来就不会出现"新模板忘了标 role"。
 */
export function roleOfTemplate(tpl) {
  if (!tpl || typeof tpl !== 'object') return 'other';
  const id = String(tpl.id || '');
  if (tpl.role && ROLE_PARENTS[normalizeRole(tpl.role)]) return normalizeRole(tpl.role);
  if (id === 'blank') return 'other';
  if (STYLE_IDS.has(id)) return 'style';
  if (PROMPT_IDS.has(id)) return 'prompt-' + (id === 'video-prompt' ? 'video' : 'audio');
  if (MODEL_ROLE[id]) return MODEL_ROLE[id];
  if (String(tpl.kind || '') === 'media') {
    const mt = String(tpl.mediaType || 'image');
    return 'gen-' + (mt === 'video' ? 'video' : mt === 'audio' ? 'audio' : 'image');
  }
  return 'content';
}

/** 归一化标题：去掉开头的圈号 / 空白。 */
export function normNodeTitle(title) {
  return String(title || '').replace(/^[①②③④⑤⑥⑦⑧⑨⑩\s]+/, '').trim();
}

/**
 * 模板标题索引：`标题 → 角色`。
 * 旧片节点没有 nodeRole，靠标题最长匹配把历史节点认出来。
 */
export function buildRoleIndex(templates) {
  const idx = new Map();
  for (const t of Array.isArray(templates) ? templates : []) {
    const title = normNodeTitle(t && t.title);
    if (!title) continue;
    if (!idx.has(title)) idx.set(title, roleOfTemplate(t));
  }
  return idx;
}

/**
 * 推断一个已有节点的角色（旧片迁移 + 运行时兜底）。
 *
 * @param raw project.json 里的节点
 * @param opts.group 继承来的组（子节点没有自己的 group）
 * @param opts.roleIndex buildRoleIndex() 的结果
 */
export function inferRole(raw, opts = {}) {
  if (!raw || typeof raw !== 'object') return 'other';
  const explicit = normalizeRole(raw.nodeRole);
  if (ROLE_PARENTS[explicit]) return explicit;
  // 媒体节点：类型是硬事实
  const mediaType = String((raw.media && raw.media.type) || '');
  if (String(raw.kind || '') === 'media' || mediaType) {
    const mt = mediaType || 'image';
    return 'gen-' + (mt === 'video' ? 'video' : mt === 'audio' ? 'audio' : 'image');
  }
  const title = normNodeTitle(raw.title);
  const idx = opts.roleIndex instanceof Map ? opts.roleIndex : new Map();
  if (idx.has(title)) return idx.get(title);
  // 最长包含匹配："生成音频提示词" 命中的是 "音频提示词" 而不是 "提示词"
  let best = null;
  for (const [k, v] of idx) {
    if (k.length < 2) continue;
    if (!title.includes(k)) continue;
    if (!best || k.length > best[0].length) best = [k, v];
  }
  if (best) return best[1];
  return 'content';
}

/* ── 主从层（R52 / R54）：聚合节点与它的描述节点，不能倒挂 ────────────────
 *
 * 用户 2026-10-29（R52）：「把身份当父节点、人物挂它下面」这种倒挂不该允许。
 * 用户 2026-10-29（R54，第二次）：「人物名节点还是在性格/外貌的下游？这是不对的，
 *   属性/其他人物信息应该在人物名字的下游」⇒ 层级从两跳变三跳：
 *
 *   人物（名册/容器） ← 人物·单人（唐老板） ← 身份/性格/外貌/服装 ← 上装/下装/鞋
 *
 * 为什么中间要多一跳：属性天然是"某个人的"属性。两跳时身份和唐老板是兄弟
 * （都挂在人物下），画布上并排列着，看起来属性挂在名册上而不是挂在某个人身上。
 *
 * 只卡这几条窄关系，不把所有内容节点锁死：
 *   · 描述节点（身份…、上装…）**只能**挂在它的主节点下（或顶层，便于先建后挪）
 *   · 聚合节点（人物、人物·单人、服装）位置不变（顶层/content/提示词都能挂）
 *   · 两边都在场时才校验：挂在别处报错写明"只能放在…"
 *
 * `masters` 是数组：旧片（短剧1）在"两跳时代"把 身份/服装 直接挂在人物下，
 * 已落盘的结构不追溯；但**新建**时按新规则只认 人物·单人（见 R54 迁移）。
 *
 * R56（2026-10-30，用户：「一个节点下面不能随便建任意节点是吧」）补上反方向：
 * `children` 声明"这个节点下面只收谁"，父节点不能来者不拒。
 * 只有 masters 时，"先在最外层建一个身份、再把人物挂上去"能绕过倒挂检查；
 * 有了 children，`人物` 在 `身份` 下面也建不出来，`视频提示词` 也塞不进 `人物·单人`。
 */
const TEMPLATE_IDENTITY = {
  identity: { kind: 'attr', masters: ['character-one'], children: [], label: '人物·单人' },
  personality: { kind: 'attr', masters: ['character-one'], children: [], label: '人物·单人' },
  appearance: { kind: 'attr', masters: ['character-one'], children: [], label: '人物·单人' },
  costume: {
    kind: 'attr',
    masters: ['character-one'],
    children: ['costume-top', 'costume-bottom', 'costume-shoes'],
    label: '人物·单人',
  },
  'costume-top': { kind: 'attr', masters: ['costume'], children: [], label: '服装' },
  'costume-bottom': { kind: 'attr', masters: ['costume'], children: [], label: '服装' },
  'costume-shoes': { kind: 'attr', masters: ['costume'], children: [], label: '服装' },

  character: { kind: 'aggregate', children: ['character-one'] },
  'character-one': {
    kind: 'aggregate',
    masters: ['character'],
    children: ['identity', 'personality', 'appearance', 'costume'],
    label: '人物',
  },
};

/** 主从层表（下发给画布，让「＋」菜单和宿主校验读同一份）。 */
export function identityTable() {
  const out = {};
  for (const [id, v] of Object.entries(TEMPLATE_IDENTITY)) out[id] = { id, ...v };
  return out;
}

/** 模板 id → 身份（聚合 / 描述 + 主节点）。未知模板返回 null。 */
export function identityOfTemplate(tpl) {
  const id = String((tpl && tpl.id) || '');
  return TEMPLATE_IDENTITY[id] ? { id, ...TEMPLATE_IDENTITY[id] } : null;
}

/** 从标题兜底认身份（旧节点没有 template 字段时用）。 */
const IDENTITY_BY_TITLE = {
  身份: 'identity', 性格: 'personality', 外貌: 'appearance', 服装: 'costume',
  上装: 'costume-top', 下装: 'costume-bottom', 鞋: 'costume-shoes',
  人物: 'character', '人物·单人': 'character-one',
};

/** 节点标题 → 身份；认不出返回 null。 */
export function identityOfTitle(title) {
  const t = normNodeTitle(title);
  if (!t) return null;
  for (const [name, id] of Object.entries(IDENTITY_BY_TITLE)) {
    if (t === name || t.endsWith(name)) return { id, ...TEMPLATE_IDENTITY[id] };
  }
  return null;
}

/** 身份 id → 人看得懂的名字（报错文案用）。 */
function identityName(id) {
  const hit = Object.keys(IDENTITY_BY_TITLE).find((k) => IDENTITY_BY_TITLE[k] === id);
  return hit || String(id || '');
}

/**
 * 主从层校验：这个身份能不能挂在那（父身份）下面。
 *
 * 两个方向都要卡（缺一个就能倒挂）：
 *   ① 描述节点只能挂主节点 —— `身份` 挂 `剧本` 下 → 拒；
 *   ② 主节点只收它声明的下位 —— `人物` 挂 `身份` 下、`视频提示词` 挂 `人物·单人` 下 → 拒。
 * 只有 ① 时，先在最外层建一个 `身份`，再把 `人物` 挂上去就能绕过（R56 补的就是这个洞）。
 *
 * @param self identityOfTemplate/identityOfTitle 的结果（认不出传 null）
 * @param parent 父节点的身份（顶层传 null）
 * @param hasParent 是不是真的挂在一个父节点下（顶层=false）
 * @returns {ok, error?, hint?, mustBeUnder?}
 */
export function checkIdentityPlacement(self, parent, hasParent = false, parentTitle = '') {
  if (!hasParent) return { ok: true };        // 真的挂在项目顶层：允许先建后挪
  const selfId = self ? String(self.id || '') : '';
  const parentId = parent ? String(parent.id || '') : '';
  const pInfo = parentId ? TEMPLATE_IDENTITY[parentId] : null;
  const masters = self && Array.isArray(self.masters)
    ? self.masters
    : (self && self.masters ? [self.masters] : []);

  /* ① 描述节点（身份/上装…）只能挂在它的主节点下 */
  if (masters.length) {
    if (parentId && masters.includes(parentId)) return { ok: true };
    const masterName = self.label || masters.map(identityName).join(' / ');
    /* 父节点不是身份节点时，报**它自己的标题**（"这个节点"读起来像 bug） */
    const parentName = parentId ? identityName(parentId) : (parentTitle || '这个节点');
    return {
      ok: false,
      error: '「' + identityName(selfId) + '」是「' + masterName
        + '」下面的描述节点，不能挂在「' + parentName + '」下面（这是倒挂）',
      hint: '换到「' + masterName + '」下面，或者放到项目顶层',
      mustBeUnder: masterName,
    };
  }

  /* ② 主节点只接收它自己声明的下位；认不出的类型也不许塞进来 */
  if (pInfo && Array.isArray(pInfo.children)) {
    if (selfId && pInfo.children.includes(selfId)) return { ok: true };
    const parentName = identityName(parentId);
    const kids = pInfo.children.map(identityName);
    return {
      ok: false,
      error: kids.length
        ? '「' + parentName + '」下面只能建 ' + kids.join(' / ')
          + '，不能建「' + (selfId ? identityName(selfId) : '这个节点') + '」'
        : '「' + parentName + '」下面不能再建子节点（它是描述节点），不能建「'
          + (selfId ? identityName(selfId) : '这个节点') + '」',
      hint: kids.length
        ? '改挂到「' + parentName + '」下面，或者放到项目顶层'
        : '「' + parentName + '」是描述节点，内容写在它自己的正文里',
    };
  }
  return { ok: true };
}

/* ── 下位白名单（R57，2026-10-30）：每个模板下面只能建什么 ────────────────
 *
 * 用户 2026-10-30：「一个节点下面不能随便建任意节点是吧」→ R56 收紧了身份节点，
 * 随后又指出「现在只有部分节点的加号里有筛选过节点」。
 *
 * 为什么身份层不够：菜单原来只按**角色**过滤，而 content 角色是个大篮子 ——
 * 剧本 / 分镜脚本 / 场景 / 道具 / 项目总纲 全是 content，于是「剧本」的 ＋ 里
 * 能点到三四十项，跟"这一步该建什么"没关系。
 *
 * 这一张表只声明**容器**；没声明的模板一律**叶子**（＋ 不出现）。
 * `blank`（空白工序）是唯一宽口：它是显式的"这一格我自己定义"。
 *
 * 不在表里的未知模板（旧节点认不出 id、agent 自建）留给角色菜单兜底 —— 不追溯。
 */
export const TEMPLATE_CHILDREN = {
  /*
   * 事实层 = "客观世界"的容器：名册、世界规则、认知层，以及各类型的**设定件**。
   * 科幻/战争/奇幻/喜剧四个包都把设定件放在事实层下（审计抓到过），
   * 场景/道具是旧模板，同样属于"世界的客观信息"，允许挂进来。
   */
  facts: [
    'character', 'worldview', 'cognition',
    'scifi-setting', 'factions', 'power-system', 'comedy-beat',
    'scene', 'props', 'blank',
  ],
  character: ['character-one'],
  'character-one': ['identity', 'personality', 'appearance', 'costume'],
  costume: ['costume-top', 'costume-bottom', 'costume-shoes'],
  worldview: ['blank'],
  script: ['script-series', 'blank'],
  storyboard: ['media-image', 'blank'],
  'video-prompt': ['video-model', 'video-gen', 'art-style', 'color', 'lighting', 'style', 'blank'],
  'audio-prompt': ['audio-model', 'media-audio', 'blank'],
  /* 宽口：按角色菜单放行（就是 R47 那份），它是"自己定义一格"的逃逸口。 */
  blank: '*',
};

/**
 * 某个模板的下位。
 *
 * @param tplId 模板 id（可以是空）
 * @param knownIds 模板库里的 id 集合（Set）；不传就当"已知"处理
 * @returns 数组 = 只有这些；'*' = 按角色菜单宽口；null = 未知模板（角色兜底）
 */
export function childrenOfTemplate(tplId, knownIds) {
  const id = String(tplId || '');
  if (!id) return null;
  if (Object.prototype.hasOwnProperty.call(TEMPLATE_CHILDREN, id)) return TEMPLATE_CHILDREN[id];
  /* 身份表里的描述/聚合节点：children 已经在 TEMPLATE_IDENTITY 里声明过（R54/R56）。 */
  if (TEMPLATE_IDENTITY[id]) {
    return Array.isArray(TEMPLATE_IDENTITY[id].children) ? TEMPLATE_IDENTITY[id].children : [];
  }
  if (knownIds instanceof Set && !knownIds.has(id)) return null;
  return [];
}

/** 模板标题索引（长标题优先；`生成视频提示词` 要命中 `视频提示词` 而不是 `视频`）。 */
const TPL_TITLE_INDEX = new WeakMap();

export function buildTemplateIndex(templates) {
  const list = Array.isArray(templates) ? templates : [];
  const cached = TPL_TITLE_INDEX.get(list);
  if (cached) return cached;
  const idx = new Map();
  for (const t of list) {
    const title = normNodeTitle(t && t.title);
    const id = String((t && t.id) || '');
    if (!title || !id) continue;
    if (!idx.has(title)) idx.set(title, id);
  }
  TPL_TITLE_INDEX.set(list, idx);
  return idx;
}

/**
 * 一个节点是哪个模板：先认落盘的 `template`，再按标题最长包含匹配。
 * 旧片没有 template 字段，全靠这一层；认不出返回 null（走角色兜底）。
 */
export function templateIdOf(raw, templates) {
  const list = Array.isArray(templates) ? templates : [];
  const ids = new Set(list.map((t) => String(t && t.id)));
  const explicit = String((raw && raw.template) || '');
  if (explicit && ids.has(explicit)) return explicit;
  const idx = buildTemplateIndex(list);
  const title = normNodeTitle(raw && raw.title);
  if (!title) return null;
  if (idx.has(title)) return idx.get(title);
  let best = null;
  for (const [name, id] of idx) {
    if (name.length < 2) continue;
    if (!title.includes(name)) continue;
    if (!best || name.length > best[0].length) best = [name, id];
  }
  return best ? best[1] : null;
}

/**
 * 这个父节点下面能建哪些模板（画布菜单 = 落盘校验 = 审计，同一份结果）。
 *
 * @param parentRaw project.json 里的父节点（顶层传 `{nodeRole:'root'}`）
 * @param templates 模板库
 * @param opts.roleIndex 复用的角色索引（省得每个节点重建）
 * @returns 模板 id 数组（已按角色/身份过滤；空数组 = 叶子）
 */
export function canAddUnder(parentRaw, templates, opts = {}) {
  const list = Array.isArray(templates) ? templates : [];
  const byId = new Map(list.map((t) => [String(t && t.id), t]));
  const known = new Set(byId.keys());
  const roleIndex = opts.roleIndex instanceof Map ? opts.roleIndex : buildRoleIndex(list);
  const explicitRole = String((parentRaw && parentRaw.nodeRole) || '');
  const isRoot = explicitRole === 'root';
  const role = isRoot ? 'root' : inferRole(parentRaw, { group: opts.group, roleIndex });
  const tplId = isRoot ? null : templateIdOf(parentRaw, list);
  const identity = (tplId ? identityOfTemplate({ id: tplId }) : null)
    || identityOfTitle(parentRaw && parentRaw.title);
  const declared = childrenOfTemplate(tplId, known);

  let ids;
  if (declared === '*') {
    ids = [...known];
  } else if (Array.isArray(declared)) {
    ids = declared.slice();
  } else {
    /* 未知模板（旧节点/自建）：按角色菜单兜底，保持旧行为 */
    const roles = menuChildrenOf(role);
    ids = list
      .filter((t) => roles.includes(normalizeRole(roleOfTemplate(t))))
      .map((t) => String(t.id));
  }
  /*
   * 用户自建节点（R58）：模板自己声明「能被谁用」（usableUnder），
   * 父节点不用改代码。挂在某个父模板下就写那个父的 id；顶层写 'root'。
   */
  const parentKey = isRoot ? 'root' : tplId;
  if (parentKey) {
    for (const t of list) {
      const uu = Array.isArray(t && t.usableUnder) ? t.usableUnder : [];
      if (uu.includes(parentKey)) ids.push(String(t.id));
    }
  }
  ids = [...new Set(ids)];

  const parentRole = normalizeRole(role) || 'root';
  return ids.filter((id) => {
    const tpl = byId.get(id);
    if (!tpl) return false;                                   // 表里写了但模板库没有 → 静默丢掉
    if (!checkPlacement(roleOfTemplate(tpl), parentRole).ok) return false;
    /*
     * 身份检查**不管父有没有身份都要跑**：描述节点（身份/上装…）挂在"不是它主节点"的
     * 地方（包括空白工序这种没有身份的父）同样必须被拦住，否则菜单会列出来、落盘被拒。
     */
    const selfId = identityOfTemplate({ id }) || identityOfTitle(tpl.title);
    if (!checkIdentityPlacement(selfId || null, identity || null, true).ok) return false;
    return true;
  });
}

/**
 * 下位表自检：返回问题清单（空 = 一致）。
 *
 * 查三件事：① 白名单里写的 id 模板库都有；② 每对父子的角色合法；
 * ③ 身份类父子与 TEMPLATE_IDENTITY 对得上（R56 的双向判据不能和菜单打架）。
 */
export function childrenWarnings(templates) {
  const list = Array.isArray(templates) ? templates : [];
  const byId = new Map(list.map((t) => [String(t && t.id), t]));
  const out = [];
  for (const [parentId, kids] of Object.entries(TEMPLATE_CHILDREN)) {
    const parent = byId.get(parentId);
    if (!parent) { out.push('下位表：' + parentId + ' 不在模板库里'); continue; }
    if (kids === '*') continue;
    if (!Array.isArray(kids)) { out.push('下位表：' + parentId + ' 的值既不是数组也不是 *'); continue; }
    const parentRole = roleOfTemplate(parent);
    const parentIdentity = identityOfTemplate({ id: parentId }) || identityOfTitle(parent.title);
    for (const kid of kids) {
      const child = byId.get(kid);
      if (!child) { out.push('下位表：' + parentId + ' 声明的 ' + kid + ' 不在模板库里'); continue; }
      if (!checkPlacement(roleOfTemplate(child), parentRole).ok) {
        out.push('下位表：' + parentId + '（' + parentRole + '）列了 ' + kid + '（' + roleOfTemplate(child) + '），角色上不合法');
      }
      if (parentIdentity) {
        const selfId = identityOfTemplate({ id: kid }) || identityOfTitle(child.title);
        if (!checkIdentityPlacement(selfId, parentIdentity, true).ok) {
          out.push('下位表：' + parentId + ' 列了 ' + kid + '，身份上不合法');
        }
      }
    }
  }
  /* 反向：身份表里有 children 的节点，必须真的出现在下位表里（或本来就是空叶子） */
  for (const [id, info] of Object.entries(TEMPLATE_IDENTITY)) {
    const kids = Array.isArray(info.children) ? info.children : [];
    if (!kids.length) continue;
    const declared = TEMPLATE_CHILDREN[id];
    if (!Array.isArray(declared)) { out.push('下位表：' + id + ' 在身份表里声明了 children，但下位表没同步'); continue; }
    for (const kid of kids) {
      if (!declared.includes(kid)) out.push('下位表：' + id + ' 的身份 children 里有 ' + kid + '，下位表里没有');
    }
  }
  return out;
}

/** 这个角色能不能挂在那个父角色下面。 */
export function checkPlacement(role, parentRole) {
  const r = normalizeRole(role);
  const allowed = ROLE_PARENTS[r] || [];
  const parent = normalizeRole(parentRole) || 'root';
  if (allowed.includes(parent) || (parent === 'content' && allowed.includes('content'))) return { ok: true };
  return {
    ok: false,
    error: roleLabel(r) + '不能挂在' + (parent === 'root' ? '项目顶层' : '「' + roleLabel(parent) + '」') + '下面',
    allowed,
  };
}

/** 这个角色能不能有子节点（菜单/界面用；比校验严格）。 */
export function canHaveChildren(role) {
  const kids = MENU_CHILDREN[normalizeRole(role)];
  return Array.isArray(kids) && kids.length > 0;
}

/** 角色中文名。 */
export function roleLabel(role) {
  const r = String(role || '');
  if (r === 'root') return '项目顶层';
  return ROLE_LABELS[normalizeRole(r)] || String(r || '节点');
}

/**
 * 生成节点的依赖是否合规。
 * @param role 生成节点角色
 * @param depRoles 它 dependsOn 的节点的角色数组
 */
export function checkDeps(role, depRoles) {
  const rule = DEP_RULES[String(role)];
  if (!rule) return { ok: true };
  const hit = (Array.isArray(depRoles) ? depRoles : []).some((r) => {
    const x = normalizeRole(r);
    return rule.roles.includes(x) || (x === 'content' && rule.roles.includes('content'));
  });
  if (hit) return { ok: true };
  return {
    ok: false,
    error: roleLabel(role) + '必须依赖至少一个' + rule.label + '节点（现在没有）',
    label: rule.label,
    roles: rule.roles,
  };
}

/**
 * 给生成节点挑一个可自动接上的依赖（挂顶层时用）。
 *
 * @param role 生成节点角色
 * @param entries [{ node, role, key, title }]
 * @param opts.preferredKey 优先选的 key（一般是它合法父节点的 key）
 */
export function depCandidates(role, entries, opts = {}) {
  const rule = DEP_RULES[String(role)];
  if (!rule) return [];
  const preferred = String(opts.preferredKey || '');
  const list = (Array.isArray(entries) ? entries : [])
    .filter((e) => e && rule.roles.includes(normalizeRole(e.role)));
  const score = (e) => {
    let s = 0;
    if (preferred && String(e.key) === preferred) s += 100;
    if (String(role) === 'gen-image') {
      if (normalizeRole(e.role) === 'content') s += 2;
      if (/分镜|视觉|画面|画风|色彩|光影/.test(String(e.title))) s += 8;
      if (/剧本|事实|人物|场景/.test(String(e.title))) s += 1;
    }
    return s;
  };
  return [...list].sort((a, b) => score(b) - score(a));
}

/**
 * 校验一次「add」请求（不改任何文件）。
 *
 * @param opts.role 新节点角色
 * @param opts.parentRole 父角色（顶层是 'root'）
 * @param opts.depRoles 显式依赖的角色数组（可以空）
 * @param opts.hasBase 项目里有没有任何节点（报错措辞用）
 */
export function checkAdd(opts) {
  const placement = checkPlacement(opts.role, opts.parentRole);
  if (!placement.ok) {
    const where = placement.allowed
      .filter((r) => r !== 'root')
      .map(roleLabel)
      .join(' / ');
    return {
      ok: false,
      error: placement.error
        + '。' + roleLabel(opts.role) + '只能放在：项目顶层'
        + (where ? ' / ' + where : ''),
    };
  }
  const dep = checkDeps(opts.role, opts.depRoles || []);
  if (!dep.ok) return { ok: false, error: dep.error, depMissing: true };
  return { ok: true };
}

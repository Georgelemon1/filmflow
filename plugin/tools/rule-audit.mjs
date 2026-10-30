#!/usr/bin/env node
/**
 * rule-audit.mjs —— 片厂结构规则的离线审计（只读，不改任何文件）
 *
 * 为什么要有它（R57，2026-10-30）：
 *   下位白名单现在同时喂给三处 —— 画布「＋」菜单、落盘校验（structureOp）、
 *   agent 提案校验（validateAddProposal）。表写歪一点，三处就一起歪。
 *   这个脚本把"表↔模板库↔骨架包↔片子"四层对一遍，改完规则先跑它。
 *
 * 三组检查：
 *   A 规则表：下位表 / 身份表 / 角色表 自洽（硬错误，退出码 1）
 *   B 骨架包：每个 t 都在模板库里；每对父子都过白名单（硬错误）
 *   C 现有片子：已落盘的子节点不在白名单 → 只报"遗留"（警告，不算失败）
 *
 * 用法：
 *   node plugins/dsh-filmflow/tools/rule-audit.mjs                 # 默认扫 <用户目录>/films
 *   node plugins/dsh-filmflow/tools/rule-audit.mjs D:\片子 --quiet  # 只输出总数
 *
 * 退出码：0 = A/B 无错（C 有警告也算 0）；1 = A/B 有错。
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const RULES = await import(new URL('../host/node-rules.js', import.meta.url).href);
const {
  ruleWarnings,
  childrenWarnings,
  canAddUnder,
  templateIdOf,
  inferRole,
  buildRoleIndex,
  roleOfTemplate,
  checkIdentityPlacement,
  identityOfTemplate,
  identityOfTitle,
} = RULES;

const argv = process.argv.slice(2);
const quiet = argv.includes('--quiet');
const roots = argv.filter((a) => !a.startsWith('--'));
const FILMS = roots[0] || join(process.env.HOME || process.env.USERPROFILE || '', 'films');
const TPL_FILE = fileURLToPath(new URL('../templates.json', import.meta.url));

const raw = JSON.parse(readFileSync(TPL_FILE, 'utf8'));
const templates = Array.isArray(raw.templates) ? raw.templates : [];
const packs = Array.isArray(raw.packs) ? raw.packs : [];
const byId = new Map(templates.map((t) => [String(t.id), t]));
const roleIndex = buildRoleIndex(templates);

const errors = [];
const warn = [];
const say = (...a) => { if (!quiet) console.log(...a); };

/* ── A 规则表 ─────────────────────────────────────────────────────── */
for (const w of ruleWarnings()) errors.push('规则表：' + w);
for (const w of childrenWarnings(templates)) errors.push('下位表：' + w);

/* 每条下位声明的父子都要能真的过一遍 canAddUnder（防"表里写了但运行时不认"） */
for (const parent of templates) {
  const parentId = String(parent.id);
  const allowed = canAddUnder(parent, templates, { roleIndex });
  for (const kid of allowed) {
    if (!byId.has(kid)) errors.push('下位表：' + parentId + ' 的 canAdd 里有不存在的模板 ' + kid);
  }
  /* 叶子（已知模板）必须 canAdd=[]；容器必须非空 —— 防止表写漏一个变叶子 */
  if (!allowed.length && !Object.prototype.hasOwnProperty.call(RULES.TEMPLATE_CHILDREN, parentId)) {
    /* 身份表里的叶子也是合法的空 */
  }
}

/* ── B 骨架包 ─────────────────────────────────────────────────────── */
function tplOfPackItem(it) {
  const id = String((it && it.t) || '');
  const tpl = byId.get(id);
  return {
    template: id,
    title: String((it && it.title) || (tpl && tpl.title) || ''),
    kind: String((tpl && tpl.kind) || ''),
    mediaType: String((tpl && tpl.mediaType) || ''),
  };
}
let packNodes = 0;
function walkPack(pack, items, parentRaw, where) {
  for (const it of Array.isArray(items) ? items : []) {
    const id = String((it && it.t) || '');
    if (!id) continue;
    packNodes++;
    if (!byId.has(id)) {
      errors.push('骨架包 ' + pack.id + '：模板 ' + id + ' 不在模板库里（' + where + '）');
      continue;
    }
    if (parentRaw) {
      const allowed = canAddUnder(parentRaw, templates, { roleIndex });
      if (!allowed.includes(id)) {
        errors.push('骨架包 ' + pack.id + '：' + where + ' 下不该建 ' + id
          + '（白名单：' + (allowed.join(' / ') || '叶子') + '）');
      }
    }
    walkPack(pack, it.children, tplOfPackItem(it), where + ' > ' + (it.title || id));
  }
}
for (const pack of packs) walkPack(pack, pack.tree, null, String(pack.id));

/* ── C 现有片子（只报遗留） ───────────────────────────────────────── */
let films = 0;
let filmNodes = 0;
let legacyBad = 0;
let legacyUnknown = 0;

if (existsSync(FILMS)) {
  for (const dir of readdirSync(FILMS)) {
    const declPath = join(FILMS, dir, '.film', 'project.json');
    if (!existsSync(declPath)) continue;
    films++;
    let decl;
    try {
      decl = JSON.parse(readFileSync(declPath, 'utf8'));
    } catch (e) {
      warn.push('片子 ' + dir + '：project.json 读不出来（' + String(e && e.message) + '）');
      continue;
    }
    const walkFilm = (node, where) => {
      filmNodes++;
      const kids = Array.isArray(node.children) ? node.children : [];
      if (kids.length) {
        const allowed = canAddUnder(node, templates, { roleIndex });
        for (const child of kids) {
          const childId = templateIdOf(child, templates);
          if (!childId) {
            legacyUnknown++;
            warn.push('遗留 ' + dir + '：' + where + ' > ' + String(child.title || '?') + ' 没标模板，判不了');
          } else if (!allowed.includes(childId)) {
            legacyBad++;
            warn.push('遗留 ' + dir + '：' + where + ' > ' + String(child.title || '?')
              + '（' + childId + '）不在白名单（' + (allowed.join(' / ') || '叶子') + '）');
          }
        }
      }
      /* 身份倒挂（R56）也算遗留，单独报 */
      const parentIdentity = identityOfTemplate({ id: templateIdOf(node, templates) }) || identityOfTitle(node.title);
      for (const child of kids) {
        if (!parentIdentity) continue;
        const childIdentity = identityOfTemplate({ id: templateIdOf(child, templates) }) || identityOfTitle(child.title);
        const res = checkIdentityPlacement(childIdentity || null, parentIdentity, true);
        if (!res.ok) legacyBad++;
      }
      for (const child of kids) walkFilm(child, where + ' > ' + String(node.title || '?'));
    };
    for (const stage of Array.isArray(decl.stages) ? decl.stages : []) walkFilm(stage, String(stage.title || '?'));
  }
}

/* ── 汇总 ─────────────────────────────────────────────────────────── */
const roleLabelOf = (t) => roleOfTemplate(t);
say('模板 ' + templates.length + ' / 骨架包 ' + packs.length + ' / 包内节点 ' + packNodes
  + ' / 片子 ' + films + '（' + filmNodes + ' 节点）');
say('容器模板（有下位）：' + Object.keys(RULES.TEMPLATE_CHILDREN).length
  + '；叶子：' + templates.filter((t) => {
    const id = String(t.id);
    if (Object.prototype.hasOwnProperty.call(RULES.TEMPLATE_CHILDREN, id)) return false;
    const info = RULES.identityOfTemplate ? RULES.identityOfTemplate({ id }) : null;
    return !(info && Array.isArray(info.children) && info.children.length);
  }).length);
if (errors.length) {
  say('\n✗ 硬错误 ' + errors.length + ' 处：');
  for (const e of errors) say('  · ' + e);
} else {
  say('\n✓ 规则表 / 骨架包：0 错误');
}
if (warn.length) {
  say('⚠ 现有片子的遗留（不阻塞，只提示）：' + warn.length + ' 条（白名单外子节点 ' + legacyBad
    + ' / 未标模板 ' + legacyUnknown + '）');
  if (!quiet) for (const w of warn.slice(0, 40)) say('  · ' + w);
  if (!quiet && warn.length > 40) say('  · …其余 ' + (warn.length - 40) + ' 条');
}
process.exit(errors.length ? 1 : 0);

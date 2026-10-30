#!/usr/bin/env node
/**
 * identity-scan.mjs —— 扫一遍所有片子的主从层违规（R52 / R54 / R56）
 *
 * 用途：
 *   · 改完 `host/node-rules.js` 的 TEMPLATE_IDENTITY 后，确认旧片有没有倒挂；
 *   · 新建/迁移之后，确认没有落下非法位置。
 *
 * 用法：
 *   node plugins/dsh-filmflow/tools/identity-scan.mjs            # 默认扫 <用户目录>/films
 *   node plugins/dsh-filmflow/tools/identity-scan.mjs D:\片子     # 换目录
 *   node plugins/dsh-filmflow/tools/identity-scan.mjs --quiet    # 只输出总数
 *
 * 退出码：0 = 没有违规；1 = 有违规（方便挂到回归里）。
 * 只读：不写任何文件，不动 project.json。
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const RULES = await import(new URL('../host/node-rules.js', import.meta.url).href);
const { identityOfTemplate, identityOfTitle, checkIdentityPlacement } = RULES;

const argv = process.argv.slice(2);
const quiet = argv.includes('--quiet');
const roots = argv.filter((a) => !a.startsWith('--'));
const ROOT = roots[0] || join(process.env.HOME || process.env.USERPROFILE || '', 'films');

/** 一个节点的身份（模板优先，标题兜底）。 */
const identityOf = (raw) =>
  identityOfTemplate({ id: raw && raw.template }) || identityOfTitle(raw && raw.title);

let projects = 0;
let nodes = 0;
const bad = [];

for (const dir of readdirSync(ROOT)) {
  const decl = join(ROOT, dir, '.film', 'project.json');
  if (!existsSync(decl)) continue;
  projects++;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(decl, 'utf8'));
  } catch (e) {
    bad.push({ project: dir, where: '(project.json)', error: '读不出来：' + String(e && e.message) });
    continue;
  }
  const walk = (node, parentId, where) => {
    nodes++;
    const id = identityOf(node);
    if (parentId) {
      const res = checkIdentityPlacement(id || null, identityOfTemplate({ id: parentId }), true);
      if (!res.ok) {
        bad.push({ project: dir, where: where + ' / ' + String(node.title || '?'), error: res.error });
      }
    }
    for (const child of Array.isArray(node.children) ? node.children : []) {
      walk(child, (id && id.id) || null, where + ' / ' + String(node.title || '?'));
    }
  };
  for (const stage of Array.isArray(parsed.stages) ? parsed.stages : []) {
    walk(stage, null, String(stage.title || '?'));
  }
}

if (!quiet) {
  for (const b of bad) console.log('✗ ' + b.project + ' :: ' + b.where + '\n    ' + b.error);
}
console.log(
  (bad.length ? '违规 ' + bad.length + ' 处' : '主从层全部合规')
  + '（' + projects + ' 部片 / ' + nodes + ' 个节点，扫描 ' + ROOT + '）',
);
process.exit(bad.length ? 1 : 0);

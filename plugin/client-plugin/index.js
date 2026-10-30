// 片场 · 浏览器半边的**宿主半边**
//
// ══ 这个包为什么有两半 ══════════════════════════════════════════════════
//
// DSH 的客户端插件机制要求：一个包声明 `dsh.client` 并导出 `./client`（浏览器半边），
// 而它必须能被宿主 Loader 当作一行插件挂上（`name:` 指向这个文件）。
// 宿主半边本身不渲染任何东西 —— 浏览器插件的代码全在 `client.js` 里。
//
// ══ 但这里顺手干了一件事：把片子目录登记成 DSH 的「工作区」══════════════
//
// 为什么需要：
//   不登记的话，DSH 第一次启动会自己造一个默认工作区
//   （`~/Documents/deepseek-harness/default-workspace`），于是：
//     · 左边栏显示一个叫「默认工作区」的东西，看着莫名其妙
//     · 会话的 cwd 是那个空目录，`@ 文件` 引用、文件树全都指向它
//   ⇒ 一个叫「片场」的软件，工作区却叫「默认工作区」还指向空文件夹 ✗
//
// 登记之后：左边栏就是这部片的名字；而且因为注册表**非空**，
// DSH 那个"仅在注册表和会话历史都为空时才初始化"的默认工作区就不会再造了。
//
// 用 `workspaceRegistry.create(path, title)` —— 官方服务，且**幂等**：
// 同一个规范化路径重复调用只会返回已有记录，不会重复建。
//
// ⚠️ 这条路故意**不让主插件（../index.js）来做**：
//    主插件是全片场的命脉，把 `workspaceRegistry` 加进它的 inject 意味着
//    这个服务缺席时整个插件不激活（工具、路由全没）。放在这一行里，
//    最坏情况只是"工作区没登记上"，片场照常能用。

import { existsSync, appendFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TRACE = join(HERE, '..', 'standalone', 'logs', 'workspace-trace.log');

/** 记一行诊断（这个插件很小，不值得引日志框架）。 */
function trace(msg) {
  try {
    appendFileSync(TRACE, new Date().toISOString() + '  ' + msg + '\n', 'utf8');
  } catch { /* 记不上就算了 */ }
}

/** 只依赖工作区这两个服务 —— 片场里其它东西不归这一行管。 */
export const inject = ['workspaceRegistry', 'workspaceController'];

/**
 * 把片子根目录登记成工作区。
 *
 * ⚠️ **必须是 async 并 await**，不能 fire-and-forget。
 *    实测（2026-10-20）：写成"发起 promise 就返回"的话，浏览器那边的
 *    `initializeDefault` 会抢在前面把「默认工作区」建出来 —— 于是左边栏
 *    两个工作区并列，而且选中的是那个空目录 ✗
 *    cordis 会等 apply 返回的 promise 结算；登记表里一旦有记录，
 *    `initializeDefault`（"仅在两表都为空时才初始化"）就不会再造默认工作区 ✓
 *
 * @param ctx - 宿主 cordis 上下文。
 * @param config - `{ workspace?: string }`（叠加层里由 FILMFLOW_ROOTS 传进来）
 * @returns 登记完成的 promise（失败也 resolve —— 名字不好看不该拦住启动）
 */
export async function apply(ctx, config) {
  const dir = String((config && config.workspace) || '').trim();
  if (!dir) return;
  if (!existsSync(dir)) return;

  /*
   * 工作区显示名：优先用叠加层给的 `title`，否则退回目录名。
   *
   * 为什么不能只用目录名：片子的根目录常常是英文的（这台机器上叫 `filmflow`），
   * 一屏中文里夹一个 `filmflow`，就是用户 2026-10-20 说的那个「改中文」。
   */
  const title = String((config && config.title) || '').trim() || basename(dir);
  try {
    await ctx.workspaceRegistry.create(dir, title);
  } catch {
    /* 登记不上只是界面上的名字不好看，不该影响片场启动 */
  }

  /*
   * 把左边栏那个英文名改成中文。
   *
   * 为什么 create 的 title 不管用：
   *   `WorkspaceRegistry.create()` 的契约是「title 只在**新建**记录时使用；
   *   同一个路径重复调用只返回已有记录，**不改标题**」。
   *   而 DSH 自己在启动时就已经把**当前目录**登记成了默认工作区 ——
   *   于是我的 title 永远落在"复用已有记录"这条路上，左边栏照旧显示文件夹名（`filmflow`）。
   *   实测证据：workspace.json 里 `<片库根> [filmflow]`，createdAt 就是本次启动的时刻。
   *
   * ⇒ 只能事后再改名。注册表没有 rename，但它的上层 `workspaceController` 有
   *   （官方 Remote `workspace/rename` 的宿主实现，参数 `{ workspaceId, title }`）。
   *
   * ⚠️ **只在"还没被改过名"时动**：标题仍等于文件夹名才改 ——
   *    用户自己重命名过的工作区，不许被插件改回去。
   */
  try {
    const folder = basename(dir);
    if (title !== folder) {
      for (const ws of ctx.workspaceRegistry.list()) {
        if (ws.path !== dir) continue;
        if (String(ws.title || '') !== folder) continue;   // 已经被用户改过名，不碰
        await ctx.workspaceController.rename({ workspaceId: ws.id, title });
        trace('工作区改名：' + folder + ' -> ' + title);
      }
    }
  } catch (e) {
    trace('工作区改名失败：' + String((e && e.message) || e));
  }

  /*
   * 再把 DSH 自动造的那个空「默认工作区」删掉。
   *
   * 为什么删得掉、且删了就不会再出现：
   *   `WorkspaceRegistry.initializeDefault()` 的契约是
   *   ——「仅在注册表和会话历史都为空时才初始化；**删掉那条登记会永久禁用自动创建**」。
   * ⇒ 删一次就一劳永逸，左边栏只剩这家片子的名字。
   *
   * ⚠️ **要扫好几遍**：它是浏览器那边第一次请求时才建的，而插件激活在它之前。
   *    只扫一遍必然扫不到（实测：日志里只看到 filmflow，没有 default-workspace）。
   *    所以按 0 / 5 / 15 秒扫三次 —— 幂等、便宜，扫到一次就永久生效。
   *
   * ⚠️ 只删**空的**那个：有会话记录的工作区一律不碰 —— 那可能是用户真在用的。
   */
  const sweep = async (why) => {
    try {
      for (const ws of ctx.workspaceRegistry.list()) {
        const isAuto = ws.title === 'default-workspace'
          || /[\\/]deepseek-harness[\\/]default-workspace$/i.test(String(ws.path || ''));
        const empty = !(ws.sessionIds && ws.sessionIds.length);
        if (!isAuto) continue;
        trace('发现自动默认工作区（' + why + '）：sessions=' + ((ws.sessionIds || []).length));
        if (!empty || ws.path === dir) continue;
        const gone = await ctx.workspaceRegistry.delete(ws.id);
        trace('删除默认工作区 -> ' + gone);
      }
    } catch (e) {
      trace('扫描工作区失败（' + why + '）：' + String((e && e.message) || e));
    }
  };
  await sweep('激活后');
  for (const ms of [5000, 15000]) {
    const t = setTimeout(() => { sweep(ms + 'ms'); }, ms);
    if (typeof t.unref === 'function') t.unref();
  }
}

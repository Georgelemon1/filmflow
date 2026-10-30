/**
 * server.mjs —— 片场的启动器（真正干活的那个）
 *
 * ══ 片场到底是什么 ══════════════════════════════════════════════════════
 *
 * **一个普通 DSH Web 进程**：`dsh --profile filmflow --patch <叠加层>`。
 * 对话、输入框、工具卡、思考链、模型设置、API Key —— 全是官方的；
 * 片场只加了「工序画布」和一个 agent preset（人格 + 四把工序工具）。见 ../filmflow.patch.yml。
 *
 * ══ 这个文件负责的四件事 ═══════════════════════════════════════════════
 *
 * ① **把叠加层里的 `__PLUGIN_DIR__` 换成这台机器上的真实路径。**
 *    模板里写死绝对路径的包，一拷到别的机器就起不来 —— 所以运行时替换，
 *    写到 dsh-home/runtime.patch.yml，再把那一个交给 dsh。
 *
 * ② **已经有一个在跑就直接开窗口**（快捷方式点两下不会起第二个服务）。
 *
 * ③ 从 dsh 的输出里抓 `dsh web: <url>`（**带访问令牌**），存到 runtime-url.txt，
 *    然后用 Chrome/Edge 的 `--app=` 模式打开 —— 没有地址栏、没有标签栏，
 *    看着就是一个独立应用。
 *
 * ④ 当 dsh 的父进程，往 logs/dsh.log 里落日志；dsh 挂了这里也退出。
 *
 * ══ 为什么不自己写 HTTP 服务 ═══════════════════════════════════════════
 *
 * 写偏过一次（2026-10-20 之前）：手写了一个 shell 去模仿 DSH 的对话面板。
 * 用户的原话是「给一个普通的 dsh 加上一些特定的功能，然后再去掉一些特定的功能」
 * —— 交互框必须是**官方原物**，不是仿制品。这个文件就是那条规矩的落地。
 *
 * 用法：node server.mjs [--port 3210] [--no-open]
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, createWriteStream } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';

const HERE = dirname(fileURLToPath(import.meta.url));

// ── 参数 ────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
/** 从命令行取一个开关的值。 */
const optOf = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const PORT = Number(optOf('--port', process.env.FILMFLOW_PORT || '3210'));
const NO_OPEN = argv.includes('--no-open') || process.env.FILMFLOW_OPEN === '0';

/*
 * 代码目录 vs 数据目录（2026-10-26 桌面版用）：
 *   安装包里的 standalone 是**只读**的（resources 下），所以 dsh-home / logs / runtime-url.txt
 *   必须能落到可写位置 —— 用 FILMFLOW_DSH_HOME 指定（桌面壳会指向 %LOCALAPPDATA%\FilmFlow）。
 *   没设这个环境变量时行为完全不变（还在 HERE 旁边）。
 */
const DATA_HOME = process.env.FILMFLOW_DSH_HOME ? resolve(process.env.FILMFLOW_DSH_HOME) : HERE;
const CONFIG_FILE = join(DATA_HOME, 'config.json');
const URL_FILE = join(DATA_HOME, 'runtime-url.txt');
const LOG_DIR = join(DATA_HOME, 'logs');
const DSH_HOME = join(DATA_HOME, 'dsh-home');

// ── 找东西 ──────────────────────────────────────────────────────────────
/**
 * 找 dsh 的入口。优先用包里自带的那份（装机即用），再退到机器上装的。
 * @returns {string|null} bin.js 的绝对路径
 */
function findDshBin() {
  /*
   * 便携版把 6.4 万个运行时文件压成了 runtime.7z，首次启动解到可写数据目录
   * （main.js 负责解压并通过 FILMFLOW_RUNTIME 告诉这里）；开发/旧包仍用包内 runtime。
   */
  const rt = String(process.env.FILMFLOW_RUNTIME || '');
  const cands = [
    rt ? join(rt, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js') : '',
    join(HERE, 'runtime', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    join(process.env.USERPROFILE || 'C:\\Users\\PC', 'AppData', 'Roaming', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
  ].filter(Boolean);
  for (const c of cands) if (existsSync(c)) return c;
  return null;
}

/**
 * 找片场插件目录。
 *
 * 顺序有意义（踩过的坑）：**先认开发目录，再认包内快照**。
 *   · 开发时：`standalone/` 的上一级就是 plugins/dsh-filmflow，直接用它 ⇒ 改完代码重启就生效
 *   · 打包后：上一级是包的根，里面没有 entry-v71.mjs ⇒ 落到 `standalone/plugin/`（打包时拷进去的快照）
 *
 * 反过来写（先认 plugin/）的话：只要打过一次包，之后改代码就**永远跑的是旧快照** ——
 * 而且看不出来，因为它确实能跑。
 * @returns {string|null} 含 entry-v71.mjs 的目录
 */
function findPluginDir() {
  const cands = [
    process.env.FILMFLOW_PLUGIN_DIR || '',
    resolve(HERE, '..'),
    join(HERE, 'plugin'),
  ].filter(Boolean);
  for (const c of cands) if (existsSync(join(c, 'entry-v71.mjs'))) return c;
  return null;
}

/** 读 config.json；读不到就给默认值。 */
function readConfig() {
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return {};
  }
}

/** 端口上有没有人在听。 */
function portBusy(port) {
  return new Promise((done) => {
    const srv = createServer();
    srv.once('error', () => done(true));
    srv.once('listening', () => srv.close(() => done(false)));
    srv.listen(port, '127.0.0.1');
  });
}

/**
 * 打开一个"像独立应用"的窗口。
 * @param url 带令牌的地址
 */
function openWindow(url) {
  if (NO_OPEN) {
    console.log('  （--no-open：不自动开窗口）' + url);
    return;
  }
  const browsers = [
    join(process.env.ProgramFiles || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(process.env.ProgramFiles || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ];
  const exe = browsers.find((p) => existsSync(p));
  if (!exe) {
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    return;
  }
  spawn(exe, ['--app=' + url, '--window-size=1500,950'], { detached: true, stdio: 'ignore' }).unref();
}

/**
 * 用模板生成运行时可用的叠加层。
 * @param pluginDir 插件绝对目录
 * @returns 生成出来的 patch 路径
 */
function writeRuntimePatch(pluginDir) {
  const tpl = readFileSync(join(pluginDir, 'filmflow.patch.yml'), 'utf8');
  /*
   * YAML 单引号字符串里反斜杠是字面量，所以路径用正斜杠最省事；
   * 路径本身含单引号时按 YAML 规矩双写。
   * ★ 整个值一起替换（模板里占位符自带引号的位置在替换值里）——
   *   之前只替换了路径、把引号留在外面，生成出 `'D:/x'/entry.mjs` 这种坏 YAML ✗
   */
  const q = (p) => "'" + p.replace(/\\/g, '/').replace(/'/g, "''") + "'";
  const out = tpl
    .replaceAll('__FF_ENTRY__', q(join(pluginDir, 'entry-v71.mjs')))
    .replaceAll('__FF_CLIENT__', q(join(pluginDir, 'client-plugin', 'index.js')));
  const path = join(DSH_HOME, 'runtime.patch.yml');
  mkdirSync(DSH_HOME, { recursive: true });
  writeFileSync(path, out, 'utf8');
  return path;
}

/** 睡眠。 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log('');
  console.log('  片场');
  console.log('');

  // ── ② 已经在跑？那就只开窗口 ────────────────────────────────────────
  if (await portBusy(PORT)) {
    console.log('  已经有一个片场在 ' + PORT + ' 上跑着，直接开窗口。');
    let url = 'http://127.0.0.1:' + PORT + '/';
    try {
      url = readFileSync(URL_FILE, 'utf8').trim() || url;
    } catch {
      /* 没有上次的地址就退回裸地址（浏览器里有会话 cookie 时照样能用） */
    }
    openWindow(url);
    return;
  }

  // ── ① 生成运行时叠加层 ──────────────────────────────────────────────
  const bin = findDshBin();
  if (!bin) {
    console.error('  ✗ 找不到 dsh 运行时。请先跑一次 打包.mjs，或在本机装好 dsh。');
    process.exit(1);
  }
  const pluginDir = findPluginDir();
  if (!pluginDir) {
    console.error('  ✗ 找不到片场插件目录（要含 entry-v71.mjs 和 filmflow.patch.yml）');
    process.exit(1);
  }
  const patch = writeRuntimePatch(pluginDir);

  // ── 环境 ────────────────────────────────────────────────────────────
  const cfg = readConfig();
  const roots = Array.isArray(cfg.roots) && cfg.roots.length
    ? cfg.roots.map(String)
    : [String(cfg.root || process.env.FILMFLOW_ROOTS || join(process.env.USERPROFILE || process.env.HOME || '.', 'films'))];
  const env = {
    ...process.env,
    DSH_HOME,
    FILMFLOW_ROOTS: roots.join(';'),
    // 关掉页面 20 分钟后自己退出 —— 见插件里 FILMFLOW_IDLE_EXIT_MIN 的注释
    FILMFLOW_IDLE_EXIT_MIN: String(cfg.idleExitMin ?? 20),
    // 追踪日志落到包内，方便排查；不写用户目录
    DSH_FILMFLOW_TRACE: join(LOG_DIR, 'filmflow-trace.log'),
  };
  if (cfg.project) env.FILMFLOW_PROJECT = String(cfg.project);

  mkdirSync(LOG_DIR, { recursive: true });

  console.log('  运行时：' + bin);
  console.log('  插件：  ' + pluginDir);
  console.log('  片子：  ' + roots.join('；'));
  console.log('');

  // ── ③ 起 dsh ────────────────────────────────────────────────────────
  /*
   * ★ 子进程的工作目录 = **片子根目录**，不是 standalone。
   *
   * 为什么：DSH 的会话工作区取进程 cwd —— 在 standalone 里起，
   * 左边栏会显示一个叫「默认工作区」的东西，@ 文件、文件树全都指向程序目录，
   * 跟"这是一部片的工作台"完全对不上。
   * 片子根目录存在就用它；不存在就退回 standalone（并在日志里说一句）。
   */
  const workdir = roots.find((r) => existsSync(r)) || HERE;
  if (workdir === HERE) console.log('  ! config.json 的 roots 里没有一个存在的目录，退回到程序目录当工作区');

  const child = spawn(process.execPath, [
    bin,
    '--profile', 'filmflow',
    '--patch', patch,
    '--port', String(PORT),
    '--no-open',
  ], { cwd: workdir, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

  const stdoutLog = createWriteStream(join(LOG_DIR, 'dsh.log'), { flags: 'a' });
  let opened = false;

  /** 从一坨输出里找 `dsh web: <url>`，找到就存起来、开窗口。 */
  const scan = (text) => {
    const m = /dsh web:\s*(\S+)/.exec(text);
    if (!m) return;
    const url = m[1].trim();
    writeFileSync(URL_FILE, url, 'utf8');
    if (opened) return;
    opened = true;
    console.log('  ✓ 服务就绪，正在开窗口…');
    openWindow(url);
  };

  let buf = '';
  child.stdout.on('data', (d) => {
    const s = d.toString('utf8');
    stdoutLog.write(s);
    buf = (buf + s).slice(-4000);
    scan(buf);
  });
  child.stderr.on('data', (d) => {
    const s = d.toString('utf8');
    stdoutLog.write(s);
    buf = (buf + s).slice(-4000);
    scan(buf);
    // 启动失败的常见原因是配置写错 —— 原样打出来，别让人对着黑窗口猜
    if (/error|Error|失败/.test(s)) process.stderr.write(s);
  });

  child.on('exit', (code) => {
    appendFileSync(join(LOG_DIR, 'dsh.log'), '\n[server.mjs] dsh 退出，exit=' + code + '\n');
    console.log('  片场已退出（exit ' + code + '）');
    process.exit(code ?? 0);
  });

  // 兜底：等 URL 行（dsh 要装配完整棵插件树之后才打印，可能比端口就绪晚几十秒）。
  // 只有**一直没等到**、而且端口确实通了，才退回裸地址 —— 裸地址在第一次访问时
  // 没有会话 cookie，会落到 401 页面，所以只能当最后的退路。
  const startedAt = Date.now();
  let portUp = false;
  while (!opened && Date.now() - startedAt < 180000) {
    await sleep(500);
    if (!portUp) portUp = await portBusy(PORT);
    if (portUp && Date.now() - startedAt > 30000 && !opened) {
      // 再宽限 15 秒等 URL 行
      await sleep(15000);
      if (opened) return;
      opened = true;
      console.log('  ! 没等到 dsh 打印地址，用裸地址开窗口（浏览器里有会话 cookie 时能直接用）');
      openWindow('http://127.0.0.1:' + PORT + '/');
    }
  }
  if (!opened) {
    console.error('  ✗ 180 秒内没有起来。看日志：' + join(LOG_DIR, 'dsh.log'));
    try { child.kill(); } catch { /* 忽略 */ }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('  启动失败：' + ((err && err.stack) || err));
  process.exit(1);
});

/**
 * 片场桌面壳（Electron 主进程）
 *
 * 使命：把「普通 DSH Web 进程 + 工序画布插件」装进一个**真正的桌面应用窗口**，
 * 而不是用 Chrome/Edge 的 --app 模式开一个网页。
 *
 * 关键决定（都踩过）：
 *   1. **代码只读、数据可写**：安装包里的 resources\standalone 不能写，
 *      所以用 FILMFLOW_DSH_HOME 把 dsh-home / logs / runtime-url.txt 指到 %LOCALAPPDATA%\FilmFlow。
 *      （第一版试过首次运行把 700MB 拷到用户目录 —— 实测 7 分钟，太慢，弃了。）
 *   2. **自带 node.exe**：用壳里的 runtime\node.exe 起 server.mjs，目标机器不用装 Node。
 *      绝不用 process.execPath（那是 electron.exe，会把 dsh 的子进程也变成 electron，实测起不来）。
 *   3. **单实例**：再点一次快捷方式只是把已有窗口叫到前面。
 */
const { app, BrowserWindow, Menu, dialog, shell } = require('electron');
const { spawn, spawnSync } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const HERE = __dirname;
const PORT = Number(process.env.FILMFLOW_PORT || 3210);
let child = null;
let quitting = false;
let win = null;
let loading = false;

/**
 * 启动画面（data URL，不依赖服务）。
 *
 * 为什么需要它：冷启动要 9–45 秒，这段时间窗口里只有一个背景色 ——
 * 用户 2026-10-28：「黑屏的样子还以为是坏了」。这里给一个转圈 + 进度条 +
 * 已等秒数，页面自己会数秒，不需要主进程持续推消息。
 */
const SPLASH_HTML = [
  '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">',
  '<style>',
  'html,body{height:100%;margin:0}',
  'body{background:#0b0c0f;color:#e8eaed;overflow:hidden;user-select:none;',
  '  font:14px/1.6 "Segoe UI","Microsoft YaHei",system-ui,sans-serif;',
  '  display:flex;align-items:center;justify-content:center;flex-direction:column;gap:24px;',
  '  -webkit-app-region:drag}',
  '.mark{display:flex;align-items:center;gap:16px}',
  '.spin{width:42px;height:42px;border-radius:50%;border:3px solid rgba(255,255,255,.07);',
  '  border-top-color:#5b8cff;animation:spin 1s cubic-bezier(.55,.15,.45,.85) infinite}',
  '@keyframes spin{to{transform:rotate(360deg)}}',
  '.word{font-size:28px;font-weight:800;letter-spacing:.2em;color:#f3f5f8}',
  '.bar{width:240px;height:3px;border-radius:2px;background:rgba(255,255,255,.07);',
  '  overflow:hidden;position:relative}',
  '.bar i{position:absolute;top:0;bottom:0;width:38%;border-radius:2px;',
  '  background:linear-gradient(90deg,transparent,#5b8cff,transparent);',
  '  animation:slide 1.5s ease-in-out infinite}',
  '@keyframes slide{0%{left:-40%}100%{left:108%}}',
  '.st{font-size:12.5px;color:#9aa4b2;letter-spacing:.05em;height:18px}',
  '.hint{font-size:11.5px;color:#606a78}',
  '</style></head><body>',
  '<div class="mark"><div class="spin"></div><div class="word">片厂</div></div>',
  '<div class="bar"><i></i></div>',
  '<div class="st" id="st">正在启动后台服务…</div>',
  '<div class="hint">首次启动 20–45 秒，之后会快很多 · <span id="sec">0</span> 秒</div>',
  '<script>',
  'window.__ffStatus=function(t){var e=document.getElementById("st");if(e)e.textContent=t};',
  'var n=0,el=document.getElementById("sec");',
  'setInterval(function(){n++;if(el)el.textContent=n},1000);',
  '</script></body></html>',
].join('');
const SPLASH_URL = 'data:text/html;charset=utf-8,' + encodeURIComponent(SPLASH_HTML);

/** 更新启动画面上的那行字（页面还没就绪时静默失败）。 */
function splashStatus(text) {
  if (!win || win.isDestroyed()) return;
  try {
    win.webContents.executeJavaScript(
      'window.__ffStatus && window.__ffStatus(' + JSON.stringify(String(text)) + ')',
    ).catch(() => { /* 已经跳走了 */ });
  } catch { /* 忽略 */ }
}

/** 片场本体（standalone）在哪。 */
function findStandalone() {
  const candidates = [
    process.env.FILMFLOW_STANDALONE,
    path.join(process.resourcesPath || '', 'standalone'),
    path.join(HERE, 'standalone'),
    path.join(HERE, '..', 'standalone'),
  ].filter(Boolean);
  for (const c of candidates) {
    try { if (fs.existsSync(path.join(c, 'server.mjs'))) return c; } catch { /* 忽略 */ }
  }
  return '';
}

/**
 * 便携模式的数据目录：exe 旁边有 `portable.txt` 就用 `.\data`。
 * 2026-10-28：用户要「zip 便携包，带 API Key，不带项目历史」——
 * 数据必须跟着包走，不能写进 %LOCALAPPDATA%（否则新机器上包里的 key 用不上）。
 */
function portableHome() {
  try {
    const exeDir = path.dirname(app.getPath('exe'));
    if (fs.existsSync(path.join(exeDir, 'portable.txt'))) return path.join(exeDir, 'data');
  } catch { /* 忽略：拿不到 exe 路径就退回普通模式 */ }
  return '';
}

/** 数据目录：便携包用 `exe\data`，普通安装用 %LOCALAPPDATA%\FilmFlow。 */
function dataHome() {
  const dir = process.env.FILMFLOW_DATA_HOME
    || portableHome()
    || path.join(process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '.', 'AppData', 'Local'), 'FilmFlow');
  for (const sub of ['', 'dsh-home', 'films', 'logs']) {
    try { fs.mkdirSync(path.join(dir, sub), { recursive: true }); } catch { /* 忽略 */ }
  }
  return dir;
}

/**
 * 找 node.exe。
 *
 * 2026-10-29 起便携版把 6.4 万个运行时文件压成 `runtime.7z`，首次运行解到
 * `dataHome\runtime`（只解一次）；所以先找这里，再退回壳里/开发目录自带的 runtime。
 */
function findNode(home) {
  const candidates = [
    home ? path.join(home, 'runtime', 'node.exe') : '',
    path.join(process.resourcesPath || '', 'runtime', 'node.exe'),
    path.join(HERE, 'runtime', 'node.exe'),
  ].filter(Boolean);
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch { /* 忽略 */ }
  }
  return 'node';
}

/**
 * 便携版首次运行：把 `standalone\runtime.7z` 解到 `dataHome\runtime`。
 * 只解一次（node.exe 在就跳过），后续启动直接复用。
 * @returns 解好的 runtime 目录；没有残留包或失败时返回空串（退回壳内运行时）
 */
function ensureRuntime(standalone, home) {
  const dst = path.join(home, 'runtime');
  /*
   * 判据是 dsh 的 bin.js（node.exe 仍用壳里 `resources\runtime\node.exe`，只有 1 个文件，
   * 不打进 6.4 万文件的 archive）；archive 解开后是这个路径。
   */
  const marker = path.join(dst, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  if (fs.existsSync(marker)) return dst;
  const arc = path.join(standalone, 'runtime.7z');
  const seven = path.join(standalone, '7za.exe');
  if (!fs.existsSync(arc) || !fs.existsSync(seven)) return '';
  try {
    fs.mkdirSync(dst, { recursive: true });
    const r = spawnSync(
      seven,
      ['x', arc, '-o' + home, '-y'],
      { windowsHide: true, stdio: 'ignore' },
    );
    if (r && r.status === 0 && fs.existsSync(marker)) return dst;
  } catch { /* 失败退回壳内运行时 */ }
  return '';
}

/** 读后台写出的访问地址。 */
function readUrl() {
  try {
    const t = fs.readFileSync(path.join(dataHome(), 'runtime-url.txt'), 'utf8').trim();
    const m = /https?:\/\/\S+/.exec(t);
    return m ? m[0] : '';
  } catch {
    return '';
  }
}

/** 等页面可访问再 load（dsh 打印 URL 时服务可能还在初始化）。 */
function loadWhenReady(url) {
  if (!win || win.isDestroyed() || !url) return;
  let tries = 0;
  const tick = () => {
    if (!win || win.isDestroyed()) return;
    win.loadURL(url).catch(() => {
      tries += 1;
      if (tries < 360) setTimeout(tick, 500); // 最多等 180 秒（冷启动实测 30–45 秒）
    });
  };
  tick();
}

/** 服务真的能应答了吗（`/filmflow/ping` 只要不是连接失败就算活着）。 */
function serverAlive() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/filmflow/ping', timeout: 1200 }, (res) => {
      res.resume();
      resolve(res.statusCode >= 200 && res.statusCode < 500);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

/**
 * 拿到地址后**先等 ping 通再跳**。
 * 否则 loadURL 会撞在"服务还在初始化"的窗口期，把 Chromium 的错误页
 * 画在启动画面上（看起来比黑屏更像坏了）。
 */
function waitForServer(url) {
  if (loading) return;
  loading = true;
  splashStatus('正在载入界面…');
  let tries = 0;
  const tick = async () => {
    if (!win || win.isDestroyed()) { loading = false; return; }
    if (tries++ > 240) { // 约 3 分钟
      loading = false;
      splashStatus('启动超时 —— 关掉窗口重开一次');
      return;
    }
    if (await serverAlive()) {
      loading = false;
      loadWhenReady(url);
      return;
    }
    setTimeout(tick, 700);
  };
  tick();
}

function killServer() {
  if (!child) return;
  const pid = child.pid;
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true });
    else process.kill(pid, 'SIGTERM');
  } catch { /* 忽略 */ }
  child = null;
}

/**
 * 首次运行要**播种** dsh-home（只要 profile，3MB，不是 700MB 运行时）。
 *
 * 坑：dsh 的 profile（filmflow / headless）住在 dsh-home\profiles 里，
 * 空目录起 `--profile filmflow` 会直接报 "profile does not exist"（实测）。
 * 所以第一次启动把包里那份 dsh-home 的**框架**（profiles/logs）拷过去；
 * 再把 seed/credentials.yaml 播成 dsh-home/.credentials.yaml（便携版带 key，开箱即用）。
 * sessions / storages / records 属于某台机器的数据，一律不带。
 * @param standalone 只读的代码目录
 * @param home 可写数据目录
 */
function seedDshHome(standalone, home) {
  const src = path.join(standalone, 'dsh-home');
  const dst = path.join(home, 'dsh-home');
  if (!fs.existsSync(src)) return;
  const seeded = path.join(dst, '.seeded');
  const profile = path.join(dst, 'profiles', 'filmflow', 'cordis.patch.yml');
  /*
   * 2026-10-28 便携版：除了 profile，还要把 **API key 种子** 播下去。
   * 用户要求「包括所有 api 及 key，新电脑开箱即用」——包里的 seed/credentials.yaml
   * 只放 refs（DeepSeek / 方舟 / 豆包语音），不放 records（浏览器会话授权属于单机）。
   * 只在目标不存在时复制：用户后来自己换过 key 的机器不会被覆盖。
   */
  const needHome = !fs.existsSync(seeded) || !fs.existsSync(profile);
  fs.mkdirSync(dst, { recursive: true });
  if (needHome) {
    const ps = path.join(src, 'profiles');
    if (fs.existsSync(ps)) fs.cpSync(ps, path.join(dst, 'profiles'), { recursive: true, force: true });
    fs.mkdirSync(path.join(dst, 'storages'), { recursive: true });
    fs.mkdirSync(path.join(dst, 'logs'), { recursive: true });
    fs.writeFileSync(seeded, new Date().toISOString(), 'utf8');
  }
  const seedCred = path.join(standalone, 'seed', 'credentials.yaml');
  const credDst = path.join(dst, '.credentials.yaml');
  if (fs.existsSync(seedCred) && !fs.existsSync(credDst)) {
    try { fs.copyFileSync(seedCred, credDst); } catch { /* 复制失败不拦启动 */ }
  }
}

/**
 * 首次运行播种「新片」底模板。
 *
 * 为什么需要：`/filmflow/newproject` 以 `roots[0]\新片\.film\project.json` 为底。
 * 新电脑的 films 目录是空的，不播种就会报「找不到模板」—— 开箱即用就断了。
 * 只补这一个模板，不覆盖用户自己的片子。
 */
function seedFilms(standalone, home) {
  const src = path.join(standalone, 'seed-films');
  if (!fs.existsSync(src)) return;
  const dst = path.join(home, 'films');
  const tpl = path.join(dst, '新片', '.film', 'project.json');
  if (fs.existsSync(tpl)) return;
  try {
    fs.cpSync(src, dst, { recursive: true, force: true });
  } catch { /* 播种失败不拦启动：用户还可以选别的底 */ }
}

function startServer(standalone) {
  const server = path.join(standalone, 'server.mjs');
  const home = dataHome();
  seedDshHome(standalone, home);
  seedFilms(standalone, home);
  const needRt = !fs.existsSync(path.join(home, 'runtime', 'node.exe'))
    && fs.existsSync(path.join(standalone, 'runtime.7z'));
  if (needRt) splashStatus('首次启动：正在展开运行时（约 1–3 分钟）…');
  const runtime = ensureRuntime(standalone, home);
  const env = {
    ...process.env,
    FILMFLOW_OPEN: '0',
    FILMFLOW_DSH_HOME: home,
    FILMFLOW_ROOTS: process.env.FILMFLOW_ROOTS || path.join(home, 'films'),
  };
  if (runtime) env.FILMFLOW_RUNTIME = runtime;
  delete env.ELECTRON_RUN_AS_NODE;
  child = spawn(findNode(home), [server, '--port', String(PORT), '--no-open'], {
    cwd: standalone,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (b) => {
    const s = String(b);
    process.stdout.write('[server] ' + s);
    const m = /dsh web:\s*(\S+)/.exec(s);
    if (m) waitForServer(m[1]);
  });
  child.stderr.on('data', (b) => process.stderr.write('[server:err] ' + String(b)));
  child.on('exit', (code) => {
    child = null;
    if (!win || win.isDestroyed() || quitting) return;
    if (code) {
      dialog.showErrorBox('片场已退出', '后台服务异常退出（code ' + code + '）。\n日志：' + path.join(dataHome(), 'logs', 'dsh.log'));
    }
    /*
     * 服务没了，留着一个死页面，用户点任何按钮都只会得到 `Failed to fetch`
     * （2026-10-28 实测：服务空闲自退，窗口还开着）。
     * ⇒ 服务退出（含 code 0 的空闲自退）就把窗口一起关掉，用户重新双击即可。
     */
    app.quit();
  });
}

function createWindow(url) {
  /* 任务栏/标题栏图标：优先用随包带的 icon.png；没有就退回 exe 内嵌图标。 */
  const iconPath = path.join(process.resourcesPath || HERE, 'icon.png');
  win = new BrowserWindow({
    width: 1500,
    height: 940,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#111214',
    title: '片场',
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false },
  });
  Menu.setApplicationMenu(null);
  win.on('closed', () => { win = null; });

  /*
   * 2026-10-30（R60）：**窗口标题只显示片场自己的名字**。
   *
   * 页面（DSH web app）会把 <title> 写成「会话名 — DeepSeek Harness」，
   * Electron 默认把它同步到窗口标题/任务栏 ⇒ 用户看到 "… — DeepSeek Harness"。
   * 这里拦掉同步，自己拼：「会话名 — 片场」。
   */
  win.on('page-title-updated', (e, title) => {
    e.preventDefault();
    /* 页面标题可能已经被客户端插件改成「… — 片场」，这里先去后缀再拼一次，避免双重 */
    const clean = String(title || '')
      .replace(/(\s*[—\-|·]\s*(DeepSeek\s*Harness|Harness|片场))\s*$/i, '')
      .trim();
    try { win.setTitle(clean && clean !== '片场' ? clean + ' — 片场' : '片场'); } catch { /* 忽略 */ }
  });
  win.webContents.setWindowOpenHandler(({ url: u }) => {
    if (/^https?:/i.test(u)) shell.openExternal(u);
    return { action: 'deny' };
  });
  if (url) {
    loadWhenReady(url);
  } else {
    // 先给一张启动画面，服务好了再跳（不依赖服务，纯 data URL）
    win.loadURL(SPLASH_URL).catch(() => { /* 忽略：最多就是黑屏 */ });
  }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });

  app.whenReady().then(() => {
    const standalone = findStandalone();
    if (!standalone) {
      dialog.showErrorBox('找不到片场本体', '没有找到 standalone/server.mjs。请把 desktop 与 standalone 放在一起。');
      app.quit();
      return;
    }
    /*
     * 启动画面先出来；同时删掉上一次留下的 runtime-url.txt ——
     * 那个文件里的 token 是上一轮进程的，先跳过去只会得到 403/连接失败。
     */
    try { fs.rmSync(path.join(dataHome(), 'runtime-url.txt'), { force: true }); } catch { /* 忽略 */ }
    createWindow('');
    startServer(standalone);
    /*
     * 兜底：每 1.5 秒看一次 runtime-url.txt，地址一变就**等 ping 通**再加载。
     * server.mjs 只把 dsh 的 URL 写进 logs/dsh.log、不转 stdout，
     * 而冷启动 30–45 秒 ⇒ 原来"25 秒兜底"必然跑在服务起来之前，窗口空白。
     */
    let loadedUrl = '';
    setInterval(() => {
      if (!win || win.isDestroyed()) return;
      const u = readUrl();
      if (!u || u === loadedUrl) return;
      loadedUrl = u;
      waitForServer(u);
    }, 1500);
  });

  app.on('window-all-closed', () => { killServer(); app.quit(); });
  app.on('before-quit', () => { quitting = true; killServer(); });
}
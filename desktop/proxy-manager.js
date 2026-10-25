"use strict";

/**
 * 代理生命周期管理器
 *
 * ============================================================================
 * 设计原则 —— 改这个文件之前请先读完，这几条就是它存在的全部理由
 * ============================================================================
 *
 * 1) 默认不存在。
 *    应用常驻期间不启动任何代理进程，也不碰系统代理设置（一个字节都不动）。
 *    唯一的启动入口是：用户在扫码结果上点「手机环境打开」并在询问卡里确认。
 *    没有任何"启动时预热""后台自动拉起"的路径。
 *
 * 2) 生命周期跟着一次授权流程走，不跟着窗口走。
 *    关掉取景框 ≠ 流程结束（微信里还在跳转 oauth → 结果页），
 *    所以代理不随窗口关闭而停止，靠下面三个出口收尾。
 *
 * 3) 必然还原。系统代理被改过，就一定改回去。出口有四个：
 *      a. TTL 到点（默认 3 分钟，用户可选 2/3/5 分钟或不自动停）
 *      b. 用户点顶部的「代理 开」胶囊 / 面板里的停止
 *      c. 本应用退出（before-quit 里同步收尾）
 *      d. python 侧守护发现父进程消失 → 自己还原并退出（防本进程被强杀）
 *
 * 4) 启动前先自愈。
 *    如果上次异常残留了 previous.json（系统代理还指着代理），
 *    先把它还原掉，再启动新的。否则设置会一层压一层，越叠越乱。
 */

const { shell, Notification, BrowserWindow } = require("electron");
const { spawn, execFile } = require("child_process");
const path = require("path");
const fs = require("fs");
const http = require("http");
const net = require("net");

// ---- 路径（P0-1）----
// 代码目录（只读）与数据目录（可写）必须分开：打包后程序在 Program Files，
// 那里写不进证书和状态。Python 侧通过 QRSCAN_PROXY_DATA 得到同一个数据目录。
const paths = require("./paths");
const settings = require("./settings");

const PROXY_DIR = paths.proxyDir();                 // 只读：*.py
const PROXY_DATA = paths.proxyDataDir();            // 可写：certs/ state.json 日志
const RUN_PY = path.join(PROXY_DIR, "run_proxy.py");
const PREV_FILE = path.join(PROXY_DATA, "previous.json");
const MANAGER_LOG = path.join(PROXY_DATA, "manager.log");
// python 侧失败退出时写下的一句人话（例如"根证书未能安装：…"）。
// 有了它，"启动超时或失败"就能换成真正的原因。
const EXIT_FILE = path.join(PROXY_DATA, "last_exit.json");
// 首选端口。8888 是 Fiddler/Charles 的默认端口，开发者机器上很可能被占，
// 所以下面每次启动都会先探测空闲端口，占不到就顺延（P1-A）。
const DEFAULT_PORT = 8888;
const DEFAULT_ADMIN_PORT = 8899;
const ADMIN_URL = `http://127.0.0.1:${DEFAULT_ADMIN_PORT}`;
const DEFAULT_TTL = 180;

try { paths.ensureProxyDataDir(); } catch (_) {}

/**
 * Python 子进程的环境变量。
 * QRSCAN_PROXY_DATA 决定证书/状态/日志落到哪；
 * QRSCAN_PROXY_LOG 决定请求日志记多细（off / host / full，默认 off）。
 * 两者都在 Python 侧读取，Node 这边只有这一个入口，避免两处各写一份。
 */
function pyEnv() {
  const logMode = settings.get().proxyLog || "off";
  return Object.assign({}, process.env, {
    QRSCAN_PROXY_DATA: PROXY_DATA,
    QRSCAN_PROXY_LOG: logMode,
    PYTHONIOENCODING: "utf-8",
  });
}

const state = {
  proc: null,
  starting: null,
  mode: "android",
  globalProxy: false,
  startedAt: 0,
  deadline: 0,     // 0 = 不自动停
  ttlSec: DEFAULT_TTL,
  stats: null,
  error: null,
  tickTimer: null,
  warnTimer: null,
  warnedEmpty: false,
  // 管理口地址：端口是每次启动现挑的（P1-A），所以不能再写常量。
  // 所有 /status /quit 都走它，stop() 与轮询用同一个值。
  adminUrl: ADMIN_URL,
  // 本次启动的范围（只接管目标站时是具体域名；全量时 scopeAll=true）
  scopeAll: true,
  scopeHosts: []
};

// 代理"彻底收尾"时回调一次（正常停止 / 进程自己退出都算）。
// 主进程用它来决定"代理跑完再退出"，避免关窗就把正在进行中的授权流程打断。
let emptyHook = null;
function onEmpty(cb) { emptyHook = cb; }
function fireEmpty() {
  if (!emptyHook) return;
  try { emptyHook(); } catch (_) {}
}

// ---------------------------------------------------------------- 基础设施

function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

function logLine(msg) {
  try {
    fs.appendFileSync(MANAGER_LOG, `[${new Date().toISOString()}] ${msg}\n`, "utf8");
  } catch (_) {}
}

function broadcast(type, payload) {
  // 发给所有窗口：取景框关掉之后，主窗口也要能显示倒计时和一键关闭。
  const msg = Object.assign({ type }, payload || {});
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win || win.isDestroyed()) continue;
    try { win.webContents.send("qr:proxy-event", msg); } catch (_) {}
  }
  // 托盘菜单上的"移动端环境"状态跟着变
  if (type === "started" || type === "stopped" || type === "healed") fireChange();
}

// 代理解析状态变化的外部订阅（主进程用它刷新托盘菜单）
let changeHook = null;
function onChange(cb) { changeHook = cb; }
function fireChange() {
  if (!changeHook) return;
  try { changeHook(); } catch (_) {}
}

function notify(title, body) {
  try {
    if (!Notification.isSupported()) return;
    new Notification({ title, body, silent: false }).show();
  } catch (_) {}
}

function httpGet(url, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const req = http.get(url, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (d) => { if (body.length < 2e6) body += d; });
      res.on("end", () => finish({ code: res.statusCode || 0, body }));
      res.on("error", () => finish({ code: 0, body: "" }));
    });
    req.setTimeout(timeoutMs || 900, () => { req.destroy(); finish({ code: 0, body: "" }); });
    req.on("error", () => finish({ code: 0, body: "" }));
  });
}

async function adminStatus() {
  const r = await httpGet(state.adminUrl + "/status", 900);
  if (r.code !== 200 || !r.body) return null;
  try {
    const j = JSON.parse(r.body);
    return j && j.ok ? j : null;
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------- 端口探测

/**
 * 端口能不能绑（在 127.0.0.1 上试）。
 *
 * 只测"我能不能绑"，不测"有没有人连"：监听中的端口 bind 会报 EADDRINUSE，
 * TIME_WAIT 的端口用 SO_REUSEADDR 语义（Node 默认）能绑上，这两种都符合预期。
 */
function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    srv.once("error", () => finish(false));
    srv.once("listening", () => srv.close(() => finish(true)));
    try { srv.listen(port, "127.0.0.1"); } catch (_) { finish(false); }
  });
}

/**
 * 从 prefer 开始找一个能用的端口。
 *
 * 顺延最多 20 个；全被占（几乎不可能）就让系统随便给一个（listen 0），
 * 避免因为端口把整个功能钉死 —— 这正是 P1-A 的问题：以前写死 8888/8899，
 * 装了 Fiddler 的人一台机器上就永远用不了「手机环境」。
 */
async function findFreePort(prefer, avoid) {
  const skip = new Set(avoid || []);
  for (let p = prefer; p < prefer + 20; p++) {
    if (skip.has(p)) continue;
    if (await portFree(p)) return p;
  }
  return await new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(prefer));
    srv.listen(0, "127.0.0.1", () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

/**
 * 读 python 侧留下的"失败原因"。
 * 只认 90 秒内写下的：否则重启应用后，上一次的旧错误会被当成本次的原因，
 * 用户会看到一个早已解决的问题。读不到/过期都返回 null，走通用文案。
 */
function lastExit() {
  try {
    const j = JSON.parse(fs.readFileSync(EXIT_FILE, "utf8"));
    if (!j || typeof j !== "object" || !j.error) return null;
    const t = Date.parse(j.time || "");
    if (!Number.isFinite(t) || Date.now() - t > 90000) return null;
    return j;
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------- python 探测

let pyCache = null;

function detectPython() {
  if (pyCache) return Promise.resolve(pyCache);
  const cands = [];
  // 顺序即优先级：
  //   1. QRSCAN_PYTHON —— 显式指定，用于排查（比如怀疑内置运行时有问题）
  //   2. **内置运行时** —— 发行包自带，普通用户机器上只有这一条能成
  //   3. 系统 Python  —— 开发态没跑 fetch-runtime 时用，也方便改脚本后直接调试
  if (process.env.QRSCAN_PYTHON) cands.push([process.env.QRSCAN_PYTHON, []]);
  const bundled = paths.runtimePython();
  if (bundled) cands.push([bundled, [], true]);
  // py 启动器优先：Windows 上裸 python 有可能命中应用商店的占位程序，会弹窗
  cands.push(["py", ["-3"]], ["python", []], ["python3", []]);

  return new Promise((resolve) => {
    let i = 0;
    const next = () => {
      if (i >= cands.length) return resolve(null);
      const [cmd, pre, isBundled] = cands[i++];
      execFile(cmd, [...pre, "-c", "print(1)"], { windowsHide: true, timeout: 6000 }, (err) => {
        if (err) return next();
        pyCache = { cmd, pre, bundled: !!isBundled };
        logLine(`[python] 使用 ${cmd} ${pre.join(" ")}`.trim() + (isBundled ? "（内置）" : "（系统）"));
        resolve(pyCache);
      });
    };
    next();
  });
}

/**
 * 运行环境自检。
 *
 * 历史上「手机环境」依赖两样非系统自带的东西：Python 3.8+ 与 openssl。
 * 现在两样都不再需要外部安装：
 *   - Python：发行包内置官方 embeddable 运行时（vendor/python）；
 *   - 证书签发：改用纯 Python 实现（proxy/certgen.py），不再调 openssl。
 *
 * 所以这里的 ok 判据只剩"能不能跑起内置运行时"。仍然探测 openssl 只是
 * 为了在日志里留一条信息（排查老机器时有用），它不再影响可用性。
 */
async function checkEnv() {
  const py = await detectPython();
  if (!py) {
    return {
      ok: false,
      python: { ok: false },
      certBackend: "native",
      hint: "未找到可用的 Python 运行时。发行版应自带 vendor\\python；" +
        "若被安全软件隔离，请恢复该目录后重试，或安装 Python 3.8+ 作为替代。",
    };
  }

  const runPy = (code) => new Promise((resolve) => {
    execFile(py.cmd, [...py.pre, "-c", code], {
      cwd: PROXY_DIR, windowsHide: true, timeout: 8000, env: pyEnv(),
    }, (err, stdout) => resolve(err ? "" : String(stdout || "").trim()));
  });

  const ver = await runPy("import sys;print('%d.%d.%d' % sys.version_info[:3])");
  // 证书后端自检：真的 import 一次，确认 certgen 随包带上了、能跑
  const certOk = await runPy(
    "import sys,os;sys.path.insert(0,os.getcwd());import certs,certgen;print('CERTOK')"
  );
  // openssl 仅作信息展示；找不到也不再是问题
  const sslPath = await runPy(
    "import sys,os;sys.path.insert(0,os.getcwd());import certs;print(certs.find_openssl() or '')"
  );

  const pyOk = !!ver && !/^0\./.test(ver);
  const missing = [];
  if (!pyOk) missing.push("Python 运行时");
  if (certOk !== "CERTOK") missing.push("证书模块");

  return {
    ok: pyOk && certOk === "CERTOK",
    python: {
      ok: pyOk,
      cmd: (py.pre.length ? py.cmd + " " + py.pre.join(" ") : py.cmd),
      version: ver,
      bundled: !!py.bundled,
    },
    certBackend: "native",
    openssl: { ok: !!sslPath, path: sslPath },
    hint: (pyOk && certOk === "CERTOK") ? "" :
      ("缺少 " + missing.join(" 与 ") + "，手机环境不可用；扫码等其它功能不受影响。"),
  };
}

function runRestore(py) {  // 幂等：没有 previous.json 时 python 侧会直接返回"没有需要还原的设置"
  return new Promise((resolve) => {
    execFile(
      py.cmd,
      [...py.pre, RUN_PY, "--restore"],
      { cwd: PROXY_DIR, windowsHide: true, timeout: 25000, env: pyEnv() },
      (err, stdout) => {
        logLine(`[restore] ${err ? "失败 " + err.message : (stdout || "").trim()}`);
        resolve(!err);
      }
    );
  });
}

function waitExit(proc, ms) {
  if (!proc || proc.exitCode !== null || proc.signalCode) return Promise.resolve(true);
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    proc.once("exit", () => finish(true));
    setTimeout(() => finish(false), ms);
  });
}

// ---------------------------------------------------------------- 范围（scope）

/**
 * 从一段任意文本（通常是扫码解码结果）里提取第一个 http(s) 链接。
 *
 * 二维码内容未必是纯 URL——"登录链接：https://a.com/x"、带说明文字的
 * 票务码都很常见。直接 `new URL(整段文本)` 会 throw，然后静默退回全量，
 * 收窄就失效了；先提取一次，命中率和鲁棒性都好得多。字符集排除空白、
 * 引号、括号与中英文逗号分号，避免把后随的说明文字或第二个链接包进来。
 */
function extractHttpUrl(text) {
  const s = String(text || "").trim();
  if (/^https?:\/\//i.test(s)) return s.split(/[\s"'<>()\[\]{}，；,;]/)[0] || s;
  const m = s.match(/https?:\/\/[^\s"'<>()\[\]{}，；,;]+/i);
  return m ? m[0] : "";
}

/**
 * 两段式公共后缀的判定：倒数第二段是这些"类别词"时（com.cn / co.jp /
 * org.nz / com.tr …），后两段是注册局后缀而不是某公司的注册域。
 *
 * 用类别词规则而不是硬编码一份后缀清单——凡是 `*.com.xx` / `*.co.xx` /
 * `*.org.xx` 形态的国家后缀天然覆盖，新增 TLD 不需要改代码（漏判的后果
 * 是把 `com.tr` 当注册域收进 scope = 多代理一批站，保守方向；误判的反
 * 向后果是"少代理一个真实存在的 com.xx 域"，靠运行期 302 学习兜底）。
 */
const SUFFIX_CATEGORY = new Set(["com", "net", "org", "gov", "edu", "ac", "co"]);

/**
 * 从一条链接（或含链接的文本）算出"要接管哪些域"。
 *
 * 只给目标域本身是不够的：扫码登录经常把 `<tenant>.zhiye.com` 跳到 `zhiye.com` 的
 * 另一个子域，所以按"从最具体到最宽"返回最多 3 级，让 PAC 的
 * `host === e || host.endswith("." + e)` 一并覆盖。
 *
 * 注意：**跨站跳转**（a 站 → b 站）算不出来，靠运行期学习补
 * （见 mit_proxy.push_scope 与 run_proxy.add_scope）。
 */
function scopeHosts(text) {
  const url = extractHttpUrl(text);
  if (!url) return [];
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase().replace(/\.$/, "");
  } catch (_) {
    return [];
  }
  if (!host) return [];
  if (host.includes(":")) return [host];                       // IPv6
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return [host];     // IPv4
  const parts = host.split(".").filter(Boolean);
  const out = [];
  for (let i = 0; i <= parts.length - 2; i++) {
    const h = parts.slice(i).join(".");
    if (parts.length - i === 2 && SUFFIX_CATEGORY.has(parts[i])) continue;
    out.push(h);
  }
  return out.slice(-3);
}

// ---------------------------------------------------------------- 状态输出

function remainSec() {
  if (!state.deadline) return 0;
  return Math.max(0, Math.round((state.deadline - Date.now()) / 1000));
}

/**
 * 时长的自然语言写法。
 * 不能在通知里一律 `Math.round(ttl / 60)`：10 秒档会变成"0 分钟后自动关闭"，
 * 用户会以为这个开关坏了（P2-A）。
 */
function fmtDuration(sec) {
  sec = Math.max(0, Math.round(Number(sec) || 0));
  if (sec === 0) return "";
  if (sec < 60) return `${sec} 秒`;
  if (sec % 60 === 0) return `${sec / 60} 分钟`;
  return `${Math.floor(sec / 60)} 分 ${sec % 60} 秒`;
}

async function getStatus() {
  const st = await adminStatus();
  return {
    running: !!(st && st.ready),
    active: isActive(),
    mode: (st && st.ua_mode) || state.mode,
    globalProxy: state.globalProxy,
    systemProxy: !!(st && st.system_proxy),
    remainSec: remainSec(),
    ttlSec: state.ttlSec,
    // 范围：全量 or 只接管 N 个域（含运行期学到的跳转域），界面据此说明影响面
    scopeAll: st ? !!st.proxy_all : state.scopeAll,
    scopeCount: st ? Number(st.scope_count) || 0 : state.scopeHosts.length,
    stats: (st && st.stats) || state.stats || null,
    error: state.error
  };
}

function isActive() {
  return !!state.proc || fs.existsSync(PREV_FILE);
}

// ---------------------------------------------------------------- 计时器

function clearTimers() {
  if (state.tickTimer) { clearInterval(state.tickTimer); state.tickTimer = null; }
  if (state.warnTimer) { clearTimeout(state.warnTimer); state.warnTimer = null; }
}

function startTimers() {
  clearTimers();
  state.warnedEmpty = false;
  let ticking = false;

  state.tickTimer = setInterval(async () => {
    if (ticking) return;           // 上一次还没回来就跳过，避免请求堆叠
    ticking = true;
    try {
      const left = remainSec();
      if (state.deadline && left <= 0) {
        await stop("ttl");
        return;
      }
      const st = await adminStatus();
      if (st) state.stats = st.stats || state.stats;
      // tick 是每秒一次的界面刷新源，必须带上范围字段：
      // 否则 launcher 收到的只有 remainSec，渲染时会退化成"只接管 0 个域名"
      // （scopeAll/scopeCount 缺失 → falsy），与实际模式完全无关地误导用户。
      broadcast("tick", {
        remainSec: left,
        ttlSec: state.ttlSec,
        stats: state.stats,
        scopeAll: st ? !!st.proxy_all : state.scopeAll,
        scopeCount: st ? Number(st.scope_count) || 0 : state.scopeHosts.length
      });
      if (!st && state.proc) {
        // 代理进程意外消失（崩了 / 被杀了）。
        // 这时候系统代理可能还指着 127.0.0.1:8888，用户会整台上不了网，
        // 所以第一件事是还原，而不是只弹个错误。
        const gone = state.proc.exitCode !== null || state.proc.killed;
        if (gone || !st) {
          state.error = "代理进程已退出，系统代理已自动还原";
          state.proc = null;
          clearTimers();
          const py = await detectPython();
          if (py && fs.existsSync(PREV_FILE)) await runRestore(py);
          broadcast("stopped", { reason: "crash" });
          notify("移动端环境已关闭", "代理进程意外退出，系统代理已自动还原。");
        }
      }
    } finally {
      ticking = false;
    }
  }, 1000);

  // 12 秒后仍没有任何请求被改写 → 说明目标程序没走系统代理，提示用户换兼容模式
  state.warnTimer = setTimeout(async () => {
    if (!isActive() || state.warnedEmpty) return;
    const st = await adminStatus();
    const n = st && st.stats ? Number(st.stats.rewritten) || 0 : 0;
    if (n === 0) {
      state.warnedEmpty = true;
      broadcast("stalled", {});
    }
  }, 12000);
}

// ---------------------------------------------------------------- 启动前自愈

/**
 * 应用启动时静默检查一次：上次是不是留下了"系统代理还指着代理"的状态。
 * 只在「没有活着的代理实例」时才动，避免误伤用户手动用 bat 起的代理。
 */
async function heal() {
  if (state.proc) return false;
  const st = await adminStatus();
  if (st) return false;                       // 有活着的实例，不碰
  if (!fs.existsSync(PREV_FILE)) return false;

  logLine("[heal] 发现上次残留的系统代理设置，尝试还原");
  const py = await detectPython();
  if (!py) return false;
  const ok = await runRestore(py);
  if (ok) broadcast("healed", {});
  return ok;
}

// ---------------------------------------------------------------- 启动

async function start(opts) {
  opts = opts || {};
  const mode = opts.mode === "iphone" ? "iphone" : "android";
  let ttl = Number(opts.ttlSec);
  if (!Number.isFinite(ttl)) ttl = DEFAULT_TTL;
  ttl = Math.max(0, Math.round(ttl));
  const globalProxy = !!opts.globalProxy;

  // ---- 范围（P1-C）----
  // 默认只接管"要打开的那条链接所在的站"。三种情况都退回全量：
  //   ① 设置里选了「全部站点」；
  //   ② 用了全局代理（ProxyOverride 做不了按域收窄，只能全量）；
  //   ③ 算不出域名（不是 http(s) 链接、或只有 localhost/IP 的极端情况）。
  // 退回时要留日志，否则排查"为什么这次没按预期收窄"会很难。
  const wantAll = opts.scopeAll === true || settings.get().proxyScope === "all";
  const hosts = (wantAll || globalProxy) ? [] : scopeHosts(opts.scopeUrl || "");
  const scopeAll = wantAll || globalProxy || hosts.length === 0;
  if (!scopeAll && hosts.length) {
    logLine(`[scope] 只接管 ${hosts.join(", ")}（目标: ${opts.scopeUrl}）`);
  } else if (wantAll || globalProxy) {
    logLine(`[scope] 全量接管（原因: ${globalProxy ? "全局代理" : "设置为全部站点"}）`);
  } else {
    logLine("[scope] 算不出目标域名，退回全量接管");
  }

  // 并发调用（连点两下按钮）时直接复用同一个启动过程，别把正在起的实例杀掉
  if (state.starting) return state.starting;

  // 已经在跑：配置一致就复用，避免重复起进程又叠一层系统代理。
  // 范围也算"配置"：换个目标站再点一次，必须重启代理（否则 scope 还是上一个站的）。
  if (state.proc) {
    const st = await adminStatus();
    const covered = !!st && (
      scopeAll ? !!st.proxy_all
        : (!st.proxy_all && hosts.every((h) => (st.scope || []).indexOf(h) >= 0))
    );
    if (st && st.ready && st.ua_mode === mode && covered) {
      if (ttl > 0) {
        state.ttlSec = ttl;
        state.deadline = Date.now() + ttl * 1000;
      }
      broadcast("started", { reused: true, ...(await getStatus()) });
      return { ok: true, reused: true, mode, remainSec: remainSec() };
    }
    await stop("restart");
  }


  state.starting = (async () => {
    state.error = null;
    const py = await detectPython();
    if (!py) {
      state.error = "未找到可用的 Python 运行时（发行包应自带 vendor\\python；" +
        "若被安全软件隔离，请恢复该目录后重试）";
      return { ok: false, error: state.error };
    }
    if (!fs.existsSync(RUN_PY)) {
      state.error = "缺少 proxy/run_proxy.py";
      return { ok: false, error: state.error };
    }

    // 上次残留的实例：先让它自己退（会顺手还原系统代理）
    const stale = await adminStatus();
    if (stale) {
      logLine("[start] 发现残留实例，先收尾");
      await httpGet(state.adminUrl + "/quit", 1500);
      await delay(900);
    }
    if (fs.existsSync(PREV_FILE)) {
      logLine("[start] 发现残留的 previous.json，先还原系统代理");
      await runRestore(py);
    }

    // 挑两个空闲端口（管理口不能与代理口撞）。挑完立刻写进 state，
    // 后面轮询 /status 用的就是新地址。
    const port = await findFreePort(DEFAULT_PORT);
    const adminPort = await findFreePort(DEFAULT_ADMIN_PORT, [port]);
    state.adminUrl = `http://127.0.0.1:${adminPort}`;
    if (port !== DEFAULT_PORT || adminPort !== DEFAULT_ADMIN_PORT) {
      logLine(`[start] 端口顺延：proxy=${port} admin=${adminPort}` +
        `（默认 ${DEFAULT_PORT}/${DEFAULT_ADMIN_PORT} 被占用）`);
    }

    const args = [
      ...py.pre, RUN_PY,
      "--mode", mode,
      // 端口每次现挑：8888/8899 被 Fiddler 之类占着时不再整体失败（P1-A）
      "--port", String(port),
      "--admin-port", String(adminPort),
      "--parent-pid", String(process.pid)
    ];
    // 传空字符串 = 全量（run_proxy 里 `proxy_all = not args.scope`）
    if (hosts.length) args.push("--scope", hosts.join(","));
    if (globalProxy) args.push("--global-proxy");
    if (ttl > 0) args.push("--ttl", String(ttl));

    let fd = null;
    try { fd = fs.openSync(MANAGER_LOG, "a"); } catch (_) {}
    const proc = spawn(py.cmd, args, {
      cwd: PROXY_DIR,
      windowsHide: true,
      detached: false,
      env: pyEnv(),
      stdio: fd === null ? "ignore" : ["ignore", fd, fd]
    });
    if (fd !== null) { try { fs.closeSync(fd); } catch (_) {} }

    proc.on("exit", (code) => {
      logLine(`[proc] 退出 code=${code}`);
      if (state.proc === proc) {
        state.proc = null;
        clearTimers();
        broadcast("stopped", { reason: "exit", code });
        // 进程异常退出后仍可能残留系统代理，做一次兜底还原
        if (fs.existsSync(PREV_FILE)) runRestore(py).then(fireEmpty);
        else fireEmpty();
      }
    });
    proc.on("error", (err) => {
      logLine("[proc] spawn error: " + err.message);
      state.error = "无法启动代理进程：" + err.message;
    });

    state.proc = proc;

    // 首次启动要现签 CA，给足 15 秒。
    // 注意不能只看端口通：管理端口比"系统代理真正设好"更早就绪，
    // 必须等到 ready 才把链接交出去，否则会抢跑。
    let st = null;
    for (let i = 0; i < 60; i++) {
      await delay(250);
      st = await adminStatus();
      if (st && st.ready) break;
      if (proc.exitCode !== null) { st = null; break; }
    }
    if (!st || !st.ready) {
      // 失败原因优先取 python 写下的那一句（例如根证书装不上）。
      // 拿不到才回落到通用文案 —— 通用文案对用户几乎没有信息量。
      const ex = lastExit();
      state.error = (ex && ex.error) || "代理启动超时或失败，详见 proxy/manager.log";
      logLine(`[start] 失败 code=${ex ? ex.code : "?"} ${state.error}`);
      try { proc.kill(); } catch (_) {}
      state.proc = null;
      state.adminUrl = ADMIN_URL;
      // 启动失败也要保证系统代理是干净的（python 侧已还原，这里再兜一层）
      if (fs.existsSync(PREV_FILE)) await runRestore(py);
      return { ok: false, error: state.error };
    }

    state.mode = mode;
    state.globalProxy = globalProxy;
    state.scopeAll = scopeAll;
    state.scopeHosts = hosts.slice();
    state.startedAt = Date.now();
    state.ttlSec = ttl;
    state.deadline = ttl > 0 ? Date.now() + ttl * 1000 : 0;
    state.stats = st.stats || null;
    startTimers();

    const modeName = mode === "android" ? "Android 微信" : "iPhone 微信";
    logLine(`[start] 已启用 ${modeName} · ttl=${ttl}s · global=${globalProxy}` +
      ` · scope=${scopeAll ? "all" : hosts.join("|")}`);
    // 通知里点明范围：用户最该知道的就是"这次代理影响多大"
    const scopeTip = scopeAll ? "" : `（只接管 ${hosts[hosts.length - 1]}）`;
    notify("移动端环境已启用",
      `${modeName} UA 改写中${scopeTip}` +
      `${ttl > 0 ? `，${fmtDuration(ttl)}后自动关闭` : "，需手动关闭"}。`);
    broadcast("started", await getStatus());

    return { ok: true, mode, ttlSec: ttl, remainSec: remainSec() };
  })();

  try {
    return await state.starting;
  } finally {
    state.starting = null;
  }
}

// ---------------------------------------------------------------- 停止

async function stop(reason) {
  reason = reason || "user";
  clearTimers();

  if (!isActive()) {
    state.proc = null;
    broadcast("stopped", { reason });
    fireEmpty();
    return { ok: true, noop: true };
  }

  logLine(`[stop] reason=${reason}`);

  // 让 python 自己退（它会在 finally 里还原系统代理）。
  // 注意用的是本次启动挑到的管理口，不是默认 8899（P1-A）。
  await httpGet(state.adminUrl + "/quit", 1500);
  const exited = await waitExit(state.proc, 4500);
  if (!exited && state.proc) {
    try { state.proc.kill(); } catch (_) {}
    await waitExit(state.proc, 1500);
  }
  state.proc = null;
  state.adminUrl = ADMIN_URL;   // 下一次启动重新挑

  // 兜底：不管它是怎么死的，只要 previous.json 还在，就一定还原
  if (fs.existsSync(PREV_FILE)) {
    const py = await detectPython();
    if (py) await runRestore(py);
  }

  state.deadline = 0;
  state.stats = null;
  broadcast("stopped", { reason });
  if (reason === "ttl") {
    notify("移动端环境已关闭", "已到时间，系统代理已自动还原。");
  }
  fireEmpty();
  return { ok: true };
}

// ---------------------------------------------------------------- 打开链接

/**
 * 只做"把链接交出去"，不决定用什么程序打开。
 * 打开方式（微信内置浏览器 / 默认浏览器）由调用方决定，因为两者的
 * UA 链路完全不同：必须微信内置浏览器才能拿到微信身份。
 */
async function openExternal(url) {
  if (typeof url !== "string") return false;
  if (!/^https?:\/\//i.test(url)) return false;
  await shell.openExternal(url);
  return true;
}

module.exports = {
  onEmpty,
  onChange,
  isActive,
  start,
  stop,
  heal,
  getStatus,
  openExternal,
  checkEnv,
  DEFAULT_TTL
};

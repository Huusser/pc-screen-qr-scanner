"use strict";

/**
 * PC 屏幕框选扫码 · 桌面版 M0
 * 主进程：全局热键 / 覆盖层窗口 / 屏幕捕获 / 剪贴板
 */

const {
  app, BrowserWindow, globalShortcut, screen, desktopCapturer,
  ipcMain, clipboard, shell, nativeImage, Tray, Menu, Notification
} = require("electron");
const path = require("path");
const fs = require("fs");
const net = require("net");
const { execFile, spawn } = require("child_process");
const proxyMgr = require("./proxy-manager");
const settings = require("./settings");
// 可写状态的唯一出口：%APPDATA%\ScreenQR（见 paths.js 头部说明）。
// 必须在 settings.init() 之前跑迁移，否则老用户的 settings.json 读不到。
const paths = require("./paths");
try { paths.migrate(); } catch (_) {}
const audioImport = require("./audio-import");
const wechatAuto = require("./wechat-auto");
// ---- 分段计时（临时诊断设施）----
// 只给「扫码后交给微信」这条链路用，把每段耗时写进 desktop/timing.log。
// 定位完问题要删时：删本行 + 下面 qr:wx-open 里的 T.begin/T.mark/T.finish，
// 以及 wechat-auto.js 里的 T.mark/T.meter，再删 timing.js 本身即可。
const T = require("./timing");

// Windows 通知（代理启用/自动关闭）需要这个，必须在 whenReady 之前设好
try { app.setAppUserModelId("com.qrscan.desktop"); } catch (_) {}

const HOTKEY_DEFAULT = "Alt+Shift+Q";
const SELFTEST = process.argv.includes("--selftest");
const ENVCHECK = process.argv.includes("--envcheck");
const UITEST = process.argv.includes("--uitest");
const SNDTEST = process.argv.includes("--sndtest");
const WXTEST = process.argv.includes("--wxtest");

// ---------------------------------------------------------------- 窗口尺寸
//
// 窗口可以自由拖四条边和四个角。上下限都写在这里，改这里就是改所有地方：
//   · 下限 400×460：再窄状态卡会挤成一条缝、设置页的分段控件会折行
//   · 上限 = 当前显示器工作区：留着空白比截断更糟，所以"最大"就是铺满屏幕；
//     内容本身还有 680px 的 max-width，窗口再宽也只会在两侧留黑，不会拉伸变形。
const WIN_MIN = { width: 400, height: 460 };
const CONTENT_MAX_WIDTH = 680;   // 必须和 launcher.html 里的 .shell max-width 一致

// 关取景框之后「等它真的消失」的上限与轮询步长（第三批 H1）。
// 上限 340ms 就是原来的固定等待，所以轮询失效时行为不会比原来更差；
// 步长 30ms 是因为窗口销毁通常几十毫秒内就完成，没必要一觉睡到底。
const OVERLAY_CLOSE_MS = 340;
const OVERLAY_CLOSE_STEP_MS = 30;

let currentHotkey = HOTKEY_DEFAULT;
let hotkeyHandle = null;
let tray = null;
let quitting = false;


// 用 start.bat 双击启动时进程是脱离的，崩溃信息不会留在控制台。
// 这里把未捕获异常落盘，出问题可以直接看 crash.log。
const CRASH_LOG = paths.file("crash.log");
function logCrash(kind, err) {
  try {
    const line = `[${new Date().toISOString()}] ${kind}\n${(err && err.stack) || err}\n\n`;
    fs.appendFileSync(CRASH_LOG, line, "utf8");
  } catch (_) {}
  console.error(`[qrscan] ${kind}:`, err);
}
process.on("uncaughtException", (err) => logCrash("uncaughtException", err));
process.on("unhandledRejection", (err) => logCrash("unhandledRejection", err));

// 启动各阶段的落盘标记：Windows 上 Electron 是 GUI 子系统，
// console.log 不会进任何日志，出问题只能靠这个文件定位卡在哪一步。
const BOOT_LOG = paths.file("boot.log");
function bootLog(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try {
    // 超过 64KB 就重置，避免长期使用把日志堆成几兆
    const st = fs.existsSync(BOOT_LOG) ? fs.statSync(BOOT_LOG) : null;
    if (st && st.size > 64 * 1024) fs.writeFileSync(BOOT_LOG, line, "utf8");
    else fs.appendFileSync(BOOT_LOG, line, "utf8");
  } catch (_) {}
  console.log("[boot]", msg);
}

let launcher = null;
let overlay = null;
let targetDisplay = null;

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// 自检/自动化测试是独立进程，不能被正在运行的主实例挡掉（否则会静默退出、不产出结果）
// 自测模式不抢单实例锁：否则用户正开着主程序时，测试进程会立刻退出，
// 表现为"跑了但什么也没发生"（这个坑踩过一次，很难看出来）
if (!SELFTEST && !ENVCHECK && !UITEST && !SNDTEST && !WXTEST &&
    !process.argv.some((a) => a.indexOf("--shot") === 0) &&
    !app.requestSingleInstanceLock()) {
  app.quit();
}

app.on("second-instance", () => {
  if (overlay) { overlay.focus(); return; }
  if (launcher) { launcher.show(); launcher.focus(); }
});

// ---------- 屏幕捕获 ----------

async function captureDisplay(display) {
  const d = display || screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const sf = d.scaleFactor || 1;
  const wantW = Math.round(d.size.width * sf);
  const wantH = Math.round(d.size.height * sf);

  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: { width: wantW, height: wantH },
    fetchWindowIcons: false
  });

  if (!sources || !sources.length) throw new Error("没有可用的屏幕捕获源");

  let src = sources.find((s) => String(s.display_id) === String(d.id));
  if (!src) src = sources[0];

  const dataUrl = src.thumbnail.toDataURL();
  const size = src.thumbnail.getSize();

  return {
    dataUrl,
    width: size.width,
    height: size.height,
    scaleFactor: sf,
    display: { id: d.id, bounds: d.bounds, size: d.size, scaleFactor: sf }
  };
}

// ---------- 窗口 ----------

// 上限跟着显示器走：把窗口拖到副屏时，上限要换成副屏的工作区，
// 否则在 1920 的屏上定好的上限会把 2560 的窗口卡住。
function maxSizeFor(win) {
  try {
    const d = screen.getDisplayMatching(win.getBounds());
    return {
      width: Math.max(WIN_MIN.width, d.workAreaSize.width),
      height: Math.max(WIN_MIN.height, d.workAreaSize.height)
    };
  } catch (_) {
    const d = screen.getPrimaryDisplay();
    return { width: d.workAreaSize.width, height: d.workAreaSize.height };
  }
}

function applySizeLimits(win) {
  if (!win || win.isDestroyed()) return;
  const max = maxSizeFor(win);
  win.setMinimumSize(WIN_MIN.width, WIN_MIN.height);
  // 最大化时不要被上限卡住：上限本身就是工作区，正好等于最大化尺寸
  win.setMaximumSize(Math.max(WIN_MIN.width, max.width), Math.max(WIN_MIN.height, max.height));
}

function broadcastWinState(win) {
  if (!win || win.isDestroyed()) return;
  try {
    win.webContents.send("qr:win-state", {
      maximized: win.isMaximized(),
      fullscreen: win.isFullScreen()
    });
  } catch (_) {}
}

function createLauncher() {
  const st = settings.get();

  launcher = new BrowserWindow({
    width: Math.max(WIN_MIN.width, 442),
    height: Math.max(WIN_MIN.height, 500),
    minWidth: WIN_MIN.width,
    minHeight: WIN_MIN.height,
    // 无边框 + 自绘标题栏：默认的系统边框和深色界面拼在一起很割裂，
    // 圆角、拖拽、关闭/最小化/最大化都交给页面自己做（见 launcher.html 的 #titlebar）。
    // 注意 resizable 必须为 true —— frame:false 时靠它才会在四条边和四个角
    // 留出系统的缩放热区（Windows 默认 thickFrame 打开）。
    frame: false,
    resizable: true,
    maximizable: true,
    minimizable: true,
    fullscreenable: false,
    backgroundColor: "#0c1017",
    title: "屏幕扫码",
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  applySizeLimits(launcher);
  launcher.setAlwaysOnTop(!!st.alwaysOnTop);
  launcher.loadFile(path.join(__dirname, "launcher.html"));
  launcher.once("ready-to-show", () => { launcher.show(); });

  // 最大化状态要同步给页面，否则图标（最大化/还原）会和真实状态对不上
  const syncState = () => broadcastWinState(launcher);
  ["maximize", "unmaximize", "enter-full-screen", "leave-full-screen", "restore"].forEach((ev) => {
    launcher.on(ev, syncState);
  });
  launcher.webContents.on("did-finish-load", syncState);

  // 拖到另一块屏幕后重新算上限
  let lastDisplayId = null;
  launcher.on("moved", () => {
    try {
      const d = screen.getDisplayMatching(launcher.getBounds());
      if (d.id !== lastDisplayId) { lastDisplayId = d.id; applySizeLimits(launcher); }
    } catch (_) {}
  });

  // 关软件 = 关代理。用户明确要求不能出现"窗口关了、系统代理还指着 127.0.0.1"
  // 的状态（那会让整台机器上不了网）。所以在真正关闭之前问一句，
  // 确认后先把系统代理还原干净，再退进程。
  launcher.on("close", (e) => {
    if (quitting) return;

    // 「收到托盘」不是关闭，进程和代理都还活着，只是窗口藏起来。
    // 但一定要说清楚，否则用户会以为软件已经退了、代理却没关。
    if (settings.get().closeAction === "tray" && tray) {
      e.preventDefault();
      launcher.hide();
      if (proxyMgr.isActive()) {
        try {
          new Notification({
            title: "程序仍在托盘运行",
            body: "移动端环境还在生效，点托盘图标可回到主界面或停止它。"
          }).show();
        } catch (_) {}
      }
      return;
    }

    if (!proxyMgr.isActive()) return;
    const { dialog } = require("electron");
    const r = dialog.showMessageBoxSync(launcher, {
      type: "warning",
      buttons: ["关闭并还原系统代理", "取消"],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
      title: "移动端环境仍在生效",
      message: "关闭软件会立即还原系统代理",
      detail:
        "如果微信里还在走授权流程，建议先点「取消」，等流程走完（或等倒计时结束）再关闭。\n" +
        "选择关闭后，系统代理会马上恢复原样，不会留下任何残留。"
    });
    if (r === 1) {
      e.preventDefault();
      return;
    }
    e.preventDefault();
    quitting = true;
    proxyMgr.stop("app-quit").catch(() => {}).then(() => app.quit());
  });

  launcher.on("closed", () => { launcher = null; });

  // 只在截图模式下把渲染进程的报错打到控制台，方便改界面时立刻发现 JS 挂了
  if (SHOT_DIR) {
    launcher.webContents.on("console-message", (_e, level, message, line, sourceId) => {
      if (level >= 2) console.log("[renderer]", level, message, `${sourceId}:${line}`);
    });
    launcher.webContents.on("preload-error", (_e, p, err) => {
      console.log("[preload-error]", p, err && err.message);
    });
  }
}

function openOverlay() {
  if (overlay) { overlay.focus(); return; }

  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  targetDisplay = display;
  const b = display.bounds;

  overlay = new BrowserWindow({
    x: b.x,
    y: b.y,
    width: b.width,
    height: b.height,
    frame: false,
    transparent: false,
    backgroundColor: "#000000",
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    hasShadow: false,
    show: false,
    enableLargerThanScreen: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      // 取景框是热键从主进程唤起的，窗口里没有任何用户手势。
      // 默认策略下 AudioContext 可能被挂起成 suspended，提示音就静音了 ——
      // 这里显式放开，和 sound.js 里 play 前的 resume() 一起兜底。
      autoplayPolicy: "no-user-gesture-required"
    }
  });

  overlay.setAlwaysOnTop(true, "screen-saver");

  // 关键：把自己从屏幕捕获中排除（Windows 走 WDA_EXCLUDEFROMCAPTURE）。
  // 否则连续模式每次重新截屏都会把覆盖层自己拍进去，形成"框里有框"的递归画面。
  overlay.setContentProtection(true);

  // 某些 Windows 环境会把无边框窗口压到工作区高度，导致覆盖层底部露边、
  // 且截图与窗口比例不一致。这里显式再设一次边界。
  overlay.setBounds({ x: b.x, y: b.y, width: b.width, height: b.height });

  overlay.loadFile(path.join(__dirname, "overlay.html"));

  overlay.on("closed", () => {
    overlay = null;
    if (launcher && !launcher.isDestroyed()) { launcher.show(); launcher.focus(); }
  });

  // 框选期间是否隐藏主窗口是可配置的：有人喜欢留着当"参照"，有人嫌挡路
  if (settings.get().hideLauncher && launcher && !launcher.isDestroyed()) launcher.hide();
}

// ---------- 微信能力探测 ----------

const FAST_LOGIN_PORT = 14013;

function checkTcpPort(port, host, timeoutMs) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs || 1200);
    sock.once("connect", () => done(true));
    sock.once("timeout", () => done(false));
    sock.once("error", () => done(false));
    try {
      sock.connect(port, host);
    } catch (_) {
      done(false);
    }
  });
}

function isProcessRunning(imageName) {
  return new Promise((resolve) => {
    execFile(
      "tasklist",
      ["/FI", `IMAGENAME eq ${imageName}`, "/NH"],
      { windowsHide: true, timeout: 4000 },
      (err, stdout) => {
        if (err) return resolve(false);
        resolve(String(stdout).toLowerCase().includes(imageName.toLowerCase()));
      }
    );
  });
}

let wechatCache = null;

/**
 * 探明本机微信是否具备「免扫码」能力。
 * fastLogin=true 表示 qrconnect 类二维码可以在浏览器里直接点头像完成登录。
 */
async function probeWechat(force) {
  if (!force && wechatCache && Date.now() - wechatCache.ts < 15000) {
    return wechatCache;
  }

  const [weixin4, wechat3, fastLogin] = await Promise.all([
    isProcessRunning("Weixin.exe"),
    isProcessRunning("WeChat.exe"),
    checkTcpPort(FAST_LOGIN_PORT, "127.0.0.1", 1200)
  ]);

  let version = null;
  if (weixin4) version = "4.x";
  else if (wechat3) version = "3.x";

  wechatCache = {
    ts: Date.now(),
    running: weixin4 || wechat3,
    version,
    fastLogin,
    port: FAST_LOGIN_PORT,
    // 快速登录要求 Windows 微信 3.9.11+，端口在监听即说明满足
    canFastLogin: fastLogin,
    summary: !weixin4 && !wechat3
      ? "未检测到微信进程"
      : fastLogin
        ? `微信 ${version} 已登录 · 快速登录可用`
        : `微信 ${version} 在运行 · 快速登录未就绪`
  };
  return wechatCache;
}

// ---------- IPC ----------

ipcMain.handle("qr:frame", async () => {
  try {
    return await captureDisplay(targetDisplay);
  } catch (err) {
    return { error: String((err && err.message) || err) };
  }
});

ipcMain.handle("qr:copy", (_e, text) => {
  if (typeof text === "string" && text) clipboard.writeText(text);
  return true;
});

ipcMain.handle("qr:open", async (_e, url) => {
  if (typeof url !== "string") return false;
  // 只放行网页与微信官方 scheme，避免把任意协议交给系统
  if (!/^(https?:\/\/|weixin:\/\/)/i.test(url)) return false;
  await shell.openExternal(url);
  return true;
});

// ---------- 交给微信：搜一搜 + 可选代点 ----------
//
// 用 ipcMain.on 而不是 handle：取景框是全屏置顶的，必须先关掉再截图，
// 关了它渲染进程就没了，没人能接这个返回值 —— 结果统一走系统通知。
ipcMain.on("qr:wx-open", async (_e, payload) => {
  const url = String((payload && payload.url) || "");
  if (!/^https?:\/\//i.test(url)) return;

  const st = settings.get();
  const click = !!st.autoOpen;
  const mode = st.autoOpenMode || "auto";

  // ---- 分段计时（临时诊断设施，见 timing.js）----
  // 从这里开始，整条链路的分段耗时会写进 desktop/timing.log。
  // 中间各节点由本文件与 wechat-auto.js 共同打点，用的是同一条时间轴，
  // 所以日志里能直接看出「主进程等取景框关掉」和「微信侧那几步」各占多少。
  // wait= 是为了对比 QR_WAIT_MS 改动的批次：不同值混在一份日志里时，
  // 靠表头这一项就能分清哪几次是 600、哪几次是 1500。
  // ready= 是第三批的就绪轮询开关（1 轮询 / 0 固定 sleep），A/B 时靠它分组。
  // worker= 是本次交接用的底层实现（worker 常驻 / spawn 一次性），
  // 两批日志混在一起时靠它也分得清。
  T.begin("wx-open", {
    click: click, mode: mode, wait: wechatAuto.WAIT_RESULT_MS,
    ready: wechatAuto.READY_ON ? 1 : 0,
    worker: wechatAuto.workerStats().mode,
  });
  T.mark("open",
    "收到交接请求：URL 通过 http(s) 校验，读出「全自动」开关与定位方式（到这里为止是前序开销）");

  try {
    // 取景框置顶且开了 setContentProtection，留着它截图会被涂黑，
    // 识别必然失败 —— 所以先关它，再等窗口真正消失。
    //
    // H1（第三批）：原来这里是 overlay.close() 之后固定 delay(340)。
    // 这段存在的唯一理由是「它还活着的时候截图是黑的」，所以要等的是
    // **窗口真的销毁**，不是「过了一小会儿」。30ms 一探，命中即走；
    // 上限仍是 340（探不到就退化成原来的行为，不会更差）。
    if (overlay && !overlay.isDestroyed()) {
      overlay.close();
      const tClose = Date.now();
      while (overlay && !overlay.isDestroyed() && Date.now() - tClose < OVERLAY_CLOSE_MS) {
        await delay(OVERLAY_CLOSE_STEP_MS);
      }
    }
    T.mark("overlay-close",
      "关闭全屏取景框，并轮询到它真的从屏幕上消失（" + OVERLAY_CLOSE_STEP_MS +
      "ms 一探，上限 " + OVERLAY_CLOSE_MS + "；不关的话后面截图是黑的）");

    const r = await wechatAuto.openViaSearch(url, { click, mode });
    T.mark("return",
      "openViaSearch 已返回：组装结果、写 boot.log 摘要（后续只剩发通知）");

    // family / targetHow 写进日志：出问题时先看这两项，
    // 能立刻判断是"进程树没覆盖到结果页"还是"目标窗口选错了"。
    // worker= 模式/重启次数：验收要求 restarts 为 0；非 0 说明 worker 中途
    // 死过（每次死都会退回一次启动开销，且是排查稳定性问题的第一线索）。
    const ws = wechatAuto.workerStats();
    bootLog("wx-open click=" + click + " mode=" + mode +
      " -> " + r.stage + " how=" + (r.how || "-") +
      (r.detail && r.detail.targetHow ? " target=" + r.detail.targetHow : "") +
      (r.detail && r.detail.family ? " pids=" + r.detail.family.join(",") : "") +
      (r.detail && r.detail.evidence ? " evidence=" + r.detail.evidence : "") +
      (r.detail && r.detail.waited != null ? " waited=" + r.detail.waited + "ms" : "") +
      (r.detail && r.detail.pixelDiff != null ? " diff=" + r.detail.pixelDiff : "") +
      (r.detail && r.detail.readyHow ? " ready=" + r.detail.readyHow +
        (r.detail.readyMs != null ? "/" + r.detail.readyMs + "ms" : "") +
        (r.detail.readyHow === "timeout" && r.detail.readyPeak >= 0 ? "/peak" + r.detail.readyPeak : "") : "") +
      " worker=" + ws.mode + "/restarts=" + ws.restarts);

    T.put("最终结果", r.stage + (r.how ? "（定位方式 " + r.how + "）" : ""));

    if (!click) {
      if (r.ok) notify("搜索词已填好", "在微信里点第一条搜索结果即可打开。");
      else notify("没能自动填入", wxReason(r));
      return;
    }
    if (!r.ok) notify("自动打开没成功", wxReason(r));
  } catch (e) {
    // 异常也要留痕：否则最需要排查的那一次反而什么日志都没有
    T.mark("exception", "openViaSearch 抛出异常：" + ((e && e.message) || e));
    T.put("最终结果", "exception");
    bootLog("wx-open exception: " + ((e && e.stack) || e));
    notify("自动打开出错", "已中断。详情见 desktop\\timing.log 与 boot.log。");
  } finally {
    T.finish();     // 无论成功、失败、超时都落盘
  }
});

const WX_FAIL = {
  "not-foreground": "微信窗口没拿到焦点，请点一下微信窗口再试。",
  "no-wechat": "没找到微信窗口，确认微信已登录。",
  input: "输入到搜索框时被中断，链接已复制在剪贴板。",
  locate: "截不到微信窗口，无法确认结果在哪，请手动点第一条。",
  "no-point": "没找到「访问网页」在哪：无障碍、文字识别、区域检测都没定位到，请手动点第一条。",
  click: "点击动作没执行成功。",
  "clicked-no-window": "点了之后画面没有任何变化，可能点偏了，请手动点第一条。",
  timeout: "微信响应超时，请重试。",
};

/**
 * 同一个 stage 可能有不同成因，通知里要说到点上：
 * not-foreground 在敲键阶段是"前台不是微信"，在点击阶段是"那一像素
 * 已经被别的窗口盖住"——后者根本不是焦点问题，让用户"点一下微信"
 * 是没用的，得告诉他挡住目标了。
 */
function wxReason(r) {
  const d = (r && r.detail) || {};
  if (r && r.stage === "not-foreground") {
    if (d.why === "point-outside-family") {
      return "要点的位置现在已经不属于微信窗口（可能被别的窗口挡住了），请手动点第一条。";
    }
    if (d.got && d.got.title) {
      return "微信窗口没拿到焦点（当前前台是「" + d.got.title + "」），请点一下微信窗口再试。";
    }
  }
  return WX_FAIL[r && r.stage] || "链接已复制，请手动点开搜索结果。";
}

function notify(title, body) {
  try {
    if (Notification.isSupported()) {
      new Notification({ title: "屏幕扫码 · " + title, body, silent: true }).show();
    }
  } catch (_) {}
}


// 微信环境探测：决定「扫码登录」类二维码能不能在 PC 上直接完成。
// 判据是微信自己的快速登录通道 https://localhost.weixin.qq.com:14013，
// 端口在监听 = 本机有已登录的微信且支持免扫码授权。
ipcMain.handle("qr:probe-wechat", async () => probeWechat());

// ---------- 移动端环境（代理）：只在用户明确点了按钮之后才会启动 ----------

ipcMain.handle("qr:proxy-status", async () => proxyMgr.getStatus());

ipcMain.handle("qr:proxy-start", async (_e, opts) => {
  // 【维护约定】overlay 端（proxyHandOff）给 proxyStart 传的每一个键，
  // 都必须出现在下面这个显式白名单里，并在 tools/_t-proxy-event.js 的
  // T4 断言中被覆盖。此处是有意不用 {...o} 透传的——渲染进程不可信，
  // 但代价是"加字段漏中间"会静默失效（scopeUrl 就这么丢过一次），
  // 所以改动必须三处同步：overlay 调用点 → 本白名单 → T4 断言。
  const o = opts && typeof opts === "object" ? opts : {};
  return proxyMgr.start({
    mode: o.mode === "iphone" ? "iphone" : "android",
    ttlSec: o.ttlSec,
    globalProxy: !!o.globalProxy,
    // 目标链接：收窄模式（默认）靠它算出"只接管哪个站"。
    // 这里必须显式透传——此前重建 opts 时把它丢了，导致永远退回全量，
    // 而界面又恰好显示"只接管 0 个域名"，用户看到的就是这对矛盾。
    scopeUrl: typeof o.scopeUrl === "string" ? o.scopeUrl : ""
  });
});

ipcMain.handle("qr:proxy-stop", async () => proxyMgr.stop("user"));

ipcMain.handle("qr:copy-image", async (_e, dataUrl) => {
  try {
    const img = nativeImage.createFromDataURL(String(dataUrl || ""));
    if (img.isEmpty()) return false;
    clipboard.writeImage(img);
    return true;
  } catch (_) {
    return false;
  }
});

ipcMain.on("qr:ready", () => {
  if (overlay && !overlay.isDestroyed()) {
    overlay.show();
    overlay.focus();
  }
});

ipcMain.on("qr:close", () => {
  if (overlay && !overlay.isDestroyed()) overlay.close();
});

ipcMain.on("qr:start", () => openOverlay());

ipcMain.on("qr:minimize", () => {
  const w = BrowserWindow.getFocusedWindow() || launcher;
  if (w && !w.isDestroyed()) w.minimize();
});

ipcMain.on("qr:quit", () => app.quit());

// ---------- 窗口控制（最大化 / 还原）----------

ipcMain.on("qr:toggle-maximize", (e) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (!w || w.isDestroyed()) return;
  // 先保证上限是当前显示器的工作区，否则最大化可能被上一次设的上限卡住
  applySizeLimits(w);
  if (w.isMaximized()) w.unmaximize();
  else w.maximize();
});

ipcMain.handle("qr:win-state", (e) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  return { maximized: !!(w && !w.isDestroyed() && w.isMaximized()) };
});

// ---------- 设置 ----------

function broadcast(channel, payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win || win.isDestroyed()) continue;
    try { win.webContents.send(channel, payload); } catch (_) {}
  }
}

function registerHotkey(combo) {
  try {
    if (hotkeyHandle) { globalShortcut.unregister(hotkeyHandle); hotkeyHandle = null; }
  } catch (_) {}
  if (!combo) return true;
  let ok = false;
  try { ok = globalShortcut.register(combo, () => openOverlay()); } catch (_) { ok = false; }
  if (ok) { hotkeyHandle = combo; currentHotkey = combo; }
  return ok;
}

function applyAutoLaunch(on) {
  // 开发态（electron.exe .）需要显式带上 app 目录；
  // 打包后 exe 自己就是应用，再传 app.asar 路径反而会让 Electron 把它当成
  // 启动参数去解析 —— 表现是"开机自启后没反应"或直接报错。
  try {
    app.setLoginItemSettings({
      openAtLogin: !!on,
      path: process.execPath,
      args: app.isPackaged ? [] : [path.resolve(__dirname)]
    });
    return true;
  } catch (err) {
    console.warn("[qrscan] 开机自启设置失败:", err && err.message);
    return false;
  }
}

function trayImage() {
  const p = path.join(__dirname, "assets", "tray.png");
  try {
    if (!fs.existsSync(p)) return null;
    const img = nativeImage.createFromPath(p);
    return img.isEmpty() ? null : img;
  } catch (_) {
    return null;
  }
}

function refreshTrayMenu() {
  if (!tray) return;
  const running = proxyMgr.isActive();
  tray.setToolTip(running ? "屏幕扫码 · 移动端环境运行中" : "屏幕扫码");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "显示主窗口", click: () => { if (launcher) { launcher.show(); launcher.focus(); } } },
    {
      label: running ? "停止移动端环境并还原代理" : "移动端环境：未启用",
      enabled: running,
      click: () => { proxyMgr.stop("tray").catch(() => {}).then(refreshTrayMenu); }
    },
    { type: "separator" },
    { label: "退出程序", click: () => { quitting = true; app.quit(); } }
  ]));
}

function ensureTray(on) {
  if (on) {
    if (tray) return true;
    const icon = trayImage();
    if (!icon) return false;   // 没图标就别假装有托盘，退化成"关闭即退出"
    tray = new Tray(icon);
    refreshTrayMenu();
    tray.on("click", () => { if (launcher) { launcher.show(); launcher.focus(); } });
    return true;
  }
  if (tray) {
    try { tray.destroy(); } catch (_) {}
    tray = null;
  }
  return true;
}

function certInfo() {
  // 证书跟着数据目录走（P0-1）：打包后程序目录是只读的，
  // 生成证书一定失败，而「手机环境」正是靠这张证书解 HTTPS。
  const dir = path.join(paths.proxyDataDir(), "certs");
  let installed = false;
  try {
    const ca = path.join(dir, "ca.crt");
    installed = fs.existsSync(ca) && fs.statSync(ca).size > 0;
  } catch (_) {}
  let domains = 0;
  try {
    // 叶子证书按后端分目录落盘：
    //   leaf-native2 —— 现在默认（纯 Python 签发，AKI 改正后的一代）
    //   leaf-native  —— 上一代纯 Python（AKI 编码有问题的，仅历史遗留）
    //   leaf         —— openssl 后端（QRSCAN_CERT_BACKEND=openssl 时才用）
    // 只数 `leaf` 会读出历史遗留的 50 个（实际在用的只有 10 个），
    // 所以按"当前后端优先"取第一个存在的目录（P2-B）。
    for (const name of ["leaf-native2", "leaf-native", "leaf"]) {
      const sub = path.join(dir, name);
      let st = null;
      try { st = fs.statSync(sub); } catch (_) { continue; }
      if (!st.isDirectory()) continue;
      domains = fs.readdirSync(sub).filter((n) => /\.crt$/i.test(n)).length;
      break;
    }
  } catch (_) {}
  return { installed, domains };
}

function appInfo() {
  const st = settings.get();
  const c = certInfo();
  return {
    version: app.getVersion(),
    hotkey: st.hotkey,
    certInstalled: c.installed,
    certDomains: c.domains,
    settingsPath: settings.FILE,
    dataDir: paths.dataDir(),
    certsDir: path.join(paths.proxyDataDir(), "certs"),
    logUsage: paths.logUsage(),
    platform: process.platform,
    // 设置页的"恢复默认"要用它，免得默认值在两端各写一份
    defaults: settings.DEFAULTS
  };
}

ipcMain.handle("qr:settings-get", () => settings.get());

ipcMain.handle("qr:settings-patch", (_e, partial) => {
  const prev = settings.get();
  let res = settings.patch(partial);
  let error = null;

  // 热键是唯一一个"写下去也可能没生效"的项：注册失败必须回滚，
  // 否则设置里显示着一套键，实际按下去没反应。
  if (res.changed.indexOf("hotkey") >= 0) {
    if (!registerHotkey(res.settings.hotkey)) {
      error = "「" + res.settings.hotkey + "」被其他程序占用了，已保留 " + prev.hotkey;
      res = settings.patch({ hotkey: prev.hotkey });
      registerHotkey(prev.hotkey);
    }
  }

  if (res.changed.indexOf("alwaysOnTop") >= 0 && launcher && !launcher.isDestroyed()) {
    launcher.setAlwaysOnTop(!!res.settings.alwaysOnTop);
  }

  if (res.changed.indexOf("autoLaunch") >= 0) {
    if (!applyAutoLaunch(res.settings.autoLaunch)) {
      error = error || "开机自启写入失败（可能被安全软件拦了）";
      res = settings.patch({ autoLaunch: prev.autoLaunch });
    }
  }

  if (res.changed.indexOf("closeAction") >= 0) {
    const wantTray = res.settings.closeAction === "tray";
    if (!ensureTray(wantTray) && wantTray) {
      error = error || "托盘图标缺失，已改回「关闭即退出」";
      res = settings.patch({ closeAction: "quit" });
    }
  }

  if (res.changed.length) {
    settings.emit(res.settings, res.changed);
    broadcast("qr:settings-changed", { settings: res.settings, changed: res.changed });
  }

  return { ok: !error, error: error, settings: res.settings, changed: res.changed };
});

ipcMain.handle("qr:settings-reset", () => {
  const prev = settings.get();
  const res = settings.reset();
  registerHotkey(res.settings.hotkey);
  if (launcher && !launcher.isDestroyed()) launcher.setAlwaysOnTop(!!res.settings.alwaysOnTop);
  applyAutoLaunch(res.settings.autoLaunch);
  ensureTray(res.settings.closeAction === "tray");
  settings.emit(res.settings, res.changed);
  broadcast("qr:settings-changed", { settings: res.settings, changed: res.changed });
  return { ok: true, settings: res.settings, changed: res.changed, before: prev };
});

ipcMain.handle("qr:app-info", () => appInfo());

// ---------- 提示音 ----------
//
// 自定义音色的导入分两跳，各自职责清楚：
//   qr:sound-pick  选文件 + 按文件头认格式（主进程）
//   qr:sound-save  收渲染进程解码归一后的 WAV，落盘并切到自定义（主进程）
// 中间那一步"能不能真的解出来"必须在渲染进程做 —— 只有那里有音频解码器。

ipcMain.handle("qr:sound-pick", async () => {
  const parent = launcher && !launcher.isDestroyed() ? launcher : null;
  const r = await audioImport.pick(parent);
  if (!r || r.canceled) return { canceled: true };
  return r;
});

ipcMain.handle("qr:sound-save", (_e, payload) => {
  const saved = audioImport.saveWav(payload);
  if (!saved.ok) return { ok: false, error: saved.error };

  const res = settings.patch({ soundId: "custom", soundCustom: saved.meta });
  settings.emit(res.settings, res.changed);
  broadcast("qr:settings-changed", { settings: res.settings, changed: res.changed });
  return { ok: true, meta: saved.meta, settings: res.settings };
});

// 取景框启动时要拿到自定义音频本体：用 base64 传，不依赖 file:// 的读取权限
ipcMain.handle("qr:sound-custom", () => {
  const st = settings.get();
  const r = audioImport.readCustom();
  if (!r.ok) return r;
  return {
    ok: true,
    base64: r.base64,
    peak: (st.soundCustom && st.soundCustom.peak) || 0.9,
    name: (st.soundCustom && st.soundCustom.name) || "自定义音色"
  };
});

ipcMain.handle("qr:open-path", async (_e, which) => {
  const map = {
    logs: paths.dataDir(),
    certs: path.join(paths.proxyDataDir(), "certs"),
    proxy: paths.proxyDataDir()
  };
  const target = map[which];
  if (!target) return false;
  try {
    const err = await shell.openPath(target);
    return !err;
  } catch (_) {
    return false;
  }
});

// 运行环境自检（P0-3）：手机环境早先依赖 Python 3.8+ 与 openssl，
// 两样都不是 Windows 自带；0.4.0 起改为"发行包内置 Python 运行时 + 纯 Python 签发证书"，
// 所以现在只剩一项要探：内置运行时能不能跑（openssl 只作日志信息）。
// 界面在「移动端」页展示结果，缺什么就直说，而不是等用户点了才报一句看不懂的错。
ipcMain.handle("qr:env-check", async () => {
  try {
    return await proxyMgr.checkEnv();
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

// 清空日志（P0-5）：把可能含访问地址的日志一把删掉，
// 用户不必知道文件在哪。设置与证书不动。
ipcMain.handle("qr:clear-logs", () => {
  const r = paths.clearLogs();
  const u = paths.logUsage();
  return { ok: true, removed: r.files, bytes: r.bytes, remain: u };
});

// 系统主题（"跟随系统"时页面要根据它决定深浅）
ipcMain.handle("qr:system-theme", () => {
  const { nativeTheme } = require("electron");
  return { dark: nativeTheme.shouldUseDarkColors };
});

// ---------- 自检 ----------

async function runSelfTest() {
  const out = { ts: new Date().toISOString(), ok: false, steps: {} };
  try {
    out.steps.wechat = await probeWechat(true);

    out.steps.displays = screen.getAllDisplays().map((d) => ({
      id: d.id, bounds: d.bounds, scaleFactor: d.scaleFactor, primary: d.bounds.x === 0 && d.bounds.y === 0
    }));

    const primary = screen.getPrimaryDisplay();
    const cap = await captureDisplay(primary);

    out.steps.capture = {
      requestedScaleFactor: cap.scaleFactor,
      width: cap.width,
      height: cap.height,
      expectedWidth: Math.round(primary.size.width * primary.scaleFactor),
      expectedHeight: Math.round(primary.size.height * primary.scaleFactor),
      dataUrlBytes: cap.dataUrl.length
    };

    const img = nativeImage.createFromDataURL(cap.dataUrl);
    const size = img.getSize();
    const bmp = img.toBitmap();

    let sum = 0, min = 255, max = 0, n = 0;
    for (let i = 0; i + 3 < bmp.length; i += 4 * 97) {
      const v = bmp[i + 2]; // RGBA -> red
      sum += v; if (v < min) min = v; if (v > max) max = v; n++;
    }

    out.steps.pixels = {
      sampled: n,
      meanRed: +(sum / Math.max(1, n)).toFixed(1),
      minRed: min,
      maxRed: max,
      range: max - min
    };

    // 窗口能力：透明/无边框/置顶窗口能否创建并加载页面
    const probe = new BrowserWindow({
      show: false, width: 240, height: 160, frame: false, transparent: true, alwaysOnTop: true
    });
    await probe.loadURL("data:text/html,<body style='background:#123'></body>");
    out.steps.window = { created: true, visible: probe.isVisible() };
    probe.destroy();

    const probeKey = settings.get().hotkey;
    const hotkeyOk = globalShortcut.isRegistered(probeKey) || globalShortcut.register(probeKey, () => {});
    out.steps.hotkey = { combo: probeKey, registered: !!hotkeyOk };
    globalShortcut.unregister(probeKey);

    out.ok =
      size.width === cap.width &&
      size.height === cap.height &&
      size.width > 100 &&
      (max - min) > 8 &&
      out.steps.window.created;

    out.steps.bufferBytes = bmp.length;
  } catch (err) {
    out.ok = false;
    out.error = String((err && err.stack) || err);
  }

  // 自检产物优先写在程序目录（开发态用来看），打包后 asar 是只读的，
  // 落到数据目录，免得自检通过与否都没留下证据。
  const text = JSON.stringify(out, null, 2);
  try {
    fs.writeFileSync(path.join(__dirname, "selftest.json"), text, "utf8");
  } catch (_) {
    try { fs.writeFileSync(paths.file("selftest.json"), text, "utf8"); } catch (_) {}
  }

  app.exit(out.ok ? 0 : 1);
}

/**
 * `--envcheck`：只做「手机环境」的运行环境自检，输出 JSON 后退出。
 * 打包产物没有控制台，发布前用它可以确认内置 Python 运行时真的跑得起来，
 * 而不是等用户点了「手机环境」才发现少了文件。
 */
async function runEnvCheckCli() {
  let out;
  try {
    out = await proxyMgr.checkEnv();
  } catch (err) {
    out = { ok: false, error: String((err && err.message) || err) };
  }
  out.runtimePython = paths.runtimePython() || "(未找到 vendor/python/python.exe)";
  out.dataDir = paths.dataDir();
  const text = JSON.stringify(out, null, 2);
  try { fs.writeFileSync(paths.file("envcheck.json"), text, "utf8"); } catch (_) {}
  try { process.stdout.write(text + "\n"); } catch (_) {}
  app.exit(out.ok ? 0 : 1);
}

/**
 * `--appinfo`：把「关于」页读的那份信息打印出来再退出。
 *
 * 存在的理由很具体：`certDomains`（已签发域名数）以前读错了目录，
 * 界面上是 50、实际只有 10，而这条信息只在「关于」页里，脚本够不到。
 * 有了这个开关就能在命令行核对，不用点开界面（P2-B）。
 */
function runAppInfoCli() {
  const out = appInfo();
  out.certsDirs = (() => {
    try {
      const dir = path.join(paths.proxyDataDir(), "certs");
      return fs.readdirSync(dir)
        .filter((n) => /^leaf/i.test(n))
        .map((n) => {
          const sub = path.join(dir, n);
          try {
            if (!fs.statSync(sub).isDirectory()) return null;
            return { name: n, crtCount: fs.readdirSync(sub).filter((f) => /\.crt$/i.test(f)).length };
          } catch (_) { return null; }
        })
        .filter(Boolean);
    } catch (_) {
      return [];
    }
  })();
  const text = JSON.stringify(out, null, 2);
  try { fs.writeFileSync(paths.file("appinfo.json"), text, "utf8"); } catch (_) {}
  try { process.stdout.write(text + "\n"); } catch (_) {}
  app.exit(0);
}

// ---------- 可视化端到端测试 ----------

async function runUiTest() {
  const out = { ts: new Date().toISOString(), ok: false };
  let qrWin = null;
  try {
    const display = screen.getPrimaryDisplay();
    const b = display.bounds;
    const size = 320;

    qrWin = new BrowserWindow({
      x: Math.round(b.x + (b.width - size) / 2),
      y: Math.round(b.y + (b.height - size) / 2),
      width: size,
      height: size,
      frame: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      show: true
    });
    // --uitest --code=<urlencoded> 可指定码内容，用于验证不同码型的判别与按钮
    const { pathToFileURL } = require("url");
    const codeArg = process.argv.find((a) => a.startsWith("--code="));
    if (codeArg) {
      const testCode = decodeURIComponent(codeArg.slice(7));
      await qrWin.loadURL(
        pathToFileURL(path.join(__dirname, "testqr.html")).href +
        "?t=" + encodeURIComponent(testCode)
      );
    } else {
      await qrWin.loadFile(path.join(__dirname, "testqr.html"));
    }
    await delay(1000);

    openOverlay();
    await delay(3500);

    // 取景框内部状态的快照，排查"黑屏/没框"时先看这个
    if (overlay && !overlay.isDestroyed()) {
      overlay.webContents.on("console-message", (_e2, level, message) => {
        if (level >= 2) console.log("[overlay]", message);
      });
      out.debug = await overlay.webContents.executeJavaScript(`(function(){
        var s = document.getElementById('stage');
        return {
          hasQr: !!window.qr,
          hasSettings: !!(window.qr && window.qr.settingsGet),
          stat: document.getElementById('statPill').textContent,
          mode: document.getElementById('modePill').textContent,
          err: document.getElementById('err').className,
          errText: document.getElementById('err').textContent,
          idle: document.getElementById('idle').className,
          bar: document.getElementById('bar').className,
          canvas: [s.width, s.height]
        };
      })()`).catch((e) => ({ error: String(e) }));

      // 隔 1.5s 再取一次：连续模式下 frameSeq 必须增长，冻结模式下必须不变。
      // 这是"连续模式黑屏/画面不动"的唯一客观判据。
      try {
        const a = await overlay.webContents.executeJavaScript("window.__qrDebug ? window.__qrDebug() : null");
        await delay(3000);
        const b = await overlay.webContents.executeJavaScript("window.__qrDebug ? window.__qrDebug() : null");
        if (a && b) {
          out.motion = {
            mode: a.mode,
            frameSeq: [a.frameSeq, b.frameSeq],
            framesGrew: b.frameSeq > a.frameSeq,
            decodeCount: [a.decodeCount, b.decodeCount],
            decoding: b.decodeCount > a.decodeCount,
            box: b.box
          };
        }
      } catch (e) {
        out.motion = { error: String(e) };
      }

      // 抓屏本身有多快：连续模式靠它定时换帧，单次几百毫秒就会看起来"卡住"
      try {
        out.framePerf = await overlay.webContents.executeJavaScript(`(async function(){
          var t = [];
          for (var i = 0; i < 3; i++) {
            var t0 = performance.now();
            var f = await window.qr.getFrame();
            t.push(Math.round(performance.now() - t0) + (f && f.dataUrl ? "" : "!"));
          }
          return t;
        })()`);
      } catch (e) {
        out.framePerf = { error: String(e) };
      }
    }

    out.diagnostics = {
      displayBounds: display.bounds,
      workArea: display.workArea,
      overlayBounds: overlay && !overlay.isDestroyed() ? overlay.getBounds() : null,
      overlayContent: overlay && !overlay.isDestroyed() ? overlay.getContentBounds() : null
    };

    if (overlay && !overlay.isDestroyed()) {
      const shot = await overlay.capturePage();
      fs.writeFileSync(path.join(__dirname, "uitest-overlay.png"), shot.toPNG());
      out.overlayShot = shot.getSize();
    }

    const cap = await captureDisplay(display);
    fs.writeFileSync(
      path.join(__dirname, "uitest-screen.png"),
      nativeImage.createFromDataURL(cap.dataUrl).toPNG()
    );
    out.screenShot = { width: cap.width, height: cap.height };

    // 覆盖层可见时再抓一次：若"自我排除"生效，这张图里不该出现取景框与暗化蒙层
    const cap2 = await captureDisplay(display);
    fs.writeFileSync(
      path.join(__dirname, "uitest-under-overlay.png"),
      nativeImage.createFromDataURL(cap2.dataUrl).toPNG()
    );
    out.underOverlay = { width: cap2.width, height: cap2.height, sameBytes: cap2.dataUrl.length === cap.dataUrl.length };

    out.ok = !!(out.overlayShot && out.overlayShot.width > 100);
  } catch (err) {
    out.error = String((err && err.stack) || err);
  } finally {
    if (qrWin && !qrWin.isDestroyed()) qrWin.destroy();
    fs.writeFileSync(path.join(__dirname, "uitest.json"), JSON.stringify(out, null, 2), "utf8");
    app.exit(out.ok ? 0 : 1);
  }
}

// ---------- UI 截图（--shot=目录，仅用于界面回归，不参与正常启动）----------

const SHOT_DIR = (() => {
  const a = process.argv.find((x) => x.startsWith("--shot="));
  return a ? a.slice("--shot=".length) : null;
})();

async function runShots(dir) {
  // Windows 上 Electron 是 GUI 子系统，console.log 不会进 stdout/日志文件，
  // 所以截图流程自己再写一份日志，出问题时有据可查。
  const logFile = path.join(dir, "shot.log");
  const log = (...args) => {
    const line = `[${new Date().toISOString()}] ` + args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
    console.log(line);
    try { fs.appendFileSync(logFile, line + "\n"); } catch (_) {}
  };
  log("start -> " + dir);
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  const win = launcher;
  if (!win) { log("no launcher"); return; }
  if (!win.isVisible()) win.show();
  log("visible=" + win.isVisible() + " bounds=" + JSON.stringify(win.getBounds()));

  const js = (code) => win.webContents.executeJavaScript(code).catch((e) => { log("js fail " + e.message); return null; });
  const shoot = async (name) => {
    await delay(450);
    let img = null;
    try {
      img = await Promise.race([
        win.capturePage(),
        new Promise((_, rej) => setTimeout(() => rej(new Error("capture timeout")), 5000))
      ]);
    } catch (e) {
      log("FAIL " + name + " " + e.message);
      return;
    }
    if (!img || img.isEmpty()) { log("EMPTY " + name); return; }
    fs.writeFileSync(path.join(dir, name), img.toPNG());
    log(name + " " + img.getSize().width + "x" + img.getSize().height);
  };

  await delay(600);
  await shoot("01-主窗口-默认.png");

  await js(`document.getElementById('btnSettings').click()`);
  await shoot("02-设置-扫码.png");

  // 「全自动打开链接」：开关 + 「点击方式」两行的实际效果。
  // 注意不能无脑 click()：真实设置里 autoOpen 可能就是开着的，盲切会拍成反状态。
  // 这里按当前状态显式置位，拍完再还原成用户原来的值。
  const autoWasOn = await js(`(function(){
    return document.querySelector('.sw[data-key="autoOpen"]').classList.contains('on');
  })()`);
  const setAuto = (on) => js(`(function(){
    var sw = document.querySelector('.sw[data-key="autoOpen"]');
    if (sw.classList.contains('on') !== ${on ? "true" : "false"}) sw.click();
    return sw.classList.contains('on');
  })()`);

  await setAuto(true);
  await js(`(function(){ document.querySelector('.pbody').scrollTop = 9999; return true; })()`);
  await delay(200);
  await shoot("13-自动打开-开关.png");
  await js(`(function(){
    var b = document.getElementById('btnAutoOpenHelp');
    b.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
    return true;
  })()`);
  await shoot("14-自动打开-说明浮窗.png");
  await js(`(function(){
    document.getElementById('btnAutoOpenHelp').dispatchEvent(new MouseEvent('mouseleave'));
    return true;
  })()`);

  // 最窄窗口（400px）下这两行能不能撑住：左边标题 + 右边四个方式按钮，
  // 挤爆就会换行或重叠，所以单独留一张图。
  const beforeAuto = win.getContentSize();
  win.setContentSize(WIN_MIN.width, WIN_MIN.height);
  await delay(280);
  await js(`(function(){ document.querySelector('.pbody').scrollTop = 9999; return true; })()`);
  await delay(180);
  await shoot("15-自动打开-窄窗.png");
  await js(`(function(){ document.querySelector('.pbody').scrollTop = 0; return true; })()`);
  win.setContentSize(beforeAuto[0], beforeAuto[1]);
  await delay(320);

  // 还原用户原本的开关状态，截图不该改设置
  await setAuto(!!autoWasOn);

  await js(`document.querySelector('.tab[data-pane="proxy"]').click()`);
  await shoot("03-设置-移动端.png");

  await js(`document.querySelector('.tab[data-pane="appearance"]').click()`);
  await shoot("04-设置-外观.png");

  await js(`document.querySelector('.tab[data-pane="about"]').click()`);
  await shoot("05-设置-关于.png");

  // 切浅色主题：同时验证「点控件 -> IPC -> settings.json -> 广播 -> 重绘」整条链路
  await js(`document.querySelector('.tab[data-pane="appearance"]').click()`);
  await js(`document.querySelector('.seg[data-key="theme"] button[data-v="light"]').click()`);
  await delay(300);
  log("[shot] theme now =", settings.get().theme);
  await shoot("06-设置-浅色.png");
  await js(`document.getElementById('btnDone').click()`);
  await shoot("07-主窗口-浅色.png");

  // 切回深色，别把用户的设置留在浅色
  await js(`document.getElementById('btnSettings').click()`);
  await js(`document.querySelector('.tab[data-pane="appearance"]').click()`);
  await js(`document.querySelector('.seg[data-key="theme"] button[data-v="dark"]').click()`);
  await js(`document.getElementById('btnDone').click()`);
  await delay(200);

  win.setContentSize(WIN_MIN.width, WIN_MIN.height);
  await shoot("08-最小尺寸.png");

  win.maximize();
  await delay(800);
  await shoot("09-最大化.png");

  win.unmaximize();
  await delay(400);

  // 代理态只在显式加 --shot-proxy 时测：它会真的改一次系统代理，
  // 但跑完一定 stop 还原（这也是要验证的点之一）。
  if (process.argv.includes("--shot-proxy")) {
    log("[shot] 启动一次真实代理用于截图…");
    win.setContentSize(442, 500);
    await delay(300);
    try {
      const r = await proxyMgr.start({ ttlSec: 120, globalProxy: false });
      log("[shot] proxy start =", JSON.stringify(r));
      await delay(1800);
      await shoot("10-主窗口-代理运行中.png");

      await js(`document.getElementById('btnSettings').click()`);
      await js(`document.querySelector('.tab[data-pane="proxy"]').click()`);
      await shoot("11-设置-移动端-运行中.png");
      await js(`document.getElementById('btnDone').click()`);
    } finally {
      const s = await proxyMgr.stop("shot-test").catch((e) => ({ error: String(e) }));
      log("[shot] proxy stop =", JSON.stringify(s));
      log("[shot] prev file exists =", fs.existsSync(path.join(paths.proxyDataDir(), "previous.json")));
    }
  }

  // 「收到托盘」行为验证：点 X 应该只是隐藏，进程和代理都还在
  if (process.argv.includes("--shot-tray")) {
    log("[shot] 测试「收到托盘」…");
    await js(`document.getElementById('btnSettings').click()`);
    await js(`document.querySelector('.tab[data-pane="appearance"]').click()`);
    await js(`document.querySelector('.seg[data-key="closeAction"] button[data-v="tray"]').click()`);
    await delay(500);
    log("[shot] tray =", !!tray, "closeAction =", settings.get().closeAction);

    await js(`document.getElementById('btnDone').click()`);
    win.close();
    await delay(700);
    const destroyed = win.isDestroyed();
    log("[shot] after X -> destroyed:", destroyed, "visible:", destroyed ? "-" : win.isVisible());

    // 收尾：改回「关闭即退出」并销毁托盘，别把测试状态留给用户
    settings.patch({ closeAction: "quit" });
    ensureTray(false);
    if (!destroyed) win.show();
    await delay(300);
    log("[shot] restored closeAction =", settings.get().closeAction, "tray =", !!tray);
  }
}


// ---------- 提示音自测（--sndtest）----------
//
// 覆盖三段：
//   1. 文件头识别：真支持 / 认得但不支持 / 认不出，三类都要归对
//   2. 渲染进程解码：decodeToWav 真的解得开、归一后仍是合法 WAV
//   3. 落盘到界面：saveWav → settings 变化 → 面板标签与选中态跟着变
// 系统文件对话框本身不点（无头环境点不了），其余链路全跑。

function makeTestWav(seconds, freq) {
  const sr = 44100;
  const n = Math.floor(sr * seconds);
  const pcm = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const env = Math.min(1, i / 200) * Math.exp(-i / (sr * 0.25));
    const v = Math.sin((2 * Math.PI * freq * i) / sr) * env * 0.8;
    pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v * 32767))), i * 2);
  }
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVE", 8);
  h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sr, 24); h.writeUInt32LE(sr * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

async function runSoundTest() {
  const out = { ts: new Date().toISOString(), ok: false, steps: {} };
  const shotDir = path.join(__dirname, "ui-preview", "app");
  try { fs.mkdirSync(shotDir, { recursive: true }); } catch (_) {}
  const before = fs.existsSync(settings.FILE) ? fs.readFileSync(settings.FILE, "utf8") : null;

  // ---- 1. 识别 ----
  const wav = makeTestWav(0.6, 880);
  const pad = (b, n) => Buffer.concat([b, Buffer.alloc(n)]);
  const cases = [
    ["wav", wav.subarray(0, 96), "ok", "wav"],
    ["mp3(ID3)", Buffer.from("ID3\u0003\u0000\u0000\u0000\u0000\u0000\u0000", "latin1"), "ok", "mp3"],
    ["flac", pad(Buffer.from("fLaC"), 60), "ok", "flac"],
    ["ogg/opus", Buffer.concat([Buffer.from("OggS"), Buffer.alloc(20), Buffer.from("OpusHead"), Buffer.alloc(40)]), "ok", "ogg"],
    ["m4a", Buffer.concat([Buffer.alloc(4), Buffer.from("ftypM4A "), Buffer.alloc(52)]), "ok", "mp4"],
    ["webm", Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(60)]), "ok", "matroska"],
    ["wma", pad(Buffer.from([0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11]), 60), "undecodable", "wma"],
    ["amr", pad(Buffer.from("#!AMR"), 60), "undecodable", "amr"],
    ["ape", pad(Buffer.from("MAC "), 60), "undecodable", "ape"],
    ["midi", pad(Buffer.from("MThd"), 60), "undecodable", "midi"],
    ["html(误存)", Buffer.from("<!DOCTYPE html><html><body>404</body></html>"), "no", null],
    ["随机字节", require("crypto").randomBytes(80), "no", null],
  ];
  out.steps.sniff = cases.map(([name, buf, want, wantFmt]) => {
    const r = audioImport.sniff(buf);
    const got = !r.ok ? "no" : (r.decode ? "ok" : "undecodable");
    const pass = got === want && (!wantFmt || r.format === wantFmt);
    return { case: name, got: got, format: r.format || null, pass: pass };
  });

  // ---- 2 + 3. 渲染进程解码 + 落盘 ----
  try {
    createLauncher();
    await new Promise((res) => {
      if (!launcher.webContents.isLoading()) return res();
      launcher.webContents.once("did-finish-load", res);
      setTimeout(res, 4000);
    });
    await delay(900);
    const js = (code) => launcher.webContents.executeJavaScript(code);

    await js(`document.getElementById('btnSettings').click();
              document.getElementById('btnSoundPick').click(); true`);
    await delay(700);
    await js(`(function(){
      var b = document.querySelector('.pbody');
      if (b) b.scrollTop = b.scrollHeight;
      return true;
    })()`);
    await delay(350);

    const shot = async (name) => {
      const img = await launcher.webContents.capturePage();
      fs.writeFileSync(path.join(shotDir, name), img.toPNG());
      const sz = img.getSize();
      out.steps[name] = sz.width + "x" + sz.height;
    };
    await shot("10-提示音-展开音色.png");

    const b64 = wav.toString("base64");
    const dec = await js(`(function(){
      return QRSound.decodeToWav(${JSON.stringify(b64)}).then(function(r){
        return { ok: r.ok, ms: r.ms, error: r.error || null,
                 bytes: r.wavBase64 ? r.wavBase64.length : 0,
                 wav: r.wavBase64 || null };
      });
    })()`);
    out.steps.decode = { ok: dec.ok, ms: dec.ms, bytes: dec.bytes, error: dec.error };

    // 坏数据必须被拦住，不能存进磁盘
    const bad = await js(`QRSound.decodeToWav(btoa("this is not audio at all")).then(function(r){
      return { ok: r.ok, error: r.error || null };
    })`);
    out.steps.decodeBad = { ok: bad.ok, error: bad.error };

    if (dec.ok) {
      const saved = audioImport.saveWav({
        wavBase64: dec.wav, name: "测试-880Hz.wav", format: "WAV", ms: dec.ms, peak: 0.9
      });
      out.steps.save = { ok: saved.ok, error: saved.error || null, bytes: saved.meta && saved.meta.bytes };
      if (saved.ok) {
        const res = settings.patch({ soundId: "custom", soundCustom: saved.meta });
        settings.emit(res.settings, res.changed);
        broadcast("qr:settings-changed", { settings: res.settings, changed: res.changed });
        await delay(400);
        await js(`(function(){
          var c = window.QRSound;
          c.setCustomFromWav(${JSON.stringify(dec.wav)}, 0.9, "测试-880Hz.wav");
          var f = document.getElementById('soundFold');
          if (!f.classList.contains('open')) document.getElementById('btnSoundPick').click();
          var pb = document.querySelector('.pbody');
          if (pb) pb.scrollTop = pb.scrollHeight;
          return true;
        })()`);
        await delay(700);
        await shot("11-提示音-自定义.png");
        out.steps.pickLabel = await js(`document.getElementById('soundPickLabel').textContent`);
        out.steps.customSelected = await js(
          `!!document.querySelector('.sopt[data-sid="custom"].on')`);
        out.steps.reimportShown = await js(`!document.getElementById('optReimport').hidden`);
      }
    }

    // 播放链路 + 去重：连续命中时同一音色不能连成一片，但试听必须每次都响
    out.steps.play = await js(`(function(){
      var first = QRSound.preview('bell');
      var dup = QRSound.play('bell');                 // 320ms 内再来一次，应被挡掉
      var forced = QRSound.play('marimba', { forced: true, force: true });
      return { first: first, deduped: dup, forced: forced, audio: QRSound.debugState() };
    })()`);

    // 选内置音色：应当立刻收起并写进设置
    await js(`(function(){
      var b = document.querySelector('.sopt[data-sid="bell"]');
      if (b) b.click();
      return true;
    })()`);
    await delay(450);
    out.steps.selectPreset = {
      soundId: settings.get().soundId,
      folded: await js(`document.getElementById('soundFold').classList.contains('open')`),
      label: await js(`document.getElementById('soundPickLabel').textContent`)
    };

    // 窄窗 + 浅色：折叠面板最容易在这里把标签挤换行或顶出横向滚动条
    launcher.setSize(400, 560);
    await js(`(function(){
      document.body.dataset.theme = 'light';
      document.getElementById('btnSoundPick').click();
      var pb = document.querySelector('.pbody');
      if (pb) pb.scrollTop = pb.scrollHeight;
      return true;
    })()`);
    await delay(700);
    await shot("12-提示音-浅色窄窗.png");
    out.steps.noHScroll = await js(`(function(){
      var pb = document.querySelector('.pbody');
      return pb ? pb.scrollWidth <= pb.clientWidth + 1 : false;
    })()`);
    out.steps.pickbtnOneLine = await js(`(function(){
      var b = document.getElementById('btnSoundPick');
      return b.getBoundingClientRect().height < 30;
    })()`);
  } finally {
    // 还原现场：设置文件原样写回，删掉测试音频，别把测试状态留给用户
    try {
      if (before === null) { if (fs.existsSync(settings.FILE)) fs.unlinkSync(settings.FILE); }
      else fs.writeFileSync(settings.FILE, before, "utf8");
      settings.init();
      audioImport.removeCustom();
    } catch (_) {}
  }

  // 注意：decodeBad 判的是"必须失败"，不能和其余的 ok 混在一起比
  const good = []
    .concat(out.steps.sniff || [], [out.steps.decode, out.steps.save])
    .filter(Boolean)
    .every((s) => s.pass !== false && s.ok !== false);
  const badRejected = !!(out.steps.decodeBad && out.steps.decodeBad.ok === false);
  const playOk = !!(out.steps.play &&
    out.steps.play.first === true && out.steps.play.deduped === false && out.steps.play.forced === true);
  out.ok = good && badRejected && playOk &&
    !!(out.steps.selectPreset && out.steps.selectPreset.soundId === "bell");

  fs.writeFileSync(path.join(__dirname, "snd-test.json"), JSON.stringify(out, null, 2), "utf8");
  console.log("[sndtest]", JSON.stringify({ ok: out.ok, steps: out.steps },
    (k, v) => (k === "wav" && v) ? "<" + String(v).length + " chars>" : v, 2));
  return out;
}


/**
 * --wxtest 的无障碍靶子：一个 WinForms 窗口，里面放一个文字正好是「访问网页」的按钮。
 *
 * 为什么不用自家 Electron 窗口当靶子：Chromium 的 DOM 无障碍树建不建、
 * 什么时候建，是渲染进程自己的事（实测 UIA 只看到 6 个 "Chrome Legacy Window"），
 * 拿它测到的是 Chromium 的行为，不是我们「走树 → 匹配名字 → 取可点坐标」的逻辑。
 * 标准 Win32 控件的 UIA 名字稳定可靠，正好用来验证这条链路。
 *
 * 传给 -Command 的是纯 ASCII 脚本，中文按钮文字走 base64：命令行编码不可信。
 */
const UIA_FIXTURE_PS = (() => {
  const label = Buffer.from(wechatAuto.NEEDLE, "utf8").toString("base64");
  return [
    "Add-Type -AssemblyName System.Windows.Forms,System.Drawing;",
    "$t=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + label + "'));",
    "$f=New-Object System.Windows.Forms.Form;",
    "$f.Text='QR UIA Fixture';$f.StartPosition='Manual';$f.ShowInTaskbar=$false;",
    "$f.Location=New-Object System.Drawing.Point(120,120);",
    // 置顶：像素判据是直接读屏幕上那一块，窗口一旦被别的窗口盖住，
    // 读到的就是遮挡物的画面，而且 Windows 会把重绘推迟到窗口重新可见，
    // 于是"点了有反应"要等到窗口期最后一刻才被看到。
    "$f.TopMost=$true;",
    "$f.Size=New-Object System.Drawing.Size(460,400);",
    "$cs=$f.ClientSize;$q=[int]($cs.Height/4);",
    // block 1: repaint only -- exercises the pixel path.
    // Deliberately no Controls.Clear(): mutating the control collection from
    // inside that collection's own event leaves the form half-updated, which
    // made the click look like it never happened.
    "$b1=New-Object System.Windows.Forms.Button;",
    "$b1.Text=$t;",
    "$b1.Location=New-Object System.Drawing.Point(0,0);",
    "$b1.Size=New-Object System.Drawing.Size($cs.Width,$q);",
    "$b1.Add_Click({ $f.BackColor=[System.Drawing.Color]::FromArgb(16,32,160); $b1.Text='LOADED' });",
    // block 2: changes only the window title -- exercises the title path
    "$b2=New-Object System.Windows.Forms.Button;",
    "$b2.Text='title';",
    "$b2.Location=New-Object System.Drawing.Point(0,$q);",
    "$b2.Size=New-Object System.Drawing.Size($cs.Width,$q);",
    "$b2.Add_Click({ $f.Text='QR Fixture Navigated' });",
    // block 3: opens a brand-new top-level window -- exercises the window path.
    // The new form is kept alive through $f.Tag: an event handler's local
    // variable dies as soon as the handler returns, and the form would then be
    // collected -- the window flashes and vanishes, which looks exactly like
    // "the click opened nothing".
    "$b3=New-Object System.Windows.Forms.Button;",
    "$b3.Text='open';",
    "$b3.Location=New-Object System.Drawing.Point(0,$q*2);",
    "$b3.Size=New-Object System.Drawing.Size($cs.Width,$q);",
    "$b3.Add_Click({ $g=New-Object System.Windows.Forms.Form; $g.Text='QR Fixture Target'; $g.StartPosition='CenterScreen'; $g.ShowInTaskbar=$false; $g.Size=New-Object System.Drawing.Size(320,220); $g.Show(); $f.Tag=$g });",
    // block 4: blank, a click here changes nothing at all
    "$p4=New-Object System.Windows.Forms.Panel;",
    "$p4.Location=New-Object System.Drawing.Point(0,$q*3);",
    "$p4.Size=New-Object System.Drawing.Size($cs.Width,$q);",
    "$f.Controls.Add($b1);$f.Controls.Add($b2);$f.Controls.Add($b3);$f.Controls.Add($p4);$f.Show();",
    "$end=(Get-Date).AddSeconds(45);",
    "while((Get-Date) -lt $end){[System.Windows.Forms.Application]::DoEvents();Start-Sleep -Milliseconds 60};",
    "$f.Close()",
  ].join("");
})();

/**
 * 微信窗口识别自测（--wxtest）
 *
 * 只覆盖本次改动，不动老功能：
 *   family —— 按进程树认亲，四个子用例
 *     F1 tree   wxprobe 必须同时纳入 Weixin 与 WeChatAppEx，且排除
 *               WeixinUpdate（它的窗口标题也叫「微信」，是误判来源）
 *     F2 uia    uiafind 传「无关 pid + 靶子 pid」能命中；只传无关 pid 不命中
 *     F3 click  落点属于家族才点；不属于则拒绝且不动鼠标
 *     F4 keys   前台校验按家族判断：家族内放行，家族外拒绝且不按键
 *   logic —— diffWindows / freshWindows / planModes（before 快照语义变了）
 *   live  —— 真实微信上只读跑一遍，记录 familyWindows 供观察，不计入通过
 *
 * 靶子是 UIA_FIXTURE_PS 起的 WinForms 窗口：标准 Win32 控件有稳定的
 * 无障碍名字，对它点击/按键都没有副作用 —— 全程不会操作真实微信。
 * 产物：wx-test/report.json，随时可跑。
 */
async function runWxTest() {
  const dir = path.join(__dirname, "wx-test");
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  const out = { ok: false, steps: {} };
  bootLog("wxtest: start");

  // ---- 1) 认亲：本次改动的核心 ----
  //
  // 要验证的假设：搜一搜结果页由 WeChatAppEx.exe（微信内置浏览器宿主）
  // 渲染，那是一个独立进程。旧判定"前台窗口 == Weixin 主窗口句柄"必然误判，
  // 旧做法"只走 Weixin 的 UIA 树"也看不到结果页。
  //
  // 靶子用 UIA_FIXTURE_PS 起的 WinForms 窗口：标准 Win32 控件必有稳定的
  // 无障碍名字，且对它点击/按键都没有副作用 —— 不会碰到真实微信。
  const fam = { ok: false, tree: null, uia: null, click: null, feedback: null, keys: null };
  let host = null;
  try {
    // F1 进程树本身（真实微信，只读，不动键鼠）
    // full:true —— 进程名是纯诊断信息，正式流程里已经不算了（每个 pid 一次
    // Get-Process，18 个要 189ms），只有这条断言需要它。
    const pre = await wechatAuto.probeTarget({ full: true });
    if (!pre.ok) {
      fam.tree = { ok: false, error: pre.error || "no-wechat-window" };
    } else {
      const names = (pre.members || []).map((m) => String(m.name || ""));
      const count = (re) => names.filter((n) => re.test(n)).length;
      const weixin = count(/^(Weixin|WeChat)$/i);
      const appex = count(/WeChatAppEx/i);
      const updater = count(/Update/i);
      fam.tree = {
        // Weixin 必须在；WeChatAppEx 必须在（结果页在它里面渲染）；
        // Update 必须不在 —— 它的窗口标题也叫「微信」，正是误判的来源
        ok: weixin >= 1 && appex >= 1 && updater === 0 && pre.pidsFrom === "tree",
        pidsFrom: pre.pidsFrom,
        total: pre.pids.length,
        weixin, appex, updater,
        pids: pre.pids,
        targetHow: pre.how,
        target: pre.target,
        familyWindows: (pre.familyWindows || []).map((w) => ({
          hwnd: w.hwnd, pid: w.pid, cls: w.cls, w: w.w, h: w.h, title: w.title,
        })),
      };
    }

    host = spawn("powershell.exe", [
      "-NoProfile", "-WindowStyle", "Hidden", "-Command", UIA_FIXTURE_PS,
    ], { windowsHide: true });
    await delay(1800);

    const wl = await wechatAuto._runPS(["-Action", "windows"], 10000);
    const hw = (wl.list || []).find((w) => w.pid === host.pid);
    if (!hw) throw new Error("靶子窗口没出现（pid " + host.pid + "）");

    // 先把靶子提到最前。下面所有点击都是按屏幕绝对坐标发的，
    // 只要它被任何一个窗口盖住，就会点到那个窗口上（第一次跑就踩到了：
    // 落点命中了 WorkBuddy 自己的窗口）。keys 传空键，只做抢前台不做别的。
    await wechatAuto._runPS([
      "-Action", "keys", "-Keys", "", "-WaitMs", "0",
      "-Pids", String(host.pid), "-Win", String(hw.hwnd),
    ], 15000);
    await delay(350);

    // 用 shot 顺带拿屏幕矩形：坐标不能硬编码 —— WinForms 的 (300,300) 是
    // 逻辑坐标，ps1 那边是物理像素，高 DPI 下差一个缩放比
    const cap = await wechatAuto._runPS([
      "-Action", "shot", "-Hwnd", String(hw.hwnd), "-Out", path.join(dir, "fixture-window.png"),
    ], 12000);
    if (!cap.ok) throw new Error("靶子截图失败: " + cap.error);
    const R = cap.rect;
    // 落在下方空白面板：那里点下去什么都不会发生，正好用来只验证
    // "落点属于谁"，不制造任何副作用
    const cx = R.x + Math.round(R.w * 0.5);
    const cy = R.y + Math.round(R.h * 0.85);

    // 先确认这个点真的属于靶子，否则下面的点击用例会点到别的东西上
    const hit = await wechatAuto._runPS(["-Action", "hit", "-X", String(cx), "-Y", String(cy)], 10000);
    if (!hit.ok || hit.pid !== host.pid) {
      throw new Error("落点不属于靶子（命中 pid " + (hit.pid || 0) + "，期望 " + host.pid + "）");
    }

    // F2 UIA：传整个 pid 集合必须能命中，只传无关 pid 必须不命中
    const multi = await wechatAuto._findUia([process.pid, host.pid]);
    const wrong = await wechatAuto._findUia([process.pid]);
    fam.uia = {
      ok: !!multi.ok && multi.point.detail.name.indexOf(wechatAuto.NEEDLE) >= 0 && !wrong.ok,
      multiPid: multi.ok
        ? { name: multi.point.detail.name, x: multi.point.x, y: multi.point.y }
        : { error: multi.error },
      wrongPid: wrong.ok ? { unexpected: wrong.point.detail.name } : { error: wrong.error },
    };

    // F3 点击落点校验：归我的才点，不归我的拒绝
    // 这里只关心"点不点"，不关心点完有没有反应，所以窗口期给短一点
    const inFam = await wechatAuto._runPS([
      "-Action", "click", "-X", String(cx), "-Y", String(cy),
      "-Pids", String(host.pid), "-PollMs", "600",
    ], 12000);
    const outFam = await wechatAuto._runPS([
      "-Action", "click", "-X", String(cx), "-Y", String(cy), "-Pids", String(process.pid),
    ], 12000);
    fam.click = {
      ok: !!inFam.ok && !outFam.ok && outFam.why === "point-outside-family",
      inFamily: { ok: !!inFam.ok, beforeCount: Array.isArray(inFam.before) ? inFam.before.length : null },
      outsideFamily: {
        ok: !!outFam.ok, why: outFam.why || null, error: outFam.error || null,
        hit: outFam.got ? { pid: outFam.got.pid, title: outFam.got.title } : null,
      },
    };

    // F5 点击后「有没有反应」的三种判据（本次改动的核心）
    //
    // 靶子客户区被切成四块：
    //   块1 只重绘（背景+按钮文字）  -> pixels
    //   块2 只改窗口标题             -> title
    //   块4 空白，点下去什么都没变    -> none
    //
    // 这三条正是本次改动要证明的：网页开在微信当前窗口里时根本没有新窗口，
    // 只有"画面变了"这一个证据可用；而"什么都没变"必须仍然判成没打开，
    // 不能因为放宽判据就一律报成功。
    //
    // 块3（点一下新开一个窗口）曾经也测，但 WinForms 在事件处理器里 Show()
    // 第二个窗体时会连带把主窗体弄挂，后续用例全部 not-foreground。那一条
    // 本来就是旧判据，logic 用例已经覆盖了窗口差集，这里不再重复。
    const at = (fy) => ({ x: R.x + Math.round(R.w * 0.5), y: R.y + Math.round(R.h * fy) });
    const pTtl = at(0.412), pPix = at(0.185), pNone = at(0.868);

    // 诊断：三个候选点各自落在哪个窗口上。点击是按绝对坐标发的，
    // 坐标偏出控件就会点空，光看 verdict 猜不出来。
    const probeHits = {};
    for (const [name, p] of [["title", pTtl], ["pixels", pPix], ["none", pNone]]) {
      const h = await wechatAuto._runPS(["-Action", "hit", "-X", String(p.x), "-Y", String(p.y)], 10000);
      probeHits[name] = { x: p.x, y: p.y, pid: h.pid || 0, cls: h.cls || "", title: h.title || "" };
    }

    const rTtl = await wechatAuto._runPS([
      "-Action", "click", "-X", String(pTtl.x), "-Y", String(pTtl.y),
      "-Pids", String(host.pid), "-PollMs", "3000",
    ], 15000);
    await delay(300);

    const rPix = await wechatAuto._runPS([
      "-Action", "click", "-X", String(pPix.x), "-Y", String(pPix.y),
      "-Pids", String(host.pid), "-PollMs", "3000",
    ], 15000);
    await delay(400);

    const rNone = await wechatAuto._runPS([
      "-Action", "click", "-X", String(pNone.x), "-Y", String(pNone.y),
      "-Pids", String(host.pid), "-PollMs", "1200",
    ], 15000);

    fam.feedback = {
      ok: rTtl.verdict === "title" && rPix.verdict === "pixels" && rNone.verdict === "none",
      hits: probeHits,
      title: { verdict: rTtl.verdict, waited: rTtl.waited, error: rTtl.error || null },
      pixels: { verdict: rPix.verdict, diff: rPix.pixelDiff, waited: rPix.waited, error: rPix.error || null, trail: rPix.trail || [] },
      none: { verdict: rNone.verdict, diff: rNone.pixelDiff, waited: rNone.waited, error: rNone.error || null },
    };

    // F4 敲键的前台校验按家族判断。
    // -Keys "" 一个键都不发，只跑"抢前台 → 校验"这一段，所以不会真打字。
    const kIn = await wechatAuto._runPS([
      "-Action", "keys", "-Keys", "", "-WaitMs", "0",
      "-Pids", String(host.pid), "-Win", String(hw.hwnd),
    ], 15000);
    const kOut = await wechatAuto._runPS([
      "-Action", "keys", "-Keys", "", "-WaitMs", "0",
      "-Pids", "1", "-Win", String(hw.hwnd),
    ], 15000);
    fam.keys = {
      ok: !!kIn.ok && !kOut.ok && kOut.error === "not-foreground",
      // 参考项，不计入通过条件：能不能把靶子抢到前台取决于 Windows 的
      // 前台锁，而靶子是个后台 PowerShell 进程，系统经常不给。真实场景里
      // 目标窗口是用户刚刚用过的微信，不受这个限制；这里失败只说明测试
      // 环境抢不到前台，不说明家族校验有问题。
      advisory: true,
      inFamily: {
        ok: !!kIn.ok, hwnd: kIn.hwnd || null,
        error: kIn.error || null,
        got: kIn.got ? { pid: kIn.got.pid, title: kIn.got.title } : null,
      },
      outsideFamily: {
        ok: !!kOut.ok, error: kOut.error || null,
        got: kOut.got ? { pid: kOut.got.pid, title: kOut.got.title } : null,
      },
    };
  } catch (e) {
    fam.error = (e && e.message) || String(e);
  } finally {
    try { if (host) host.kill(); } catch (_) {}
  }
  fam.ok = !!(fam.tree && fam.tree.ok && fam.uia && fam.uia.ok &&
    fam.click && fam.click.ok && fam.feedback && fam.feedback.ok);
  out.steps.family = fam;

  // ---- 2) 纯逻辑用例 ----
  const before = [{ hwnd: 1, title: "微信" }, { hwnd: 2, title: "文档.docx - Word" }];
  const after = [{ hwnd: 1, title: "微信" }, { hwnd: 2, title: "文档.docx - Word" },
    { hwnd: 3, title: "扫码登录 - 浏览器" }, { hwnd: 4, title: "微信文件传输助手" }];
  // diffWindows 只算"多出来的窗口"，freshWindows 再剔掉标题含微信的内部窗口
  const diff = wechatAuto._diffWindows(before, after);
  const kept = wechatAuto._freshWindows(before, after);
  const planAuto = wechatAuto._planModes("auto").join(">");
  const planOcr = wechatAuto._planModes("ocr").join(">");
  const planBad = wechatAuto._planModes("乱写").join(">");
  const logic = {
    ok: planAuto === "uia>ocr>region" && planOcr === "ocr" && planBad === "uia>ocr>region" &&
      diff.length === 2 && kept.length === 1 && kept[0].hwnd === 3,
    planAuto, planOcr, planBad,
    diff: { all: diff.map((w) => w.title), kept: kept.map((w) => w.title) },
  };
  out.steps.logic = logic;

  // ---- 3) 真实微信窗口：三种方式只读定位一遍（点不下去，只看能不能找到） ----
  try {
    const live = await wechatAuto.diagnose();
    if (!live.ok) {
      out.steps.live = { ran: false, error: live.error || "no-wechat-window" };
    } else {
      if (live.shot) {
        try { fs.copyFileSync(live.shot, path.join(dir, "live.png")); } catch (_) {}
      }
      out.steps.live = {
        ran: true,
        rect: live.rect,
        // 认亲结果：pids 里应该同时有 Weixin 和 WeChatAppEx；
        // familyWindows 列出这棵树当前持有的可见窗口
        family: {
          pids: live.family.pids,
          from: live.family.from,
          targetHow: live.family.targetHow,
          target: live.family.target,
          windows: (live.family.windows || []).map((w) => ({
            hwnd: w.hwnd, pid: w.pid, cls: w.cls, w: w.w, h: w.h, title: w.title,
          })),
        },
        region: live.region,
        ocr: { ok: live.ocr.ok, error: live.ocr.error || null,
          point: live.ocr.ok ? { x: live.ocr.point.x, y: live.ocr.point.y } : null,
          text: live.ocr.ok ? live.ocr.point.detail.text : null },
        uia: { ok: live.uia.ok, error: live.uia.error || null,
          point: live.uia.ok ? { x: live.uia.point.x, y: live.uia.point.y } : null,
          name: live.uia.ok ? live.uia.point.detail.name : null },
      };
    }
  } catch (e) {
    out.steps.live = { ran: false, error: (e && e.message) || String(e) };
  }

  // 本次只验收改动部分：认亲（tree/uia/click/keys 四项）+ 相关纯逻辑。
  // live 是只读诊断，记录进报告供观察，不作为通过条件。
  out.ok = !!(fam.ok && logic.ok);
  bootLog("wxtest: done ok=" + out.ok +
    " tree=" + (fam.tree && fam.tree.ok) +
    " uia=" + (fam.uia && fam.uia.ok) +
    " click=" + (fam.click && fam.click.ok) +
    " feedback=" + (fam.feedback && fam.feedback.ok) +
    " keys=" + (fam.keys && fam.keys.ok) +
    " logic=" + logic.ok);

  fs.writeFileSync(path.join(dir, "report.json"), JSON.stringify(out, null, 2), "utf8");
  console.log("[wxtest]", JSON.stringify(out, null, 2));
  return out;
}


// ---------- 生命周期 ----------

app.whenReady().then(() => {
  bootLog("whenReady");
  settings.init();

  // 第二批（常驻 worker）：提前把 powershell 助手拉起来。
  // 进程启动 + Add-Type 编译 + 首次 JIT 约 0.7~1.1s，这段正好落在用户还在
  // 扫码的那几秒里，对用户免费；不预热的话它整段出现在交接的关键路径上。
  // 不 await：它和创建窗口没有依赖关系，失败也只影响那一次交接（会退回
  // 一次性子进程或直接报 worker 相关错误，见 wechat-auto.js 的重启上限）。
  wechatAuto.prewarmWorker().then((r) => {
    if (r && r.ok) bootLog("worker warm " + r.bootMs + "ms");
    else bootLog("worker prewarm failed: " + ((r && r.error) || "?"));
  }).catch((e) => bootLog("worker prewarm threw: " + ((e && e.message) || e)));

  if (SELFTEST) { runSelfTest(); return; }
  // 环境自检的独立入口：打包后没有终端，靠它验证"内置运行时真的能用"。
  // 结果同时写到数据目录的 envcheck.json，发布前可以直接看。
  if (ENVCHECK) { runEnvCheckCli(); return; }
  // 「关于」页那份信息（版本/证书/域名数）的命令行出口，用来核对 P2-B 的计数。
  if (process.argv.includes("--appinfo")) { runAppInfoCli(); return; }
  if (UITEST) { runUiTest(); return; }
  if (SNDTEST) {
    runSoundTest()
      .catch((e) => bootLog("sndtest failed: " + ((e && e.stack) || e)))
      .finally(() => setTimeout(() => app.exit(0), 300));
    return;
  }
  if (WXTEST) {
    runWxTest()
      .catch((e) => bootLog("wxtest failed: " + ((e && e.stack) || e)))
      .finally(() => setTimeout(() => app.exit(0), 300));
    return;
  }

  // 上次异常退出可能把系统代理留在"指向代理"的状态，静默还原一次。
  // 正常情况下这里什么都不会做（没有残留文件）。
  proxyMgr.heal().catch(() => {});

  createLauncher();
  bootLog("launcher created, shotDir=" + (SHOT_DIR || "-"));

  const st = settings.get();
  if (!registerHotkey(st.hotkey)) {
    bootLog("hotkey failed: " + st.hotkey);
  }
  ensureTray(st.closeAction === "tray");
  bootLog("tray ok=" + !!tray);

  // 托盘菜单里的"移动端环境"状态要跟着代理变化刷新
  proxyMgr.onChange(() => refreshTrayMenu());

  // 系统深浅色变了，"跟随系统"要立刻跟上
  const { nativeTheme } = require("electron");
  nativeTheme.on("updated", () => {
    broadcast("qr:system-theme", { dark: nativeTheme.shouldUseDarkColors });
  });

  if (SHOT_DIR) {
    bootLog("runShots -> " + SHOT_DIR);
    runShots(SHOT_DIR).finally(() => setTimeout(() => app.exit(0), 300));
  }
}).catch((e) => {
  // 启动链路任何一步抛错，以前是彻底静默：窗口可能已经出来了但功能全废。
  // 现在至少落到 boot.log 里，并且用错误框告诉用户。
  bootLog("startup failed: " + ((e && e.stack) || e));
  try {
    require("electron").dialog.showErrorBox("启动失败", String((e && e.message) || e) + "\n\n详见 desktop/boot.log");
  } catch (_) {}
});

app.on("window-all-closed", () => {
  // --wxtest 会先开再关一个仿真窗口：那是测试流程的一部分，
  // 不能让 window-all-closed 把还没写完 report.json 的进程带走。
  if (WXTEST) return;
  // 代理是否还原，已经在关闭主窗口时处理过了（见 createLauncher 里的 close 拦截）。
  // 走到这里说明用户要么没开代理，要么已经确认关闭。
  app.quit();
});

// 代理开着时退出：先还原系统代理再退，避免把用户机器留在"全局走代理"的状态。
// 万一这里没跑成（强杀/蓝屏），python 侧还有 parent-pid 守护兜底。
app.on("before-quit", (e) => {
  if (quitting) return;
  if (!proxyMgr.isActive()) return;
  e.preventDefault();
  quitting = true;
  proxyMgr.stop("app-quit")
    .catch(() => {})
    .then(() => app.quit());
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  // 常驻 worker 必须在这里关掉，否则会留下一个没有人喂 JSON 的 powershell。
  // 关 stdin 就是它的退出信号，它自己会走完循环退出（见 win-helper.ps1）。
  try { wechatAuto.stopWorker(); } catch (_) {}
});

"use strict";

/**
 * 微信「搜一搜」自动打开 —— 三套定位方式，不再依赖任何人工标定
 *
 * 背景见《搜一搜直达-方案设计.md》与用户的实测结论：
 *   · 结果第一条不能用键盘选中（↓ / Tab + Enter 均不通）
 *   · 微信 4.x 聊天区是 Qt 自绘，UIAutomation 拿不到控件；
 *     但「搜一搜」结果页在内置 webview 里渲染，网页层可能暴露无障碍树
 *   · 固定坐标/人工标定在实际使用场景多样时适用性差 —— 已删除
 *
 * 三套定位方式（设置里可选，auto = 依次尝试）：
 *   S2 uia    ：走 UI Automation 树找名字含「访问网页」的元素，拿它的可点坐标
 *   S3 ocr    ：截图后用 Windows 内置 OCR 找「访问网页」四个字，点文字中心
 *   S1 region ：扫一张截图找「第一条结果那张浅色大卡片」，点卡片中央
 *
 * 三条硬约束，改代码时别破坏：
 *   1. 敲键前必须确认前台窗口就是微信（win-helper.ps1 里做），否则立刻放弃
 *   2. 点完必须校验：出现新的顶层窗口才算成功；没出现就停下，不重试、不乱点
 *   3. 找不到目标就不点 —— 宁可少一步，也不能盲点
 */

const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { clipboard, nativeImage } = require("electron");

// ---- 分段计时（临时诊断设施）----
// 会话由 main.js 的 qr:wx-open 用 T.begin() 开、T.finish() 关；
// 这里只负责往当前会话里打节点。s 为 null 时所有调用是空操作，
// 所以 --wxtest 之类不走 wx-open 的路径完全不受影响。
// 定位问题后要删：删本行 + 下面所有 T.mark( / T.meter( 即可。
const T = require("./timing");

// 每个 ps1 动作「干什么」的说明，写进 timing.log 的调用明细里。
// 只有一列文字，删掉不影响任何逻辑。
const ACTION_NOTE = {
  wxprobe: "认亲：进程树 pid 集合 + 主窗口 + 目标窗口 rect",
  keys: "抢前台 + Ctrl+F/粘贴/回车 + 等结果 + 截图 + 枚举窗口",
  shot: "把目标窗口截成 PNG",
  uiafind: "走 UIA 树找「访问网页」，取元素可点坐标（无果时每 120ms 复查，最多 8 遍）",
  ocr: "WinRT OCR 识别截图里的「访问网页」",
  click: "落点校验 + 左键点击 + 轮询判定是否真的打开",
  hit: "查某个屏幕坐标属于哪个窗口（只读）",
  windows: "枚举可见顶层窗口",
};

const PS1 = require("./paths").asset("win-helper.ps1");
const TMP = path.join(os.tmpdir(), "qrscan-wechat");

// 按了回车之后「最多等多久」让搜索结果出来。
//
// 注意语义在第三批变了：以前是「睡满这么久」，现在是**上限** —— ps1 在 Enter
// 之后每 40ms 采一次结果区的画面指纹，看到页面变化且不再动就立刻返回，
// 真等不到才睡到这个上限。所以这个值现在只需要「够大」，不需要「刚好」。
// 实测旧的固定 sleep 是 1501~1515ms、CV 0.3%（从不检测），而 click 的
// waited 只有 267ms —— 说明页面远早于 1.5s 就已经有可见变化。
//
// 想退回旧行为（固定 sleep）用 QRSCAN_READY=0，不必改这里：
//   Windows(cmd):   set QRSCAN_READY=0 && npm start
// 想临时降低上限（零代码实验）仍然用 QRSCAN_WAIT_MS：
//   Windows(cmd):   set QRSCAN_WAIT_MS=600 && npm start
// 允许 0~6000；非法值或未设置时一律回到 1500。实际生效的值会写进
// timing.log 的表头（wait=600）和 keys 节点的说明里，便于对比不同批次。
function readWaitMs() {
  const raw = process.env.QRSCAN_WAIT_MS;
  if (raw == null || String(raw).trim() === "") return 1500;
  const n = parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(n) || n < 0 || n > 6000) return 1500;
  return n;
}
const WAIT_RESULT_MS = readWaitMs();

// 就绪轮询的总开关（第三批 F2）。0 = 退回「Enter 之后睡满 WaitMs」。
// 它有两个作用，缺一不可：
//   1. 一键回退：轮询判据万一在某个版本上失效，不至于只能改代码；
//   2. 同一台机器上直接 A/B：不依赖任何估算就知道这项到底省了多少。
const READY_OFF = String(process.env.QRSCAN_READY || "").trim() === "0";
const READY_ON = !READY_OFF;

// 点击之后「看到反应」的窗口期。以前是死等 900ms 再枚举一次窗口，
// 结果慢一点的网页会先被判定成"没打开"，然后页面才出来 —— 于是用户
// 明明看到了网页，却收到一条失败通知。
// 现在改成在这个窗口期内每 250ms 探一次，三种证据任一成立就算打开。
const CLICK_POLL_MS = 4000;

// 「第一条结果」卡片上要找的字。卡片标题、无障碍名、OCR 文本里都含它。
const NEEDLE = "访问网页";

// S1 区域检测的参数（都是相对窗口的比例，不依赖绝对坐标）：
//   只在 x∈[0.30,0.72] 采样 —— 避开左侧功能区和右侧 › 箭头
//   只在 y∈[0.10,0.70] 扫描 —— 避开顶部标签页，也不关心太靠下的结果
//   「浅」是相对概念：比扫描区 20 分位亮度亮出 lightDelta 才算。
//   为什么用 20 分位而不是中位数：结果页上亮的东西本来就多（搜索框、多张卡片），
//   中位数会被抬到"卡片亮度"上去，阈值一高整张卡片反而被判成暗 —— 实测踩过。
//   用低分位当背景估计，深色/浅色主题都成立；minBand 用来滤掉搜索框这类矮条
const REG = {
  x0: 0.30, x1: 0.72,
  y0: 0.10, y1: 0.70,
  lightDelta: 15,   // 比背景亮度亮多少算「卡片」
  minBand: 62,      // 卡片高度下限（搜索框 ~40~48px，卡片 ~70~110px）
  maxBand: 420,     // 高度上限：整页都亮说明判断错了，不算
};

// auto 模式的尝试顺序：无障碍最干净 → OCR 更抗改版 → 区域点击兜底
const AUTO_ORDER = ["uia", "ocr", "region"];

// 最近一次识别的中间量，--wxtest 会打进 report.json，调参时不用靠猜
let lastDebug = null;

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function ensureTmp() {
  try { fs.mkdirSync(TMP, { recursive: true }); } catch (_) {}
  return TMP;
}

/** ps1 的 -Target 参数只吃 base64(UTF-8)：文件本身必须保持纯 ASCII */
function b64(s) {
  return Buffer.from(String(s), "utf8").toString("base64");
}

function unb64(s) {
  try { return Buffer.from(String(s), "base64").toString("utf8"); }
  catch (_) { return ""; }
}

// ---------------------------------------------------------------- 常驻 worker
//
// 一个长期活着的 powershell（win-helper.ps1 -Serve），一行 JSON 进、一行出。
//
// 为什么值得：每次调用约 845ms 的「进程启动 + 退出」是跟"做什么动作"完全
// 无关的固定成本，4 次调用就是 3.4 秒、占整条链路 40%。常驻之后这笔钱
// 只在启动时付一次，而且正好付在用户还在扫码的那几秒里。
//
// 四条约束（改这里时别破坏）：
//   1. 它是单点：卡住就是所有动作一起卡。所以每次请求都带超时，超时就判死
//      重启，不等它自己好。
//   2. 应答必须按 id 配对 —— 管道里可能同时躺着两条请求的应答。
//   3. 连续重启超过 MAX_RESTARTS 就放弃，不做无限重试（无限重试会把
//      "启动失败"变成"卡住不动"）。
//   4. QRSCAN_WORKER=0 走一次性子进程。它既是一键回退，也是在同一台机器上
//      直接 A/B 对比两条路真实差距的唯一办法。
const WORKER_OFF = String(process.env.QRSCAN_WORKER || "").trim() === "0";
const MAX_RESTARTS = 2;

const W = {
  proc: null,          // 子进程；null = 当前没有活的 worker
  seq: 0,              // 请求 id 自增
  pending: new Map(),  // id -> { resolve, timer }
  restarts: 0,         // 连续重启次数（任意一次成功应答即归零）
  spawned: 0,          // 累计启动次数（诊断用）
  bootMs: 0,           // 最近一次：从 spawn 到第一条应答的毫秒数
  buf: "",             // stdout 行缓冲
  err: "",             // stderr 尾部（只用于失败时说明原因）
};

// 命令行参数名 → 协议字段名。协议里用短名（a=action，o=options），
// 因为一行 JSON 要尽量短，且 ps1 的 Get-Opt 是按短名取的。
const OPT_KEY = {
  out: "out", waitms: "wait", x: "x", y: "y", keys: "keys", target: "target",
  targetpid: "targetpid", pids: "pids", file: "file", hwnd: "hwnd",
  win: "win", pollms: "poll", ready: "ready",
};

/**
 * 把老的命令行参数翻译成一条 worker 请求。
 * runPS 的调用方（7 处，含 --wxtest）继续写 ["-Action","keys","-WaitMs","1500"]，
 * 不必知道底下已经换成了协议 —— 这样两种模式共用同一份调用代码。
 *
 * 值一律原样传字符串：类型转换只在 ps1 的 Get-Opt 里按默认值做一次，
 * 免得 JS 与 ps1 各有一套"什么算数字"的判断。
 */
function argsToRequest(args) {
  const a = args[0] === "-Action" ? String(args[1] || "") : "";
  const o = {};
  for (let i = 2; i < args.length; i++) {
    const flag = String(args[i] || "");
    if (flag.charAt(0) !== "-") continue;
    const name = flag.replace(/^--?/, "").toLowerCase();
    if (name === "full") { o.full = true; continue; }     // 唯一的开关型参数
    const key = OPT_KEY[name];
    if (!key) continue;
    const v = args[i + 1];
    if (v == null) continue;
    i++;
    o[key] = v;
  }
  return { a: a, o: o };
}

/** 把一条 stdout 行交给对应的等待者。非 JSON 行直接忽略（动作里若有意外的输出）。 */
function onWorkerLine(line) {
  const s = String(line || "").trim();
  if (!s || s.charAt(0) !== "{") return;
  let obj = null;
  try { obj = JSON.parse(s); } catch (_) { return; }
  const id = obj && obj.id;
  if (id == null) return;
  const p = W.pending.get(id);
  if (!p) return;                       // 超时之后迟到的应答，丢掉
  W.pending.delete(id);
  clearTimeout(p.timer);
  W.restarts = 0;                       // 能应答就是活的，重启链到此为止
  p.resolve(obj);
}

function dropPending(err) {
  for (const [, p] of W.pending) {
    clearTimeout(p.timer);
    p.resolve(err);
  }
  W.pending.clear();
}

function spawnWorker() {
  if (W.spawned > 0) W.restarts++;      // 这是一次替换，不是首次启动
  W.spawned++;
  W.buf = "";
  W.err = "";

  const child = spawn("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", PS1, "-Serve",
  ], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });

  W.proc = child;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  child.stdout.on("data", (chunk) => {
    W.buf += chunk;
    for (;;) {
      const m = W.buf.search(/\r?\n/);
      if (m < 0) break;
      const line = W.buf.slice(0, m);
      W.buf = W.buf.slice(m + (W.buf.charAt(m) === "\r" ? 2 : 1));
      onWorkerLine(line);
    }
  });
  child.stderr.on("data", (chunk) => {
    W.err = (W.err + chunk).slice(-800);
  });
  child.stdin.on("error", () => {});    // 进程已经死了还往里写：由 exit 兜底

  const gone = (code) => {
    if (W.proc === child) W.proc = null;
    W.buf = "";
    // 在途请求全部拒绝，不让调用方等满超时 —— 它们马上会被下一次调用重新发起
    dropPending({ ok: false, error: "worker-exit", code: code, stderr: W.err.slice(-300) });
  };
  child.on("exit", (code) => gone(code));
  child.on("error", (e) => {
    W.err = "spawn error: " + ((e && e.message) || e);
    gone(-1);
  });
  return child;
}

/** 没有活的 worker 就拉一个；已经连续重启到上限则返回 null（调用方报错）。 */
function ensureWorker() {
  if (WORKER_OFF) return null;
  if (W.proc) return W.proc;
  if (W.restarts >= MAX_RESTARTS) return null;
  return spawnWorker();
}

/**
 * 发一条请求并等它的应答。
 * @returns {Promise<object>} 与一次性进程模式的返回形状完全一致，上层无感
 */
function askWorker(req, timeoutMs) {
  return new Promise((resolve) => {
    const child = ensureWorker();
    if (!child) {
      return resolve({ ok: false, error: WORKER_OFF ? "worker-off" : "worker-restart-limit" });
    }
    const id = ++W.seq;
    const timer = setTimeout(() => {
      W.pending.delete(id);
      // 一次超时就判死：它已经证明自己不能在承诺时间内应答，而下一次调用
      // 重新拉起一个干净的代价只有一次启动。动作之间没有共享状态可丢。
      killWorker();
      resolve({ ok: false, error: "timeout" });
    }, timeoutMs || 15000);
    W.pending.set(id, { resolve: resolve, timer: timer, t0: Date.now() });
    try {
      child.stdin.write(JSON.stringify({ id: id, a: req.a, o: req.o || {} }) + "\n", "utf8");
    } catch (e) {
      clearTimeout(timer);
      W.pending.delete(id);
      resolve({ ok: false, error: "write:" + ((e && e.message) || e) });
    }
  });
}

/** 优雅关闭：关掉 stdin 就是 worker 的退出信号，等不到才强杀。 */
function stopWorker() {
  const child = W.proc;
  W.proc = null;
  if (!child) return;
  try { child.stdin.end(); } catch (_) {}
  const t = setTimeout(() => { try { child.kill(); } catch (_) {} }, 800);
  if (t.unref) t.unref();              // 别让这个定时器拖住应用退出
}

/** 判死重启：先拒掉在途请求，再按 stopWorker 的方式关掉。 */
function killWorker() {
  dropPending({ ok: false, error: "worker-killed" });
  stopWorker();
}

// 进程无论怎么退出（正常关闭、app.exit 的测试模式、崩溃），都不能把一个
// 没有人在喂 JSON 的 powershell 留在后台。stdin 一断 worker 自己也会退出，
// 这里再补一刀让它更确定。
process.on("exit", () => {
  const child = W.proc;
  W.proc = null;
  if (!child) return;
  try { child.stdin.destroy(); } catch (_) {}
  try { child.kill(); } catch (_) {}
});

/**
 * 提前把 worker 拉起来（main.js 的 whenReady 里调）。
 * 一次最便宜的只读动作就够：它让 ps1 跑完进程启动 + Add-Type 编译 + 预热，
 * 整段约 0.7~1.1s 落在用户还在扫码的那几秒里，而不是交接的关键路径上。
 */
async function prewarmWorker() {
  if (WORKER_OFF) return { ok: false, error: "worker-off" };
  const t0 = Date.now();
  const r = await askWorker({ a: "hit", o: { x: 0, y: 0 } }, 20000);
  W.bootMs = Date.now() - t0;
  if (!r || !r.ok) return { ok: false, error: (r && r.error) || "prewarm-failed" };
  return { ok: true, bootMs: W.bootMs };
}

/** 给 boot.log 用的状态快照：验收要求 restarts 为 0。 */
function workerStats() {
  return {
    mode: WORKER_OFF ? "spawn" : "worker",
    alive: !!W.proc,
    restarts: W.restarts,
    spawned: W.spawned,
    bootMs: W.bootMs,
    pending: W.pending.size,
  };
}

/**
 * 跑一次动作，返回它最后一行 JSON。
 *
 * 两套实现，同一个签名（调用点不必知道走的是哪条路）：
 *   worker —— 常驻进程，一行 JSON 进、一行出（默认）
 *   spawn  —— 一次性子进程（QRSCAN_WORKER=0）。每次约 0.6~0.9s 的启动与退出，
 *             但任何一次卡死都只影响那一次调用，不会留下需要收拾的状态。
 */
// ---- 分段计时（临时）：把每次子进程调用拆成「启动」与「干活」两截 ----
// 纯附加代码。删掉 metered() 与下面三处调用即可，runPS 的行为不变。
//
// 两种模式下 boot/tail 的含义不同，但 boot+tail 的含义是同一个：
//   固定开销（与动作无关、每次调用都要重付的部分）。
//   spawn  ：boot = 进程启动 + 解析 + 编译 C#，tail = JSON + 卸载 + 退出
//   worker ：boot ≈ 请求分发（0~3ms），tail = 管道往返 + JSON + 解析
// 所以时序表里 work 一列在两种模式下可以直接比，固定开销一列也可以。
function metered(args, t0, obj, mode) {
  if (!T.ENABLED) return;
  const action = args[0] === "-Action" ? String(args[1] || "?") : "?";
  const total = Date.now() - t0;
  const boot = Number(obj && obj.bootMs) || 0;
  const emitAt = Number(obj && obj.emitAt) || 0;
  const isWorker = mode === "worker";
  let work, tail;
  if (isWorker) {
    // ps1 的时钟在 worker 模式下是按请求重置的：emitAt - bootMs 就是这个
    // 动作自己花的时间，和一次性模式下的 work 同口径、可直接比。
    work = emitAt > boot ? emitAt - boot : 0;
    tail = Math.max(0, total - work);
  } else {
    // 一次性模式：三段必须闭合，emitAt 不合法时宁可整段算 work，
    // 也不去编一个数出来（这条规则是当年 tail=0 那个 bug 留下的教训）。
    const ok = boot > 0 && emitAt > boot && emitAt <= total;
    work = ok ? emitAt - boot : Math.max(0, total - boot);
    tail = ok ? total - emitAt : 0;
  }

  // 动作内部的细分（有就拼上，没有就只留动作说明）：
  //   keys 回报 fg/type/wait/target/shot/list —— 等结果、选窗口各占多少一眼可见
  //   hit  回报 enter/body          —— 用来标定「每次调用的下限」
  let note = ACTION_NOTE[action] || "";
  const t = obj && obj.t;
  if (t && t.wait != null) {
    // keys 的「等结果」在第三批之后不再等于「等结果窗口」（轮询会提前结束），
    // 所以把就绪判据和实际等待一起打出来：readyHow=fingerprint 说明真的看到了
    // 页面，timeout 说明睡满了上限（此时 readyPeak 就是该拿来调阈值的数）。
    const ready = obj && obj.readyHow
      ? `〔就绪 ${obj.readyHow}` +
        (obj.readyHow === "sleep" ? (obj.readyOn === false ? "(轮询关)" : "(无可采画面)") : "") +
        (obj.readyMs != null ? "/" + obj.readyMs + "ms" : "") +
        (obj.readyHow === "timeout" && obj.readyPeak != null && obj.readyPeak >= 0
          ? "，峰值差 " + obj.readyPeak : "") +
        "〕"
      : "";
    note += `（抢前台 ${t.fg} / 敲键 ${t.type} / 等结果 ${t.wait}` +
      (t.target != null ? ` / 选窗口 ${t.target}` : "") +
      ` / 截图 ${t.shot} / 枚举 ${t.list}）` + ready;
  } else if (t && t.body != null) {
    note += `（分发 ${t.enter} / 动作本体 ${t.body}）`;
  }
  // uiafind：第几遍才命中。配合「多遍短间隔」的重试策略，一眼看出页面是
  // 首查即中（attempt=1，正常）还是在等 Chromium 建无障碍树（attempt>1，
  // 每多一遍多 ~120ms；若长期 >4，该去查的是页面而不是轮询参数）。
  if (action === "uiafind" && obj && obj.attempt != null && obj.attempt > 1) {
    note += `〔第 ${obj.attempt} 遍才命中〕`;
  }
  T.meter({ action, mode: isWorker ? "worker" : "spawn", total, boot, work, tail, note });
}

/**
 * 一次性子进程实现（QRSCAN_WORKER=0 时的回退路径，也是原来的唯一实现）。
 * 保留原样：它是性能对照的基准，也是"worker 出问题"时的退路。
 */
function runPSSpawn(args, timeoutMs, t0) {
  return new Promise((resolve) => {
    const child = spawn("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", PS1,
    ].concat(args), { windowsHide: true });

    let out = "";
    let err = "";
    let done = false;

    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { child.kill(); } catch (_) {}
      metered(args, t0, { ok: false, error: "timeout" }, "spawn");
      resolve({ ok: false, error: "timeout" });
    }, timeoutMs || 15000);

    child.stdout.on("data", (b) => { out += b.toString("utf8"); });
    child.stderr.on("data", (b) => { err += b.toString("utf8"); });
    child.on("error", (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      metered(args, t0, { ok: false }, "spawn");
      resolve({ ok: false, error: "spawn:" + (e && e.message) });
    });
    child.on("close", () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const line = out.split(/\r?\n/).filter((s) => s.trim().startsWith("{")).pop();
      if (!line) {
        metered(args, t0, { ok: false }, "spawn");
        return resolve({ ok: false, error: "no-json", stderr: err.slice(0, 300) });
      }
      try {
        const obj = JSON.parse(line);
        metered(args, t0, obj, "spawn");
        resolve(obj);
      } catch (_) {
        metered(args, t0, { ok: false }, "spawn");
        resolve({ ok: false, error: "bad-json" });
      }
    });
  });
}

/**
 * 跑一次动作。默认走常驻 worker，QRSCAN_WORKER=0 时走一次性子进程。
 * 两种实现返回的形状完全一样，调用方无需关心（7 处调用点一行都没改）。
 */
function runPS(args, timeoutMs) {
  const t0 = Date.now();                       // ← 计时用
  if (WORKER_OFF) return runPSSpawn(args, timeoutMs, t0);
  const req = argsToRequest(args);
  if (!req.a) return Promise.resolve({ ok: false, error: "bad-args" });
  return askWorker(req, timeoutMs).then((obj) => {
    metered(args, t0, obj, "worker");
    return obj;
  });
}

// ---------------------------------------------------------------- 像素工具

function lumaAt(buf, w, x, y) {
  const i = (y * w + x) * 4;               // BGRA
  return (0.299 * buf[i + 2] + 0.587 * buf[i + 1] + 0.114 * buf[i]) | 0;
}

/** 取一张图的灰度矩阵（只取一次，后面检测复用） */
function toGray(image) {
  const buf = image.toBitmap();
  if (!buf || !buf.length) return null;

  // getSize() 与 toBitmap() 不一定同尺度：capturePage 给的 nativeImage 中
  // getSize 是逻辑像素（886×587），toBitmap 是物理像素（1108×734）。
  // 直接信任 getSize 会算错缓冲长度，旧代码只处理了"变大"这一种情况，
  // 于是 capturePage 的图一律被判成 null —— 这里按长度 + 宽高比反推两者。
  const size = image.getSize();
  let w = size.width;
  let h = size.height;
  if (buf.length !== w * h * 4) {
    const ratio = size.width / size.height;
    const area = buf.length / 4;                 // 像素总数
    h = Math.round(Math.sqrt(area / ratio));
    w = Math.round(area / h);
    if (w * h * 4 !== buf.length) {
      // 宽高比本身被取整过：改用「宽已知、高由长度推」再试一次
      w = size.width;
      h = Math.round(buf.length / (4 * w));
      if (w * h * 4 !== buf.length) return null;
    }
  }

  const gray = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) gray[y * w + x] = lumaAt(buf, w, x, y);
  }
  return { w, h, gray };
}

/**
 * S1 区域检测：在截图里找「第一条结果」的浅色大卡片。
 *
 * 逐行算采样段的平均亮度，取扫描区亮度的中位数当基准；
 * 连续比基准亮出 lightDelta 的行构成一个「亮带」，高度在
 * [minBand, maxBand] 之间的最靠上的亮带就是第一张卡片。
 * 返回卡片中心（图像内像素坐标）；找不到返回 null。
 */
function findRegion(g) {
  if (!g || !g.w || !g.h) return null;

  const x0 = Math.round(g.w * REG.x0);
  const x1 = Math.round(g.w * REG.x1);
  const y0 = Math.round(g.h * REG.y0);
  const y1 = Math.round(g.h * REG.y1);
  if (x1 - x0 < 20 || y1 - y0 < 80) return null;

  const xs = [];
  for (let x = x0; x < x1; x += 2) xs.push(x);

  const rows = [];
  for (let y = y0; y < y1; y += 2) {
    let sum = 0;
    for (const x of xs) sum += g.gray[y * g.w + x];
    rows.push({ y, mean: sum / xs.length });
  }

  // 20 分位亮度当背景估计：亮的东西占一半以上时，中位数会失真
  const sorted = rows.map((r) => r.mean).sort((a, b) => a - b);
  const base = sorted[Math.floor(sorted.length * 0.2)];
  const light = rows.map((r) => r.mean >= base + REG.lightDelta);

  // 找连续亮带的起止（行距 2px，高度按像素换算）
  let best = null;
  let run = 0;
  for (let i = 0; i <= light.length; i++) {
    if (i < light.length && light[i]) {
      run++;
      continue;
    }
    if (run > 0) {
      const startY = rows[i - run].y;
      const endY = rows[i - 1].y + 2;
      const hpx = endY - startY;
      if (hpx >= REG.minBand && hpx <= REG.maxBand && !best) {
        best = { y: startY + (hpx >> 1), h: hpx };
      }
      run = 0;
    }
  }
  if (!best) return null;

  return {
    x: Math.round(g.w * (REG.x0 + REG.x1) / 2),
    y: best.y,
    how: "region",
    detail: { bandH: best.h, base: Math.round(base) },
  };
}

// ---------------------------------------------------------------- 窗口比对

/** 点击后校验用的：找出 after 里新出现的、标题不像微信的顶层窗口 */
function diffWindows(before, after) {
  const seen = new Set((before || []).map((w) => w.hwnd));
  return (after || []).filter((w) => !seen.has(w.hwnd) && w.title && w.title.trim());
}

/**
 * 「打开成功」的判据：点击前后多出来的窗口里，去掉标题含「微信」的那些。
 * 微信自己会开内部子窗口（文件传输助手之类），只有外部浏览器的新窗口才算数。
 */
function freshWindows(before, after) {
  return diffWindows(before, after).filter((w) => w.title.indexOf("微信") < 0);
}

// ---------------------------------------------------------------- S2 / S3

/**
 * S2 无障碍定位：让 ps1 走一遍「微信进程家族」所有顶层窗口的 UIA 树，
 * 找名字含「访问网页」的元素，拿它的可点坐标（屏幕绝对坐标）。
 *
 * 关键在于传的是**整个家族**而不是主进程 pid：搜一搜结果页由
 * WeChatAppEx.exe（微信内置浏览器宿主）渲染，只走 Weixin.exe 的树
 * 永远看不到它 —— 这正是之前"明明有结果却说定位不到"的原因。
 *
 * 找到多个时取最靠上的 —— 第一条结果永远在最上面。
 */
async function findUia(pids) {
  const list = (Array.isArray(pids) ? pids : [pids])
    .map((n) => parseInt(n, 10))
    .filter((n) => n > 0);
  if (!list.length) return { ok: false, error: "no-pid" };

  const r = await runPS([
    "-Action", "uiafind",
    "-Target", b64(NEEDLE),
    "-Pids", list.join(","),
  ], 14000);
  if (!r.ok) return { ok: false, error: r.error || "uia-failed", raw: r };
  const hits = (r.hits || []).map((h) => ({ x: h.x, y: h.y, name: unb64(h.name) }))
    .filter((h) => h.x > 0 && h.y > 0);
  if (!hits.length) return { ok: false, error: "no-hit", attempts: r.attempt, scanned: r.scanned, windows: r.windows, sample: (r.sample || []).map(unb64) };
  hits.sort((a, b) => a.y - b.y);
  return { ok: true, point: { x: hits[0].x, y: hits[0].y, how: "uia", detail: { name: hits[0].name, hits: hits.length } } };
}

/**
 * S3 OCR 定位：把截图交给 Windows 内置 OCR（需要中文语言包），
 * 找含「访问网页」的那一行文字，点这行文字的中心。
 * 返回的是图像内坐标 —— 调用方要加上截图时窗口的左上角。
 */
async function findOcr(png) {
  if (!png) return { ok: false, error: "no-image" };
  const r = await runPS([
    "-Action", "ocr",
    "-Target", b64(NEEDLE),
    "-File", png,
  ], 25000);
  if (!r.ok) return { ok: false, error: r.error || "ocr-failed", raw: r };
  const hits = (r.hits || []).map((h) => ({
    x: h.x, y: h.y, w: h.w, h: h.h, text: unb64(h.t),
  }));
  if (!hits.length) return { ok: false, error: "no-hit", lines: r.lineCount };
  hits.sort((a, b) => a.y - b.y);
  const top = hits[0];
  return {
    ok: true,
    point: { x: top.x, y: top.y, how: "ocr", detail: { text: top.text, hits: hits.length, lang: r.lang } },
  };
}

/**
 * 按设置把三种方式排成尝试顺序。
 * auto：无障碍 → OCR → 区域；单项：只用那一种。
 */
function planModes(mode) {
  if (AUTO_ORDER.indexOf(mode) >= 0) return [mode];
  return AUTO_ORDER.slice();
}

// ---------------------------------------------------------------- 认亲

/**
 * 确定「我们的微信」是哪一整棵进程树，以及这一步该动哪个窗口。
 *
 * WeChat 4.x 既不是一个窗口、也不是一个进程。本机实测：
 *
 *   Weixin.exe(有主窗口)
 *     ├─ Weixin.exe ×4                 渲染/辅助
 *     └─ WeChatAppEx.exe ×12           内置浏览器 + 小程序宿主
 *   WeixinUpdate.exe ×1                另一棵树，但窗口标题也叫「微信」
 *
 * 所以：按进程名找会漏掉 WeChatAppEx（结果页就在它里面渲染），
 * 按窗口标题找会撞上更新插件。唯一可靠的是**进程树**——
 * 从拥有主窗口的 Weixin.exe 出发收全部子进程，两个问题一起解决。
 *
 * @returns {{ok:boolean, pids:number[], root:object, target:object|null,
 *            how:string, rect:object|null, windows:object[]}}
 *   how: foreground（前台就是家族窗口，优先用它，因为结果页可能搬到这里）
 *        main（主窗口） / largest（家族里面积最大的可见窗口） / none
 *
 * @param {{timeoutMs?:number, full?:boolean}} [opt]
 *   full = 连每个 pid 的进程名一起要。那是**纯诊断**信息（出问题时看日志用、
 *   以及 --wxtest 断言家族里有 WeChatAppEx、没有 WeixinUpdate），
 *   代价是每个 pid 一次 Get-Process —— 18 个进程实测 189ms，批量调用也不省
 *   （182ms，因为贵在进程本身而不是调用次数）。所以默认不算，只有测试要。
 */
async function probeTarget(opt) {
  const o = opt || {};
  const args = ["-Action", "wxprobe"];
  if (o.full) args.push("-Full");
  const r = await runPS(args, o.timeoutMs || 15000);
  if (!r.ok) return { ok: false, error: r.error || "no-wechat-window", raw: r };

  const pids = (r.pids || []).map((n) => parseInt(n, 10)).filter((n) => n > 0);
  const t = r.target || null;
  return {
    ok: true,
    root: r.root || null,
    pids,
    members: r.members || [],
    pidsFrom: r.pidsFrom || "self",
    fg: r.fg || null,
    how: r.targetHow || "none",
    target: t ? { hwnd: t.hwnd, pid: t.pid, title: t.title, w: t.w, h: t.h, cls: t.cls } : null,
    rect: r.rect || null,
    familyWindows: r.familyWindows || [],
    windows: r.windows || [],
  };
}

// ---------------------------------------------------------------- 主流程

/**
 * @param {string} url   要打开的链接（会覆盖剪贴板）
 * @param {object} opt   { click:boolean, mode:"auto"|"uia"|"ocr"|"region" }
 * @returns {{ok:boolean, stage:string, how?:string, detail?:object}}
 *   stage: input | ready | opened | clicked-no-window | no-point
 *          | not-foreground | no-wechat | locate | click
 */
async function openViaSearch(url, opt) {
  const o = opt || {};
  const click = !!o.click;
  const modes = planModes(o.mode);
  ensureTmp();

  // 每次交接重置 worker 的重启预算。上限的定义是「本次交接最多重启 2 次」，
  // 不是「这辈子一共 2 次」—— 否则一次瞬时故障就会让之后所有交接都直接
  // 报 worker-restart-limit，只能重启应用才能恢复。
  W.restarts = 0;

  // 0) 认亲：拿到「我们的微信」这整棵进程树的 pid，以及主窗口。
  //    之后每一步（敲键的前台校验、截图、UIA、点击的落点校验）都以它为边界，
  //    而不是固定拿进程名叫 Weixin 的那一个 —— 搜一搜结果页是
  //    WeChatAppEx.exe（内置浏览器宿主）渲染的，那是个独立的 pid。
  const pre = await probeTarget();
  if (!pre.ok) return { ok: false, stage: "no-wechat", detail: pre };
  const pidArg = pre.pids.join(",");
  const mainHwnd = (pre.root && pre.root.hwnd) || 0;
  T.mark("probe-pre",
    "第一次认亲：拿到微信整棵进程树的 pid 集合与主窗口，后面所有前台/落点校验都以它为边界");

  clipboard.writeText(url);
  await delay(120);
  T.mark("clipboard",
    "把链接写进剪贴板（120ms 是给系统剪贴板留的生效时间，后面 Ctrl+V 要用）");

  // 1) 敲键。前台校验按「家族」判断：结果页开在 WeChatAppEx 的窗口里时，
  //    前台就是那个窗口，它同样算"微信在前台"。
  //    -WaitMs 在第三批之后是**上限**：ps1 在 Enter 之后自己采指纹轮询，
  //    看到页面出现并稳定就提前返回（QRSCAN_READY=0 时才真的睡满）。
  const input = await runPS([
    "-Action", "keys",
    "-Keys", "^f,560,^v,420,{ENTER}",
    "-WaitMs", String(WAIT_RESULT_MS),
    "-Ready", READY_ON ? "1" : "0",
    "-Pids", pidArg,
    "-Win", String(mainHwnd),
  ], 25000);
  T.mark("keys",
    "抢前台 → Ctrl+F → 粘贴 → 回车 → " +
    (READY_ON ? "轮询结果区画面、出现即走（上限 " + WAIT_RESULT_MS + "ms）"
              : "固定睡满 " + WAIT_RESULT_MS + "ms（QRSCAN_READY=0）") +
    " → 选目标窗口 → 截图 → 枚举窗口（进程内部耗时见明细里的 keys，" +
    "本次就绪判定 " + (input.readyHow || "-") + "/" + (input.readyMs != null ? input.readyMs + "ms" : "-") +
    "）");

  if (!input.ok) {
    T.mark("keys-failed", "敲键失败（" + (input.error || "?") + "），流程到此为止");
    const stage = input.error === "not-foreground" ? "not-foreground"
      : input.error === "no-wechat-window" ? "no-wechat" : "input";
    return { ok: false, stage, detail: input };
  }

  // 2) 该动哪个窗口，已经由 keys 在「结果出来之后」现场判定了 ——
  //    结果页若被开进 WeChatAppEx 自己的窗口，那个窗口才是屏幕上真正显示
  //    结果的地方：截图得拍它，坐标也得以它的 rect 为原点，否则整体会偏移
  //    一个主窗口的距离。
  //    以前这里是第二次认亲（另起一个进程重新枚举同一棵没变过的进程树，
  //    实测每次 1.4~1.7 秒，六次真实运行的答案都是 main）。选窗口本来就是
  //    Select-WxTarget 一个函数的事，放在 keys 里只多一次 EnumWindows。
  let targetHwnd = mainHwnd;
  let targetHow = "main";
  let rect = input.rect || { x: 0, y: 0, w: 0, h: 0 };
  if (input.target && input.target.hwnd) {
    targetHwnd = input.target.hwnd;
    targetHow = input.targetHow || "foreground";
    if (input.targetRect) rect = input.targetRect;
  }
  // 家族只有 probe 一处建立，全程沿用：keys 刚刚用同一个集合校验过前台，
  // click 用它校验落点。微信若在这几秒里重启，pid 变了会被 click 的
  // WindowFromPoint 校验直接拒绝（fail-safe），不会点错窗口。
  const pids = pre.pids;
  const clickPids = pids.join(",");

  // 半自动：只把搜索词填好并回车，最后一下交给用户
  if (!click) {
    return { ok: true, stage: "ready", detail: { rect, family: pids, targetHow, targetHwnd } };
  }

  // 3) 截图：改成**按需**。
  //    uia 走的是无障碍树，既不需要像素也不需要图；ocr 要 PNG 文件，
  //    region 要灰度矩阵。以前无论哪种方式都先截一张（近 1 秒），
  //    而 uia 在全部真实运行里都一次命中，这张图根本没人读。
  //    现在谁要谁先 ensureShot()，uia 命中时整段不执行。
  const shot = path.join(TMP, "search.png");
  let shotRect = rect;
  let shotState = 0;            // 0=还没试过 1=成功 -1=失败
  let shotError = null;
  let g = null;

  async function ensureShot() {
    if (shotState !== 0) return shotState === 1;
    const cap = await runPS([
      "-Action", "shot",
      "-Hwnd", String(targetHwnd || 0),
      "-Out", shot,
    ], 15000);
    if (!cap.ok) {
      shotState = -1;
      shotError = cap.error || "shot-failed";
      T.mark("shot-failed", "截目标窗口失败，后面没有图可定位");
      return false;
    }
    shotState = 1;
    shotRect = cap.rect || rect;
    T.mark("shot",
      "把目标窗口截成 PNG 存盘（只有 ocr / region 会走到这里，uia 命中时不截图）");
    return true;
  }

  function ensureGray() {
    if (g || shotState !== 1) return g;
    try {
      const img = nativeImage.createFromPath(shot);
      if (img && !img.isEmpty()) g = toGray(img);
    } catch (_) {}
    T.mark("gray",
      "把 PNG 解码成灰度矩阵（只有区域检测需要；OCR 那边由 ps1 自己读文件）");
    return g;
  }


  for (const mode of modes) {
    let pt = null;

    // ---- 分段计时：定位阶段（临时，删时连带下面的 T.mark 一起删）----
    // 每个分支都会打一个点，所以 auto 模式降级时能在日志里看到 1→2→3 的链条
    if (mode === "uia") {
      const u = await findUia(pids);
      if (u.ok) pt = u.point;
      else lastDebug = { mode, fail: u.error };
      T.mark("locate:uia",
        "无障碍：走 UIA 树找名字含「访问网页」的元素、取它的可点坐标 → " +
        (u.ok ? "命中(" + u.point.x + "," + u.point.y + ")" : "未命中 " + u.error));
    } else if (mode === "ocr") {
      // OCR 只认 PNG 文件，先确保截到图；截不到就当作本方式未命中，
      // 让 auto 继续往 region 走，而不是整条流程提前判死。
      let c = { ok: false, error: "no-shot" };
      if (await ensureShot()) c = await findOcr(shot);
      if (c.ok) {
        // OCR 给的是图像内坐标，换算成屏幕绝对坐标
        pt = { x: shotRect.x + c.point.x, y: shotRect.y + c.point.y, how: "ocr", detail: c.point.detail };
      } else lastDebug = { mode, fail: c.error };
      T.mark("locate:ocr",
        "文字识别：OCR 在截图里找「访问网页」四个字、取包围盒中心 → " +
        (c.ok ? "命中(" + c.point.x + "," + c.point.y + ")" : "未命中 " + c.error));
    } else if (mode === "region") {
      // 纯像素几何：要灰度矩阵，先截图再解码，同样按需
      if (await ensureShot()) ensureGray();
      let rg = null;                       // 提到块外，下面打点要用
      if (g) {
        rg = findRegion(g);
        if (rg) {
          pt = { x: shotRect.x + rg.x, y: shotRect.y + rg.y, how: "region", detail: rg.detail };
        } else lastDebug = { mode, fail: "no-band" };
      } else lastDebug = { mode, fail: "no-gray" };
      T.mark("locate:region",
        "区域：找比背景明显亮、高 62~420px 的最靠上横带（纯像素几何，不看文字） → " +
        (rg ? "命中(" + Math.round(rg.x) + "," + Math.round(rg.y) + ") 带高" + rg.detail.bandH
            : "未命中 " + (lastDebug.fail || "?")));
    }

    // 硬约束 3：找不到就不点，换下一种方式
    if (!pt) continue;

    lastDebug = { mode, point: pt, targetHwnd, targetHow };

    // 落点校验在 ps1 里用 WindowFromPoint 做：判定的是"这一像素属于谁"，
    // 比"前台窗口是不是微信"更贴近真实风险。
    // 点击后 ps1 会自己盯着画面最多 CLICK_POLL_MS，返回 verdict：
    //   window —— 冒出了新的、有标题的顶层窗口
    //   title  —— 被点窗口的标题变了
    //   pixels —— 客户区像素变了（网页开在当前窗口里时唯一能用的证据）
    //   none   —— 四种都没发生，这才真的算"点了没反应"
    const res = await runPS([
      "-Action", "click",
      "-X", String(pt.x), "-Y", String(pt.y),
      "-Pids", clickPids,
      "-PollMs", String(CLICK_POLL_MS),
    ], 18000);
    if (!res.ok) {
      T.mark("click-failed", "点击没执行成功（" + (res.error || "?") + "）");
      const stage = res.error === "not-foreground" ? "not-foreground" : "click";
      return { ok: false, stage, how: pt.how, detail: res };
    }

    // 硬约束 2：点了必须真的打开，没打开就停手 —— 不重试、不换点再点。
    // 判据以 ps1 的 verdict 为准；只有旧版 ps1（不返回 verdict）才退回
    // 窗口差集。注意 before 是点击前一瞬的快照，所以"结果页自己新开了
    // 一个窗口"不会被误算成点击的功劳。
    // 兜底的 before 用 keys 那一刻的窗口快照：第二次认亲去掉之后，那就
    // 是点击前最近的一份全量快照（res.before 由 ps1 在点击前一瞬自己拍）。
    const verdict = res.verdict || "";
    let opened = false;
    let how2 = verdict || "window-diff";
    if (verdict === "window" || verdict === "title" || verdict === "pixels") {
      opened = true;
    } else if (!verdict) {
      opened = freshWindows(res.before || input.windows, res.windows).length > 0;
    }
    T.mark("click",
      "落点校验 → 左键点击 → 轮询最多 " + CLICK_POLL_MS + "ms 判是否真打开（" +
      (pt.how || "?") + " 定位）→ 判定 " + (verdict || "window-diff") +
      "，内部 waited=" + (res.waited != null ? res.waited + "ms" : "-"));
    T.put("定位方式", pt.how + (pt.detail && pt.detail.bandH ? "（bandH=" + pt.detail.bandH + "）" : ""));
    T.put("判定证据", how2 + "，ps1 内部轮询等待 " + (res.waited != null ? res.waited + "ms" : "-"));


    if (opened) {
      const fresh = freshWindows(res.before || [], res.windows);
      return {
        ok: true, stage: "opened", how: pt.how,
        detail: {
          point: pt, targetHow, targetHwnd,
          evidence: how2,
          waited: res.waited,
          pixelDiff: res.pixelDiff,
          window: fresh.length ? fresh[0].title : null,
          // 就绪判定随结果一起上抛：boot.log 里一行就能看出这次是「真的看到页面」
          // 还是「睡满了上限」，A/B 时不用翻整张 timing 表。
          readyHow: input.readyHow,
          readyMs: input.readyMs,
          readyPeak: input.readyPeak,
        },
      };
    }
    return {
      ok: false, stage: "clicked-no-window", how: pt.how,
      detail: {
        point: pt, targetHow, waited: res.waited, pixelDiff: res.pixelDiff,
        readyHow: input.readyHow, readyMs: input.readyMs, readyPeak: input.readyPeak,
      },
    };
  }

  // 走到这里说明三种方式都没给出坐标。区分两种情况，因为提示语不一样：
  //   - 图截不下来（locate）      -> 「截不到微信窗口，请手动点」
  //   - 图截到了但没找到那四个字   -> 「三种方式都没定位到，请手动点」
  // 截图现在是按需的，所以「根本没截」也算 locate。
  const shotBad = shotState === -1;
  return {
    ok: false,
    stage: shotBad ? "locate" : "no-point",
    detail: shotBad ? { error: shotError, targetHow, targetHwnd } : lastDebug,
  };
}

/**
 * 只读诊断（--wxtest 的 live 部分）：对真实微信窗口把三种方式
 * 各跑一遍定位，但一次也不点 —— 可以在任何时刻安全跑。
 */
async function diagnose() {
  ensureTmp();
  // 先认亲：只读，不改前台。截图和 UIA 都以家族 + 选中的目标窗口为准。
  const pre = await probeTarget();
  if (!pre.ok) return { ok: false, error: pre.error || "no-wechat-window" };

  const shot = path.join(TMP, "diag.png");
  const hwnd = (pre.target && pre.target.hwnd) || (pre.root && pre.root.hwnd) || 0;
  const cap = await runPS(["-Action", "shot", "-Hwnd", String(hwnd), "-Out", shot], 12000);
  if (!cap.ok) return { ok: false, error: cap.error || "no-wechat-window" };

  const out = {
    ok: true,
    rect: cap.rect,
    shot,
    family: {
      pids: pre.pids,
      from: pre.pidsFrom,
      targetHow: pre.how,
      target: pre.target,
      windows: pre.familyWindows,
    },
    region: null, ocr: null, uia: null,
  };

  // 区域检测（纯进程内，不碰系统）
  try {
    const img = nativeImage.createFromPath(shot);
    if (img && !img.isEmpty()) {
      const g = toGray(img);
      if (g) {
        const rg = findRegion(g);
        out.region = rg
          ? { ok: true, x: rg.x, y: rg.y, bandH: rg.detail.bandH, base: rg.detail.base }
          : { ok: false, error: "no-band" };
        out.image = { w: g.w, h: g.h };
      }
    }
  } catch (_) {}

  // OCR（ps1 只读 PNG）
  out.ocr = await findOcr(shot);

  // 无障碍：传整棵进程树 —— 结果页由 WeChatAppEx 渲染，那是个独立进程
  out.uia = pre.pids.length
    ? await findUia(pre.pids)
    : { ok: false, error: "no-wechat-pid" };

  return out;
}

function cleanup() {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
}

module.exports = {
  openViaSearch, diagnose, cleanup, probeTarget, TMP, NEEDLE, AUTO_ORDER, REG,
  WAIT_RESULT_MS,   // 已应用 QRSCAN_WAIT_MS 覆盖后的实际值，供日志表头标注
  READY_ON,         // 就绪轮询是否开启（QRSCAN_READY=0 时 false），同上
  // 常驻 worker 的生命周期：main.js 在 whenReady 里预热、退出前关掉；
  // workerStats() 给 boot.log 记录 restarts（验收要求为 0）。
  prewarmWorker, stopWorker, workerStats,
  // 测试用：把内部工具暴露出来，方便离线验证检测效果
  _toGray: toGray, _findRegion: findRegion, _diffWindows: diffWindows,
  _freshWindows: freshWindows, _planModes: planModes, _unb64: unb64,
  _findOcr: findOcr, _findUia: findUia, _runPS: runPS,
  _argsToRequest: argsToRequest, _workerStats: workerStats,
  getLastDebug: () => lastDebug,
};

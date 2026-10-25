/**
 * 分段计时（临时诊断设施）
 * ============================================================
 * 用途：把「扫码成功 → 微信里点开第一条结果」这条链路切成若干段，
 *       逐段计时，写进 desktop/timing.log，用来定位到底哪一段在花时间。
 *
 * 【怎么关掉】
 *   把下面的 ENABLED 改成 false。所有 mark/meter 立刻变成空操作，
 *   不留任何开销，也不用改任何调用点。
 *
 * 【怎么彻底删除】
 *   1) 删掉本文件；
 *   2) 在 desktop 目录搜 `T.mark(` 和 `T.meter(`，把命中的行一并删掉；
 *   3) 删掉 main.js 里的 `require("./timing")`、`T.begin` / `T.finish`；
 *   4) 删掉 win-helper.ps1 里的 `$SW` / `$BOOT` 两处赋值（以及 Emit 里的注入）。
 *   这些都是纯附加代码，删掉不影响任何业务逻辑。
 *
 * 【为什么这样设计】
 *   - mark 只往内存里 push，不碰磁盘。整条流程只在 finish() 写一次盘，
 *     所以埋点本身几乎不产生额外耗时 —— 不会出现「测出来比实际更慢」。
 *   - 节点耗时 = 与上一次 mark 的时间差，调用点不用自己记时间戳。
 *   - 每个节点都必须写 note，说明「这一段负责什么」。日志要回答的不是
 *     「有多少毫秒」，而是「这几千毫秒是谁花的」。
 *   - meter 记录每一次底层 powershell 调用的「总耗时 / 启动开销 / 真实计算」，
 *     用来暴露「反复起进程」这种看不见的成本。
 */

const fs = require("fs");
const path = require("path");

const ENABLED = true;                        // ← 改成 false 即整体静默
const FILE = require("./paths").file("timing.log");
const MAX_KB = 512;                          // 超过就备份成 timing.old.log（只留一份）

let s = null;                                // 当前会话

// ---------------------------------------------------------------- 排版工具
// 中文占 2 个显示宽度，直接用 length 对齐会歪，所以自己算宽度
function dw(str) {
  let n = 0;
  for (const ch of String(str)) {
    const c = ch.codePointAt(0);
    const wide =
      c === 0x2329 || c === 0x232a ||
      (c >= 0x1100 && c <= 0x115f) ||
      (c >= 0x2e80 && c <= 0xa4cf) ||
      (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe6f) ||
      (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6) ||
      (c >= 0x20000 && c <= 0x3fffd);
    n += wide ? 2 : 1;
  }
  return n;
}
const padR = (str, w) => String(str) + " ".repeat(Math.max(0, w - dw(str)));
const padL = (str, w) => " ".repeat(Math.max(0, w - dw(str))) + String(str);
const num = (v, w) => padL(v == null ? "-" : String(v), w);

// ---------------------------------------------------------------- 会话
function begin(name, meta) {
  if (!ENABLED) return;
  s = {
    name: name || "session",
    meta: meta || {},
    at: new Date(),
    t0: Date.now(),
    nodes: [],
    calls: [],
    extras: {},
  };
}

/**
 * 记录一个节点。
 * @param {string} node  节点名（英文短名，便于 grep）
 * @param {string} note  这个节点负责什么 —— 必填，日志的可读性全靠它
 */
function mark(node, note) {
  if (!ENABLED || !s) return;
  const now = Date.now();
  const prev = s.nodes.length ? s.nodes[s.nodes.length - 1].at : s.t0;
  s.nodes.push({ node, note: note || "", at: now, gap: now - prev });
}

/**
 * 记录一次底层调用。
 * @param {{action:string, mode?:string, total:number, boot:number, work:number,
 *          tail:number, note?:string}} rec
 *   total 整笔调用从发出到拿到应答的时间，它被拆成三段：
 *     boot = spawn: 进程启动 + 解析脚本 + 编译 C# + 预热（与动作无关）
 *            worker: 请求分发（0~3ms，进程启动只在第一次付）
 *     work = 动作本身干活（真正的算法成本，两种模式同口径、可直接比）
 *     tail = spawn: JSON 序列化 + 卸载程序集 + 进程退出
 *            worker: 管道往返 + JSON + Node 侧解析
 *   拆成三段是因为「慢在启动」和「慢在退出」的优化手段不一样。
 *   mode 只是把两种实现区分出来：boot+tail 在两种模式下都等于"固定开销"。
 */
function meter(rec) {
  if (!ENABLED || !s || !rec) return;
  s.calls.push({
    action: rec.action || "?",
    mode: rec.mode === "worker" ? "worker" : "spawn",
    total: Math.max(0, Math.round(rec.total || 0)),
    boot: Math.round(rec.boot || 0),
    work: Math.max(0, Math.round(rec.work || 0)),
    tail: Math.max(0, Math.round(rec.tail || 0)),
    note: rec.note || "",
  });
}

/** 往日志尾部加一段自由格式的补充说明（例如被选中的定位方式、最终判定） */
function put(key, value) {
  if (!ENABLED || !s) return;
  s.extras[key] = value;
}

// ---------------------------------------------------------------- 输出
function render() {
  const total = Date.now() - s.t0;
  const L = [];

  L.push("");
  L.push("═".repeat(96));
  L.push(` ${s.name} · ${s.at.toLocaleString("zh-CN", { hour12: false })}` +
    (Object.keys(s.meta).length
      ? " · " + Object.entries(s.meta).map(([k, v]) => `${k}=${v}`).join(" ")
      : ""));
  L.push("═".repeat(96));

  // ---- 1) 阶段表 ----
  L.push(` ${padR("#", 3)}${padR("区间(ms)", 15)}${padR("耗时", 8)}${padR("占比", 7)}` +
    `${padR("节点", 20)}负责什么`);
  L.push("─".repeat(96));

  let acc = 0;
  s.nodes.forEach((n, i) => {
    acc += n.gap;
    const pct = total > 0 ? (n.gap / total) * 100 : 0;
    const range = `${acc - n.gap} → ${acc}`;
    L.push(` ${padR(i + 1, 3)}${padR(range, 15)}${num(n.gap, 6)}  ${num(pct.toFixed(1), 5)}%  ` +
      `${padR(n.node, 20)}${n.note}`);
  });
  L.push("─".repeat(96));
  L.push(` ${padR("", 3)}${padR("合计", 15)}${num(total, 6)} ms`);

  // ---- 2) 底层调用明细 ----
  if (s.calls.length) {
    const sum = (k) => s.calls.reduce((a, c) => a + c[k], 0);
    const sumTotal = sum("total");
    const sumBoot = sum("boot");
    const sumWork = sum("work");
    const sumTail = sum("tail");
    const workers = s.calls.filter((c) => c.mode === "worker").length;

    L.push("");
    L.push(" ── 底层调用明细 ──");
    L.push(` 本次共 ${s.calls.length} 次调用（worker ${workers} 次 / spawn ${s.calls.length - workers} 次）。`);
    L.push(" 模式 worker = 常驻 powershell（一行 JSON 进、一行出），进程启动只在第一次付；");
    L.push(" 模式 spawn  = 一次性子进程（QRSCAN_WORKER=0 的回退路径）。");
    L.push(" boot = spawn: 进程启动 + 解析脚本 + 编译 C# 声明块；worker: 请求分发（0~3ms）");
    L.push(" work = 动作本身真正干活（算法成本，两种模式同口径，可直接比较）");
    L.push(" tail = spawn: JSON 序列化 + 卸载程序集 + 进程退出；worker: 管道往返 + JSON + 解析");
    L.push(" boot + tail 是每次调用都要重付的固定成本，和做什么动作无关。");
    // 第三批（F1）之后 keys 的「等结果」不再是纯 sleep：ps1 在 Enter 之后
    // 轮询结果区画面，看到页面出现并稳定就提前返回，`wait` 因此变成
    // 「实际等了多久」而不是「配了多久」。行尾的〔就绪 …〕说明它是怎么结束的。
    if (s.calls.some((c) => c.action === "keys" && c.note.indexOf("〔就绪") >= 0)) {
      L.push(" keys 行尾的〔就绪 X/Yms〕= 回车后多久判定结果页已经出现：");
      L.push("   fingerprint = 真的看到画面变化并稳定下来（正常路径）");
      L.push("   timeout     = 睡满上限仍未达标，括号里的「峰值差」是期间看到的最大画面差（调阈值用）");
      L.push("   sleep       = 轮询关闭（QRSCAN_READY=0），退回固定等待");
    }
    L.push("");
    L.push(` ${padR("次", 4)}${padR("动作", 10)}${padR("模式", 8)}${padR("总耗时", 8)}` +
      `${padR("boot", 7)}${padR("work", 7)}${padR("tail", 7)}${padR("固定占比", 10)}说明`);
    L.push(" " + "─".repeat(102));

    s.calls.forEach((c, i) => {
      const fixed = c.total > 0 ? ((c.boot + c.tail) / c.total) * 100 : 0;
      L.push(` ${padR(i + 1, 4)}${padR(c.action, 10)}${padR(c.mode, 8)}${num(c.total, 6)}  ` +
        `${num(c.boot, 5)}  ${num(c.work, 5)}  ${num(c.tail, 5)}  ${num(fixed.toFixed(0) + "%", 8)}  ${c.note}`);
    });
    L.push(" " + "─".repeat(102));
    L.push(` ${padR("", 4)}${padR("合计", 10)}${padR("", 8)}${num(sumTotal, 6)}  ${num(sumBoot, 5)}  ` +
      `${num(sumWork, 5)}  ${num(sumTail, 5)}  ` +
      `${num((sumTotal ? ((sumBoot + sumTail) / sumTotal) * 100 : 0).toFixed(0) + "%", 8)}  ` +
      `共 ${s.calls.length} 次调用`);
    L.push(` 说明：固定开销共 ${sumBoot + sumTail} ms` +
      `（boot ${sumBoot} + tail ${sumTail}），真正用于干活的只有 ${sumWork} ms。` +
      (workers ? "常驻 worker 下每个请求的固定开销应只剩几十毫秒。" : ""));
  }

  // ---- 3) 补充 ----
  const ek = Object.keys(s.extras);
  if (ek.length) {
    L.push("");
    L.push(" ── 结论 ──");
    for (const k of ek) L.push(`  ${padR(k, 16)}${s.extras[k]}`);
  }

  L.push("");
  return L.join("\n");
}

function rotateIfBig() {
  try {
    if (!fs.existsSync(FILE)) return;
    if (fs.statSync(FILE).size > MAX_KB * 1024) {
      fs.renameSync(FILE, FILE.replace(/\.log$/, ".old.log"));
    }
  } catch (_) {}
}

/** 结束并落盘。正常、异常都要调，否则这一轮的记录就丢了 */
function finish(extra) {
  if (!ENABLED || !s) return null;
  if (extra) for (const [k, v] of Object.entries(extra)) s.extras[k] = v;
  let text;
  try { text = render(); } catch (e) { text = `\n[timing] render failed: ${e && e.message}\n`; }
  try {
    rotateIfBig();
    // 数据目录首启时可能还没建（timing 比迁移更早被调用）
    try { require("./paths").ensureDataDir(); } catch (_) {}
    fs.appendFileSync(FILE, text, "utf8");
  } catch (_) {}
  const done = { total: Date.now() - s.t0, nodes: s.nodes.length, calls: s.calls.length };
  s = null;
  return done;
}

module.exports = { begin, mark, meter, put, finish, FILE, ENABLED };

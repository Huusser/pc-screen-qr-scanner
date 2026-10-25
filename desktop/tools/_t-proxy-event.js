"use strict";

/**
 * 2026-10-25 故障复盘的回归：状态卡显示"只接管 0 个域名"但功能一切正常。
 *
 * 根因是两个独立缺陷叠加：
 *   ① main.js 的 qr:proxy-start 重建 opts 时丢了 scopeUrl → 永远退回全量；
 *   ② tick 事件每秒用残缺对象（只有 remainSec）调 renderProxy，
 *      scopeAll/scopeCount 缺失 → 渲染成"只接管 0 个域名"。
 *
 * 本脚本验证修复后的行为：
 *   T1  main.js 的 IPC handler 显式透传 scopeUrl（静态断言：main.js 无法在
 *       无 Electron 的 harness 里 require，只能查源码——防再次丢字段）
 *   T2  收窄模式下 start()：spawn 参数带 --scope、通知正文带"（只接管 x）"
 *   T3  tick 事件每秒广播，且 payload 带 scopeAll/scopeCount
 *
 * 用法：node tools/_t-proxy-event.js
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");
const { EventEmitter } = require("events");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "qr-pxevent-"));
process.env.QRSCAN_DATA_DIR = tmp;
fs.mkdirSync(path.join(tmp, "proxy"), { recursive: true });

const sent = [];        // 捕获 broadcast → webContents.send(type, payload)
const notes = [];       // 捕获系统通知
const spawnCalls = [];

const STATUS = {
  ok: true, ready: true, listen: 8888, ua_mode: "android",
  proxy_all: false, scope: ["a.com", "b.com"], scope_count: 2,
  system_proxy: true, ttl: 60, remain: 60, parent_pid: 0, stats: { rewritten: 1 },
};

function fakeProc() {
  const p = new EventEmitter();
  p.exitCode = null;                 // 不退出，让 startTimers 跑起来
  p.signalCode = null;
  p.killed = false;
  p.kill = () => {};
  return p;
}

const fakeWin = {
  isDestroyed: () => false,
  webContents: { send: (type, payload) => sent.push({ type, payload }) },
};

const origLoad = Module._load;
Module._load = function (request) {
  if (request === "electron") {
    return {
      shell: { openExternal: async () => {} },
      Notification: class {
        static isSupported() { return true; }
        constructor(opts) { notes.push(opts); }
        show() {}
      },
      BrowserWindow: { getAllWindows: () => [fakeWin] },
    };
  }
  if (request === "child_process") {
    return {
      spawn: (cmd, args) => { spawnCalls.push(args || []); return fakeProc(); },
      execFile: (cmd, args, opts, cb) => { cb(null, "3.12.10", ""); },
    };
  }
  if (request === "http") {
    return {
      get(url, cb) {
        const req = { setTimeout() {}, on() {}, destroy() {} };
        const res = new EventEmitter();
        res.statusCode = 200;
        res.setEncoding = () => {};
        setImmediate(() => { cb(res); res.emit("data", JSON.stringify(STATUS)); res.emit("end"); });
        return req;
      },
    };
  }
  return origLoad.apply(this, arguments);
};

const mgr = require("../proxy-manager.js");

const fails = [];
function check(cond, label, extra) {
  console.log((cond ? "ok   " : "FAIL ") + label + (!cond && extra ? "  " + extra : ""));
  if (!cond) fails.push(label);
}

(async () => {
  // ---- T1：IPC 层透传（静态断言）----
  const mainSrc = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
  const handler = mainSrc.slice(mainSrc.indexOf("qr:proxy-start"),
    mainSrc.indexOf("qr:proxy-stop") > 0 ? mainSrc.indexOf("qr:proxy-stop") : mainSrc.indexOf("qr:proxy-start") + 600);
  check(/scopeUrl/.test(handler), "T1 qr:proxy-start 显式透传 scopeUrl", handler.slice(0, 200));

  // ---- T4：IPC 白名单键集 = overlay 调用键集（防"加字段漏中间"再现）----
  // main.js 的 handler 是显式白名单（有意不 {...o} 透传），代价是新增字段
  // 必须三处同步：overlay 调用点 → main 白名单 → 本断言。这里静态提取两
  // 端的键集做包含断言，今后谁忘了同步，回归先红。
  const overlaySrc = fs.readFileSync(path.join(__dirname, "..", "overlay.js"), "utf8");
  const ovM = overlaySrc.match(/proxyStart\(\{([\s\S]*?)\}\)/);
  check(!!ovM, "T4 overlay 里能找到 proxyStart({...}) 调用", String(ovM && ovM[1]).slice(0, 120));
  if (ovM) {
    const overlayKeys = [...ovM[1].matchAll(/(\w+)\s*:/g)].map((m) => m[1]);
    const handlerKeys = [...handler.matchAll(/(\w+)\s*:\s*(?:typeof\s+|[!\s])*o\.\w+/g)]
      .map((m) => m[1]);
    const missing = overlayKeys.filter((k) => handlerKeys.indexOf(k) < 0);
    check(missing.length === 0,
      "T4 overlay 的每个键都在 main 白名单里（缺: " + missing.join(",") + "）",
      "overlay=[" + overlayKeys.join(",") + "] main=[" + handlerKeys.join(",") + "]");
  }

  // ---- T2：收窄启动 ----
  const r = await mgr.start({ mode: "android", ttlSec: 60, scopeUrl: "https://a.com/login?x=1" });
  check(r && r.ok === true, "T2 start() 成功", JSON.stringify(r));
  const args = spawnCalls.length ? spawnCalls[0] : [];
  const i = args.indexOf("--scope");
  check(i >= 0 && args[i + 1] === "a.com", "T2 spawn 参数带 --scope a.com", JSON.stringify(args));
  check(notes.length === 1 && /（只接管 a\.com）/.test(notes[0].body || ""),
    "T2 通知正文带范围", JSON.stringify(notes));

  // ---- T3：tick 带范围 ----
  // broadcast 的 send(channel, msg)：channel 固定 "qr:proxy-event"，事件类型在 msg.type
  await new Promise((res) => setTimeout(res, 1300));
  const events = sent.filter((e) => e.payload && e.payload.type).map((e) => e.payload);
  const ticks = events.filter((e) => e.type === "tick");
  check(ticks.length >= 1, "T3 收到 tick 事件", "count=" + ticks.length);
  const t = ticks[ticks.length - 1] || {};
  check(t.scopeAll === false, "T3 tick.scopeAll=false（收窄）", JSON.stringify(t));
  check(t.scopeCount === 2, "T3 tick.scopeCount=2", JSON.stringify(t));
  const starts = events.filter((e) => e.type === "started");
  check(starts.length === 1 && starts[0].scopeAll === false && starts[0].scopeCount === 2,
    "T3 started 事件也带范围", JSON.stringify(starts));

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log("结果:", fails.length ? "HAS FAILURES: " + fails.join(", ") : "ALL PASS");
  process.exit(fails.length ? 1 : 0);
})().catch((e) => {
  console.log("FAIL 异常 " + (e && e.stack || e));
  process.exit(1);
});

"use strict";

/**
 * P1-A 验收（桌面端那一半）：默认端口被占用时，启动参数必须换成空闲端口。
 *
 * 不启动 Electron、不启真代理：把 electron / child_process 换成探针，
 * 只是为了看清 start() 到底把哪两个端口交给了 python。
 *
 * 场景：本进程先真的监听 8888 与 8899（模拟 Fiddler + 别的程序），
 * 期望 spawn 参数里的 --port / --admin-port 都不等于默认值。
 *
 * 用法：node tools/_t-proxy-ports.js
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");
const Module = require("module");
const { EventEmitter } = require("events");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "qr-pxport-"));
process.env.QRSCAN_DATA_DIR = tmp;
fs.mkdirSync(path.join(tmp, "proxy"), { recursive: true });

const spawnCalls = [];

function fakeProc() {
  const p = new EventEmitter();
  p.exitCode = 2;          // 直接当作"已失败退出"，让 start() 尽快返回
  p.signalCode = null;
  p.killed = false;
  p.kill = () => {};
  return p;
}

const origLoad = Module._load;
Module._load = function (request) {
  if (request === "electron") {
    return {
      shell: { openExternal: async () => {} },
      Notification: Object.assign(function () {}, { isSupported: () => false }),
      BrowserWindow: { getAllWindows: () => [] },
    };
  }
  if (request === "child_process") {
    return {
      spawn: (cmd, args) => { spawnCalls.push({ cmd, args: args || [] }); return fakeProc(); },
      execFile: (cmd, args, opts, cb) => { cb(null, "3.12.10", ""); },
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

function occupy(port) {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(port, "127.0.0.1", () => resolve(srv));
  });
}

function argAfter(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? Number(args[i + 1]) : NaN;
}

(async () => {
  const held = [];
  try {
    held.push(await occupy(8888));
    held.push(await occupy(8899));
    console.log("已占用 8888 与 8899，模拟 Fiddler 抢端口");
  } catch (e) {
    console.log("skip  两个默认端口没能都占住（可能已被本机其他程序占用）: " + e.message);
  }

  const r = await mgr.start({ mode: "android", ttlSec: 60 });
  check(r && r.ok === false, "进程起不来时 start() 照旧返回 ok:false");

  check(spawnCalls.length === 1, "只拉起一个代理进程", JSON.stringify(spawnCalls.length));
  const args = spawnCalls.length ? spawnCalls[0].args : [];
  const port = argAfter(args, "--port");
  const adminPort = argAfter(args, "--admin-port");

  check(Number.isFinite(port), "--port 被显式传给 python", JSON.stringify(args));
  check(Number.isFinite(adminPort), "--admin-port 被显式传给 python", JSON.stringify(args));

  if (held.length === 2) {
    check(port !== 8888, "代理口顺延（不再是 8888）", "port=" + port);
    check(adminPort !== 8899, "管理口顺延（不再是 8899）", "adminPort=" + adminPort);
    check(port !== adminPort, "两个口不冲突", `port=${port} admin=${adminPort}`);
    check(port >= 8888 && port < 8888 + 20, "代理口在顺延窗口内", "port=" + port);
    check(adminPort >= 8899 && adminPort < 8899 + 20, "管理口在顺延窗口内", "adminPort=" + adminPort);
  }

  for (const s of held) { try { s.close(); } catch (_) {} }
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log("结果:", fails.length ? "HAS FAILURES: " + fails.join(", ") : "ALL PASS");
  process.exit(fails.length ? 1 : 0);
})().catch((e) => {
  console.log("FAIL 异常 " + (e && e.stack || e));
  process.exit(1);
});

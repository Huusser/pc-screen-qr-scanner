"use strict";

/**
 * P2-A 验收：启用通知里的时长要"说人话"。
 *
 * 用假的 admin 接口把 start() 的成功路径跑通（不启真代理、不启 Electron），
 * 只为了看清那条系统通知到底写了什么：
 *   10 秒档以前是"0 分钟后自动关闭"（看着像开关坏了）。
 *
 * 用法：QR_TTL=10 QR_EXPECT="10 秒后自动关闭" node tools/_t-proxy-notify.js
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");
const { EventEmitter } = require("events");

const ttl = Number(process.env.QR_TTL || "0");
const expect = process.env.QR_EXPECT || "";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "qr-pxnotify-"));
process.env.QRSCAN_DATA_DIR = tmp;
fs.mkdirSync(path.join(tmp, "proxy"), { recursive: true });

const notes = [];

const STATUS = {
  ok: true, ready: true, listen: 8888, ua_mode: "android", proxy_all: true,
  scope: [], system_proxy: false, ttl, remain: ttl, parent_pid: 0, stats: {},
};

function fakeProc() {
  const p = new EventEmitter();
  p.exitCode = null;
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
      Notification: class {
        static isSupported() { return true; }
        constructor(opts) { notes.push(opts); }
        show() {}
      },
      BrowserWindow: { getAllWindows: () => [] },
    };
  }
  if (request === "child_process") {
    return {
      spawn: () => fakeProc(),
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
        setImmediate(() => {
          cb(res);
          res.emit("data", JSON.stringify(STATUS));
          res.emit("end");
        });
        return req;
      },
    };
  }
  return origLoad.apply(this, arguments);
};

const mgr = require("../proxy-manager.js");

(async () => {
  const r = await mgr.start({ mode: "android", ttlSec: ttl });
  const body = notes.length ? String(notes[0].body || "") : "";
  const ok = !!r && r.ok === true && (!expect || body.includes(expect));
  console.log((ok ? "ok   " : "FAIL ") + `ttl=${ttl} → "${body}"` +
    (ok ? "" : `  期望包含 "${expect}"`));
  console.log(`     通知条数 ${notes.length}，返回 ok=${r && r.ok}`);
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.log("FAIL 异常 " + (e && e.stack || e));
  process.exit(1);
});

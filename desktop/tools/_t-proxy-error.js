"use strict";

/**
 * P0-A 前端侧验收：python 失败退出后，桌面端能不能把"真正的原因"显示出来。
 *
 * 不启动 Electron、不启真代理：把 electron / child_process 换成探针，
 * 伪造一个"退出码 4 + 写下了 last_exit.json"的 python 子进程，
 * 然后看 start() 返回的 error 是那句人话，还是那句没信息量的"启动超时或失败"。
 *
 * 用法：node tools/_t-proxy-error.js
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");
const { EventEmitter } = require("events");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "qr-pxerr-"));
process.env.QRSCAN_DATA_DIR = tmp;          // 数据目录指到临时目录
const proxyData = path.join(tmp, "proxy");
fs.mkdirSync(proxyData, { recursive: true });

// 探针：假子进程（exitCode 非 null = 已经退出）
function fakeProc() {
  const p = new EventEmitter();
  p.exitCode = 4;
  p.signalCode = null;
  p.killed = false;
  p.kill = () => {};
  return p;
}

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "electron") {
    return {
      shell: { openExternal: async () => {} },
      Notification: Object.assign(function () {}, { isSupported: () => false }),
      BrowserWindow: { getAllWindows: () => [] },
    };
  }
  if (request === "child_process") {
    return {
      spawn: () => fakeProc(),
      execFile: (cmd, args, opts, cb) => { cb(null, "3.12.10", ""); },
    };
  }
  return origLoad.apply(this, arguments);
};

const mgr = require("../proxy-manager.js");

const fails = [];
function check(cond, label, extra) {
  const okMark = cond ? "ok   " : "FAIL ";
  console.log(okMark + label + (!cond && extra ? "  " + extra : ""));
  if (!cond) fails.push(label);
}

// python 侧写的是本机时间（不带时区），这里保持一致，
// 否则 toISOString 的 UTC 会凭空差出 8 小时，把"刚刚失败"判成"很久以前"。
function localIso(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function writeExit(code, error, ageMs) {
  fs.writeFileSync(path.join(proxyData, "last_exit.json"),
    JSON.stringify({ code, error, time: localIso(new Date(Date.now() - (ageMs || 0))) }), "utf8");
}

(async () => {
  // 1) 新鲜的失败原因 → 必须原样透出
  writeExit(4, "根证书未能安装：安装脚本执行失败。已停止启用移动端环境，系统代理未改动。", 0);
  let r = await mgr.start({ mode: "android", ttlSec: 60 });
  check(r && r.ok === false, "失败时 start() 返回 ok:false", JSON.stringify(r));
  check(!!(r && /根证书未能安装/.test(r.error || "")), "原因来自 last_exit.json（可读）", r && r.error);
  check(!/启动超时或失败/.test((r && r.error) || ""), "不再是那句通用文案", r && r.error);

  // 2) 过期的失败原因 → 不能当成本次原因
  writeExit(4, "根证书未能安装：这是上次的旧错误", 10 * 60 * 1000);
  r = await mgr.start({ mode: "android", ttlSec: 60 });
  check(/启动超时或失败/.test((r && r.error) || ""), "90 秒前的旧原因被忽略", r && r.error);

  // 3) 没有 last_exit.json → 回落到通用文案
  try { fs.unlinkSync(path.join(proxyData, "last_exit.json")); } catch (_) {}
  r = await mgr.start({ mode: "android", ttlSec: 60 });
  check(/启动超时或失败/.test((r && r.error) || ""), "没有原因文件时用通用文案", r && r.error);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log("结果:", fails.length ? "HAS FAILURES: " + fails.join(", ") : "ALL PASS");
  process.exit(fails.length ? 1 : 0);
})().catch((e) => {
  console.log("FAIL 异常 " + (e && e.stack || e));
  process.exit(1);
});

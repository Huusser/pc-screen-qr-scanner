"use strict";

/**
 * P1-C 验收（桌面端那一半）：--scope 到底传了什么。
 *
 * 不启动 Electron / 不启真代理：把 electron 与 child_process 换成探针，
 * 只为看清 start() 交给 python 的 --scope 参数。
 *
 * 盯的事：
 *   1. 目标站 + 父域都要进 scope（同站子域跳转不会漏）
 *   2. 两段式公共后缀不能当域用（否则 a.b.com.cn 会宽化到整个 com.cn）
 *   3. 设置成「全部站点」时不传 --scope
 *   4. 全局代理模式下不传（ProxyOverride 做不了按域收窄）
 *   5. 非 http(s) 链接退回全量
 *   6-8. 通用性（2026-10-25 重构后）：集合外的两段式国家后缀、
 *        带说明文字的非纯 URL 文本、深子域
 *   9. --port/--admin-port 不回归
 *
 * 用法：node tools/_t-proxy-scope.js
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");
const { EventEmitter } = require("events");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "qr-pxscope-"));
process.env.QRSCAN_DATA_DIR = tmp;
fs.mkdirSync(path.join(tmp, "proxy"), { recursive: true });

const spawnCalls = [];

function fakeProc() {
  const p = new EventEmitter();
  p.exitCode = 2;              // 立刻当作失败退出，让 start() 尽快返回
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
      spawn: (cmd, args) => { spawnCalls.push(args || []); return fakeProc(); },
      execFile: (cmd, args, opts, cb) => { cb(null, "3.12.10", ""); },
    };
  }
  return origLoad.apply(this, arguments);
};

const mgr = require("../proxy-manager.js");
const settings = require("../settings.js");

const fails = [];
function check(cond, label, extra) {
  console.log((cond ? "ok   " : "FAIL ") + label + (!cond && extra ? "  " + extra : ""));
  if (!cond) fails.push(label);
}

function scopeArg(args) {
  const i = args.indexOf("--scope");
  return i >= 0 ? String(args[i + 1]) : null;
}

async function run(opts) {
  spawnCalls.length = 0;
  await mgr.start(opts);
  return spawnCalls.length ? scopeArg(spawnCalls[0]) : null;
}

(async () => {
  // ---- 1. 目标站 + 父域 ----
  let s = await run({ scopeUrl: "https://qr.example.com/api/Login/ScanQR?key=abc" });
  let list = (s || "").split(",").filter(Boolean);
  check(list.indexOf("qr.example.com") >= 0, "1 完整 host 进 scope", s);
  check(list.indexOf("example.com") >= 0, "1 父域也进 scope（同站子域跳转）", s);
  check(list.length === 2, "1 不多不少就这两级", s);

  // ---- 2. 两段式公共后缀 ----
  s = await run({ scopeUrl: "https://oa.corp.com.cn/login" });
  list = (s || "").split(",").filter(Boolean);
  check(list.indexOf("oa.corp.com.cn") >= 0, "2 完整 host 进 scope", s);
  check(list.indexOf("corp.com.cn") >= 0, "2 公司域进 scope", s);
  check(list.indexOf("com.cn") < 0, "2 没有宽化到公共后缀 com.cn", s);

  // ---- 3. 设置「全部站点」→ 不传 --scope ----
  settings.patch({ proxyScope: "all" });
  s = await run({ scopeUrl: "https://qr.example.com/x" });
  check(s === null, "3 全部站点时不传 --scope（python 侧即全量）", String(s));

  // ---- 4. 全局代理 → 不传 --scope ----
  settings.patch({ proxyScope: "target" });
  s = await run({ scopeUrl: "https://qr.example.com/x", globalProxy: true });
  check(s === null, "4 全局代理时不传 --scope（只能全量）", String(s));

  // ---- 5. 算不出域名 → 退回全量 ----
  s = await run({ scopeUrl: "weixin://dl/chat" });
  check(s === null, "5 非 http(s) 链接退回全量", String(s));

  // ---- 6. 通用性：集合外的两段式国家后缀（重构后由类别词规则覆盖） ----
  // 旧实现 MULTI_LABEL_SUFFIX 只列了 18 个后缀，a.com.tr 会把 com.tr 当
  // 注册域塞进 scope（= 整个 *.com.tr 被接管）。类别词规则应天然覆盖。
  s = await run({ scopeUrl: "https://recruit.a.com.tr/qr" });
  list = (s || "").split(",").filter(Boolean);
  check(list.indexOf("a.com.tr") >= 0, "6 集合外的 com.tr：注册域进 scope", s);
  check(list.indexOf("com.tr") < 0, "6 集合外的 com.tr：不宽化到后缀", s);

  s = await run({ scopeUrl: "https://x.org.nz/qr" });
  list = (s || "").split(",").filter(Boolean);
  check(list.indexOf("x.org.nz") >= 0 && list.indexOf("org.nz") < 0,
    "6 org.nz 同样被类别词规则覆盖", s);

  // ---- 7. 通用性：非纯 URL 文本（二维码常带说明文字） ----
  s = await run({ scopeUrl: "登录链接：https://hr.example.com/qr?key=1 请用微信打开" });
  list = (s || "").split(",").filter(Boolean);
  check(list.indexOf("hr.example.com") >= 0 && list.indexOf("example.com") >= 0,
    "7 带说明文字的文本也能提取出链接", s);

  s = await run({ scopeUrl: "https://a.example.com/x,https://b.other.com/y" });
  list = (s || "").split(",").filter(Boolean);
  check(list.indexOf("a.example.com") >= 0 && list.indexOf("b.other.com") < 0,
    "7 逗号分隔的多链接只取第一个", s);

  // ---- 8. 通用性：深子域 ----
  s = await run({ scopeUrl: "https://q.r.s.example.com/qr" });
  list = (s || "").split(",").filter(Boolean);
  check(list.indexOf("example.com") >= 0 && list.indexOf("r.s.example.com") >= 0,
    "8 深子域取最宽 3 级（PAC 后缀匹配自动覆盖全 host）", s);

  // ---- 9. 端口参数仍在（P1-A 不许回归） ----
  spawnCalls.length = 0;
  await mgr.start({ scopeUrl: "https://a.qq.com/x" });
  const args = spawnCalls.length ? spawnCalls[0] : [];
  check(args.indexOf("--port") >= 0 && args.indexOf("--admin-port") >= 0,
    "9 --port/--admin-port 仍然显式传入", JSON.stringify(args));

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log("结果:", fails.length ? "HAS FAILURES: " + fails.join(", ") : "ALL PASS");
  process.exit(fails.length ? 1 : 0);
})().catch((e) => {
  console.log("FAIL 异常 " + (e && e.stack || e));
  process.exit(1);
});

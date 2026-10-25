#!/usr/bin/env node
"use strict";

/**
 * 一条命令检查"发布产物到底签没签、签得对不对"
 * ============================================================
 *
 * 为什么需要它：签名最容易出错的不是"签"这一步，而是**签错对象**——
 *   只签了安装包、没签里面的 exe；或者签完之后又重新打了一次包，
 *   把签名覆盖掉。这两种情况 Installer 属性页看起来都像"已签名"。
 *
 * 用法：
 *   node tools/verify-sign.js                 # 检查默认产物
 *   node tools/verify-sign.js path\to.exe ... # 检查指定文件
 *
 * 退出码：0 = 全部已签且受信任；1 = 有文件没签；2 = 签了但不受信任（自签/根未装）。
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const PS1 = path.join(__dirname, "verify-sign.ps1");

const DEFAULTS = [
  "dist/win-unpacked",
  "dist",
];

function expand(target) {
  const abs = path.resolve(ROOT, target);
  if (!fs.existsSync(abs)) return [];
  const st = fs.statSync(abs);
  if (!st.isDirectory()) return [abs];
  const out = [];
  for (const name of fs.readdirSync(abs)) {
    const p = path.join(abs, name);
    if (!fs.statSync(p).isFile() || !/\.exe$/i.test(name)) continue;
    // dist 根目录里还会生成卸载器，它由 NSIS 生成、随安装包一起被签，
    // 单独检查没有意义，跳过
    if (/^__uninstaller-/i.test(name)) continue;
    out.push(p);
  }
  return out;
}

function check(file) {
  const r = spawnSync("powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", PS1, "-Path", file],
    { encoding: "utf8", windowsHide: true });
  const lines = (r.stdout || "").trim().split(/\r?\n/);
  try { return JSON.parse(lines[lines.length - 1]); } catch (_) {
    return { ok: false, file, error: (r.stdout || r.stderr || "").slice(0, 200) };
  }
}

function relOf(f) {
  const rel = path.relative(ROOT, f);
  // 目标在项目外（例如临时拷贝）时显示绝对路径，避免一长串 ..\..
  return rel.startsWith("..") ? f : rel;
}

function main() {
  const args = process.argv.slice(2);
  const targets = args.length ? args : DEFAULTS;

  const files = [];
  for (const t of targets) {
    for (const f of expand(t)) if (files.indexOf(f) < 0) files.push(f);
  }
  if (!files.length) {
    console.error("[verify] 没找到可检查的 exe。先 npm run pack 生成 dist/");
    process.exit(1);
  }

  let unsigned = 0;
  let untrusted = 0;

  for (const f of files) {
    const r = check(f);
    const rel = relOf(f);
    const size = (() => { try { return (fs.statSync(f).size / 1048576).toFixed(1) + " MB"; } catch (_) { return "?"; } })();

    if (!r.signed) {
      unsigned++;
      console.log("未签名  " + rel + "  (" + size + ")");
      if (r.error) console.log("        " + r.error);
      continue;
    }
    const mark = r.trusted ? "已签名·受信任" : "已签名·根不受信任";
    console.log(mark.padEnd(18) + rel + "  (" + size + ")");
    console.log("        签名者 : " + r.signer);
    console.log("        有效期 : " + r.notAfter);
    console.log("        时间戳 : " + (r.timestamped ? r.timestamp.subject + " (" + r.timestamp.notAfter + ")" : "无"));
    if (!r.trusted) untrusted++;
  }

  console.log("");
  if (untrusted) {
    console.log("[verify] 有 " + untrusted + " 个文件的签名不受信任。自签证书属正常；" +
      "正式证书请确认根证书链已装进系统。");
  }
  if (unsigned) {
    console.log("[verify] 有 " + unsigned + " 个文件没签名。检查是否漏签，或签完又被重新打包覆盖。");
  }
  if (!unsigned && !untrusted) console.log("[verify] 全部已签名且受信任。");

  process.exit(unsigned ? 1 : (untrusted ? 2 : 0));
}

main();

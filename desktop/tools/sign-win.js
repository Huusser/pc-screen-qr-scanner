#!/usr/bin/env node
"use strict";

/**
 * 给构建产物打 Authenticode 签名（Windows）
 * ============================================================
 *
 * 为什么不用 electron-builder 自带的签名链路：
 *   它依赖 winCodeSign 这个二进制包，包里带 macOS 的符号链接。在没有
 *   "创建符号链接"权限的 Windows（默认就是没有）上，7za 解压会直接失败，
 *   整个 build 卡在第一步。而且它还需要 Windows SDK 的 signtool。
 *   我们只用系统自带的 Set-AuthenticodeSignature，零额外依赖。
 *
 * 用法：
 *   node tools/sign-win.js --dev --target dist/win-unpacked            # 自签，验证管线
 *   CSC_LINK=C:\key.pfx CSC_KEY_PASSWORD=xxx \
 *     node tools/sign-win.js --target dist/win-unpacked                # 正式证书
 *
 * 参数：
 *   --target <路径>   文件、目录（找其中的 .exe）或通配符，可重复
 *   --dev             用自签证书（不会被信任，只用于验证流程）
 *   --timestamp <url> 指定时间戳服务；正式模式默认 http://timestamp.digicert.com
 *   --no-timestamp    不打时间戳（不推荐：证书过期后签名会一起失效）
 *
 * 顺序很重要：**先签 app 主程序，再打安装包，最后签安装包**。
 * 因为 NSIS 把主程序压缩进安装包，装完之后磁盘上的 exe 就是压缩进去的那份，
 * 事后签安装包并不会让它变成已签名。
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const PS1 = path.join(__dirname, "sign-file.ps1");
const DEFAULT_TSA = "http://timestamp.digicert.com";

function parseArgs(argv) {
  const out = { dev: false, targets: [], timestamp: null, thumbprint: "" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dev") out.dev = true;
    else if (a === "--target") out.targets.push(argv[++i]);
    else if (a === "--timestamp") out.timestamp = argv[++i];
    else if (a === "--no-timestamp") out.timestamp = "";
    else if (a === "--thumbprint") out.thumbprint = argv[++i] || "";
  }
  // 环境变量兜底：令牌模式更常见的用法是把指纹存进环境变量，命令保持一致
  if (!out.thumbprint && process.env.CSC_THUMBPRINT) {
    out.thumbprint = process.env.CSC_THUMBPRINT;
  }
  return out;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function expand(target) {
  const abs = path.resolve(ROOT, target);
  const hits = [];
  if (fs.existsSync(abs)) {
    const st = fs.statSync(abs);
    if (st.isDirectory()) {
      for (const name of fs.readdirSync(abs)) {
        const p = path.join(abs, name);
        if (fs.statSync(p).isFile() && /\.exe$/i.test(name)) hits.push(p);
      }
    } else {
      hits.push(abs);
    }
    return hits;
  }
  // 通配符：只支持单层 *（够用：dist/ScreenQR-*-x64.exe）
  const dir = path.dirname(abs);
  const pat = path.basename(abs);
  if (!fs.existsSync(dir) || pat.indexOf("*") < 0) return [];
  const re = new RegExp("^" + pat.split("*").map(escapeRe).join(".*") + "$", "i");
  for (const name of fs.readdirSync(dir)) {
    if (re.test(name)) hits.push(path.join(dir, name));
  }
  return hits;
}

function run(file, opts, prod) {
  const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", PS1, "-Path", file];
  if (prod) {
    if (opts.thumbprint) {
      // 令牌 / HSM 里的证书：私钥不可导出，只能按指纹用证书库中的那一张
      args.push("-Thumbprint", opts.thumbprint);
    } else {
      // 证书路径与密码只经环境变量传到 ps1，不进命令行（防进程列表泄露）
      args.push("-Pfx", process.env.CSC_LINK, "-Password", process.env.CSC_KEY_PASSWORD || "");
    }
  } else {
    args.push("-Dev");
  }
  if (opts.timestamp) args.push("-Timestamp", opts.timestamp);

  const r = spawnSync("powershell.exe", args, {
    encoding: "utf8",
    windowsHide: true,
    env: process.env,
  });
  const lines = (r.stdout || "").trim().split(/\r?\n/);
  let info = null;
  try { info = JSON.parse(lines[lines.length - 1]); } catch (_) {}
  if (!info) {
    return { ok: false, file, error: (r.stdout || r.stderr || "no output").slice(0, 300) };
  }
  return { ok: r.status === 0, file, ...info };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const prod = !opts.dev;

  if (prod && !process.env.CSC_LINK && !opts.thumbprint) {
    console.error(
      "[sign] 没有证书。正式签名二选一：\n" +
      "       · 软件证书（.pfx）：设置 CSC_LINK 与 CSC_KEY_PASSWORD\n" +
      "       · 令牌/HSM 证书：设置 CSC_THUMBPRINT（证书须装在 当前用户\\个人 证书库）\n" +
      "       只想验证签名管线本身，加 --dev 使用自签证书（不会被信任）。"
    );
    process.exit(2);
  }

  // 正式签名默认打时间戳：没有它，证书到期后所有旧安装包会重新变成"未签名"
  if (prod && opts.timestamp === null) opts.timestamp = DEFAULT_TSA;

  const files = [];
  for (const t of opts.targets) files.push(...expand(t));
  if (files.length === 0) {
    console.error("[sign] 没有找到要签的文件，检查 --target");
    process.exit(2);
  }

  let bad = 0;
  for (const f of files) {
    const r = run(f, opts, prod);
    const rel = path.relative(ROOT, f);
    if (!r.ok) {
      bad++;
      console.log("[sign] FAIL " + rel + "  " + (r.error || r.statusMessage || ""));
      continue;
    }
    const stamp = r.timed ? "已打时间戳" : "未打时间戳";
    console.log("[sign] ok   " + rel + "  → " + r.status + " / " + stamp);
    if (r.status !== "Valid") {
      console.log("       " + (r.statusMessage || "") +
        "\n       （自签证书的预期结果：签名已写入，只是根没有被系统信任）");
    }
    if (!r.timed && opts.timestamp) {
      console.log("       时间戳失败：" + (r.timeError || "") +
        "\n       （签名本身有效，但证书到期后它会失效；网络恢复后重跑即可）");
    }
  }
  process.exit(bad ? 1 : 0);
}

main();

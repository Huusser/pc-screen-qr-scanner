#!/usr/bin/env node
"use strict";

/**
 * 让 electron-builder 能在"受限环境"下跑起来
 * ============================================================
 *
 * 这一步解决两个**只在这类机器上出现**的问题（都是实测踩到的）：
 *
 * 1. Electron 包下载失败
 *    electron-builder 不管 node_modules 里有没有 electron，都会另下一份 zip。
 *    GitHub release 在国内经常 502/超时。若本机 electron 的缓存里已有同版本 zip，
 *    直接搬到 builder 的缓存目录，构建就不再联网。
 *
 * 2. winCodeSign 解压失败（更隐蔽）
 *    electron-builder 打包阶段**无条件**拉 winCodeSign-2.6.0。这个包里带 macOS 的
 *    符号链接（libcrypto.dylib / libssl.dylib），而 Windows 默认没有"创建符号链接"
 *    权限（要管理员或开发者模式），于是 7za 直接报
 *      ERROR: Cannot create symbolic link : 客户端没有所需的特权
 *    整个 build 停在这一步，且报错信息看起来跟签名毫不相干。
 *    这里自己下载并解压（排除 darwin 目录），builder 见到缓存目录即跳过该步骤。
 *
 * 用法：node tools/prepare-builder.js
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const https = require("https");
const { spawnSync } = require("child_process");

const MIRROR = process.env.ELECTRON_BUILDER_BINARIES_MIRROR ||
  "https://npmmirror.com/mirrors/electron-builder-binaries/";
const WINCODESIGN = "winCodeSign-2.6.0";

const CACHE = path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
  "electron-builder", "Cache"
);

function log(...a) { console.log("[prepare]", ...a); }

function download(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 60000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 5) {
        res.resume();
        return resolve(download(new URL(res.headers.location, url).toString(), dest, redirects + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error("HTTP " + res.statusCode + " " + url));
      }
      const total = Number(res.headers["content-length"] || 0);
      let got = 0;
      const tmp = dest + ".part";
      const out = fs.createWriteStream(tmp);
      res.on("data", (c) => {
        got += c.length;
        if (total && process.stdout.isTTY) {
          process.stdout.write(`\r[prepare] 下载 ${Math.floor((got / total) * 100)}% (${(got / 1048576).toFixed(1)} MB)`);
        }
      });
      res.pipe(out);
      out.on("finish", () => out.close(() => {
        if (process.stdout.isTTY) process.stdout.write("\n");
        fs.renameSync(tmp, dest);
        resolve(dest);
      }));
      out.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
  });
}

function sevenZip() {
  try {
    const p = path.join(path.dirname(require.resolve("7zip-bin/package.json")), "win", "x64", "7za.exe");
    if (fs.existsSync(p)) return p;
  } catch (_) {}
  return "";
}

function readElectronVersion() {
  try {
    return JSON.parse(fs.readFileSync(
      path.join(__dirname, "..", "node_modules", "electron", "package.json"), "utf8")).version;
  } catch (_) {
    return "";
  }
}

/** Electron zip：把 electron 自己的缓存搬进 builder 缓存 */
function ensureElectron() {
  const ver = readElectronVersion();
  if (!ver) {
    log("跳过 Electron（读不到 node_modules/electron 的版本）");
    return;
  }
  const target = path.join(CACHE, "electron");
  const name = `electron-v${ver}-win32-x64.zip`;
  if (fs.existsSync(path.join(target, name))) {
    log(`Electron ${ver} 已在缓存`);
    return;
  }
  fs.mkdirSync(target, { recursive: true });

  const electronCache = path.join(
    process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
    "electron", "Cache"
  );
  if (fs.existsSync(electronCache)) {
    for (const sub of fs.readdirSync(electronCache)) {
      const p = path.join(electronCache, sub, name);
      if (fs.existsSync(p)) {
        fs.copyFileSync(p, path.join(target, name));
        log(`Electron ${ver}：从本地缓存复制`);
        return;
      }
    }
  }
  log(`Electron ${ver}：本地没有，构建时将由 electron-builder 下载（可用 ELECTRON_MIRROR 指定镜像）`);
}

async function ensureWinCodeSign() {
  const target = path.join(CACHE, "winCodeSign", WINCODESIGN);
  // 判"就绪"不能只看目录在不在：杀软可能把 rcedit-x64.exe 单独隔离掉，
  // 目录还在、文件没了，builder 会在 rcedit 那一步报 "file does not exist"，
  // 而这条错误信息完全看不出是杀软干的。
  if (fs.existsSync(path.join(target, "rcedit-x64.exe"))) {
    log("winCodeSign 已就绪");
    return true;
  }
  if (fs.existsSync(target)) log("winCodeSign 目录不完整（缺 rcedit），重新解压");

  const zip = path.join(CACHE, "winCodeSign", WINCODESIGN + ".7z");
  fs.mkdirSync(path.dirname(zip), { recursive: true });

  if (!fs.existsSync(zip)) {
    const url = MIRROR.replace(/\/?$/, "/") + WINCODESIGN + "/" + WINCODESIGN + ".7z";
    try {
      log("下载 " + url);
      await download(url, zip);
    } catch (e) {
      log("下载失败：" + e.message);
      log("可在有网环境手动把 " + WINCODESIGN + ".7z 放到 " + path.dirname(zip));
      return false;
    }
  }

  const seven = sevenZip();
  if (!seven) {
    log("找不到 7za（npm install 后应随 7zip-bin 一起装上）");
    return false;
  }
  // 排除 darwin：里面是两个符号链接，Windows 上没权限建，而我们也不需要
  const r = spawnSync(seven, ["x", zip, "-o" + target, "-xr!darwin", "-y"], {
    encoding: "utf8", windowsHide: true,
  });
  if (r.status !== 0) {
    log("解压失败：" + ((r.stderr || r.stdout || "").slice(0, 300)));
    return false;
  }
  if (!fs.existsSync(path.join(target, "rcedit-x64.exe"))) {
    log("解压完成了，但 rcedit-x64.exe 仍不存在 —— 大概率被安全软件隔离。");
    log("处理办法：把 " + target + " 加入杀软信任/排除，再重跑本脚本。");
    return false;
  }
  log("winCodeSign 已解压（已排除 darwin 符号链接）");
  return true;
}

(async () => {
  fs.mkdirSync(CACHE, { recursive: true });
  ensureElectron();
  await ensureWinCodeSign();
  log("完成，可以跑 npm run pack / npm run dist");
})().catch((e) => {
  console.error("[prepare] 失败：" + e.message);
  process.exit(1);
});

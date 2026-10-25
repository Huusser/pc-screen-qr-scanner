#!/usr/bin/env node
"use strict";

/**
 * 下载并解出内置的 Python 运行时（Windows embeddable 版）
 * ============================================================
 *
 * 目的：让「手机环境」（本地代理）在**没有装 Python 的机器**上也能用。
 * 之前这块依赖用户自己装 Python 3.8+，普通用户满足率极低，等于功能不可用。
 *
 * 为什么用 python.org 的 embeddable 包，而不是 PyInstaller 打一个 exe：
 *   - 我们的代理脚本只用标准库（http.server / ssl / socket / winreg），
 *     没有第三方依赖，不需要 pip、不需要打包器；
 *   - embeddable 包就是"官方裁剪版 CPython + 标准库 zip"，约 11 MB，
 *     解压即用，没有安装程序、不写注册表、不进 PATH；
 *   - PyInstaller 需要额外装包且每次改代码都要重新打包，产物也更容易被
 *     杀软误报（自解压 PE 是高危特征）。
 *
 * 产物落在 desktop/vendor/python/，打包时经 asarUnpack 解到
 * `resources/app.asar.unpacked/vendor/python`，运行时由 paths.asset() 定位。
 *
 * 用法：
 *   node tools/fetch-runtime.js            # 缺什么补什么
 *   node tools/fetch-runtime.js --force    # 重新下载
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const https = require("https");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

const VERSION = "3.12.10";
// python.org 官方发布的 embeddable zip 校验值：钉死它，避免镜像/中间人被换包
// （取自 https 直连 python.org 下载的同一文件；换版本号时必须同步更新）
const SHA256 = "4acbed6dd1c744b0376e3b1cf57ce906f9dc9e95e68824584c8099a63025a3c3";
const URL_BASE = `https://www.python.org/ftp/python/${VERSION}/`;
const ZIP_NAME = `python-${VERSION}-embed-amd64.zip`;
// 国内直连 python.org 常常很慢，官方源失败时退到镜像（同一份文件）
const MIRRORS = [
  URL_BASE + ZIP_NAME,
  `https://registry.npmmirror.com/-/binary/python/${VERSION}/${ZIP_NAME}`,
];

const OUT_DIR = path.join(__dirname, "..", "vendor", "python");
const EXE = path.join(OUT_DIR, "python.exe");

function log(...a) {
  console.log("[runtime]", ...a);
}

function download(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 60000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 5) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        return resolve(download(next, dest, redirects + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error("HTTP " + res.statusCode + " " + url));
      }
      const total = Number(res.headers["content-length"] || 0);
      let got = 0;
      let lastPct = -1;
      const tmp = dest + ".part";
      const out = fs.createWriteStream(tmp);
      res.on("data", (c) => {
        got += c.length;
        if (total) {
          const pct = Math.floor((got / total) * 100);
          if (pct >= lastPct + 20) {
            lastPct = pct;
            log(`下载中 ${pct}% (${(got / 1048576).toFixed(1)} MB)`);
          }
        }
      });
      res.pipe(out);
      out.on("finish", () => {
        out.close(() => {
          fs.renameSync(tmp, dest);
          resolve(dest);
        });
      });
      out.on("error", reject);
    });
    req.on("timeout", () => { req.destroy(new Error("timeout " + url)); });
    req.on("error", reject);
  });
}

function find7za() {
  try {
    // electron-builder 的依赖里就带 7za，构建机上一定有
    const bin = require("7zip-bin");
    const p = path.join(path.dirname(require.resolve("7zip-bin/package.json")), "win", "x64", "7za.exe");
    if (fs.existsSync(p)) return p;
    if (bin && bin.path7za && fs.existsSync(bin.path7za)) return bin.path7za;
  } catch (_) {}
  return "";
}

function extract(zip, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const seven = find7za();
  if (seven) {
    const r = spawnSync(seven, ["x", zip, "-o" + dest, "-y"], { encoding: "utf8", windowsHide: true });
    if (r.status === 0) return "7za";
    log("7za 解压失败，改用 PowerShell：" + (r.stderr || "").slice(0, 200));
  }
  // 兜底：系统自带的 Expand-Archive（PowerShell 5.1 就有）
  const cmd = `Expand-Archive -LiteralPath '${zip.replace(/'/g, "''")}' -DestinationPath '${dest.replace(/'/g, "''")}' -Force`;
  const r2 = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", cmd], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (r2.status !== 0) throw new Error("解压失败：" + (r2.stderr || r2.stdout || "").slice(0, 300));
  return "Expand-Archive";
}

function sha256(file) {
  const h = crypto.createHash("sha256");
  h.update(fs.readFileSync(file));
  return h.digest("hex");
}

function probe(exe) {
  const r = spawnSync(exe, ["-c", "import sys,ssl;print('PYOK',sys.version.split()[0],ssl.OPENSSL_VERSION)"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 20000,
  });
  const out = (r.stdout || "").trim();
  if (r.status === 0 && out.indexOf("PYOK") === 0) return out;
  return "";
}

async function main() {
  const force = process.argv.includes("--force");
  const skipDownload = process.argv.includes("--no-download");

  if (!force && fs.existsSync(EXE)) {
    const v = probe(EXE);
    if (v) {
      log("已就绪：" + v);
      log("路径 " + EXE);
      return;
    }
    log("现有运行时不可用，重新准备");
  }

  if (!skipDownload) {
    const tmpZip = path.join(os.tmpdir(), ZIP_NAME);
    let got = "";
    let lastErr = null;
    for (const url of MIRRORS) {
      try {
        log("下载 " + url);
        await download(url, tmpZip);
        got = url;
        break;
      } catch (e) {
        lastErr = e;
        log("失败：" + e.message);
      }
    }
    if (!got) throw lastErr || new Error("所有下载源都失败");

    const sum = sha256(tmpZip);
    if (SHA256 !== "PLACEHOLDER" && sum !== SHA256) {
      throw new Error(`校验值不匹配（期望 ${SHA256}，实际 ${sum}），已中止`);
    }
    if (SHA256 === "PLACEHOLDER") log("（校验值未内置，本次记录 sha256 = " + sum + "）");

    log("解压到 " + OUT_DIR);
    const how = extract(tmpZip, OUT_DIR);
    log("解压方式：" + how);
    try { fs.unlinkSync(tmpZip); } catch (_) {}
  }

  const v = probe(EXE);
  if (!v) {
    throw new Error("运行时不可用：" + EXE + " 无法执行 ssl 模块");
  }
  log("完成：" + v);
  log("大小 " + (dirSize(OUT_DIR) / 1048576).toFixed(1) + " MB");
}

function dirSize(dir) {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    n += e.isDirectory() ? dirSize(p) : (fs.statSync(p).size || 0);
  }
  return n;
}

main().catch((e) => {
  console.error("[runtime] 失败：" + e.message);
  console.error("        可以手动下载 " + URL_BASE + ZIP_NAME + " 解压到 " + OUT_DIR);
  process.exit(1);
});

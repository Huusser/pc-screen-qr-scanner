"use strict";

/**
 * 可写状态的唯一出口
 * ============================================================
 *
 * 为什么要有这个文件：程序此前把 settings.json / boot.log / timing.log / 代理证书
 * 全写在**程序自己的目录**里。开发态（`electron .`）没问题，但装到
 * `C:\Program Files\` 之后，普通用户对这些路径没有写权限 —— 设置改完重启就丢、
 * 日志静默失败、代理证书生成失败。公开发布必须先把这件事拆干净：
 *
 *   程序目录（APP_DIR）  = 只读资源：代码、页面、win-helper.ps1、proxy/*.py
 *   数据目录（dataDir）  = 唯一可写：设置、日志、证书、代理状态
 *
 * 数据目录固定在 `%APPDATA%\ScreenQR`：
 *   - 不用 Electron 的 userData，是因为它跟随 app name，开发态与打包态会变成
 *     两个不同的目录，用户升级后看起来像"设置丢了"；
 *   - 名字用纯 ASCII，避免中文路径在 PowerShell 5.1 / Python 子进程里踩编码坑
 *     （本项目的 ps1 与 py 都要通过命令行传递路径）。
 *
 * 迁移：老版本把状态留在程序目录。首次启动时若数据目录还没有对应文件，
 * 就把老文件**复制**过来（不删除原件），用户升级后设置、证书都还在。
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

// 程序目录：只读资源所在（开发态是 desktop/，打包后是 resources/app/）
const APP_DIR = __dirname;

// 允许测试与便携模式改写数据目录（不要放进"用户能改的界面设置"里）。
// 每次解析时读环境变量，测试里可以改完再 _resetCache()。
const DATA_NAME = "ScreenQR";

// 老版本留在程序目录里的东西（迁移用）
const LEGACY_FILES = ["settings.json", "boot.log", "crash.log", "timing.log"];
const LEGACY_PROXY_FILES = [
  "state.json", "previous.json", "learned.json", "stats.json",
  "manager.log", "mitm.log", "proxy-debug.log",
];
const LEGACY_PROXY_DIRS = ["certs"];

let cachedDataDir = "";

/** `%APPDATA%\ScreenQR`（或 QRSCAN_DATA_DIR 指定的位置） */
function dataDir() {
  if (cachedDataDir) return cachedDataDir;
  if (process.env.QRSCAN_DATA_DIR) {
    cachedDataDir = path.resolve(process.env.QRSCAN_DATA_DIR);
    return cachedDataDir;
  }
  const roaming = process.env.APPDATA ||
    path.join(os.homedir(), "AppData", "Roaming");
  cachedDataDir = path.join(roaming, DATA_NAME);
  return cachedDataDir;
}

/** userData 布局里的子路径，例如 file("boot.log") */
function file(name) {
  return path.join(dataDir(), name);
}

function ensureDataDir() {
  const dir = dataDir();
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  return dir;
}

/**
 * proxy 的**代码**目录（只读）：开发态是 `<project>/proxy`，
 * 打包后是 `resources/proxy`（见 package.json 的 extraResources）。
 * 判据用 app.isPackaged，拿不到 electron 时按开发态处理。
 */
function proxyDir() {
  try {
    const e = require("electron");
    if (e && e.app && e.app.isPackaged && process.resourcesPath) {
      return path.join(process.resourcesPath, "proxy");
    }
  } catch (_) {}
  return path.join(APP_DIR, "..", "proxy");
}

/** proxy 的**数据**目录（可写）：证书、状态、日志都落在这里 */
function proxyDataDir() {
  return path.join(dataDir(), "proxy");
}

/**
 * 程序目录里某个**要被外部进程打开**的文件的真实路径。
 *
 * 为什么不能直接用 path.join(__dirname, name)：打包后 __dirname 是
 * `resources\app.asar`，那是个压缩包，Node 能读，但 PowerShell / Python /
 * 任何外部程序都打不开。electron-builder 对 package.json 里 asarUnpack
 * 声明的文件会额外解出一份到 `app.asar.unpacked`，这里把路径改过去。
 */
function asset(name) {
  const p = path.join(APP_DIR, name);
  if (p.indexOf("app.asar") >= 0) return p.replace("app.asar", "app.asar.unpacked");
  return p;
}

/**
 * 程序自带的 Python 运行时（vendor/python/python.exe）。
 *
 * 「手机环境」原本要求用户自己装 Python；现在发行包里带一份官方
 * embeddable 运行时（见 tools/fetch-runtime.js），开发态与安装态都能用。
 * 返回空串表示这份文件不存在（例如构建时没跑 fetch-runtime），
 * 调用方应回落到系统 Python。
 */
function runtimePython() {
  const p = asset(path.join("vendor", "python", "python.exe"));
  try {
    return fs.existsSync(p) ? p : "";
  } catch (_) {
    return "";
  }
}

function ensureProxyDataDir() {
  const dir = proxyDataDir();
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  return dir;
}

function copyIfMissing(from, to) {
  try {
    if (fs.existsSync(to)) return false;
    if (!fs.existsSync(from)) return false;
    const st = fs.statSync(from);
    if (st.isDirectory()) {
      if (typeof fs.cpSync === "function") fs.cpSync(from, to, { recursive: true });
      else return false;
    } else {
      fs.copyFileSync(from, to);
    }
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * 老版本（状态写在程序目录）→ 新布局的一次性迁移。
 * 只在目标不存在时复制，绝不覆盖新数据，也绝不删除老文件。
 * @returns {string[]} 实际迁移过来的文件/目录名
 */
function migrate() {
  const moved = [];
  ensureDataDir();

  for (const name of LEGACY_FILES) {
    if (copyIfMissing(path.join(APP_DIR, name), file(name))) moved.push(name);
  }

  const code = proxyDir();
  const pdata = proxyDataDir();
  if (fs.existsSync(code) && path.resolve(code) !== path.resolve(pdata)) {
    try { fs.mkdirSync(pdata, { recursive: true }); } catch (_) {}
    for (const name of LEGACY_PROXY_FILES) {
      if (copyIfMissing(path.join(code, name), path.join(pdata, name))) moved.push("proxy/" + name);
    }
    for (const name of LEGACY_PROXY_DIRS) {
      if (copyIfMissing(path.join(code, name), path.join(pdata, name))) moved.push("proxy/" + name + "/");
    }
  }
  return moved;
}

/** 「清空日志」要处理哪些文件（不含设置与证书） */
function logFiles() {
  return [
    file("boot.log"),
    file("crash.log"),
    file("timing.log"),
    path.join(proxyDataDir(), "manager.log"),
    path.join(proxyDataDir(), "mitm.log"),
    path.join(proxyDataDir(), "proxy-debug.log"),
  ];
}

/**
 * 清空日志：删除文件而不是截断 —— 免得占用中的句柄让旧内容继续可见。
 * 返回删掉了几个、共多少字节，界面据此给反馈。
 */
function clearLogs() {
  let files = 0;
  let bytes = 0;
  for (const p of logFiles()) {
    try {
      if (!fs.existsSync(p)) continue;
      const st = fs.statSync(p);
      bytes += st.size || 0;
      fs.unlinkSync(p);
      files += 1;
    } catch (_) {}
  }
  return { files, bytes };
}

/** 日志总体积（设置页显示用） */
function logUsage() {
  let bytes = 0;
  let files = 0;
  for (const p of logFiles()) {
    try {
      if (!fs.existsSync(p)) continue;
      bytes += fs.statSync(p).size || 0;
      files += 1;
    } catch (_) {}
  }
  return { files, bytes };
}

module.exports = {
  APP_DIR,
  dataDir,
  file,
  ensureDataDir,
  proxyDir,
  proxyDataDir,
  ensureProxyDataDir,
  asset,
  runtimePython,
  migrate,
  logFiles,
  clearLogs,
  logUsage,
  // 测试用：允许在同一个进程里换目录
  _resetCache: () => { cachedDataDir = ""; },
};

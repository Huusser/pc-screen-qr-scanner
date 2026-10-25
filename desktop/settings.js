"use strict";

/**
 * 设置中心
 *
 * 单一职责：定义所有可配置项 + 校验 + 落盘。不掺任何业务逻辑。
 * 需要"改设置之后要做什么"的动作（重注册热键、置顶、开机自启…）都在 main.js 里，
 * 这里只保证：读到的一定是合法值，写下去的一定能读回来。
 *
 * 落盘位置：`%APPDATA%\ScreenQR\settings.json`（见 paths.js）。
 * 不再写在程序目录：装到 Program Files 后那里没有写权限，
 * 表现是"设置改完重启就丢"。用户可以整个目录删掉来重置。
 */

const fs = require("fs");
const paths = require("./paths");

const FILE = paths.file("settings.json");

// ---------------------------------------------------------------- 默认值
//
// 每加一项，同步改 launcher.html 里对应的控件（data-key 必须一致）。

const DEFAULTS = {
  // ---- 扫码 ----
  hotkey: "Alt+Shift+Q",       // Electron accelerator 语法
  scanMode: "single",          // single = 冻结（读到就停） | continuous = 连续
  autoCopy: true,              // 识别后自动写剪贴板
  rememberBox: true,           // 记住上次框选区域
  hideLauncher: true,          // 框选时把主窗口藏起来
  autoJudge: true,             // 自动判断是否需要手机环境
  resultDwell: "medium",       // 结果条自动收起等待：short 2s / medium 4s / long 8s
  sound: false,                // 识别成功提示音（总开关）
  soundId: "twotone",          // 音色：6 个内置合成音 + custom（用户导入）
  soundCustom: null,           // custom 的元信息 { name, format, ms, file, bytes, at }
  autoOpen: false,             // 全自动打开链接（搜一搜定位 + 点击）
  autoOpenMode: "auto",        // 点击方式：auto 依次尝试 | uia 无障碍 | ocr 文字识别 | region 区域
  timingTest: false,           // 时间测试：默认关闭，不触发任何运行（后备开关，行为待接）

  // ---- 移动端环境（代理）----
  proxyAnswer: "ask",          // ask 每次问 | auto 直接开 | off 不启用
  proxyTtl: 180,               // 10 / 60 / 180 / 300 / 0(不限)
  proxyScope: "target",        // target 只接管目标站（默认）| all 全部站点
  proxyMode: "pac",            // global 全局 | pac 兼容（默认 PAC：接管全部 HTTPS，腾讯系与系统更新除外）
  // 代理请求日志：off 不记录（默认）| host 只记域名 | full 记完整路径
  // 默认 off 是隐私要求：full 会把用户访问的完整 URL（含查询串）明文落盘
  proxyLog: "off",

  // ---- 外观与窗口 ----
  theme: "dark",               // dark | light | system
  maskOpacity: 60,             // 取景框外遮罩浓度 30~85
  autoLaunch: false,           // 开机自启
  alwaysOnTop: true,           // 主窗口置顶
  closeAction: "quit",         // quit 退出 | tray 收到托盘
  frameSize: "medium",         // 取景框默认大小 small | medium | large
};

// ---------------------------------------------------------------- 校验
//
// 只做"值是否合法"的判断，不做类型转换。非法值一律回落到默认，
// 避免手改 settings.json 写坏一个值就整个程序行为诡异。

const ENUMS = {
  scanMode: ["single", "continuous"],
  resultDwell: ["short", "medium", "long"],
  proxyAnswer: ["ask", "auto", "off"],
  proxyMode: ["global", "pac"],
  // 代理范围：target 只接管要打开的那个站（及其父域，跳转域边跑边加）| all 全部站点
  proxyScope: ["target", "all"],
  // 代理请求日志：off 不记录 | host 只记域名 | full 记完整路径
  proxyLog: ["off", "host", "full"],
  theme: ["dark", "light", "system"],
  closeAction: ["quit", "tray"],
  frameSize: ["small", "medium", "large"],
  // 点击方式：必须和 wechat-auto.js 的 AUTO_ORDER 一致
  autoOpenMode: ["auto", "uia", "ocr", "region"],
  // 必须和 sound.js 里的 PRESETS + CUSTOM_ID 一致
  soundId: ["blip", "twotone", "marimba", "wood", "bell", "arpeggio", "custom"],
};

const NUMBERS = {
  maskOpacity: { min: 30, max: 85 },
};

const TTL_ALLOWED = [0, 10, 60, 180, 300];

/**
 * 自定义音色的元信息。只有 file 字段会被真正用到（指向 sounds/custom.wav），
 * 其余是为了界面显示文件名和时长。
 * file 限死在 sounds/ 下：这是唯一允许读写的音频路径，
 * 免得手改 settings.json 就能让它去读任意文件。
 */
function cleanCustom(v) {
  if (!v || typeof v !== "object") return null;
  const file = typeof v.file === "string" ? v.file : "";
  if (!/^sounds\/[A-Za-z0-9._-]{1,64}$/.test(file)) return null;
  return {
    name: String(v.name || "自定义音色").slice(0, 80),
    format: String(v.format || "WAV").slice(0, 24),
    ms: Math.max(0, Math.min(60000, Math.round(Number(v.ms) || 0))),
    peak: Math.max(0.01, Math.min(2, Number(v.peak) || 0.9)),
    bytes: Math.max(0, Math.round(Number(v.bytes) || 0)),
    file,
    at: typeof v.at === "string" ? v.at.slice(0, 40) : "",
  };
}

function clean(key, value) {
  const def = DEFAULTS[key];

  if (key === "soundCustom") return cleanCustom(value);

  if (Object.prototype.hasOwnProperty.call(ENUMS, key)) {
    return ENUMS[key].indexOf(value) >= 0 ? value : def;
  }

  if (Object.prototype.hasOwnProperty.call(NUMBERS, key)) {
    const n = Math.round(Number(value));
    if (!Number.isFinite(n)) return def;
    return Math.min(NUMBERS[key].max, Math.max(NUMBERS[key].min, n));
  }

  if (key === "proxyTtl") {
    const n = Math.round(Number(value));
    return TTL_ALLOWED.indexOf(n) >= 0 ? n : def;
  }

  if (key === "autoCopy" || key === "rememberBox" || key === "hideLauncher" ||
      key === "autoJudge" || key === "sound" || key === "autoLaunch" ||
      key === "autoOpen" || key === "alwaysOnTop" || key === "timingTest") {
    return typeof value === "boolean" ? value : def;
  }

  if (key === "hotkey") {
    if (typeof value !== "string") return def;
    const v = value.trim();
    // 至少要有一个修饰键 + 一个主键，纯字母会把全局键盘全吃掉
    if (v.length < 3 || v.length > 40) return def;
    if (!/(Ctrl|Alt|Shift|Super|Command)/i.test(v)) return def;
    return v;
  }

  return def;
}

function emptyState() {
  return Object.assign({}, DEFAULTS);
}

// ---------------------------------------------------------------- 读写

let current = null;
let listeners = [];

function readFile() {
  try {
    const raw = fs.readFileSync(FILE, "utf8");
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== "object") return emptyState();
    const out = emptyState();
    for (const key of Object.keys(DEFAULTS)) {
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        out[key] = clean(key, obj[key]);
      }
    }
    return out;
  } catch (_) {
    // 首次运行没有文件、或者文件被写坏 —— 都当默认值处理，不影响启动
    return emptyState();
  }
}

/**
 * 交叉校验：soundId=custom 但没有自定义文件时回落默认。
 * 否则界面上显示"自定义音色"，实际按下去只会退回默认音，看起来像坏了。
 */
function normalize(obj) {
  if (obj.soundId === "custom" && !obj.soundCustom) obj.soundId = DEFAULTS.soundId;
  return obj;
}

function persist() {
  const write = () => {
    const tmp = FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(current, null, 2), "utf8");
    fs.renameSync(tmp, FILE);
  };
  try {
    write();
    return true;
  } catch (err) {
    // 数据目录可能在首启时还没建（例如设置页比迁移更早被读一次）：
    // 补建一次再写，而不是让用户的设置静默丢失。
    try {
      paths.ensureDataDir();
      write();
      return true;
    } catch (err2) {
      console.error("[settings] 保存失败:", err2 && err2.message);
      return false;
    }
  }
}

function init() {
  paths.ensureDataDir();
  current = normalize(readFile());
  return current;
}

function get() {
  if (!current) init();
  return Object.assign({}, current);
}

/**
 * 合并写入。只接受已知 key，非法值回落到默认值。
 * 返回真正发生变化的 key 列表，调用方据此决定要不要做副作用。
 */
function patch(partial) {
  if (!current) init();
  const src = partial && typeof partial === "object" ? partial : {};
  const changed = [];

  for (const key of Object.keys(src)) {
    if (!Object.prototype.hasOwnProperty.call(DEFAULTS, key)) continue;
    const next = clean(key, src[key]);
    // soundCustom 是对象，只能按内容比；其它都是原始值
    const same = key === "soundCustom"
      ? JSON.stringify(next) === JSON.stringify(current[key])
      : next === current[key];
    if (!same) {
      current[key] = next;
      changed.push(key);
    }
  }

  if (changed.length) {
    if (current.soundId === "custom" && !current.soundCustom) {
      current.soundId = DEFAULTS.soundId;
      if (changed.indexOf("soundId") < 0) changed.push("soundId");
    }
    persist();
  }
  return { changed, settings: get() };
}

function reset() {
  const before = current || {};
  current = normalize(emptyState());
  persist();
  const changed = Object.keys(DEFAULTS).filter((k) => before[k] !== current[k]);
  return { changed, settings: get() };
}

function onChange(cb) {
  if (typeof cb === "function") listeners.push(cb);
}

function emit(settings, changed) {
  for (const cb of listeners) {
    try { cb(settings, changed); } catch (_) {}
  }
}

module.exports = {
  DEFAULTS,
  FILE,
  init,
  get,
  patch,
  reset,
  onChange,
  emit,
  // 测试用
  _clean: clean,
};

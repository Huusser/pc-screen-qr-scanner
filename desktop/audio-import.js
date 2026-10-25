"use strict";

/**
 * 自定义提示音的导入
 *
 * 这里只做两件事：
 *   1. 识别：按**文件头**判断真实格式，不信扩展名（网上下的音效经常 .mp3 实为 mp4、
 *      .wav 实为 flac，只看后缀会白费一次解码）
 *   2. 落盘：把渲染进程解码并归一后的 WAV 存成 sounds/custom.wav
 *
 * 真正的"能不能用"由渲染进程的 decodeAudioData 决定 —— 格式表只能判断"大概支持"，
 * 解码器才是最终裁判，所以这里对可疑格式一律放行到解码那一步，不提前拦死。
 *
 * 为什么最终存 WAV 而不是原文件：用户随时可能删掉/移动源文件，而提示音要跟着走。
 * 存 WAV 就不依赖任何外部路径，格式也确定，不存在"下次打开播不出来"。
 */

const fs = require("fs");
const path = require("path");

const SOUNDS_DIR = path.join(__dirname, "sounds");
const CUSTOM_FILE = path.join(SOUNDS_DIR, "custom.wav");

const MAX_BYTES = 24 * 1024 * 1024;      // 24MB：提示音够用了，再大只说明选错了文件
const MAX_WAV_BYTES = 8 * 1024 * 1024;   // 归一后的 WAV 上限（约 45 秒双声道）

// ---------------------------------------------------------------- 工具

function ascii(buf, from, to) {
  try { return buf.toString("latin1", from, to); } catch (_) { return ""; }
}

function findAscii(buf, needle, limit) {
  const end = Math.min(buf.length, limit || 2048);
  const s = ascii(buf, 0, end);
  return s.indexOf(needle) >= 0;
}

function bytesAt(buf, off, list) {
  if (buf.length < off + list.length) return false;
  for (let i = 0; i < list.length; i++) if (buf[off + i] !== list[i]) return false;
  return true;
}

// ---------------------------------------------------------------- 格式表
//
// decode:true  = 浏览器内置解码器能处理
// decode:false = 认得出来，但 Chromium 解不了，直接给结论 + 转换建议，不浪费一次解码

const ASF_GUID = [0x30, 0x26, 0xB2, 0x75, 0x8E, 0x66, 0xCF, 0x11];

const FORMATS = [
  {
    fmt: "wav", label: "WAV", decode: true, ext: ["wav", "wave"],
    test: (b) => ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WAVE"
  },
  {
    fmt: "aiff", label: "AIFF", decode: true, ext: ["aif", "aiff", "aifc"],
    test: (b) => ascii(b, 0, 4) === "FORM" && /AIFF|AIFC/.test(ascii(b, 8, 12))
  },
  {
    fmt: "flac", label: "FLAC", decode: true, ext: ["flac"],
    test: (b) => ascii(b, 0, 4) === "fLaC"
  },
  {
    fmt: "ogg", label: "OGG", decode: true, ext: ["ogg", "oga", "opus"],
    test: (b) => ascii(b, 0, 4) === "OggS",
    // Speex 是 OGG 容器里唯一 Chromium 不支持的编解码器
    refine: (b) => (findAscii(b, "Speex", 512)
      ? { fmt: "speex", label: "Speex(OGG)", decode: false,
          why: "Speex 是早期语音编码，Chromium 没有内置解码器" }
      : null)
  },
  {
    fmt: "mp4", label: "M4A / MP4", decode: true, ext: ["m4a", "m4b", "mp4", "aac", "m4r"],
    test: (b) => ascii(b, 4, 8) === "ftyp",
    // ALAC 是无损编码，Chromium 不解；先认出来，能省一次失败
    refine: (b) => (findAscii(b, "alac", 512)
      ? { fmt: "alac", label: "ALAC(M4A)", decode: false,
          why: "ALAC 是苹果无损编码，Chromium 不支持（转成 AAC 或 WAV 即可）" }
      : null)
  },
  {
    fmt: "matroska", label: "WebM / MKV", decode: true, ext: ["webm", "mka", "mkv"],
    test: (b) => bytesAt(b, 0, [0x1A, 0x45, 0xDF, 0xA3])
  },
  {
    fmt: "adts", label: "AAC(ADTS)", decode: true, ext: ["aac"],
    test: (b) => b.length > 1 && b[0] === 0xFF && (b[1] & 0xF6) === 0xF0
  },
  {
    fmt: "mp3", label: "MP3", decode: true, ext: ["mp3", "mp2", "mpga"],
    test: (b) => ascii(b, 0, 3) === "ID3" || (b.length > 1 && b[0] === 0xFF && (b[1] & 0xE0) === 0xE0)
  },

  // ---- 认得出来但解不了：给结论，别让用户以为是软件坏了 ----
  {
    fmt: "wma", label: "WMA", decode: false, ext: ["wma", "asf", "wmv"],
    test: (b) => bytesAt(b, 0, ASF_GUID),
    why: "WMA 是 Windows Media 私有编码，Chromium 没有内置解码器"
  },
  {
    fmt: "ape", label: "APE", decode: false, ext: ["ape"],
    test: (b) => ascii(b, 0, 4) === "MAC ",
    why: "APE 是无损压缩，Chromium 没有内置解码器"
  },
  {
    fmt: "amr", label: "AMR", decode: false, ext: ["amr", "awb"],
    test: (b) => ascii(b, 0, 5) === "#!AMR",
    why: "AMR 是功能机时代的语音编码，Chromium 没有内置解码器"
  },
  {
    fmt: "midi", label: "MIDI", decode: false, ext: ["mid", "midi", "rmi"],
    test: (b) => ascii(b, 0, 4) === "MThd",
    why: "MIDI 存的是乐谱不是声音，需要音源才能渲染成音频"
  },
  {
    fmt: "wavpack", label: "WavPack", decode: false, ext: ["wv"],
    test: (b) => ascii(b, 0, 4) === "wvpk",
    why: "WavPack 是无损压缩，Chromium 没有内置解码器"
  },
  {
    fmt: "dsd", label: "DSD", decode: false, ext: ["dsf", "dff"],
    test: (b) => ascii(b, 0, 4) === "DSD " || ascii(b, 0, 4) === "FRM8",
    why: "DSD 是 SACD 用的 1bit 编码，Chromium 没有内置解码器"
  },
  {
    fmt: "tta", label: "TTA", decode: false, ext: ["tta"],
    test: (b) => ascii(b, 0, 4) === "TTA1",
    why: "TTA 是无损压缩，Chromium 没有内置解码器"
  },
  {
    fmt: "ac3", label: "AC-3 / E-AC-3", decode: false, ext: ["ac3", "eac3", "ec3"],
    test: (b) => bytesAt(b, 0, [0x0B, 0x77]),
    why: "AC-3 是影院多声道格式，Chromium 没有内置解码器"
  },
  {
    fmt: "caf", label: "CAF", decode: false, ext: ["caf"],
    test: (b) => ascii(b, 0, 4) === "caff",
    why: "CAF 是苹果容器格式，Chromium 不支持"
  },
  {
    fmt: "au", label: "AU", decode: false, ext: ["au", "snd"],
    test: (b) => ascii(b, 0, 4) === ".snd",
    why: "AU 是 Unix 老格式，Chromium 不支持"
  },
  {
    fmt: "real", label: "RealAudio", decode: false, ext: ["ra", "ram", "rm"],
    test: (b) => ascii(b, 0, 4) === ".ra\xfd" || ascii(b, 0, 4) === ".RMF",
    why: "RealAudio 是流媒体私有格式，Chromium 不支持"
  },
  {
    fmt: "musepack", label: "Musepack", decode: false, ext: ["mpc"],
    test: (b) => ascii(b, 0, 4) === "MPCK" || ascii(b, 0, 3) === "MP+",
    why: "Musepack 是有损压缩，Chromium 没有内置解码器"
  }
];

const DECODABLE_EXT = [];
const ALL_EXT = [];
for (const f of FORMATS) {
  for (const e of f.ext || []) {
    ALL_EXT.push(e);
    if (f.decode) DECODABLE_EXT.push(e);
  }
}

// ---------------------------------------------------------------- 识别

/**
 * 按文件头认格式。返回 { ok, format, label, decode, why } 或 { ok:false, code, message }
 */
function sniff(buf) {
  if (!buf || buf.length < 4) {
    return { ok: false, code: "unknown", message: "文件是空的，读不到任何内容" };
  }
  // 先排除"把网页/文本当音频下载"的常见情况，给出的提示比"格式不支持"具体
  const head = ascii(buf, 0, 64).trim().toLowerCase();
  if (head.startsWith("<!doctype") || head.startsWith("<html") || head.startsWith("<?xml")) {
    return {
      ok: false, code: "unknown",
      message: "这是一个网页而不是音频文件，可能是下载链接直接存成了文件"
    };
  }

  for (const f of FORMATS) {
    if (!f.test(buf)) continue;
    const refined = f.refine ? f.refine(buf) : null;
    const hit = refined || f;
    if (!hit.decode) {
      return {
        ok: true, format: hit.fmt, label: hit.label, decode: false,
        why: hit.why,
        message: "识别为 " + hit.label + "，但" + hit.why +
          "。请先转成 MP3 / WAV / M4A / OGG（任意转换工具都行，命令行可用：ffmpeg -i 输入文件 输出文件.mp3）"
      };
    }
    return { ok: true, format: hit.fmt, label: hit.label, decode: true };
  }

  return {
    ok: false, code: "unknown",
    message: "认不出这个文件的音频格式。支持 MP3 / WAV / M4A / AAC / FLAC / OGG / Opus / AIFF / WebM"
  };
}

// ---------------------------------------------------------------- 打开并读取

function extOf(name) {
  const m = /\.([a-z0-9]{1,6})$/i.exec(name || "");
  return m ? m[1].toLowerCase() : "";
}

/**
 * 选一个文件并读进内存。
 * 返回：{ canceled } | { ok:true, name, format, label, size, base64 }
 *       | { ok:false, code, message, ... }
 */
async function pick(parent) {
  const { dialog } = require("electron");
  const filters = [
    { name: "音频文件（推荐 MP3 / WAV / M4A）", extensions: Array.from(new Set(DECODABLE_EXT)) },
    { name: "全部已知音频格式", extensions: Array.from(new Set(ALL_EXT)) },
    { name: "所有文件", extensions: ["*"] }
  ];

  let res;
  try {
    res = await dialog.showOpenDialog(parent || undefined, {
      title: "选择提示音（自定义音色）",
      buttonLabel: "导入这个文件",
      properties: ["openFile"],
      filters
    });
  } catch (err) {
    return { ok: false, code: "dialog", message: "打不开文件选择框：" + (err && err.message) };
  }
  if (!res || res.canceled || !res.filePaths || !res.filePaths.length) return { canceled: true };

  const file = res.filePaths[0];
  return inspect(file);
}

function inspect(file) {
  let st;
  try {
    st = fs.statSync(file);
  } catch (err) {
    return { ok: false, code: "readfail", message: "读不到这个文件：" + (err && err.message) };
  }
  if (!st.isFile()) return { ok: false, code: "notfile", message: "选的不是文件" };
  if (st.size === 0) return { ok: false, code: "unknown", message: "这个文件是空的（0 字节）" };
  if (st.size > MAX_BYTES) {
    return {
      ok: false, code: "toolarge",
      message: "文件 " + (st.size / 1048576).toFixed(1) + "MB，超过 24MB 上限。" +
        "提示音通常几十 KB，这么大的多半是歌曲或无损专辑"
    };
  }

  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch (err) {
    return { ok: false, code: "readfail", message: "读取失败：" + (err && err.message) };
  }

  const hit = sniff(buf);
  if (!hit.ok) {
    return Object.assign({ name: path.basename(file), size: st.size }, hit);
  }

  const name = path.basename(file);
  if (!hit.decode) {
    // 认得出来但解不了：直接给结论。message 里已经带上补救办法。
    return {
      ok: false, code: "undecodable", format: hit.format, label: hit.label,
      name, size: st.size, message: hit.message
    };
  }

  // 扩展名和实际格式不一致是常见现象（很多网站 .mp3 实际是 m4a），
  // 只记一笔供提示用，不拦。
  const ext = extOf(name);
  return {
    ok: true,
    name,
    extr: ext,
    format: hit.format,
    label: hit.label,
    mismatch: !!ext && (FORMATS.find((f) => f.fmt === hit.format) || { ext: [] }).ext.indexOf(ext) < 0,
    size: st.size,
    base64: buf.toString("base64")
  };
}

// ---------------------------------------------------------------- 落盘

function ensureDir() {
  if (!fs.existsSync(SOUNDS_DIR)) fs.mkdirSync(SOUNDS_DIR, { recursive: true });
}

/**
 * 存渲染进程送来的 WAV（已解码、已归一）。
 * 只收真正的 RIFF/WAVE，别的东西一律拒 —— 这是唯一会被写进目录的文件。
 */
function saveWav(payload) {
  const p = payload || {};
  if (typeof p.wavBase64 !== "string" || p.wavBase64.length < 128) {
    return { ok: false, error: "音频数据为空" };
  }
  let buf;
  try {
    buf = Buffer.from(p.wavBase64, "base64");
  } catch (_) {
    return { ok: false, error: "音频数据解码失败" };
  }
  if (buf.length < 44 || ascii(buf, 0, 4) !== "RIFF" || ascii(buf, 8, 12) !== "WAVE") {
    return { ok: false, error: "音频数据不是合法的 WAV" };
  }
  if (buf.length > MAX_WAV_BYTES) {
    return { ok: false, error: "音频太长，转换后超过 8MB 上限" };
  }

  try {
    ensureDir();
    // 先写临时文件再改名：中途失败不会留下半个 custom.wav，
    // 否则下次播放会拿到损坏文件。
    const tmp = CUSTOM_FILE + ".tmp";
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, CUSTOM_FILE);
  } catch (err) {
    return { ok: false, error: "写入失败：" + (err && err.message) };
  }

  const ms = Math.max(0, Math.round(Number(p.ms) || 0));
  const meta = {
    name: String(p.name || "自定义音色").slice(0, 80),
    format: String(p.format || "WAV").slice(0, 24),
    ms,
    peak: 0.9,
    file: "sounds/custom.wav",
    bytes: buf.length,
    at: new Date().toISOString()
  };
  return { ok: true, meta };
}

function readCustom() {
  if (!fs.existsSync(CUSTOM_FILE)) return { ok: false, error: "还没有导入自定义音色" };
  try {
    const buf = fs.readFileSync(CUSTOM_FILE);
    if (buf.length < 44 || ascii(buf, 0, 4) !== "RIFF") {
      return { ok: false, error: "自定义音频文件已损坏，请重新导入" };
    }
    return { ok: true, base64: buf.toString("base64"), bytes: buf.length };
  } catch (err) {
    return { ok: false, error: "读取自定义音频失败：" + (err && err.message) };
  }
}

function removeCustom() {
  try {
    if (fs.existsSync(CUSTOM_FILE)) fs.unlinkSync(CUSTOM_FILE);
    return true;
  } catch (_) {
    return false;
  }
}

module.exports = {
  SOUNDS_DIR,
  CUSTOM_FILE,
  MAX_BYTES,
  FORMATS,
  DECODABLE_EXT,
  ALL_EXT,
  sniff,
  pick,
  inspect,
  saveWav,
  readCustom,
  removeCustom
};

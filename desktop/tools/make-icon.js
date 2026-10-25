"use strict";

/**
 * 生成安装包与窗口图标（build/icon.ico + build/icon.png）
 *
 * 为什么不用现成的 png 转 ico 库：这个项目不想为了一个 256×256 的图标
 * 引入构建期依赖。图标本身是纯几何图形（圆角底 + 三个定位块 + 几个模块 +
 * 一条扫描线），用几十行像素运算直接画出来，再用 zlib 编成 PNG（Node 自带），
 * 最后套一层 ICO 头即可 —— Windows Vista 以后支持 ICO 内直接放 PNG。
 *
 * 用法：node tools/make-icon.js
 * 产物：build/icon.ico（256×256，PNG 负载）、build/icon.png（同图，供 Linux/macOS 或预览）
 * 这两个文件是**生成物**，已提交到仓库，打包时不需要再跑本脚本。
 */

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const SIZE = 256;
const OUT_DIR = path.join(__dirname, "..", "build");

// ---- 调色（与 launcher.html 的深色主题一致）----
const BG_TOP = [16, 22, 32, 255];      // #101620
const BG_BOT = [24, 34, 48, 255];      // #182230
const WHITE = [255, 255, 255, 255];
const ACCENT = [59, 130, 246, 255];    // #3b82f6

// RGBA 画布
const px = Buffer.alloc(SIZE * SIZE * 4, 0);

function setPx(x, y, c) {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
  const i = (y * SIZE + x) * 4;
  px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]; px[i + 3] = c[3];
}

function rect(x, y, w, h, c) {
  for (let yy = y; yy < y + h; yy++) {
    for (let xx = x; xx < x + w; xx++) setPx(xx, yy, c);
  }
}

// 圆角矩形（用圆方程做边缘判定，足够平滑；不追求抗锯齿）
function roundRect(x, y, w, h, r, colorFn) {
  for (let yy = y; yy < y + h; yy++) {
    for (let xx = x; xx < x + w; xx++) {
      const dx = Math.min(xx - x, x + w - 1 - xx);
      const dy = Math.min(yy - y, y + h - 1 - yy);
      if (dx < r && dy < r) {
        const cx = r - dx;
        const cy = r - dy;
        if (cx * cx + cy * cy > r * r) continue;   // 四角切掉
      }
      setPx(xx, yy, colorFn(xx, yy));
    }
  }
}

// ---- 1) 底：圆角方块 + 竖向渐变 ----
const PAD = 8;
roundRect(PAD, PAD, SIZE - PAD * 2, SIZE - PAD * 2, 52, (_x, y) => {
  const t = (y - PAD) / (SIZE - PAD * 2);
  return [
    Math.round(BG_TOP[0] + (BG_BOT[0] - BG_TOP[0]) * t),
    Math.round(BG_TOP[1] + (BG_BOT[1] - BG_TOP[1]) * t),
    Math.round(BG_TOP[2] + (BG_BOT[2] - BG_TOP[2]) * t),
    255,
  ];
});

// ---- 2) 三个定位块（QR 的"回"字）----
// 尺寸按 256 画布定：外框 56，间隔 8，内芯 24
function finder(x, y) {
  rect(x, y, 56, 56, WHITE);
  rect(x + 8, y + 8, 40, 40, BG_TOP);
  rect(x + 16, y + 16, 24, 24, WHITE);
}
finder(36, 36);
finder(164, 36);
finder(36, 164);

// ---- 3) 右下角的模块阵列（示意数据区）----
// 固定图案而不是随机：图标必须每次生成都一样，否则每次打包 git 都在抖。
// 位置与尺寸要留出圆角：右下的圆角从 x>232 开始切，方块不能压过去。
const MOD = 14;
const GAP = 7;
const MOD_X = 150;
const MOD_Y = 150;
const pattern = [
  [1, 1, 0, 1],
  [1, 0, 1, 1],
  [0, 1, 1, 0],
  [1, 1, 0, 1],
];
for (let r = 0; r < pattern.length; r++) {
  for (let c = 0; c < pattern[r].length; c++) {
    if (!pattern[r][c]) continue;
    rect(MOD_X + c * (MOD + GAP), MOD_Y + r * (MOD + GAP), MOD, MOD, WHITE);
  }
}

// ---- 4) 扫描线（品牌识别：一眼看出是"扫码"）----
// 半透明蓝色横条压在中间，两端各留 30px，避免糊住定位块
for (let y = 122; y < 134; y++) {
  for (let x = 26; x < SIZE - 26; x++) {
    setPx(x, y, [ACCENT[0], ACCENT[1], ACCENT[2], y < 124 || y > 131 ? 150 : 235]);
  }
}

// ---------------------------------------------------------------- PNG 编码

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 6;    // RGBA
  ihdr[10] = 0;   // deflate
  ihdr[11] = 0;   // filter
  ihdr[12] = 0;   // no interlace

  // 每行前面加一个 filter 字节（0 = None）
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------- ICO 封装
// ICO 允许内嵌 PNG（Vista+ 支持 256×256）。格式：
//   ICONDIR(6) + ICONDIRENTRY(16) + PNG 数据
// 宽高字段为 0 表示 256（一个字节存不下 256）。
function wrapIco(pngBuf, size) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);   // reserved
  header.writeUInt16LE(1, 2);   // type = icon
  header.writeUInt16LE(1, 4);   // count

  const entry = Buffer.alloc(16);
  entry[0] = size >= 256 ? 0 : size;
  entry[1] = size >= 256 ? 0 : size;
  entry[2] = 0;                 // palette
  entry[3] = 0;                 // reserved
  entry.writeUInt16LE(1, 4);    // color planes
  entry.writeUInt16LE(32, 6);   // bits per pixel
  entry.writeUInt32LE(pngBuf.length, 8);
  entry.writeUInt32LE(6 + 16, 12);  // 数据起始偏移

  return Buffer.concat([header, entry, pngBuf]);
}

// ---------------------------------------------------------------- 输出

fs.mkdirSync(OUT_DIR, { recursive: true });
const png = encodePng(SIZE, SIZE, px);
fs.writeFileSync(path.join(OUT_DIR, "icon.png"), png);
fs.writeFileSync(path.join(OUT_DIR, "icon.ico"), wrapIco(png, SIZE));

console.log("icon.png  " + png.length + " bytes");
console.log("icon.ico  " + (png.length + 22) + " bytes");

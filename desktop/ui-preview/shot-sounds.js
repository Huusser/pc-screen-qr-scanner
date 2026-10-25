// 离屏渲染「提示音试听.html」导出一张 PNG，用于确认版式没有被裁切。
// 用法: env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe shot-sounds.js
const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const path = require("path");

app.disableHardwareAcceleration();
const S = 1.4;
const SRC = path.join(__dirname, "sound-candidates", "提示音试听.html");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 900,
    height: 900,
    show: false,
    frame: false,
    webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false },
  });

  await win.loadFile(SRC);
  win.webContents.setZoomFactor(S); // loadFile 之后会被重置，必须重设
  await wait(600);

  const box = await win.webContents.executeJavaScript(`(function(){
    var w = document.querySelector('.wrap').getBoundingClientRect();
    return { w: Math.ceil(w.width) + 44, h: Math.ceil(document.body.scrollHeight) };
  })()`);
  win.setContentSize(Math.ceil(box.w * S), Math.ceil(box.h * S));
  await wait(700);

  // 选中第 2 张卡片，确认「已选」态也能正常渲染
  await win.webContents.executeJavaScript(`document.querySelectorAll('.card')[1].click()`);
  await wait(400);

  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(__dirname, "sound-candidates", "试听页预览.png"), img.toPNG());
  console.log("saved", box.w + "x" + box.h, "->", img.getSize().width + "x" + img.getSize().height);

  // 单独截「接入示意」那一块，按 1:1 像素判断排版细节
  // 注意：页面 zoom 过，getBoundingClientRect 是页面 CSS 像素，
  // capturePage 的 rect 是窗口 DIP，必须乘回 S，否则截到的是别的区域。
  const clip = await win.webContents.executeJavaScript(`(function(){
    var m = document.querySelector('.mock');
    var r = m.getBoundingClientRect();
    return { x: Math.floor(r.left) - 4, y: Math.floor(r.top) - 4, width: Math.ceil(r.width) + 8, height: Math.ceil(r.height) + 8 };
  })()`);
  const shot = await win.webContents.capturePage({
    x: Math.round(clip.x * S),
    y: Math.round(clip.y * S),
    width: Math.round(clip.width * S),
    height: Math.round(clip.height * S),
  });
  fs.writeFileSync(path.join(__dirname, "sound-candidates", "接入示意.png"), shot.toPNG());
  console.log("mock clip", JSON.stringify(clip), "->", shot.getSize());
  setTimeout(() => app.quit(), 200);
});

app.on("window-all-closed", () => app.quit());

// 离屏渲染 settings-mockup.html，按画板分组导出 PNG
// 用法: node shot-settings.js   (由 electron 执行)
// 注意：desktop/node_modules 下装了 npm 的 electron 包，
// 直接 require("electron") 会解析到该包（导出的是 exe 路径字符串），必须走内置子路径
const { app, BrowserWindow } = require("electron/main");
const fs = require("fs");
const path = require("path");

app.disableHardwareAcceleration();

const S = 1.5; // 放大倍率（保证文字清晰，同时不超过屏幕工作区）
const SRC = path.join(__dirname, "settings-mockup.html");
const JOBS = [
  ["1", "设置-1-入口位置.png"],
  ["2", "设置-2-扫码与移动端.png"],
  ["3", "设置-3-外观与关于.png"],
  ["4", "设置-4-功能清单.png"],
];

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    show: false,
    frame: false,
    webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false },
  });
  win.webContents.setZoomFactor(S);

  for (const [g, name] of JOBS) {
    await win.loadFile(SRC);
    // 每次导航后 zoom 会被重置，必须重新设置，否则窗口多出来的部分全是空白
    win.webContents.setZoomFactor(S);
    await wait(500);
    const box = await win.webContents.executeJavaScript(`(function(){
      document.querySelectorAll('.board').forEach(function(b){ if (b.dataset.g !== '${g}') b.remove(); });
      var el = document.querySelector('.board');
      var r = el.getBoundingClientRect();
      return { w: Math.ceil(r.width), h: Math.ceil(r.height) };
    })()`);
    win.setContentSize(Math.ceil(box.w * S), Math.ceil(box.h * S));
    await wait(700);
    const img = await win.webContents.capturePage();
    const out = path.join(__dirname, name);
    fs.writeFileSync(out, img.toPNG());
    console.log("saved", name, box.w + "x" + box.h, "->", img.getSize().width + "x" + img.getSize().height);
  }

  setTimeout(() => app.quit(), 200);
});

app.on("window-all-closed", () => app.quit());

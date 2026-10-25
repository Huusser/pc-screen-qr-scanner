// 生成托盘图标 desktop/assets/tray.png（一次性脚本，产物已入库，改图标时再跑）
const { app, BrowserWindow, nativeImage } = require("electron");
const fs = require("fs");
const path = require("path");

app.disableHardwareAcceleration();

const OUT_DIR = path.join(__dirname, "..", "assets");
const SIZE = 64;

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false, width: 80, height: 80,
    webPreferences: { offscreen: true, contextIsolation: true }
  });
  await win.loadURL("data:text/html,<body style='margin:0;background:transparent'><canvas id='c'></canvas></body>");

  const dataUrl = await win.webContents.executeJavaScript(`(function(){
    var S = ${SIZE};
    var c = document.getElementById('c');
    c.width = S; c.height = S;
    var x = c.getContext('2d');
    x.clearRect(0, 0, S, S);

    // 底：蓝色圆角方块（深色/浅色任务栏都看得见）
    var pad = 3, r = 15;
    var g = x.createLinearGradient(0, pad, S, S - pad);
    g.addColorStop(0, '#3b82f6');
    g.addColorStop(1, '#1d4ed8');
    x.fillStyle = g;
    x.beginPath();
    if (x.roundRect) x.roundRect(pad, pad, S - pad*2, S - pad*2, r);
    else x.rect(pad, pad, S - pad*2, S - pad*2);
    x.fill();

    // 取景框四角
    var inset = 15, len = 11, lw = 5;
    x.strokeStyle = '#ffffff';
    x.lineWidth = lw;
    x.lineCap = 'round';
    var L = inset, R = S - inset, T = inset, B = S - inset;
    var corners = [[L,T,1,1],[R,T,-1,1],[L,B,1,-1],[R,B,-1,-1]];
    for (var i=0;i<corners.length;i++){
      var q = corners[i];
      x.beginPath();
      x.moveTo(q[0] + q[2]*len, q[1]);
      x.lineTo(q[0], q[1]);
      x.lineTo(q[0], q[1] + q[3]*len);
      x.stroke();
    }

    // 中间的小方块
    x.fillStyle = '#ffffff';
    x.beginPath();
    if (x.roundRect) x.roundRect(S/2 - 5, S/2 - 5, 10, 10, 2.5);
    else x.rect(S/2 - 5, S/2 - 5, 10, 10);
    x.fill();

    return c.toDataURL('image/png');
  })()`);

  const img = nativeImage.createFromDataURL(dataUrl);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, "tray.png"), img.toPNG());
  console.log("tray.png", img.getSize());
  app.quit();
});

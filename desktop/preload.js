"use strict";

const { contextBridge, ipcRenderer } = require("electron");

// 统一的"订阅-返回退订函数"写法，避免页面里漏删监听导致重复触发
function on(channel, cb) {
  const h = (_e, data) => { try { cb(data); } catch (_) {} };
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
}

contextBridge.exposeInMainWorld("qr", {
  getFrame: () => ipcRenderer.invoke("qr:frame"),
  copy: (text) => ipcRenderer.invoke("qr:copy", text),
  copyImage: (dataUrl) => ipcRenderer.invoke("qr:copy-image", dataUrl),
  openExternal: (url) => ipcRenderer.invoke("qr:open", url),
  // 交给微信：主进程负责关取景框、填搜索、按设置决定是否代点
  wxOpen: (payload) => ipcRenderer.send("qr:wx-open", payload),
  probeWechat: (force) => ipcRenderer.invoke("qr:probe-wechat", force),

  // 移动端环境（按需启动的本地代理）
  proxyStatus: () => ipcRenderer.invoke("qr:proxy-status"),
  proxyStart: (opts) => ipcRenderer.invoke("qr:proxy-start", opts),
  proxyStop: () => ipcRenderer.invoke("qr:proxy-stop"),
  onProxyEvent: (cb) => on("qr:proxy-event", cb),
  // 运行环境自检：手机环境靠发行包自带的 Python 运行时（vendor/python）
  // 与纯 Python 证书模块（proxy/certgen.py），两者缺一就在界面上说清楚
  envCheck: () => ipcRenderer.invoke("qr:env-check"),
  // 清空日志（可能含访问地址）：只删日志，不动设置与证书
  clearLogs: () => ipcRenderer.invoke("qr:clear-logs"),

  // 设置中心
  settingsGet: () => ipcRenderer.invoke("qr:settings-get"),
  settingsPatch: (partial) => ipcRenderer.invoke("qr:settings-patch", partial),
  settingsReset: () => ipcRenderer.invoke("qr:settings-reset"),
  onSettingsChanged: (cb) => on("qr:settings-changed", cb),

  appInfo: () => ipcRenderer.invoke("qr:app-info"),
  openPath: (which) => ipcRenderer.invoke("qr:open-path", which),
  systemTheme: () => ipcRenderer.invoke("qr:system-theme"),
  onSystemTheme: (cb) => on("qr:system-theme", cb),

  // 提示音（自定义音色导入）
  soundPick: () => ipcRenderer.invoke("qr:sound-pick"),
  soundSave: (payload) => ipcRenderer.invoke("qr:sound-save", payload),
  soundCustom: () => ipcRenderer.invoke("qr:sound-custom"),

  // 窗口控制
  winState: () => ipcRenderer.invoke("qr:win-state"),
  onWinState: (cb) => on("qr:win-state", cb),
  toggleMaximize: () => ipcRenderer.send("qr:toggle-maximize"),

  ready: () => ipcRenderer.send("qr:ready"),
  close: () => ipcRenderer.send("qr:close"),
  start: () => ipcRenderer.send("qr:start"),
  minimize: () => ipcRenderer.send("qr:minimize"),
  quit: () => ipcRenderer.send("qr:quit")
});

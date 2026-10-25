# 参与贡献

感谢有兴趣改进这个项目。它是 Windows 专有的 Electron + Python 混合应用，
有一些与常规前端项目不同的约束，先看这几点能省不少时间。

## 环境

| 项目 | 要求 |
|---|---|
| 操作系统 | Windows 10 1809+ / Windows 11 x64（macOS/Linux 不支持，核心能力依赖 UIA/GDI/WinRT） |
| Node.js | 22.x（CI 用 22） |
| Python | **不需要预装**。`npm run runtime` 会把内置运行时下载到 `desktop/vendor/python` |

## 首次构建

```bash
cd desktop
npm ci                 # 必须用 ci，不要用 install（保证与 lock 完全一致）
npm run runtime        # 下载内置 Python 运行时（约 22 MB，SHA-256 校验）
npm start              # 或双击 start.bat（会自愈缺失的依赖与运行时）
```

出安装包：

```bash
npm run prepare:builder   # 预热 electron-builder 缓存，换机器必跑
npm run dist              # → dist/ScreenQR-<版本>-x64.exe
```

## 改完先跑这些

```bash
# 桌面端（不启动 Electron 的纯 Node 回归）
node tools/_t-proxy-error.js     # 启动失败原因能否显示
node tools/_t-proxy-ports.js     # 端口占用顺延
node tools/_t-proxy-scope.js      # --scope 传参与域名推导
node tools/_t-proxy-event.js      # tick 事件是否带范围字段 + IPC 白名单键集

# 代理侧（需要本机 Python）
python _t_ca_guard.py             # 证书装不上时是否停手
python _t_port_guard.py           # 端口被占用的可读原因
python _t_proxy_mitm.py           # 非 443 端口的 TLS（默认用 18443，不需要管理员）
python _t_scope.py                # 302 写回前是否已把新域名加进 scope

# 应用级
npm run selftest
```

回归脚本的命名约定：代理侧 `proxy/_t_*.py`、桌面侧 `desktop/tools/_t-*.js`，
两者都**不进安装包**，但**要提交到仓库**。

## 隐私红线（提交前逐条确认）

这些东西一旦进仓库就是不可撤销的泄露（Git 历史会保留）：

- ❌ `proxy/certs/`（**CA 私钥**）、任何 `*.key` `*.pem` `*.pfx`
- ❌ 抓包样本：`proxy/ac.html`、`proxy/r*.html` 或任何第三方响应正文
- ❌ 运行态文件：`settings.json`、`state.json`、`learned.json`、`stats.json`、`previous.json`、`*.log`
- ❌ 客户/租户的真实域名（文档与测试里请用 `<tenant>.example.com`）
- ❌ 本机绝对路径（`C:\Users\<你的名字>\...`）

`.gitignore` 已覆盖上述大部分，但它不是安全网——**提交前请自己看一眼 `git status`**。

## 代码约定

- **`proxy/win-helper.ps1` 必须纯 ASCII**：PowerShell 5.1 按本地代码页读取无 BOM 的 .ps1，
  中文注释会导致 parse error。
- **所有 `.bat` 必须纯 ASCII + CRLF**，且**不能写绝对路径**——安装后的目录布局与源码树不同，
  解释器一律通过 `proxy/python-env.bat` 探测。`.gitattributes` 已钉死换行，不要绕过它。
- **坐标统一用物理像素**：脚本启动时已声明 Per-Monitor DPI 感知，UI 自动化、截屏、窗口坐标共用同一套。
- **IPC 字段三处同步**：`overlay.js` 的调用点 → `main.js` 的显式白名单 → `tools/_t-proxy-event.js` 的 T4 断言。
  这是有意不用 `{...opts}` 透传的代价，漏一处的症状是"功能正常但显示异常"。
- **每秒刷新的事件 payload 必须与完整状态同构**：缺字段会被渲染层当成 `false`/`0`，
  表现为界面显示与实际状态矛盾。

## 提 PR

- 一个 PR 解决一件事，说明"改前是什么现象、改后是什么行为、怎么验证的"。
- 涉及代理范围、证书、系统代理还原的改动，请附带对应的回归脚本或说明为何无法覆盖。
- 不要求签署 CLA。提交即表示同意以本仓库的 MIT 许可证分发你的贡献。

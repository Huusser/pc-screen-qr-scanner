"use strict";

(function () {
  var stage = document.getElementById("stage");
  var ctx = stage.getContext("2d", { alpha: false });
  var bar = document.getElementById("bar");
  var badgeEl = document.getElementById("badge");
  var codeEl = document.getElementById("code");
  var tipEl = document.getElementById("tip");
  var metaEl = document.getElementById("meta");
  var btnCopy = document.getElementById("btnCopy");
  var btnOpen = document.getElementById("btnOpen");
  var modePill = document.getElementById("modePill");
  var statPill = document.getElementById("statPill");
  var wxPill = document.getElementById("wxPill");
  var errEl = document.getElementById("err");
  var errMsg = document.getElementById("errMsg");
  var btnMobile = document.getElementById("btnMobile");
  var proxyPill = document.getElementById("proxyPill");
  var askEl = document.getElementById("ask");
  var askSub = document.getElementById("askSub");
  var askGlobal = document.getElementById("askGlobal");
  var askTtl = document.getElementById("askTtl");
  var askRemember = document.getElementById("askRemember");
  var askOk = document.getElementById("askOk");
  var askCancel = document.getElementById("askCancel");
  var toastEl = document.getElementById("toast");
  var idleEl = document.getElementById("idle");
  var helpEl = document.getElementById("help");
  var btnHelp = document.getElementById("btnHelp");
  var btnClose = document.getElementById("btnClose");
  var btnBarClose = document.getElementById("btnBarClose");

  // 微信能力：决定「扫码登录」类二维码能否在 PC 上免扫码完成
  var wechatEnv = { running: false, fastLogin: false, canFastLogin: false, summary: "微信检测中" };

  // ---------- 用户设置 ----------
  // 取景框每次打开读一次。开着取景框时改设置不会即时反映到当前这一次，
  // 但下一次打开一定生效 —— 这类工具的生命周期就是"打开-扫完-关掉"。
  var ST = {
    scanMode: "single", autoCopy: true, sound: false, autoJudge: true,
    resultDwell: "medium", maskOpacity: 60, frameSize: "medium",
    rememberBox: true, proxyAnswer: "ask", proxyTtl: 180, proxyMode: "pac",
    soundId: "twotone", soundCustom: null
  };
  var maskAlpha = 0.56;

  function loadSettings() {
    if (!window.qr || !window.qr.settingsGet) return Promise.resolve(ST);
    return window.qr.settingsGet().then(function (s) {
      if (s && typeof s === "object") {
        for (var k in ST) {
          if (Object.prototype.hasOwnProperty.call(ST, k) &&
              Object.prototype.hasOwnProperty.call(s, k)) ST[k] = s[k];
        }
      }
      // 30~85 的百分比映射到 0.24~0.82 的黑度；60 正好是原来的 .56
      var v = Number(ST.maskOpacity);
      if (!isFinite(v)) v = 60;
      maskAlpha = Math.min(0.82, Math.max(0.24, v / 100 * 0.93));
      return ST;
    }).catch(function () { return ST; });
  }

  function refreshWechatEnv() {
    if (!window.qr || !window.qr.probeWechat) return Promise.resolve(wechatEnv);
    return window.qr.probeWechat()
      .then(function (r) {
        if (r) {
          wechatEnv = r;
          if (wxPill) {
            wxPill.textContent = r.summary;
            wxPill.className = "pill" + (r.canFastLogin ? " hot" : "");
          }
        }
        return wechatEnv;
      })
      .catch(function () { return wechatEnv; });
  }

  var img = new Image();
  var imgReady = false;
  var meta = null;
  var box = null;
  var drag = null;
  var paused = false;
  var mode = "freeze";
  var lastResult = null;
  var hitFlash = 0;
  var missCount = 0;
  var lastDecodeMs = 0;
  var decodeCount = 0;
  var skipCount = 0;
  var decodeBusy = false;
  var frameBusy = false;
  var frameSeq = 0;   // 成功换帧的次数：连续模式下应该持续增长，否则就是没在刷新
  var lastSig = null;
  var MIN = 48;
  var contTimer = null;    // 连续模式：定时重新抓屏（按实测耗时自适应）
  var decodeTimer = null;  // 解码循环：定时读当前帧解二维码
  var continuousOn = false;
  var lastCaptureMs = 0;

  var work = document.createElement("canvas");
  var wctx = work.getContext("2d", { willReadFrequently: true });

  function dpr() { return Math.min(window.devicePixelRatio || 1, 2); }

  function resize() {
    var r = dpr();
    var w = Math.max(1, Math.round(stage.clientWidth * r));
    var h = Math.max(1, Math.round(stage.clientHeight * r));
    if (stage.width !== w || stage.height !== h) { stage.width = w; stage.height = h; }
  }

  function clampBox(b) {
    var cw = stage.clientWidth, ch = stage.clientHeight;
    var x = Math.max(0, Math.min(b.x, cw));
    var y = Math.max(0, Math.min(b.y, ch));
    var w = Math.max(MIN, Math.min(b.w, cw - x));
    var h = Math.max(MIN, Math.min(b.h, ch - y));
    return { x: x, y: y, w: w, h: h };
  }

  var HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
  var HANDLE_R = 7;

  function handlePoints(b) {
    return {
      nw: [b.x, b.y], n: [b.x + b.w / 2, b.y], ne: [b.x + b.w, b.y],
      e: [b.x + b.w, b.y + b.h / 2], se: [b.x + b.w, b.y + b.h],
      s: [b.x + b.w / 2, b.y + b.h], sw: [b.x, b.y + b.h], w: [b.x, b.y + b.h / 2]
    };
  }

  function hitHandle(b, px, py) {
    if (!b) return null;
    var pts = handlePoints(b);
    for (var i = 0; i < HANDLES.length; i++) {
      var h = HANDLES[i], p = pts[h];
      if (Math.abs(px - p[0]) <= HANDLE_R + 4 && Math.abs(py - p[1]) <= HANDLE_R + 4) return h;
    }
    return null;
  }

  function inBox(b, px, py) {
    return b && px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h;
  }

  function cursorFor(h) {
    if (h === "n" || h === "s") return "ns-resize";
    if (h === "e" || h === "w") return "ew-resize";
    if (h === "nw" || h === "se") return "nwse-resize";
    return "nesw-resize";
  }

  // ---------- frame ----------

  function swapFrame(dataUrl) {
    return new Promise(function (resolve) {
      var next = new Image();
      next.onload = function () { img = next; imgReady = true; frameSeq++; resolve(true); };
      next.onerror = function () { resolve(false); };
      next.src = dataUrl;
    });
  }

  function showError(msg) {
    errMsg.textContent = (msg || "未知错误") +
      "。可能是系统权限（Windows 设置 → 隐私 → 屏幕截图）或远程桌面会话限制。";
    errEl.classList.add("show");
  }

  var booted = false;

  async function bootstrap() {
    if (!window.qr) { showError("preload 未加载，无法与主进程通信"); return; }

    await loadSettings();

    // 自定义音色：不阻塞首帧（抓屏本来就要 1~2 秒，顺手并行取回来）
    loadSoundAsset();

    // 默认扫描方式来自设置；这里直接落值，不走 setMode（避免开窗就弹提示）
    mode = ST.scanMode === "continuous" ? "continuous" : "freeze";
    modePill.textContent = mode === "continuous" ? "连续" : "冻结";
    modePill.classList.toggle("hot", mode === "continuous");

    // 这些绑定只做一次：失败重试时再跑一遍会挂上重复的事件监听
    if (!booted) {
      booted = true;
      refreshWechatEnv();
      // 代理状态：只读一次现状。如果上次流程留下的代理还开着（TTL 未到），
      // 顶部胶囊会显示倒计时，用户可以点它立刻关掉。
      renderProxyPill();
      bindProxyEvents();
      refreshProxy();
    }

    statPill.textContent = "正在抓屏…";
    var f = await window.qr.getFrame();
    if (!f || f.error) throw new Error(String((f && f.error) || "取帧失败"));
    if (!f.dataUrl) throw new Error("抓到的画面是空的");
    meta = f;
    if (!(await swapFrame(f.dataUrl))) throw new Error("画面数据无法解码");

    errEl.classList.remove("show");
    if (!restoreBox()) autoBox();
    updateStat();
    requestAnimationFrame(function () { window.qr.ready(); });
    startDecodeLoop();
    // 设置里默认就是连续模式时，这里必须把"重新抓屏"的定时器也开起来，
    // 否则胶囊显示"连续"但画面永远停在第一帧（会刷新的码就再也扫不到）。
    if (mode === "continuous") startContinuous();
  }

  // ---------- 记住上次框选位置 ----------
  //
  // 存的是相对屏幕的比例，不存像素：换分辨率、换外接屏之后位置仍然合理。
  // localStorage 在 file:// 下通常可用；不可用就当没这功能，不影响扫码。

  var BOX_KEY = "qrscan.lastBox";

  function saveBox() {
    if (!ST.rememberBox || !box) return;
    var cw = stage.clientWidth || 1, ch = stage.clientHeight || 1;
    try {
      localStorage.setItem(BOX_KEY, JSON.stringify({
        x: box.x / cw, y: box.y / ch, w: box.w / cw, h: box.h / ch
      }));
    } catch (e) {}
  }

  function restoreBox() {
    if (!ST.rememberBox) return false;
    var r = null;
    try { r = JSON.parse(localStorage.getItem(BOX_KEY) || "null"); } catch (e) { return false; }
    if (!r || !(r.w > 0.02) || !(r.h > 0.02) || r.w > 1.2 || r.h > 1.2) return false;

    var cw = stage.clientWidth, ch = stage.clientHeight;
    var b = { x: r.x * cw, y: r.y * ch, w: r.w * cw, h: r.h * ch };
    // 上次的外接屏比现在大很多时，恢复出来会跑到屏幕外，这种情况直接重算
    if (b.x < -8 || b.y < -8 || b.x > cw - 24 || b.y > ch - 24) return false;
    box = clampBox(b);
    return true;
  }

  function autoBox() {
    var cw = stage.clientWidth, ch = stage.clientHeight;
    var BASE = { small: 240, medium: 340, large: 460 };
    var want = BASE[ST.frameSize] || BASE.medium;
    var size = Math.round(Math.min(want, cw * 0.62, ch * 0.68));
    box = { x: Math.round((cw - size) / 2), y: Math.round((ch - size) / 2), w: size, h: size };
  }

  // ---------- decode ----------

  function signature(data, w, h) {
    var S = 32, out = new Float32Array(S * S);
    var sx = w / S, sy = h / S;
    for (var y = 0; y < S; y++) {
      for (var x = 0; x < S; x++) {
        var px = Math.min(w - 1, (x * sx) | 0);
        var py = Math.min(h - 1, (y * sy) | 0);
        var i = (py * w + px) * 4;
        out[y * S + x] = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
      }
    }
    return out;
  }

  function diffRatio(a, b) {
    if (!a || !b) return 1;
    var s = 0;
    for (var i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
    return s / (a.length * 255);
  }

  function decodeOnce(force) {
    if (decodeBusy || paused || !imgReady || !box) return;

    var cw = stage.clientWidth, ch = stage.clientHeight;
    // 横纵分别算比例：窗口尺寸与捕获图像比例不一致时（多屏/任务栏/系统缩放），
    // 用单一比例会把裁剪区域算歪，这是这类工具最常见的事故点。
    var kx = img.naturalWidth / cw;
    var ky = img.naturalHeight / ch;

    var sx = Math.max(0, box.x * kx);
    var sy = Math.max(0, box.y * ky);
    var sw = Math.min(box.w * kx, img.naturalWidth - sx);
    var sh = Math.min(box.h * ky, img.naturalHeight - sy);
    if (sw < 20 || sh < 20) return;

    var MAX = 960;
    var s = Math.min(1, MAX / Math.max(sw, sh));
    var dw = Math.max(20, Math.round(sw * s));
    var dh = Math.max(20, Math.round(sh * s));
    if (work.width !== dw || work.height !== dh) { work.width = dw; work.height = dh; }

    decodeBusy = true;
    try {
      wctx.drawImage(img, sx, sy, sw, sh, 0, 0, dw, dh);
      var data = wctx.getImageData(0, 0, dw, dh);
      var sig = signature(data.data, dw, dh);

      if (!force && lastSig) {
        if (diffRatio(sig, lastSig) < 0.012) { skipCount++; lastSig = sig; return; }
      }
      lastSig = sig;

      var t0 = performance.now();
      var res = window.jsQR ? window.jsQR(data.data, dw, dh, { inversionAttempts: "attemptBoth" }) : null;
      lastDecodeMs = Math.round(performance.now() - t0);
      decodeCount++;

      if (res && res.data) {
        onHit(res.data);
      } else {
        missCount++;
        if (missCount === 10 && !lastResult) {
          setBadge("未检测到二维码 · 试着把框拉大或对准整张码", "warn");
        }
      }
      updateStat();
    } catch (e) {
      /* 单帧异常不影响循环 */
    } finally {
      decodeBusy = false;
    }
  }

  function startDecodeLoop() {
    if (decodeTimer) return; // 重复调用（重试/切模式）不能再叠一个定时器
    decodeTimer = setInterval(function () {
      decodeOnce(false);
    }, mode === "continuous" ? 150 : 220);
  }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function onHit(text) {
    var now = Date.now();
    missCount = 0;
    if (lastResult && lastResult.text === text && now - lastResult.at < 1500) return;
    lastResult = { text: text, at: now };
    hitFlash = performance.now();

    var c = window.classifyCode ? window.classifyCode(text, wechatEnv) : null;
    codeEl.textContent = text;
    if (c) {
      badgeEl.textContent = c.verdictText;
      badgeEl.className = "badge " + c.verdict;
      var why = esc(c.tip).replace(/"/g, "&quot;");
      var html = "<b>" + esc(c.label) + "</b>" +
        '<div class="why" title="' + why + '">' + esc(c.tip) + "</div>";
      if (c.steps && c.steps.length) {
        html += '<div class="steps">' +
          c.steps.map(function (s, i) { return "<div><i>" + (i + 1) + "</i>" + esc(s) + "</div>"; }).join("") +
          "</div>";
      }
      tipEl.innerHTML = html;
    } else {
      badgeEl.textContent = "已识别";
      badgeEl.className = "badge info";
      tipEl.textContent = "";
    }
    renderActions(c, text);
    bar.classList.add("show");
    hideIdle();

    // 自动复制：读到的瞬间就进剪贴板，省掉再去点一次「复制」。
    // 结果条上的按钮仍然保留，用户想再复制一次也不会受限。
    if (ST.autoCopy && window.qr && window.qr.copy) {
      try { window.qr.copy(text); } catch (e) {}
    }
    if (ST.sound) beep();
    armDwell();
  }

  // ---------- 结果条自动收起 ----------
  //
  // "停留时长"是给"扫完就走"的人用的：读到了、也复制了，条子不必一直杵着。
  // 所以有三条保险，任何一条成立都不收：
  //   · 询问卡打开着（正在做选择）
  //   · 鼠标停在结果条上（正在看 / 正在点）
  //   · 时长设置成"长"也最多 10 秒
  var dwellTimer = null;
  var DWELL_MS = { short: 3000, medium: 5000, long: 10000 };

  function stopDwell() {
    if (dwellTimer) { clearTimeout(dwellTimer); dwellTimer = null; }
  }

  function armDwell() {
    stopDwell();
    if (!bar.classList.contains("show") || askOpen) return;
    var ms = DWELL_MS[ST.resultDwell] || DWELL_MS.medium;
    dwellTimer = setTimeout(function () {
      dwellTimer = null;
      if (askOpen) return;
      if (bar.matches(":hover")) { armDwell(); return; }
      dismissResult();
    }, ms);
  }

  // 未识别时底部那块「拖动鼠标框住二维码」的引导卡：一旦识别成功就让位给结果条
  function hideIdle() {
    if (idleEl) idleEl.classList.remove("show");
  }

  function showIdle(text) {
    if (!idleEl) return;
    var t = idleEl.querySelector(".i1");
    if (t) {
      t.textContent = text || "拖动鼠标，把二维码框进框内";
      t.style.color = "#cfdae9";
    }
    idleEl.classList.add("show");
  }

  // 收起结果条，回到可重新框选的状态（不给鼠标用户留"只能按 Esc 退出"的死路）
  function dismissResult() {
    stopDwell();
    bar.classList.remove("show");
    lastResult = null;
    missCount = 0;
    lastSig = null;
    showIdle();
  }

  // 按码型决定主按钮：能免扫码登录的，直接把「用微信快捷登录」放到最显眼位置
  var currentAction = "none";
  function renderActions(c, text) {
    var isUrl = /^https?:\/\//i.test(text);
    var isScheme = /^weixin:\/\//i.test(text);
    var action = (c && c.action) || (isUrl ? "open-browser" : "none");
    var needsMobile = !!(c && c.needsMobile) && isUrl;
    currentAction = action;

    btnOpen.style.display = "none";
    btnOpen.className = "";
    btnMobile.style.display = "none";
    btnMobile.className = "";

    if (action === "wechat-fast") {
      btnOpen.style.display = "";
      btnOpen.textContent = "用微信快捷登录";
      btnOpen.className = "primary";
    } else if (action === "open-in-wechat" && isUrl) {
      // 组合动作：链接进剪贴板 + 把微信弹到前台，用户只需在文件传输助手里粘贴
      btnOpen.style.display = "";
      btnOpen.textContent = "复制并唤起微信";
      btnOpen.className = needsMobile ? "" : "primary";
    } else if (action === "open-browser" && isUrl) {
      btnOpen.style.display = "";
      btnOpen.textContent = "浏览器打开";
    } else if (action === "wake-wechat" && isScheme) {
      btnOpen.style.display = "";
      btnOpen.textContent = "唤起微信打开";
    }
    // copy-only 不显示打开按钮，靠「复制」

    // 「手机环境打开」对所有 http(s) 链接都可用 —— 实际场景里的站点无穷无尽，
    // 不能只给识别出来的那几类。但只有判定「依赖移动端」时才提为主按钮，
    // 否则会干扰正常流程。点它一定会先弹确认卡，不会直接起飞。
    // 设置里关掉「自动判断」时整个按钮都不出现：用户明确说了只要读码。
    if (isUrl && ST.autoJudge) {
      btnMobile.style.display = "";
      btnMobile.textContent = needsMobile ? "手机环境打开（推荐）" : "手机环境打开";
      if (needsMobile) {
        btnMobile.className = "primary";
        if (btnOpen.style.display !== "none") btnOpen.className = "";
      }
    } else {
      btnMobile.style.display = "none";
      btnMobile.className = "";
    }

    // 只有一个主按钮：没有明确下一步时，复制升为主按钮
    var hasPrimary = btnMobile.className === "primary" || btnOpen.className === "primary";
    btnCopy.className = hasPrimary ? "" : "primary";
  }

  function setBadge(text, cls) {
    badgeEl.textContent = text;
    badgeEl.className = "badge " + (cls || "info");
    // 还没识别出内容时不开结果条（空结果条上挂着一排按钮很怪），
    // 把状态写进底部那张引导卡，反馈一样到位。
    if (bar.classList.contains("show")) return;
    if (idleEl) {
      var t = idleEl.querySelector(".i1");
      if (t) {
        t.textContent = text;
        t.style.color = cls === "warn" ? "#ffc76a" : "#cfdae9";
      }
    }
  }

  function updateStat() {
    if (!meta) return;
    // 模式已经在左边的胶囊上了，这里不再重复，只报尺寸与解码耗时
    statPill.textContent = (paused ? "已暂停 · " : "") +
      meta.width + "×" + meta.height + " · 解码 " + lastDecodeMs + "ms";
    statPill.classList.toggle("on", paused);
  }

  function updateMeta() {
    metaEl.textContent = "捕获 " + (meta ? meta.width + "×" + meta.height + " @" + meta.scaleFactor + "x" : "-") +
      " · 框 " + Math.round(box ? box.w : 0) + "×" + Math.round(box ? box.h : 0) +
      " · 已解 " + decodeCount + " 帧 · 跳帧 " + skipCount;
  }

  // 提示音走 sound.js：和设置页试听同一套配方，听到的就是响的。
  // 自定义音色如果没取到（文件被删/解码失败），play() 内部会退回默认音，
  // 不会出现"开了提示音却没声"。
  function beep() {
    if (!window.QRSound) return;
    window.QRSound.play(ST.soundId || "twotone");
  }

  // 自定义音色本体按需读取：只有真的在用自定义时才去拉那几百 KB
  function loadSoundAsset() {
    if (!window.QRSound || ST.soundId !== "custom") return Promise.resolve(false);
    if (window.QRSound.hasCustom()) return Promise.resolve(true);
    if (!window.qr || !window.qr.soundCustom) return Promise.resolve(false);
    return window.qr.soundCustom().then(function (r) {
      if (!r || !r.ok) return false;
      return window.QRSound.loadCustom(r.base64, r.peak, r.name);
    }).catch(function () { return false; });
  }

  // ---------- render ----------

  function roundRect(c, x, y, w, h, r) {
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }

  function render() {
    var r = dpr();
    resize();
    ctx.setTransform(r, 0, 0, r, 0, 0);

    var cw = stage.clientWidth, ch = stage.clientHeight;
    ctx.fillStyle = "#05070a";
    ctx.fillRect(0, 0, cw, ch);

    if (imgReady) {
      try { ctx.drawImage(img, 0, 0, cw, ch); } catch (e) {}
    } else {
      // 第一次抓屏在 Windows 上要 1~3 秒。这段时间如果只铺一层黑底，
      // 用户看到的就是"整个屏幕突然全黑" —— 必须说明在等什么。
      ctx.fillStyle = "rgba(255,255,255,.34)";
      ctx.font = "13px system-ui, 'Microsoft YaHei', sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("正在捕获屏幕…", cw / 2, ch / 2 + 46);
      ctx.textAlign = "start";
      ctx.textBaseline = "alphabetic";
    }

    if (box) {
      var t = performance.now();
      var flashing = t - hitFlash < 420;
      var accent = flashing ? "#51d88a" : "#3f8cff";

      ctx.fillStyle = "rgba(5,7,11," + maskAlpha.toFixed(3) + ")";
      ctx.fillRect(0, 0, cw, box.y);
      ctx.fillRect(0, box.y + box.h, cw, ch - box.y - box.h);
      ctx.fillRect(0, box.y, box.x, box.h);
      ctx.fillRect(box.x + box.w, box.y, cw - box.x - box.w, box.h);

      ctx.save();
      ctx.strokeStyle = accent;
      ctx.lineWidth = 1.5;
      ctx.shadowColor = accent;
      ctx.shadowBlur = flashing ? 22 : 9;
      roundRect(ctx, box.x + 0.5, box.y + 0.5, box.w - 1, box.h - 1, 8);
      ctx.stroke();
      ctx.restore();

      var L = Math.min(20, box.w / 3, box.h / 3);
      ctx.strokeStyle = accent; ctx.lineWidth = 3; ctx.lineCap = "round";
      var corners = [
        [box.x, box.y, 1, 1], [box.x + box.w, box.y, -1, 1],
        [box.x, box.y + box.h, 1, -1], [box.x + box.w, box.y + box.h, -1, -1]
      ];
      for (var i = 0; i < corners.length; i++) {
        var c = corners[i];
        ctx.beginPath();
        ctx.moveTo(c[0] + c[2] * L, c[1]);
        ctx.lineTo(c[0], c[1]);
        ctx.lineTo(c[0], c[1] + c[3] * L);
        ctx.stroke();
      }

      // 连续模式下画一条缓慢扫过的光线，让"正在持续扫描"这件事看得见
      if (mode === "continuous" && !flashing && box.h > 20) {
        var span = (performance.now() % 2400) / 2400;
        var sy = box.y + box.h * span;
        var g = ctx.createLinearGradient(box.x, sy, box.x + box.w, sy);
        g.addColorStop(0, "rgba(63,140,255,0)");
        g.addColorStop(0.5, "rgba(140,190,255,.42)");
        g.addColorStop(1, "rgba(63,140,255,0)");
        ctx.fillStyle = g;
        ctx.fillRect(box.x, sy, box.w, 1.5);
      }

      var pts = handlePoints(box);
      for (var j = 0; j < HANDLES.length; j++) {
        var p = pts[HANDLES[j]];
        ctx.beginPath();
        ctx.arc(p[0], p[1], 3.5, 0, Math.PI * 2);
        ctx.fillStyle = "#fff"; ctx.fill();
        ctx.lineWidth = 1.5; ctx.strokeStyle = accent; ctx.stroke();
      }

      var label = Math.round(box.w) + " × " + Math.round(box.h);
      ctx.font = "11.5px Consolas, monospace";
      var tw = ctx.measureText(label).width;
      var ly = Math.max(44, box.y - 27);
      ctx.fillStyle = "rgba(12,16,23,.92)";
      roundRect(ctx, box.x, ly, tw + 16, 20, 6);
      ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,.14)";
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = "#b6c3d6";
      ctx.fillText(label, box.x + 8, ly + 14);
    }

    requestAnimationFrame(render);
  }

  // ---------- interaction ----------

  function pos(e) {
    var r = stage.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  stage.addEventListener("pointerdown", function (e) {
    var p = pos(e);
    try { stage.setPointerCapture(e.pointerId); } catch (err) {}

    var h = hitHandle(box, p.x, p.y);
    if (h) { drag = { mode: "resize", handle: h, orig: Object.assign({}, box), sx: p.x, sy: p.y }; return; }
    if (inBox(box, p.x, p.y)) { drag = { mode: "move", orig: Object.assign({}, box), sx: p.x, sy: p.y }; return; }
    drag = { mode: "new", sx: p.x, sy: p.y };
    box = { x: p.x, y: p.y, w: MIN, h: MIN };
  });

  stage.addEventListener("pointermove", function (e) {
    var p = pos(e);
    if (!drag) {
      var h = hitHandle(box, p.x, p.y);
      stage.style.cursor = h ? cursorFor(h) : (inBox(box, p.x, p.y) ? "move" : "crosshair");
      return;
    }
    if (drag.mode === "new") {
      box = clampBox({
        x: Math.min(drag.sx, p.x), y: Math.min(drag.sy, p.y),
        w: Math.abs(p.x - drag.sx), h: Math.abs(p.y - drag.sy)
      });
    } else if (drag.mode === "move") {
      var o = drag.orig;
      box = clampBox({ x: o.x + (p.x - drag.sx), y: o.y + (p.y - drag.sy), w: o.w, h: o.h });
    } else {
      var ob = drag.orig, hh = drag.handle;
      var left = ob.x, top = ob.y, right = ob.x + ob.w, bottom = ob.y + ob.h;
      if (hh.indexOf("w") >= 0) left = Math.min(p.x, right - MIN);
      if (hh.indexOf("e") >= 0) right = Math.max(p.x, left + MIN);
      if (hh.indexOf("n") >= 0) top = Math.min(p.y, bottom - MIN);
      if (hh.indexOf("s") >= 0) bottom = Math.max(p.y, top + MIN);
      box = clampBox({ x: left, y: top, w: right - left, h: bottom - top });
    }
    updateMeta();
  });

  stage.addEventListener("pointerup", function () {
    if (drag) {
      drag = null;
      missCount = 0;
      lastSig = null;
      decodeOnce(true);
      updateMeta();
      saveBox();
    }
  });

  stage.addEventListener("pointercancel", function () { drag = null; });
  stage.addEventListener("dblclick", function () { resetBox(); });

  function resetBox() {
    autoBox();
    missCount = 0;
    lastSig = null;
    skipCount = 0;
    decodeOnce(true);
    updateMeta();
    saveBox();
  }

  // ---------- 连续模式 ----------

  async function continuousTick() {
    if (!continuousOn) return;
    if (frameBusy || !window.qr) { scheduleContinuous(700); return; }
    frameBusy = true;
    var t0 = performance.now();
    try {
      var f = await window.qr.getFrame();
      if (f && f.dataUrl) {
        meta = f;
        await swapFrame(f.dataUrl);
        // 换帧了就让下一轮解码强制重算；但不清 lastResult ——
        // 清了会让同一张码每次都当成"新扫到"，自动复制/提示音会反复触发
        lastSig = null;
      }
    } catch (e) {
    } finally {
      // getSources 在 Windows 上每次都要重建捕获会话，实测 1~3 秒。
      // 固定 320ms 去轮询只会让请求排队、画面更卡，所以按实测耗时定下一跳。
      lastCaptureMs = Math.round(performance.now() - t0);
      frameBusy = false;
      scheduleContinuous(Math.max(600, lastCaptureMs + 200));
    }
  }

  function scheduleContinuous(gap) {
    if (!continuousOn) return;
    if (contTimer) clearTimeout(contTimer);
    contTimer = setTimeout(continuousTick, gap || 800);
  }

  function stopContinuous() {
    continuousOn = false;
    if (contTimer) { clearTimeout(contTimer); contTimer = null; }
  }

  function startContinuous() {
    if (continuousOn) return;
    continuousOn = true;
    continuousTick();
  }

  function setMode(next) {
    mode = next;
    modePill.textContent = mode === "continuous" ? "连续" : "冻结";
    modePill.classList.toggle("hot", mode === "continuous");
    stopContinuous();
    if (mode === "continuous") {
      startContinuous();
      setBadge("连续扫描中 · 屏幕变化会自动重扫", "info");
      toast("已切到连续扫描：画面会自动刷新重扫，适合会刷新的二维码。", "", 2600);
    } else {
      setBadge("已切回冻结 · 松手后自动识别", "info");
      toast("已切回冻结：只识别当前画面，按需拖动选框。", "", 2200);
    }
    updateStat();
  }

  function togglePause() {
    paused = !paused;
    // 状态要写在胶囊上并保持住，否则下一次 updateStat 会把它冲掉，用户以为没生效
    updateStat();
    toast(paused ? "已暂停解码，按 P 恢复。" : "已恢复解码。", "", 1800);
  }

  // ---------- 移动端环境（按需代理）----------
  //
  // 这一段是整件事的"选择权"所在，逻辑很简单但顺序不能乱：
  //   识别出链接 → 用户点「手机环境打开」→ 弹卡问 → 选了才启动 → 关掉才还原
  // 任何时候都不会自动启动代理，正常扫码不受任何影响。

  var proxyState = { running: false, remainSec: 0, mode: "android", stats: null };
  var rememberChoice = null;   // "proxy" | "direct" | null（本次运行内记住）
  var askOpen = false;

  function formatSec(s) {
    s = Math.max(0, Math.round(s));
    var m = Math.floor(s / 60), r = s % 60;
    return m + ":" + (r < 10 ? "0" : "") + r;
  }

  var toastTimer = null;
  function toast(msg, kind, ms) {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.className = "show" + (kind ? " " + kind : "");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.className = ""; }, ms || 4200);
  }

  function renderProxyPill() {
    if (!proxyPill) return;
    if (proxyState.running) {
      proxyPill.textContent = "代理 开 · " + (proxyState.remainSec > 0 ? formatSec(proxyState.remainSec) : "不限时");
      proxyPill.className = "pill clickable on";
      proxyPill.title = "点击立即关闭并还原系统代理";
    } else {
      proxyPill.textContent = "代理 关";
      proxyPill.className = "pill clickable";
      proxyPill.title = "正常扫码不启用代理；需要时点结果里的「手机环境打开」";
    }
  }

  async function refreshProxy() {
    if (!window.qr || !window.qr.proxyStatus) return;
    try {
      var s = await window.qr.proxyStatus();
      if (!s) return;
      proxyState.running = !!s.running;
      proxyState.remainSec = s.remainSec || 0;
      proxyState.mode = s.mode || "android";
      proxyState.stats = s.stats || null;
      renderProxyPill();
    } catch (e) {}
  }

  function bindProxyEvents() {
    if (!window.qr || !window.qr.onProxyEvent) return;
    window.qr.onProxyEvent(function (ev) {
      if (!ev) return;
      if (ev.type === "tick") {
        proxyState.running = true;
        proxyState.remainSec = ev.remainSec || 0;
        proxyState.stats = ev.stats || proxyState.stats;
        renderProxyPill();
      } else if (ev.type === "started") {
        proxyState.running = true;
        proxyState.remainSec = ev.remainSec || 0;
        proxyState.mode = ev.mode || "android";
        renderProxyPill();
      } else if (ev.type === "stopped") {
        proxyState.running = false;
        proxyState.remainSec = 0;
        renderProxyPill();
        if (ev.reason === "ttl") toast("已到时间，代理自动关闭，系统代理已还原。", "", 3600);
      } else if (ev.type === "stalled") {
        toast("代理已开，但还没有任何请求经过。说明微信没走系统代理 —— " +
          "重新点一次「手机环境打开」并勾选「兼容模式（全局代理）」。", "warn", 10000);
      } else if (ev.type === "error") {
        toast("代理异常：" + (ev.message || "未知错误"), "bad", 8000);
      }
    });
  }

  // ---- 询问卡 ----

  // 按钮文案跟着选项走，别让用户在"确定"上猜会发生什么
  function syncAskOk() {
    if (!askOk) return;
    var v = document.querySelector('input[name="pmode"]:checked');
    askOk.textContent = (v && v.value === "direct") ? "复制并打开微信" : "启用并在微信打开";
  }

  function showAsk(c, text) {
    askOpen = true;
    stopDwell();
    hideHelp();
    var host = "";
    try { host = new URL(text).host; } catch (e) { host = text.slice(0, 48); }
    var why = (c && c.mobileWhy) || "这类页面常按 UA 分流，PC 环境可能拿不到结果。";
    if (askSub) {
      askSub.innerHTML = "<b>" + esc(host) + "</b> · " +
        esc((c && c.label) || "链接") + "<br/>" + esc(why);
    }

    // 卡里的默认值跟着设置走：时长、是否全局代理。用户改了设置就应该"记住"。
    if (askTtl) {
      var tv = String(ST.proxyTtl);
      var has = Array.prototype.some.call(askTtl.options, function (o) { return o.value === tv; });
      askTtl.value = has ? tv : "180";
    }
    if (askGlobal) askGlobal.checked = (ST.proxyMode === "global");
    if (askRemember) askRemember.checked = false;

    var pick = rememberChoice || "proxy";
    var r = document.querySelector('input[name="pmode"][value="' + pick + '"]');
    if (r) r.checked = true;
    syncAskOk();
    askEl.classList.add("show");
  }

  function hideAsk() {
    askOpen = false;
    askEl.classList.remove("show");
    armDwell();
  }

  // 交接完成就收起取景框：它是全屏置顶的，不收起来会一直盖在微信上面，
  // 用户还得自己按 Esc 才能看到刚被唤醒的微信，很别扭。代理不受影响。
  function handOff(delay) {
    setTimeout(function () { if (window.qr) window.qr.close(); }, delay || 1100);
  }

  /* 交给微信
   *
   * 以前是「复制 + 唤起微信 + 让用户自己粘贴」；现在整段交给主进程：
   * 它会先把取景框关掉（置顶 + 内容保护，不关的话截图是黑的），
   * 再在微信「搜一搜」里填好链接，按设置决定要不要顺手点开第一条结果。
   *
   * 这里只负责"说一声然后退场"——所有失败原因都通过系统通知告诉用户，
   * 因为取景框一关，页面上就没有地方显示提示了。
   */
  function handToWechat(text, msg) {
    if (!window.qr) return;
    window.qr.copy(text);
    toast(msg || "正在交给微信…", "", 1600);
    setTimeout(function () {
      if (window.qr) window.qr.wxOpen({ url: text });
    }, 380);
  }

  async function directHandOff(text, msg) {
    if (!window.qr) return;
    handToWechat(text, msg);
  }

  async function proxyHandOff(text, ttl, global) {
    if (!window.qr) return false;
    toast("正在启用移动端环境…", "", 6000);
    // 把目标链接交给主进程：它会据此算出"只接管哪个站"（设置里选「全部站点」时不传）
    var r = await window.qr.proxyStart({
      mode: "android", ttlSec: ttl, globalProxy: global, scopeUrl: text
    });
    if (!r || !r.ok) {
      toast("启用失败：" + ((r && r.error) || "未知错误，详见 proxy/manager.log"), "bad", 9000);
      return false;
    }
    await refreshProxy();
    handToWechat(text, "代理已开 · 正在交给微信…");
    return true;
  }

  async function submitAsk() {
    var text = codeEl.textContent || "";
    var pickEl = document.querySelector('input[name="pmode"]:checked');
    var pmode = pickEl ? pickEl.value : "proxy";
    var ttl = parseInt((askTtl && askTtl.value) || "180", 10);
    var global = !!(askGlobal && askGlobal.checked);
    if (askRemember && askRemember.checked) rememberChoice = pmode;

    hideAsk();
    if (!/^https?:\/\//i.test(text)) return;

    if (pmode === "direct") return directHandOff(text);
    return proxyHandOff(text, ttl, global);
  }

  if (btnMobile) btnMobile.onclick = function () {
    if (!window.qr) return;
    var text = codeEl.textContent || "";
    if (!/^https?:\/\//i.test(text)) return;

    // 设置里选了「不启用」：完全不碰系统代理，直接复制 + 唤起微信
    if (ST.proxyAnswer === "off") {
      directHandOff(text, "已按设置跳过代理：链接已复制，正在切到微信。");
      return;
    }

    var c = window.classifyCode ? window.classifyCode(text, wechatEnv) : null;

    // 设置里选了「自动开启」：不问，直接按设置的时长/模式启动。
    // 启动失败（缺 python、端口被占）再退回询问卡，不让流程死在一次失败里。
    if (ST.proxyAnswer === "auto") {
      if (rememberChoice === "direct") { directHandOff(text); return; }
      proxyHandOff(text, ST.proxyTtl, ST.proxyMode === "global").then(function (ok) {
        if (!ok) showAsk(c, text);
      });
      return;
    }

    showAsk(c, text);
  };

  if (askOk) askOk.onclick = submitAsk;
  if (askCancel) askCancel.onclick = hideAsk;
  Array.prototype.forEach.call(
    document.querySelectorAll('input[name="pmode"]'),
    function (r) { r.addEventListener("change", syncAskOk); }
  );

  // 模式胶囊也能点：不习惯快捷键的人可以直接用鼠标切连续/冻结
  if (modePill) {
    modePill.classList.add("clickable");
    modePill.title = "点击切换 冻结 / 连续扫描（或按空格）";
    modePill.onclick = function (e) {
      e.stopPropagation();
      setMode(mode === "continuous" ? "freeze" : "continuous");
    };
  }

  if (proxyPill) proxyPill.onclick = async function (e) {
    e.stopPropagation();
    if (!proxyState.running) {
      toast("代理未启用。正常使用不启动；需要手机环境时点结果里的「手机环境打开」。", "", 3600);
      return;
    }
    await window.qr.proxyStop();
    await refreshProxy();
    toast("已关闭代理，系统代理已还原。", "", 3600);
  };

  // ---------- 顶栏按钮 ----------

  function hideHelp() {
    if (helpEl) helpEl.classList.remove("show");
    if (btnHelp) btnHelp.classList.remove("active");
  }

  if (btnClose) btnClose.onclick = function (e) {
    e.stopPropagation();
    if (window.qr) window.qr.close();
  };

  if (btnHelp) btnHelp.onclick = function (e) {
    e.stopPropagation();
    if (!helpEl) return;
    var open = helpEl.classList.toggle("show");
    btnHelp.classList.toggle("active", open);
  };

  document.addEventListener("pointerdown", function (e) {
    if (!helpEl || !helpEl.classList.contains("show")) return;
    if (helpEl.contains(e.target)) return;
    if (btnHelp && btnHelp.contains(e.target)) return;
    hideHelp();
  });

  // ---------- actions ----------

  async function copyCode() {
    var text = codeEl.textContent || "";
    if (!text) return;
    if (window.qr) await window.qr.copy(text);
    else if (navigator.clipboard) navigator.clipboard.writeText(text);
    btnCopy.textContent = "已复制";
    setTimeout(function () { btnCopy.textContent = "复制"; }, 1400);
  }

  btnCopy.onclick = copyCode;

  if (btnBarClose) btnBarClose.onclick = function (e) {
    e.stopPropagation();
    dismissResult();
  };

  // 鼠标停在结果条上就不自动收：这时候用户多半正在读内容或准备点按钮
  if (bar) {
    bar.addEventListener("pointerenter", stopDwell);
    bar.addEventListener("pointerleave", function () { armDwell(); });
  }

  btnOpen.onclick = function () {
    var text = codeEl.textContent || "";
    if (!window.qr) return;

    // 组合动作：交给微信（填搜索词，必要时代点第一条结果）
    if (currentAction === "open-in-wechat" && /^https?:\/\//i.test(text)) {
      handToWechat(text, "已复制 · 正在交给微信…");
      return;
    }

    // 只放行 http(s) 与微信 scheme，避免把任意协议交给系统处理
    if (/^(https?:\/\/|weixin:\/\/)/i.test(text)) window.qr.openExternal(text);
  };

  document.addEventListener("keydown", function (e) {
    // 询问卡打开时吃掉所有快捷键，避免误触把取景框关掉
    if (askOpen) {
      if (e.key === "Escape") { e.preventDefault(); hideAsk(); return; }
      if (e.key === "Enter") { e.preventDefault(); submitAsk(); return; }
      if (e.key === "1" || e.key === "2") {
        var v = e.key === "1" ? "proxy" : "direct";
        var el = document.querySelector('input[name="pmode"][value="' + v + '"]');
        if (el) el.checked = true;
        return;
      }
      return;
    }
    if (helpEl && helpEl.classList.contains("show")) {
      if (e.key === "Escape") { e.preventDefault(); hideHelp(); return; }
    }
    if (e.key === "Escape") {
      if (window.qr) window.qr.close();
      return;
    }
    if (e.code === "Space") { e.preventDefault(); setMode(mode === "continuous" ? "freeze" : "continuous"); return; }
    if (e.key === "c" || e.key === "C") { copyCode(); return; }
    if (e.key === "r" || e.key === "R") { resetBox(); return; }
    if (e.key === "p" || e.key === "P") { togglePause(); return; }
  });

  // ---------- boot ----------

  window.addEventListener("resize", function () {
    if (box) box = clampBox(box); else autoBox();
  });

  requestAnimationFrame(render);

  // 只读诊断口：给 --uitest 判断"取景框到底在不在动"用，不参与任何业务流程
  window.__qrDebug = function () {
    return {
      mode: mode, paused: paused, imgReady: imgReady,
      frameSeq: frameSeq, decodeCount: decodeCount, skipCount: skipCount,
      hasBox: !!box,
      box: box ? { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.w), h: Math.round(box.h) } : null
    };
  };

  // bootstrap 里任何一个 await 失败都会让取景框停在"等待画面"，
  // 不加 catch 就是静默黑屏 —— 这种问题最难查，所以这里必须兜住。
  // 抓屏偶发失败（多屏切换、权限刚授予）很常见，所以自动重试，但只重试 4 次。
  var bootTries = 0;
  function boot() {
    bootstrap()
      .then(function () { updateMeta(); })
      .catch(function (e) {
        showError((e && e.message) || e);
        if (++bootTries > 4) return;
        setTimeout(function () { boot(); }, 1500);
      });
  }
  boot();
})();

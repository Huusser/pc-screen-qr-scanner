"use strict";

/**
 * 主窗口逻辑
 * - 主界面：开始框选 / 微信与代理状态 / 退出
 * - 设置面板：四页（扫码 / 移动端 / 外观 / 关于），控件与 settings.js 的 key 一一对应
 *
 * 一条原则：所有控件都靠 data-key 驱动，不写死在某个函数里。
 * 加一项设置 = settings.js 加一条默认值 + 这个页面加一个带 data-key 的控件。
 */
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var qsa = function (sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); };
  var api = window.qr || null;

  var state = {
    settings: null,
    info: null,
    sysDark: false,
    pane: "scan",
    recording: false,
    resetArm: 0
  };

  // ---------------------------------------------------------------- 提示条

  var toastTimer = null;
  function toast(msg, bad) {
    var el = $("toast");
    if (!el) return;
    el.textContent = msg;
    el.className = "show" + (bad ? " bad" : "");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.className = ""; }, bad ? 5200 : 2600);
  }

  // ---------------------------------------------------------------- 主题

  function applyTheme() {
    var t = (state.settings && state.settings.theme) || "dark";
    var resolved = t === "system" ? (state.sysDark ? "dark" : "light") : t;
    if (document.body.dataset.theme !== resolved) document.body.dataset.theme = resolved;
  }

  // ---------------------------------------------------------------- 控件渲染

  // 滑块左半段画成已填充的蓝色（原生 range 没有这个效果）
  function paintSlider(el) {
    if (!el) return;
    var min = Number(el.min) || 0, max = Number(el.max) || 100;
    var v = Number(el.value);
    var p = Math.max(0, Math.min(100, ((v - min) / (max - min)) * 100));
    el.style.background = "linear-gradient(90deg, var(--accent) 0%, var(--accent) " +
      p + "%, var(--sw-off) " + p + "%)";
  }

  function paint() {
    var st = state.settings || {};

    qsa(".seg[data-key]").forEach(function (seg) {
      var cur = String(st[seg.dataset.key]);
      Array.prototype.forEach.call(seg.querySelectorAll("button"), function (b) {
        b.classList.toggle("on", b.dataset.v === cur);
      });
    });

    qsa(".sw[data-key]").forEach(function (sw) {
      sw.classList.toggle("on", !!st[sw.dataset.key]);
    });

    var range = $("maskRange");
    if (range && typeof st.maskOpacity === "number") {
      range.value = st.maskOpacity;
      $("maskPv").textContent = st.maskOpacity + "%";
      paintSlider(range);
    }

    var hk = st.hotkey || "Alt+Shift+Q";
    if (!state.recording && $("btnHotkey")) $("btnHotkey").textContent = hk;
    if ($("tbHotkey")) $("tbHotkey").textContent = hk;
    if ($("hintHotkey")) $("hintHotkey").textContent = hk;

    // 「点击方式」这一行跟随总开关：关着时压暗且不可点（CSS .dim），
    // 开着才让它可交互 —— 顺序问题在这里解决，不用每个按钮单独监听。
    if (rowAutoMode) rowAutoMode.classList.toggle("dim", !st.autoOpen);

    // 「代理范围」跟着「代理模式」：全局代理靠 ProxyOverride，做不了按域收窄，
    // 所以选全局时这一行压暗（值仍然保留，切回 PAC 就恢复），避免给出做不到的选项。
    if (rowProxyScope) rowProxyScope.classList.toggle("dim", st.proxyMode === "global");

    paintSound();
  }

  // ---------------------------------------------------------------- 写设置

  function patch(obj) {
    if (!api || !api.settingsPatch) return Promise.resolve(null);
    return api.settingsPatch(obj).then(function (r) {
      if (r && r.settings) {
        state.settings = r.settings;
        paint();
        applyTheme();
      }
      if (r && r.ok === false && r.error) toast(r.error, true);
      return r;
    }).catch(function (err) {
      toast("保存失败：" + (err && err.message ? err.message : err), true);
      return null;
    });
  }

  qsa(".seg[data-key]").forEach(function (seg) {
    seg.addEventListener("click", function (e) {
      var b = e.target.closest ? e.target.closest("button") : null;
      if (!b || !seg.contains(b)) return;
      var key = seg.dataset.key;
      var raw = b.dataset.v;
      var val = /^-?\d+$/.test(raw) ? Number(raw) : raw;
      // 先本地高亮，不等 IPC 回来：点下去就有反馈，失败时服务端返回会覆盖回来
      Array.prototype.forEach.call(seg.querySelectorAll("button"), function (x) {
        x.classList.toggle("on", x === b);
      });
      var o = {}; o[key] = val;
      patch(o);
    });
  });

  qsa(".sw[data-key]").forEach(function (sw) {
    sw.addEventListener("click", function () {
      var key = sw.dataset.key;
      var next = !sw.classList.contains("on");
      sw.classList.toggle("on", next);
      var o = {}; o[key] = next;
      patch(o);
    });
  });

  var maskRange = $("maskRange");
  if (maskRange) {
    maskRange.addEventListener("input", function () {
      $("maskPv").textContent = maskRange.value + "%";
      paintSlider(maskRange);
    });
    maskRange.addEventListener("change", function () {
      patch({ maskOpacity: Number(maskRange.value) });
    });
  }

  // ---------------------------------------------------------------- 说明浮窗
  //
  // 为什么不用 title 属性或纯 CSS tooltip：
  //   · title 要等 1 秒才有，且不能换行排版，讲不清"开/关两种行为"
  //   · 纯 CSS 绝对定位会被 .pbody 的 overflow 裁掉（设置页本身是可滚动的）
  // 所以用 fixed 定位 + JS 量尺寸，再把箭头对准问号。

  var qTip = $("qTip");
  var btnAutoHelp = $("btnAutoOpenHelp");
  var rowAutoMode = $("rowAutoMode");
  var rowProxyScope = $("rowProxyScope");
  // 最近一次"完整状态"里的范围。tick/started 事件若没带范围字段，
  // 就沿用这个值，而不是把状态卡刷成"只接管 0 个域名"。
  var lastScope = { all: true, count: 0 };

  // 浮窗里有好几行字，鼠标往浮窗上挪的那一下不能让它消失 —— 收起留 200ms，
  // 真进到浮窗里就撤销。切页/滚动/改窗口尺寸则立刻收，不然会飘在错误的位置上。
  var tipOff = null;

  function hideTip() {
    if (tipOff) { clearTimeout(tipOff); tipOff = null; }
    if (!qTip) return;
    qTip.classList.remove("show", "below");
    if (btnAutoHelp) btnAutoHelp.classList.remove("on");
  }

  function hideTipSoon() {
    if (tipOff) clearTimeout(tipOff);
    tipOff = setTimeout(hideTip, 200);
  }

  function showTip(btn) {
    if (!qTip || !btn) return;
    if (tipOff) { clearTimeout(tipOff); tipOff = null; }
    var r = btn.getBoundingClientRect();
    var tw = qTip.offsetWidth;
    var th = qTip.offsetHeight;
    var GAP = 9;
    // 问号是这一行的最后一个元素，贴着右边缘 —— 浮窗右端必须允许伸进窗口内边距，
    // 否则箭头会被挤到圆角上（半径 9px 以内），看起来就像没有箭头。
    var ARROW_INSET = 30;

    // 默认往上弹：这一行在页面底部，往下会被底栏压住
    var top = r.top - th - GAP;
    var placedBelow = false;
    if (top < 10) { top = r.bottom + GAP; placedBelow = true; }

    var bc = r.left + r.width / 2;
    var left = bc + 4 - (tw - ARROW_INSET);
    left = Math.max(8, Math.min(window.innerWidth - tw - 8, left));

    qTip.style.left = Math.round(left) + "px";
    qTip.style.top = Math.round(top) + "px";
    // 浮窗在问号上方时，箭头要在浮窗底边；在下方才放到顶边
    qTip.classList.toggle("below", !placedBelow);
    // 箭头对准问号中心，同时不许跑到圆角外面
    var ax = bc - left - 4;
    qTip.style.setProperty("--ax", Math.round(Math.max(16, Math.min(tw - ARROW_INSET + 4, ax))) + "px");
    qTip.classList.add("show");
    btn.classList.add("on");
  }

  if (btnAutoHelp) {
    btnAutoHelp.addEventListener("mouseenter", function () { showTip(btnAutoHelp); });
    btnAutoHelp.addEventListener("mouseleave", hideTipSoon);
    btnAutoHelp.addEventListener("focus", function () { showTip(btnAutoHelp); });
    btnAutoHelp.addEventListener("blur", hideTip);
  }
  if (qTip) {
    qTip.addEventListener("mouseenter", function () { if (tipOff) { clearTimeout(tipOff); tipOff = null; } });
    qTip.addEventListener("mouseleave", hideTipSoon);
  }
  var pbodyEl = document.querySelector(".pbody");
  if (pbodyEl) pbodyEl.addEventListener("scroll", hideTip, { passive: true });
  window.addEventListener("resize", hideTip);

  // ---------------------------------------------------------------- 提示音
  //
  // 三条交互约定：
  //   · 「试听」不受开关影响 —— 开关只管"扫成功时响不响"，试听是调音色用的
  //   · 点音色按钮向下展开，选中任意一项立刻收起并试听
  //   · 自定义 = 选文件 → 主进程认格式 → 这里真解一遍 → 归一存 WAV → 选中

  var SND = window.QRSound || null;
  var soundFold = $("soundFold");
  var soundOpts = $("soundOpts");
  var btnSoundPick = $("btnSoundPick");
  var btnSoundTest = $("btnSoundTest");
  var testTimer = null;

  var CK_SVG = '<svg class="ck" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.6l4.4 4.4L19 6.6"/></svg>';

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  // 文件名太长会把这一行挤爆，去掉扩展名再截断
  function shortName(n) {
    var s = String(n || "").replace(/\.[a-z0-9]{1,5}$/i, "");
    return s.length > 16 ? s.slice(0, 15) + "…" : s;
  }

  function fmtMs(ms) {
    var v = Number(ms) || 0;
    if (!v) return "";
    return v >= 1000 ? (v / 1000).toFixed(1) + "s" : v + "ms";
  }

  function hasCustomSound() {
    var st = state.settings || {};
    return !!(st.soundCustom && st.soundCustom.file);
  }

  function soundIdNow() {
    var st = state.settings || {};
    var id = st.soundId || (SND ? SND.DEFAULT_ID : "twotone");
    // 选了自定义但文件没了（被手动删掉）：显示和播放都退回默认，避免"选了没声"
    if (id === "custom" && !hasCustomSound()) return SND ? SND.DEFAULT_ID : "twotone";
    return id;
  }

  // 内置音色的行由 sound.js 提供数据生成：名字、时长只维护一处
  function buildSoundRows() {
    if (!soundOpts || soundOpts.dataset.built || !SND) return;
    var anchor = $("optCustom");
    if (!anchor) return;
    var html = SND.list().map(function (it, i) {
      var no = (i + 1 < 10 ? "0" : "") + (i + 1);
      return '<button class="sopt" data-sid="' + esc(it.id) + '" type="button">' +
        '<span class="no">' + no + '</span>' +
        '<span class="nm">' + esc(it.name) + '</span>' +
        '<span class="hint2">' + esc(it.hint) + '</span>' +
        '<span class="du">' + (it.ms >= 1000 ? (it.ms / 1000).toFixed(1) + "s" : it.ms + "ms") + '</span>' +
        CK_SVG +
        '</button>';
    }).join("");
    anchor.insertAdjacentHTML("beforebegin", html);
    soundOpts.dataset.built = "1";
  }

  function paintSound() {
    if (!SND) return;
    var st = state.settings || {};
    var id = soundIdNow();
    var cs = st.soundCustom;

    if ($("soundPickLabel")) {
      var label = id === "custom" && cs ? shortName(cs.name) : SND.nameOf(id);
      $("soundPickLabel").textContent = label;
      if (btnSoundPick) btnSoundPick.title = "当前：" + label;
    }
    qsa(".sopt[data-sid]").forEach(function (b) {
      b.classList.toggle("on", b.dataset.sid === id);
    });

    if ($("customHint")) $("customHint").textContent = cs ? "已导入，点这里可换" : "导入本地音频文件";
    if ($("customMeta")) $("customMeta").textContent = cs ? fmtMs(cs.ms) : "";
    if ($("customFile")) $("customFile").textContent = cs ? cs.name : "";
    if ($("optReimport")) $("optReimport").hidden = !cs;
    if ($("optCustom")) $("optCustom").disabled = false;
  }

  function setSoundFold(open) {
    if (!soundFold) return;
    // 展开时先把行建好，免得第一次点开是空的
    if (open) buildSoundRows();
    soundFold.classList.toggle("open", open);
    if (btnSoundPick) btnSoundPick.setAttribute("aria-expanded", open ? "true" : "false");
    // 音色行在扫码页靠下，展开后列表多半在视口外。
    // 等高度动画开始后再滚，否则 scrollIntoView 量到的是收起来的高度。
    if (open) {
      setTimeout(function () {
        try { soundFold.scrollIntoView({ block: "nearest", behavior: "smooth" }); } catch (_) {}
      }, 80);
    }
  }

  if (btnSoundPick) {
    btnSoundPick.addEventListener("click", function () {
      setSoundFold(!soundFold.classList.contains("open"));
    });
  }

  // 点空白处收起（只收这一层，不影响设置面板本身）
  document.addEventListener("mousedown", function (e) {
    if (!soundFold || !soundFold.classList.contains("open")) return;
    if (e.target.closest && (e.target.closest("#soundFold") || e.target.closest("#btnSoundPick"))) return;
    setSoundFold(false);
  });

  if (btnSoundTest) {
    btnSoundTest.addEventListener("click", function () {
      if (!SND) return;
      loadCustomSound().then(function () {
        SND.preview(soundIdNow());
        btnSoundTest.classList.add("on");
        if (testTimer) clearTimeout(testTimer);
        testTimer = setTimeout(function () { btnSoundTest.classList.remove("on"); }, 700);
      });
    });
  }

  // 打开提示音开关时顺便响一次：等于"确认一下这是我要的声音"
  var swSound = document.querySelector('.sw[data-key="sound"]');
  if (swSound) {
    swSound.addEventListener("click", function () {
      if (!SND || !swSound.classList.contains("on")) return;
      loadCustomSound().then(function () { SND.preview(soundIdNow()); });
    });
  }

  function selectSound(id) {
    setSoundFold(false);
    var p = hasCustomSound() ? loadCustomSound() : Promise.resolve(true);
    p.then(function () {
      patch({ soundId: id }).then(function () {
        paintSound();
        if (SND) SND.preview(id);
      });
    });
  }

  if (soundOpts) {
    soundOpts.addEventListener("click", function (e) {
      var b = e.target.closest ? e.target.closest(".sopt") : null;
      if (!b || !soundOpts.contains(b) || b.disabled) return;
      if (b.id === "optReimport") { pickCustom(); return; }

      var sid = b.dataset.sid;
      if (!sid) return;
      // 点"自定义"时：还没有文件就去导入，已有文件就直接选中
      if (sid === "custom" && !hasCustomSound()) { pickCustom(); return; }
      selectSound(sid);
    });
  }

  // 自定义音色本体只在需要时取一次，取到就缓存在 sound.js 里
  function loadCustomSound() {
    if (!SND) return Promise.resolve(false);
    if (!hasCustomSound()) return Promise.resolve(false);
    if (SND.hasCustom()) return Promise.resolve(true);
    if (!api || !api.soundCustom) return Promise.resolve(false);
    return api.soundCustom().then(function (r) {
      if (!r || !r.ok) return false;
      return SND.loadCustom(r.base64, r.peak, (state.settings.soundCustom || {}).name);
    }).catch(function () { return false; });
  }

  function pickCustom() {
    if (!SND || !api || !api.soundPick) { toast("导入功能不可用", true); return; }
    var row = $("optCustom");
    var hint = $("customHint");
    var restore = hint ? hint.textContent : "";
    if (row) row.disabled = true;
    if (hint) hint.textContent = "正在选择…";

    api.soundPick().then(function (r) {
      if (row) row.disabled = false;
      if (hint) hint.textContent = restore;
      if (!r || r.canceled) return;                       // 自己取消的，不弹提示
      if (!r.ok) { toast(r.message || "这个文件用不了", true); return; }
      return importFile(r);
    }).catch(function (err) {
      if (row) row.disabled = false;
      if (hint) hint.textContent = restore;
      toast("导入失败：" + ((err && err.message) || err), true);
    });
  }

  // 第二跳：真解码。格式表只能说"大概支持"，解不开就是不能用。
  function importFile(r) {
    var row = $("optCustom");
    var hint = $("customHint");
    if (row) row.disabled = true;
    if (hint) hint.textContent = "解码中…";

    return SND.decodeToWav(r.base64).then(function (dec) {
      if (!dec.ok) {
        if (row) row.disabled = false;
        if (hint) hint.textContent = "导入失败，点这里重试";
        toast(dec.error + (r.label ? "（" + r.label + "）" : ""), true);
        return;
      }
      if (hint) hint.textContent = "保存中…";
      return api.soundSave({
        wavBase64: dec.wavBase64,
        name: r.name,
        format: r.label,
        ms: dec.ms,
        peak: dec.peak
      }).then(function (saved) {
        if (row) row.disabled = false;
        if (!saved || !saved.ok) {
          if (hint) hint.textContent = "导入失败，点这里重试";
          toast((saved && saved.error) || "保存失败", true);
          return;
        }
        if (saved.settings) state.settings = saved.settings;
        paint();
        paintSound();
        setSoundFold(false);
        SND.setCustomFromWav(dec.wavBase64, 0.9, r.name).then(function () {
          SND.preview("custom");
        });
        toast("已导入「" + r.name + "」" + (r.mismatch
          ? "（扩展名与实际格式不一致，已按实际内容导入）" : ""));
      });
    }).catch(function (err) {
      if (row) row.disabled = false;
      if (hint) hint.textContent = "导入失败，点这里重试";
      toast("导入失败：" + ((err && err.message) || err), true);
    });
  }

  // ---------------------------------------------------------------- 快捷键录制

  function accelFromEvent(e) {
    var mods = [];
    if (e.ctrlKey) mods.push("Ctrl");
    if (e.altKey) mods.push("Alt");
    if (e.shiftKey) mods.push("Shift");
    if (e.metaKey) mods.push("Super");
    if (!mods.length) return null;          // 光按一个字母会把整个键盘吃掉

    var k = e.key;
    if (k === "Control" || k === "Alt" || k === "Shift" || k === "Meta") return null;

    var code = e.code || "";
    var main = null;
    if (/^Key[A-Z]$/.test(code)) main = code.slice(3);
    else if (/^Digit[0-9]$/.test(code)) main = code.slice(5);
    else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) main = code;
    else if (k && k.length === 1) main = k.toUpperCase();
    if (!main) return null;

    return mods.join("+") + "+" + main;
  }

  var btnHotkey = $("btnHotkey");
  if (btnHotkey) {
    btnHotkey.addEventListener("click", function () {
      if (state.recording) return;
      state.recording = true;
      btnHotkey.classList.add("rec");
      btnHotkey.textContent = "按下组合键…";
    });
  }

  document.addEventListener("keydown", function (e) {
    if (!state.recording) return;
    e.preventDefault();
    e.stopPropagation();

    if (e.key === "Escape") {
      state.recording = false;
      if (btnHotkey) btnHotkey.classList.remove("rec");
      paint();
      return;
    }

    var acc = accelFromEvent(e);
    if (!acc) return;                        // 只按了修饰键，继续等主键

    state.recording = false;
    if (btnHotkey) {
      btnHotkey.classList.remove("rec");
      btnHotkey.textContent = acc;
    }
    patch({ hotkey: acc }).then(function () { paint(); });
  }, true);

  // ---------------------------------------------------------------- 视图切换

  function setSettingsView(on) {
    document.body.classList.toggle("settings", on);
    var gear = $("btnSettings");
    if (gear) gear.classList.toggle("on", on);
    if (!on) setSoundFold(false);        // 退出设置时把展开的音色列表收掉
    hideTip();
    if (on) {
      refreshAbout();
      var body = document.querySelector(".pbody");
      if (body) body.scrollTop = 0;
    }
  }

  if ($("btnSettings")) {
    $("btnSettings").addEventListener("click", function () {
      setSettingsView(!document.body.classList.contains("settings"));
    });
  }
  if ($("btnBack")) $("btnBack").addEventListener("click", function () { setSettingsView(false); });
  if ($("btnDone")) $("btnDone").addEventListener("click", function () { setSettingsView(false); });

  qsa(".tab").forEach(function (tab) {
    tab.addEventListener("click", function () {
      var name = tab.dataset.pane;
      state.pane = name;
      qsa(".tab").forEach(function (t) { t.classList.toggle("on", t === tab); });
      qsa(".pane").forEach(function (p) { p.classList.toggle("on", p.dataset.pane === name); });
      setSoundFold(false);
      hideTip();
      var body = document.querySelector(".pbody");
      if (body) body.scrollTop = 0;
      $("btnResetPane").style.display = name === "about" ? "none" : "";
      $("sFootNote").textContent = name === "proxy"
        ? "改动立即生效，运行中也可改"
        : "改动立即生效，无需重启";
      // 进「移动端」页就顺手自检一次：缺 Python/openssl 时用户应当一眼看到，
      // 而不是点「手机环境打开」之后才收到一句看不懂的报错。
      if (name === "proxy") runEnvCheck();
    });
  });

  // 恢复默认：只重置当前这一页的项，别把别的页面调好的东西一起洗掉
  var PANE_KEYS = {
    scan: ["hotkey", "scanMode", "autoCopy", "rememberBox", "hideLauncher", "autoJudge",
      "resultDwell", "sound", "soundId", "soundCustom", "autoOpen", "autoOpenMode", "timingTest"],
    proxy: ["proxyAnswer", "proxyTtl", "proxyScope", "proxyMode", "proxyLog"],
    appearance: ["theme", "maskOpacity", "autoLaunch", "alwaysOnTop", "closeAction", "frameSize"]
  };

  if ($("btnResetPane")) {
    $("btnResetPane").addEventListener("click", function () {
      var keys = PANE_KEYS[state.pane] || [];
      var defaults = (state.info && state.info.defaults) || null;
      if (!keys.length || !defaults) return;
      var o = {};
      keys.forEach(function (k) { if (k in defaults) o[k] = defaults[k]; });
      patch(o).then(function () { toast("已恢复本页默认值"); });
    });
  }

  if ($("btnResetAll")) {
    $("btnResetAll").addEventListener("click", function () {
      var btn = $("btnResetAll");
      var now = Date.now();
      if (now - state.resetArm > 4000) {
        state.resetArm = now;
        btn.textContent = "再点一次确认重置";
        setTimeout(function () {
          if (Date.now() - state.resetArm >= 4000) {
            btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9.5 7V4.6h5V7M6.5 7l1 12.4h9L17.5 7"/></svg>重置全部设置';
          }
        }, 4100);
        return;
      }
      state.resetArm = 0;
      if (!api || !api.settingsReset) return;
      api.settingsReset().then(function (r) {
        if (r && r.settings) { state.settings = r.settings; paint(); applyTheme(); }
        btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9.5 7V4.6h5V7M6.5 7l1 12.4h9L17.5 7"/></svg>重置全部设置';
        toast("已恢复全部默认设置");
      });
    });
  }

  // ---------------------------------------------------------------- 关于页

  function fmtBytes(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
    return (n / 1024 / 1024).toFixed(1) + " MB";
  }

  function refreshAbout() {
    if (!api || !api.appInfo) return;
    api.appInfo().then(function (info) {
      if (!info) return;
      state.info = info;
      if ($("abVersion")) $("abVersion").textContent = "v" + info.version;
      if ($("tbVer")) $("tbVer").textContent = "v" + info.version;
      if ($("abCert")) {
        $("abCert").textContent = info.certInstalled
          ? "已安装 · " + info.certDomains + " 个域名"
          : "未安装（首次启用代理时自动签发）";
        $("abCert").style.color = info.certInstalled ? "" : "var(--dimmer)";
      }
      if ($("abLogs") && info.logUsage) {
        $("abLogs").textContent = info.logUsage.files
          ? fmtBytes(info.logUsage.bytes)
          : "无";
      }
      paint();
    }).catch(function () {});
  }

  // 清空日志（P0-5）：日志可能含访问地址，用户要能一键清掉而不必找文件
  if ($("btnClearLogs")) {
    $("btnClearLogs").addEventListener("click", function () {
      if (!api || !api.clearLogs) return;
      api.clearLogs().then(function (r) {
        if (!r || !r.ok) { toast("清理失败，日志可能正被占用", true); return; }
        if ($("abLogs")) $("abLogs").textContent = "无";
        toast(r.removed
          ? "已清空 " + r.removed + " 个日志文件（" + fmtBytes(r.bytes) + "）"
          : "没有需要清理的日志");
      }).catch(function () { toast("清理失败", true); });
    });
  }

  // 运行环境自检：「手机环境」现在自带 Python 运行时与证书签发（纯 Python），
  // 所以正常机器上必然是"就绪"。这里留着是为了让极端情况（杀软把
  // vendor\python 删了、公司策略禁止子进程）能被看见，而不是点了没反应。
  function paintEnv(r) {
    var tag = $("envTag");
    var hint = $("envHint");
    if (!tag || !hint) return;
    if (!r) {
      tag.textContent = "未检测";
      tag.style.color = "var(--dimmer)";
      hint.textContent = "未检测：程序自带运行时，无需另装";
      return;
    }
    if (r.ok) {
      tag.textContent = "就绪";
      tag.style.color = "";
      hint.textContent =
        "Python " + (r.python.version || "?") +
        (r.python.bundled ? "（内置）" : "（系统）") +
        " · 证书签发：内置";
    } else {
      tag.textContent = "缺少依赖";
      tag.style.color = "var(--warn, #d97706)";
      hint.textContent = r.hint || "缺少运行依赖，手机环境不可用";
    }
  }

  function runEnvCheck() {
    if (!api || !api.envCheck) return;
    var b = $("btnEnvCheck");
    if (b) { b.disabled = true; b.textContent = "检测中"; }
    // 立刻把标签也切成"检测中"：探一次 Python + openssl 要一秒左右，
    // 期间若还显示"未检测"，看起来像按钮没响应。
    if ($("envTag")) { $("envTag").textContent = "检测中"; $("envTag").style.color = "var(--dimmer)"; }
    api.envCheck().then(function (r) {
      paintEnv(r);
      if (b) { b.disabled = false; b.textContent = "检测"; }
    }).catch(function () {
      paintEnv({ ok: false, hint: "检测失败" });
      if (b) { b.disabled = false; b.textContent = "检测"; }
    });
  }

  if ($("btnEnvCheck")) $("btnEnvCheck").addEventListener("click", runEnvCheck);

  if ($("btnCheck")) {
    $("btnCheck").addEventListener("click", function () {
      var b = $("btnCheck");
      b.disabled = true;
      b.textContent = "检查中…";
      setTimeout(function () {
        b.disabled = false;
        b.textContent = "检查更新";
        if ($("abLatest")) $("abLatest").textContent = "已是最新版本";
        toast("当前 v" + ((state.info && state.info.version) || "0.4.0") + "，已是最新版本");
      }, 700);
    });
  }

  qsa("[data-open]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      if (!api || !api.openPath) return;
      api.openPath(btn.dataset.open).then(function (ok) {
        if (!ok) toast("打不开这个目录，路径可能被移动了", true);
      });
    });
  });

  if ($("btnHelpKeys")) {
    $("btnHelpKeys").addEventListener("click", function () {
      var box = $("helpKeys");
      if (box) box.classList.toggle("show");
    });
  }

  // ---------------------------------------------------------------- 窗口控制

  if (api) {
    if ($("btnMin")) $("btnMin").addEventListener("click", function () { api.minimize(); });
    if ($("btnMax")) $("btnMax").addEventListener("click", function () { api.toggleMaximize(); });
    if ($("btnClose")) $("btnClose").addEventListener("click", function () { api.quit(); });
    if ($("btnQuit")) $("btnQuit").addEventListener("click", function () { api.quit(); });
    if ($("btnStart")) $("btnStart").addEventListener("click", function () { api.start(); });

    // 最大化 / 还原状态同步：图标和 help 文案跟着变
    function applyWinState(s) {
      var max = !!(s && s.maximized);
      document.body.classList.toggle("maximized", max);
      if ($("btnMax")) $("btnMax").title = max ? "还原" : "最大化";
    }
    if (api.onWinState) api.onWinState(applyWinState);
    if (api.winState) api.winState().then(applyWinState).catch(function () {});

    // 双击标题栏 = 最大化/还原（Windows 习惯）；点在按钮上不触发
    var tb = $("titlebar");
    if (tb) {
      tb.addEventListener("dblclick", function (e) {
        if (e.target.closest && e.target.closest("button")) return;
        api.toggleMaximize();
      });
    }
  }

  // ---------------------------------------------------------------- 微信环境

  function renderWechat(r) {
    if (!r) return;
    var dot = $("wxDot"), val = $("wxVal"), sub = $("wxSub");
    if (!r.running) {
      dot.className = "dot bad";
      val.textContent = "未检测到";
      sub.textContent = "请先打开并登录 PC 微信";
      return;
    }
    dot.className = "dot " + (r.fastLogin ? "ok" : "warn");
    val.textContent = "微信 " + (r.version || "") + (r.fastLogin ? " · 可用" : " · 受限");
    sub.textContent = r.fastLogin ? "支持免扫码授权登录" : "快速登录未就绪，部分流程需要手机";
  }

  function refreshWechat() {
    if (!api || !api.probeWechat) return;
    api.probeWechat().then(renderWechat).catch(function () {});
  }

  // ---------------------------------------------------------------- 移动端环境

  function fmt(sec) {
    sec = Math.max(0, Math.round(sec || 0));
    var m = Math.floor(sec / 60), r = sec % 60;
    return m + ":" + (r < 10 ? "0" : "") + r;
  }

  var proxy = { running: false, remainSec: 0 };

  function renderProxy(s) {
    var on = !!(s && s.running);
    proxy.running = on;
    proxy.remainSec = (s && s.remainSec) || 0;

    // 主界面
    var banner = $("proxyBanner");
    if (banner) banner.className = on ? "show" : "";
    if ($("hintKeys")) $("hintKeys").style.display = on ? "none" : "";
    // 代理跑起来之后，主窗口的重心从"怎么扫"换成"接下来在微信里做什么"
    var hero = document.querySelector(".hero");
    if (hero) hero.style.display = on ? "none" : "";
    if ($("stepsIdle")) $("stepsIdle").style.display = on ? "none" : "";
    if ($("stepsProxy")) $("stepsProxy").style.display = on ? "" : "none";

    if ($("pxDot")) $("pxDot").className = "dot " + (on ? "warn live" : "");
    if ($("pxVal")) $("pxVal").textContent = on ? "运行中" : "未启用";
    // 范围要写在状态里：用户最该一眼看到的就是"这次代理影响多大"（P1-C）。
    // 只有完整状态（scopeAll 是 boolean）才允许更新记忆值；残缺事件对象
    // （老代码只带 remainSec）不许把范围文案刷成误导性的"0 个域名"。
    if (s && typeof s.scopeAll === "boolean") {
      lastScope.all = s.scopeAll;
      lastScope.count = typeof s.scopeCount === "number" ? s.scopeCount : 0;
    }
    var knownScope = s && typeof s.scopeAll === "boolean";
    var scopeAll = knownScope ? s.scopeAll : lastScope.all;
    var scopeCount = knownScope ? s.scopeCount : lastScope.count;
    if ($("pxSub")) {
      $("pxSub").textContent = !on ? "按需启动，平时不占后台"
        : (scopeAll ? "系统代理指向本机（全部站点）"
          : "只接管 " + (scopeCount || 0) + " 个域名，其余直连");
    }
    if ($("proxyText") && on) {
      $("proxyText").textContent = proxy.remainSec > 0
        ? "移动端环境运行中 · 剩 " + fmt(proxy.remainSec)
        : "移动端环境运行中 · 不限时";
    }

    // 设置页状态条
    var st = $("pxState");
    if (st) {
      st.className = "pstate" + (on ? "" : " off");
      $("pxStateText").textContent = on ? "移动端环境运行中" : "移动端环境未启用";
      $("pxStateRemain").textContent = on
        ? (proxy.remainSec > 0 ? "剩 " + fmt(proxy.remainSec) : "不限时")
        : "";
      $("pxStateDot").className = "dot " + (on ? "warn live" : "");
    }
    // 一键还原任何时候都可用：就算界面上没显示代理在跑，
    // 也可能有上一次异常残留的系统代理需要清掉。
    if ($("btnRestoreProxy")) $("btnRestoreProxy").disabled = false;
  }

  function refreshProxy() {
    if (!api || !api.proxyStatus) return;
    api.proxyStatus().then(renderProxy).catch(function () {});
  }

  if ($("proxyStop")) {
    $("proxyStop").addEventListener("click", function () {
      var b = this;
      b.disabled = true;
      b.textContent = "正在还原…";
      api.proxyStop().then(refreshProxy).then(function () {
        b.disabled = false;
        b.textContent = "关闭并还原";
      }).catch(function () { b.disabled = false; b.textContent = "关闭并还原"; });
    });
  }

  if ($("pxStateStop")) {
    $("pxStateStop").addEventListener("click", function () {
      api.proxyStop().then(refreshProxy).then(function () { toast("已停止，系统代理已还原"); });
    });
  }

  if ($("btnRestoreProxy")) {
    $("btnRestoreProxy").addEventListener("click", function () {
      if (!api) return;
      var b = $("btnRestoreProxy");
      b.textContent = "正在还原…";
      api.proxyStop().then(function (r) {
        return refreshProxy().then(function () { return r; });
      }).then(function (r) {
        b.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 12a8 8 0 1016 0"/><path d="M4 12H2.2M4 12l2.6-2.6M4 12l2.6 2.6"/></svg>一键还原系统代理';
        toast(r && r.noop ? "当前没有在跑的代理，系统代理本来就是干净的" : "已停止并还原系统代理");
      }).catch(function () {
        b.textContent = "一键还原系统代理";
        toast("还原失败，详见 proxy/manager.log", true);
      });
    });
  }

  if (api && api.onProxyEvent) {
    api.onProxyEvent(function (ev) {
      if (!ev) return;
      if (ev.type === "tick" || ev.type === "started") {
        renderProxy({
          running: true,
          remainSec: ev.remainSec,
          // 主进程在事件里带上范围（tick 已补齐）；老事件缺字段时
          // renderProxy 内部会沿用 lastScope，不会刷成 0
          scopeAll: ev.scopeAll,
          scopeCount: ev.scopeCount
        });
      } else if (ev.type === "stopped") {
        renderProxy({ running: false });
      }
    });
  }

  // ---------------------------------------------------------------- 键盘

  document.addEventListener("keydown", function (e) {
    if (state.recording) return;
    var inSettings = document.body.classList.contains("settings");
    if (inSettings && e.key === "Escape") {
      // 从内到外收：先收展开的音色列表，再退设置
      if (soundFold && soundFold.classList.contains("open")) { setSoundFold(false); return; }
      setSettingsView(false); return;
    }
    if (inSettings) return;
    if (e.key === "Enter") {
      var tag = (e.target && e.target.tagName) || "";
      if (tag === "BUTTON" || tag === "INPUT") return;
      e.preventDefault();
      if (api) api.start();
    }
  });

  // ---------------------------------------------------------------- 启动

  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) { refreshProxy(); refreshWechat(); }
  });

  function boot() {
    if (!api) return;

    Promise.all([
      api.settingsGet ? api.settingsGet() : null,
      api.systemTheme ? api.systemTheme() : null
    ]).then(function (res) {
      var st = res[0], sys = res[1];
      if (sys) state.sysDark = !!sys.dark;
      if (st) state.settings = st;
      applyTheme();
      buildSoundRows();
      paint();
      loadCustomSound();
    }).catch(function () {
      applyTheme();
      buildSoundRows();
      paint();
    });

    if (api.onSettingsChanged) {
      api.onSettingsChanged(function (payload) {
        if (payload && payload.settings) {
          state.settings = payload.settings;
          paint();
          applyTheme();
          if (payload.changed && payload.changed.indexOf("soundCustom") >= 0) {
            // 自定义音色变了：缓存里没有就补一次（导入那条路径自己已经塞好了，不会重复解码）
            loadCustomSound();
          }
          if (payload.changed && payload.changed.indexOf("hotkey") >= 0) {
            toast("全局快捷键已改为 " + payload.settings.hotkey);
          }
        }
      });
    }

    if (api.onSystemTheme) {
      api.onSystemTheme(function (t) {
        state.sysDark = !!(t && t.dark);
        applyTheme();
      });
    }

    refreshWechat();
    refreshProxy();
    setInterval(refreshWechat, 20000);
  }

  boot();
})();

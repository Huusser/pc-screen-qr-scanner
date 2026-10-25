"use strict";

/**
 * 提示音 · 两个窗口共用
 *
 * 设置页（launcher.html）用它试听，取景框（overlay.html）用它出声 —— 同一个文件，
 * 所以"试听听到的"和"实机响的"必然一致，不会出现演示好听、装上不一样的情况。
 *
 * 预设音色全部是 WebAudio 现场合成，不打包任何音频文件：
 *   · 安装包不变大，也没有音频授权问题
 *   · 配方与 ui-preview/sound-candidates/render.py 一一对应（含等响度 trim）
 * 自定义音色是用户导入的文件，导入时解码 → 校验 → 归一 → 重编码成 16bit WAV 存盘，
 * 播放时走同一套 master 增益，所以音色之间的相对响度可控。
 */
(function (global) {
  var SR = 44100;

  // 所有预设的最终音量 = 配方增益 × trim × MASTER。
  // trim 是做等响度归一后的系数（让 6 个音色听起来一样响），MASTER 是绝对音量。
  // 0.18 下峰值落在 0.056~0.104，远不到削波，同时比原来写死的 0.07 稍响一点。
  var MASTER = 0.18;
  var PREVIEW_BOOST = 1.4;   // 试听时略放大：分辨音色要比"刚好能听见"再响一点
  var DEDUPE_MS = 320;       // 连续扫描反复命中时，同一音色不要连成一片

  // ---------------------------------------------------------------- 预设配方
  //
  // at/dur/tau 单位秒；gain 是配方内相对增益；trim 见上。
  // 改这里请同步改 render.py，否则试听页和实机就会不一致。

  var PRESETS = [
    {
      id: "blip", name: "经典扫码嘀", ms: 180, hint: "像扫码枪",
      trim: 0.4477,
      notes: [
        { freq: 1760, at: 0, dur: 0.1, tau: 0.03, gain: 1, wave: "sine" },
        { freq: 3520, at: 0, dur: 0.06, tau: 0.016, gain: 0.16, wave: "sine" }
      ]
    },
    {
      id: "twotone", name: "双音上行", ms: 280, hint: "最常见的成功音",
      trim: 0.3318,
      notes: [
        { freq: 1046.5, at: 0, dur: 0.09, tau: 0.045, gain: 0.85, wave: "sine" },
        { freq: 1568, at: 0.095, dur: 0.15, tau: 0.07, gain: 1, wave: "sine" },
        { freq: 3136, at: 0.095, dur: 0.07, tau: 0.03, gain: 0.12, wave: "sine" }
      ]
    },
    {
      id: "marimba", name: "马林巴轻敲", ms: 350, hint: "最耐听",
      trim: 0.299,
      notes: [
        { freq: 1318.5, at: 0, dur: 0.33, tau: 0.085, gain: 1, wave: "sine" },
        { freq: 2637, at: 0, dur: 0.18, tau: 0.04, gain: 0.26, wave: "sine" },
        { freq: 3955.5, at: 0, dur: 0.09, tau: 0.02, gain: 0.09, wave: "sine" }
      ]
    },
    {
      id: "wood", name: "木质轻叩", ms: 150, hint: "最安静",
      trim: 1.3028,
      notes: [],
      tone: { freq: 470, at: 0, dur: 0.09, tau: 0.017, gain: 0.45, wave: "sine" },
      noise: [
        { at: 0, dur: 0.11, tau: 0.011, gain: 1, f0: 1150, q: 5 },
        { at: 0, dur: 0.09, tau: 0.009, gain: 0.55, f0: 2450, q: 7 }
      ]
    },
    {
      id: "bell", name: "清亮双叮", ms: 320, hint: "最像微信",
      trim: 0.2817,
      notes: [
        { freq: 1568, at: 0, dur: 0.3, tau: 0.1, gain: 1, wave: "sine" },
        { freq: 2093, at: 0, dur: 0.22, tau: 0.07, gain: 0.3, wave: "sine" },
        { freq: 2352, at: 0, dur: 0.16, tau: 0.05, gain: 0.13, wave: "sine" }
      ]
    },
    {
      id: "arpeggio", name: "三连上行琶音", ms: 440, hint: "最有仪式感",
      trim: 0.2883,
      notes: [
        { freq: 1046.5, at: 0, dur: 0.17, tau: 0.062, gain: 0.8, wave: "sine" },
        { freq: 1318.5, at: 0.065, dur: 0.18, tau: 0.068, gain: 0.85, wave: "sine" },
        { freq: 1568, at: 0.13, dur: 0.29, tau: 0.095, gain: 1, wave: "sine" },
        { freq: 3136, at: 0.13, dur: 0.09, tau: 0.035, gain: 0.1, wave: "sine" }
      ]
    }
  ];

  var byId = {};
  var idOrder = [];
  PRESETS.forEach(function (p) { byId[p.id] = p; idOrder.push(p.id); });

  var CUSTOM_ID = "custom";
  var DEFAULT_ID = "twotone";

  // ---------------------------------------------------------------- 运行时

  var ctx = null;
  var noiseBuf = null;
  var custom = null;          // { buffer, peak, name }
  var lastPlay = { id: "", at: 0 };
  var pending = null;         // 自定义音频解码中的 Promise

  function audioCtx() {
    if (ctx) return ctx;
    var C = global.AudioContext || global.webkitAudioContext;
    if (!C) return null;
    try { ctx = new C({ latencyHint: "interactive" }); } catch (e) {
      try { ctx = new C(); } catch (_) { return null; }
    }
    return ctx;
  }

  // 浏览器自动播放策略会把没在用户手势里创建的 AudioContext 挂起成 suspended，
  // 取景框是热键从主进程唤起的，没有手势，所以每次播放前都尝试恢复一次。
  function ensureRunning(c) {
    if (c.state === "running") return;
    try { c.resume(); } catch (_) {}
  }

  function noiseBuffer(c) {
    if (noiseBuf && noiseBuf.sampleRate === c.sampleRate) return noiseBuf;
    var n = Math.floor(c.sampleRate);
    var b = c.createBuffer(1, n, c.sampleRate);
    var d = b.getChannelData(0);
    for (var i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    noiseBuf = b;
    return b;
  }

  // 一个声部：振荡器 + 包络。setTargetAtTime 的 timeConstant 就是配方里的 tau，
  // 和 render.py 的 exp(-t/tau) 同一条曲线。
  function voice(c, dest, spec, trim, startAt) {
    var o = c.createOscillator();
    var g = c.createGain();
    var t = startAt + (spec.at || 0);
    var peak = Math.max(0.0002, (spec.gain || 1) * trim);
    o.type = spec.wave || "sine";
    o.frequency.value = spec.freq;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(peak, t + 0.004);
    g.gain.setTargetAtTime(0.0001, t + 0.004, Math.max(0.004, spec.tau || 0.03));
    o.connect(g); g.connect(dest);
    o.start(t);
    o.stop(t + (spec.dur || 0.1));
    o.onended = function () {
      try { o.disconnect(); g.disconnect(); } catch (_) {}
    };
  }

  function noiseVoice(c, dest, spec, trim, startAt) {
    var src = c.createBufferSource();
    var bp = c.createBiquadFilter();
    var g = c.createGain();
    var t = startAt + (spec.at || 0);
    src.buffer = noiseBuffer(c);
    src.loop = true;
    bp.type = "bandpass";
    bp.frequency.value = spec.f0;
    bp.Q.value = spec.q;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(Math.max(0.0002, (spec.gain || 1) * trim), t + 0.002);
    g.gain.setTargetAtTime(0.0001, t + 0.002, Math.max(0.003, spec.tau || 0.01));
    src.connect(bp); bp.connect(g); g.connect(dest);
    src.start(t);
    src.stop(t + (spec.dur || 0.1));
    src.onended = function () {
      try { src.disconnect(); bp.disconnect(); g.disconnect(); } catch (_) {}
    };
  }

  function playPreset(id, boost) {
    var c = audioCtx();
    if (!c) return false;
    var p = byId[id];
    if (!p) return false;
    ensureRunning(c);

    var bus = c.createGain();
    bus.gain.value = MASTER * (boost || 1);
    bus.connect(c.destination);

    var t0 = c.currentTime + 0.02;
    var end = 0;
    (p.notes || []).forEach(function (n) {
      voice(c, bus, n, p.trim, t0);
      end = Math.max(end, (n.at || 0) + (n.dur || 0));
    });
    if (p.tone) {
      voice(c, bus, p.tone, p.trim, t0);
      end = Math.max(end, (p.tone.at || 0) + (p.tone.dur || 0));
    }
    (p.noise || []).forEach(function (n) {
      noiseVoice(c, bus, n, p.trim, t0);
      end = Math.max(end, (n.at || 0) + (n.dur || 0));
    });

    // 收尾：等声音放完再断开总线，别让节点一直挂在 destination 上
    setTimeout(function () {
      try { bus.disconnect(); } catch (_) {}
    }, (end + 0.6) * 1000);
    return true;
  }

  function playCustom(boost) {
    if (!custom || !custom.buffer) return false;
    var c = audioCtx();
    if (!c) return false;
    ensureRunning(c);

    var src = c.createBufferSource();
    var g = c.createGain();
    // 导入时已经把峰值归一到 0.9，这里按 0.10 的目标峰值折算，
    // 和预设的 0.056~0.104 落在同一量级；peak 存下来是为了兼容历史文件。
    var peak = custom.peak > 0 ? custom.peak : 0.9;
    g.gain.value = (0.10 / peak) * (boost || 1);
    src.buffer = custom.buffer;
    src.connect(g); g.connect(c.destination);
    src.start();
    src.onended = function () {
      try { src.disconnect(); g.disconnect(); } catch (_) {}
    };
    return true;
  }

  /**
   * 播放。opts.force 用于设置页试听（不受 320ms 去重限制）。
   * 返回 false 表示"没播"，调用方不必处理。
   */
  function play(id, opts) {
    var o = opts || {};
    var want = id || DEFAULT_ID;
    if (want === CUSTOM_ID && (!custom || !custom.buffer)) want = DEFAULT_ID;  // 没导入就退回默认
    if (!byId[want] && want !== CUSTOM_ID) want = DEFAULT_ID;

    var now = Date.now();
    if (!o.force && lastPlay.id === want && now - lastPlay.at < DEDUPE_MS) return false;
    lastPlay = { id: want, at: now };

    return want === CUSTOM_ID ? playCustom(o.boost) : playPreset(want, o.boost);
  }

  function preview(id) {
    return play(id, { force: true, boost: PREVIEW_BOOST });
  }

  // ---------------------------------------------------------------- 导入
  //
  // 两步：主进程按文件头识别格式（不信扩展名），这里再用浏览器解码器真解一次。
  // 解出来才算"能用"——格式表只能说明"大概支持"，最终以解码结果为准。

  function b64ToBytes(b64) {
    var s = global.atob(b64);
    var n = s.length;
    var out = new Uint8Array(n);
    for (var i = 0; i < n; i++) out[i] = s.charCodeAt(i);
    return out;
  }

  function bytesToB64(bytes) {
    var CH = 0x8000, out = [];
    for (var i = 0; i < bytes.length; i += CH) {
      out.push(String.fromCharCode.apply(null, bytes.subarray(i, i + CH)));
    }
    return global.btoa(out.join(""));
  }

  function encodeWav(chans, sampleRate) {
    var ch = chans.length;
    var frames = chans[0].length;
    var dataBytes = frames * ch * 2;
    var buf = new ArrayBuffer(44 + dataBytes);
    var v = new DataView(buf);
    var wr = function (off, s) { for (var i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };
    wr(0, "RIFF"); v.setUint32(4, 36 + dataBytes, true); wr(8, "WAVE");
    wr(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, ch, true);
    v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * ch * 2, true);
    v.setUint16(32, ch * 2, true); v.setUint16(34, 16, true);
    wr(36, "data"); v.setUint32(40, dataBytes, true);

    var off = 44;
    for (var i = 0; i < frames; i++) {
      for (var c = 0; c < ch; c++) {
        var s = Math.max(-1, Math.min(1, chans[c][i]));
        v.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
        off += 2;
      }
    }
    return buf;
  }

  /**
   * 把任意可解码的音频转成 16bit WAV（44.1kHz，最多双声道，峰值归一 0.9）。
   * 好处：① 解码这一步就把"能不能用"验证了；② 存下来的格式是确定的，
   * 以后播放不用再猜容器；③ 体积可控（截掉尾部静音）。
   */
  function decodeToWav(base64) {
    return Promise.resolve().then(function () {
      var bytes;
      try { bytes = b64ToBytes(base64); } catch (_) { throw new Error("文件内容读取失败"); }
      if (bytes.length < 64) throw new Error("文件太小，不像音频");
      var ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

      var oc;
      try { oc = new (global.OfflineAudioContext || global.webkitOfflineAudioContext)(1, 1, SR); } catch (_) {
        throw new Error("当前环境不支持音频解码");
      }
      return new Promise(function (res, rej) {
        // 回调式更稳：个别版本同时支持 Promise 和回调时会触发 AlreadyDecoded 报错
        var p = oc.decodeAudioData(ab, res, function (e) { rej(e || new Error("decode failed")); });
        if (p && typeof p.catch === "function") p.catch(function (e) { rej(e); });
      });
    }).then(function (buf) {
      var dur = buf.duration;
      if (!isFinite(dur) || dur < 0.04) throw new Error("音频不到 0.04 秒，听不出来");
      if (dur > 20) throw new Error("音频 " + dur.toFixed(1) + " 秒，超过 20 秒上限（提示音不宜过长）");

      var chCount = Math.min(2, buf.numberOfChannels);
      var chans = [];
      for (var c = 0; c < chCount; c++) chans.push(buf.getChannelData(c).slice(0));

      // 找峰值，顺便找最后一个有声样本 —— 尾部静音截掉，不然每次都要干等一截空气。
      // 峰值要跨所有声道找：只有右声道有内容的文件不算静音。
      var peak = 0, lastLoud = 0, thr = 0;
      for (var c0 = 0; c0 < chCount; c0++) {
        var d0 = chans[c0];
        for (var i = 0; i < d0.length; i++) {
          var a = Math.abs(d0[i]);
          if (a > peak) peak = a;
        }
      }
      if (peak < 0.0008) throw new Error("这段音频几乎是静音，导入后也听不到");
      thr = peak * 0.02;
      for (var j = chans[0].length - 1; j >= 0; j--) {
        var loud = false;
        for (var k = 0; k < chCount; k++) if (Math.abs(chans[k][j]) > thr) { loud = true; break; }
        if (loud) { lastLoud = j; break; }
      }
      var keep = Math.min(chans[0].length, lastLoud + Math.floor(buf.sampleRate * 0.25));
      keep = Math.max(keep, Math.floor(buf.sampleRate * 0.05));

      var gain = Math.min(0.9 / peak, 12);      // 太轻的素材最多放大 12 倍，免得把底噪拉起来
      var fadeIn = Math.floor(buf.sampleRate * 0.002);
      var fadeOut = Math.min(Math.floor(buf.sampleRate * 0.015), Math.floor(keep / 4));
      for (var c2 = 0; c2 < chCount; c2++) {
        var d = chans[c2];
        for (var n = 0; n < keep; n++) {
          var s = d[n] * gain;
          if (n < fadeIn) s *= n / fadeIn;
          if (n >= keep - fadeOut) s *= (keep - n) / fadeOut;
          d[n] = s;
        }
        chans[c2] = d.subarray(0, keep);
      }

      var wav = encodeWav(chans, buf.sampleRate);
      return {
        ok: true,
        wavBase64: bytesToB64(new Uint8Array(wav)),
        ms: Math.round((keep / buf.sampleRate) * 1000),
        peak: 0.9,
        channels: chCount,
        sampleRate: buf.sampleRate,
        trimmedMs: Math.round((buf.duration - keep / buf.sampleRate) * 1000)
      };
    }).catch(function (e) {
      var msg = (e && e.message) || String(e);
      if (/decode|Unable|EncodingError|NotSupported/i.test(msg)) {
        msg = "这段音频的内编码解不开（可能是损坏、加密或非音频流）";
      }
      return { ok: false, error: msg };
    });
  }

  /** 导入成功后把内存里的缓冲换掉，立刻就能试听，不用等下次开窗 */
  function setCustomFromWav(wavBase64, peak, name) {
    return decodeToWav(wavBase64).then(function (r) {
      if (!r.ok) return false;
      var bytes = b64ToBytes(r.wavBase64);
      var ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      var c = audioCtx();
      if (!c) return false;
      return new Promise(function (res) {
        var done = function (buf) {
          custom = { buffer: buf, peak: peak || r.peak, name: name || "自定义" };
          res(true);
        };
        var p = c.decodeAudioData(ab, done, function () { res(false); });
        if (p && typeof p.then === "function") p.then(done).catch(function () { res(false); });
      });
    });
  }

  function loadCustom(base64, peak, name) {
    if (!base64) return Promise.resolve(false);
    if (pending) return pending;
    pending = setCustomFromWav(base64, peak, name).then(function (ok) {
      pending = null;
      return ok;
    });
    return pending;
  }

  function hasCustom() { return !!(custom && custom.buffer); }

  /**
   * 诊断用：AudioContext 是否在 running。取景框没有用户手势，
   * 如果策略把它挂起，"设置了提示音却没声"就会很难查 —— 这个一眼能看出来。
   */
  function debugState() {
    var c = audioCtx();
    return {
      ctx: c ? c.state : "unavailable",
      sampleRate: c ? c.sampleRate : 0,
      custom: hasCustom()
    };
  }

  function nameOf(id) {
    if (id === CUSTOM_ID) return custom && custom.name ? custom.name : "自定义音色";
    return byId[id] ? byId[id].name : byId[DEFAULT_ID].name;
  }

  function list() {
    return PRESETS.map(function (p) {
      return { id: p.id, name: p.name, ms: p.ms, hint: p.hint };
    });
  }

  // 别处的 AudioContext 也要抢手势：第一次真正点击/按键时把上下文拉起来
  ["pointerdown", "keydown"].forEach(function (ev) {
    global.addEventListener(ev, function () {
      var c = audioCtx();
      if (c && c.state !== "running") { try { c.resume(); } catch (_) {} }
    }, true);
  });

  global.QRSound = {
    PRESETS: PRESETS,
    DEFAULT_ID: DEFAULT_ID,
    CUSTOM_ID: CUSTOM_ID,
    ids: idOrder,
    list: list,
    nameOf: nameOf,
    play: play,
    preview: preview,
    decodeToWav: decodeToWav,
    setCustomFromWav: setCustomFromWav,
    loadCustom: loadCustom,
    hasCustom: hasCustom,
    debugState: debugState
  };
})(window);

# -*- coding: utf-8 -*-
"""
生成「识别成功提示音」候选方案的可试听 WAV。

为什么用合成而不是找现成音频文件：
  1. 桌面端要保持零资源依赖（现在 overlay.js 里的 beep() 就是 WebAudio 现场合成，
     不打包任何音频文件），加 6 个 wav 会让安装包变大、还要处理授权。
  2. 合成出来的音色可以精确复刻到 WebAudio：正弦 + 包络 + 少量噪声，
     浏览器端用同样的配方表就能得到一样的声音，试听与实际触发不会「两回事」。

本脚本是配方的唯一真源，正式实现时把 RECIPES 原样搬进 sound.js 即可。
导出参数：44.1kHz / 16bit / 单声道；预览音量约为实际播放的 20 倍（只为听得清）。
"""
import json
import math
import os
import random
import struct
import wave

SR = 44100
MASTER = 1.40           # 预览音量，约为正式播放（0.07 × trim）的 20 倍，只为听得清
random.seed(20261023)   # 噪声可复现，方便对比


def osc(wave_name, freq, n, phase=0.0):
    """理想波形。WebAudio 的 sine / triangle 与这里一致。"""
    out = []
    w = 2 * math.pi * freq / SR
    for i in range(n):
        p = w * i + phase
        if wave_name == "triangle":
            # 三角波：8/π² * Σ (-1)^k sin((2k+1)p)/(2k+1)²，取到 7 次谐波足够
            v = 0.0
            for k in range(4):
                m = 2 * k + 1
                v += ((-1) ** k) * math.sin(m * p) / (m * m)
            out.append(v * 8 / (math.pi ** 2))
        else:
            out.append(math.sin(p))
    return out


def env(n, attack, tau):
    """短线性起音 + 指数衰减。快起音让确认显得利落，缓衰减不刺耳。"""
    a = max(1, int(attack * SR))
    out = []
    for i in range(n):
        g = (i / a) if i < a else 1.0
        out.append(g * math.exp(-(i / SR) / tau))
    return out


def biquad_bp(x, f0, q):
    """RBJ cookbook 带通，Direct Form I。"""
    w0 = 2 * math.pi * f0 / SR
    alpha = math.sin(w0) / (2 * q)
    b0, b1, b2 = alpha, 0.0, -alpha
    a0, a1, a2 = 1 + alpha, -2 * math.cos(w0), 1 - alpha
    b0, b1, b2, a1, a2 = b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0
    y = [0.0] * len(x)
    x1 = x2 = y1 = y2 = 0.0
    for i, xi in enumerate(x):
        yi = b0 * xi + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
        y[i] = yi
        x2, x1 = x1, xi
        y2, y1 = y1, yi
    return y


def add(buf, sig, start):
    off = int(start * SR)
    for i, v in enumerate(sig):
        j = off + i
        if j < len(buf):
            buf[j] += v


# ---------- 候选配方（正式实现时搬进 sound.js）----------

RECIPES = [
    {
        "id": "blip",
        "name": "经典扫码嘀",
        "en": "Scanner Blip",
        "total": 0.16,
        "primary": 1760,
        "notes": [
            {"freq": 1760.0, "at": 0.0, "dur": 0.10, "tau": 0.030, "gain": 1.00, "wave": "sine"},
            {"freq": 3520.0, "at": 0.0, "dur": 0.06, "tau": 0.016, "gain": 0.16, "wave": "sine"},
        ],
        "traits": "最短促的一声「嘀」，和超市、快递扫码枪同族。起音 2ms，尾巴 30ms 就收干净。",
        "scene": "连续扫多张、只想确认「扫到了」。存在感最低，但也最没有「成功」语气。",
        "pros": ["最短（160ms），密集扫描不烦", "辨识度最高，不看屏幕也知道成了"],
        "cons": ["单音缺少「完成」的收束感", "不像付款成功，仪式感为零"],
        "hint": "像扫码枪",
    },
    {
        "id": "twotone",
        "name": "双音上行",
        "en": "Rising Two-Tone",
        "total": 0.26,
        "primary": 1046,
        "notes": [
            {"freq": 1046.5, "at": 0.000, "dur": 0.090, "tau": 0.045, "gain": 0.85, "wave": "sine"},
            {"freq": 1568.0, "at": 0.095, "dur": 0.150, "tau": 0.070, "gain": 1.00, "wave": "sine"},
            {"freq": 3136.0, "at": 0.095, "dur": 0.070, "tau": 0.030, "gain": 0.12, "wave": "sine"},
        ],
        "traits": "C6 到 G6 上行纯五度，两段式。上行代表完成、下行代表失败，是通用听觉语汇。",
        "scene": "默认首选。扫码登录这种「扫一次、等一下、有结果」的节奏最贴合。",
        "pros": ["有明确的完成语气", "两段式比单音耐听，重复触发不刺"],
        "cons": ["比单音长 100ms，快速连扫时略拖", "高频偏多，耳机大音量下略亮"],
        "hint": "最常见的成功音",
    },
    {
        "id": "marimba",
        "name": "马林巴轻敲",
        "en": "Marimba Ding",
        "total": 0.33,
        "primary": 1318,
        "notes": [
            {"freq": 1318.5, "at": 0.0, "dur": 0.330, "tau": 0.085, "gain": 1.00, "wave": "sine"},
            {"freq": 2637.0, "at": 0.0, "dur": 0.180, "tau": 0.040, "gain": 0.26, "wave": "sine"},
            {"freq": 3955.5, "at": 0.0, "dur": 0.090, "tau": 0.020, "gain": 0.09, "wave": "sine"},
        ],
        "traits": "以 E6 为基音，叠二、三次泛音后快速衰减，形成木质琴键的物品感，不是电子嘟声。",
        "scene": "办公室、安静环境，或一天要扫很多次的长时间使用。",
        "pros": ["温暖不刺耳，长时间听不累", "有实体感，比纯正弦显质感"],
        "cons": ["能量偏低，笔记本小喇叭外放时偏闷", "音高柔和，嘈杂环境可能漏听"],
        "hint": "最耐听",
    },
    {
        "id": "wood",
        "name": "木质轻叩",
        "en": "Woodblock",
        "total": 0.13,
        "primary": 1150,
        "notes": [],
        "noise": [
            {"at": 0.0, "dur": 0.11, "tau": 0.011, "gain": 1.00, "f0": 1150.0, "q": 5.0},
            {"at": 0.0, "dur": 0.09, "tau": 0.009, "gain": 0.55, "f0": 2450.0, "q": 7.0},
        ],
        "tone": {"freq": 470.0, "at": 0.0, "dur": 0.09, "tau": 0.017, "gain": 0.45, "wave": "sine"},
        "traits": "极短噪声瞬态加两个共振峰，模拟轻敲木块。没有音高旋律，所以不会被当成音乐。",
        "scene": "开会中、共享屏幕、怕吵到同事，或者用户明确讨厌电子音。",
        "pros": ["最不打扰，几乎不可能腻", "短到只有 130ms"],
        "cons": ["音量小时容易漏听", "没有成功语义，纯粹是「动了一下」的提示"],
        "hint": "最安静",
    },
    {
        "id": "bell",
        "name": "清亮双叮",
        "en": "Bell Ding",
        "total": 0.30,
        "primary": 1568,
        "notes": [
            {"freq": 1568.0, "at": 0.0, "dur": 0.300, "tau": 0.100, "gain": 1.00, "wave": "sine"},
            {"freq": 2093.0, "at": 0.0, "dur": 0.220, "tau": 0.070, "gain": 0.30, "wave": "sine"},
            {"freq": 2352.0, "at": 0.0, "dur": 0.160, "tau": 0.050, "gain": 0.13, "wave": "sine"},
        ],
        "traits": "G6 加 C7，再叠一个 1.5 倍的非整数泛音做铃的金属感。国内用户最熟悉的提示音语汇。",
        "scene": "面向普通用户、希望一听就知道是提示；外放音量小也能听清。",
        "pros": ["高频足，小喇叭和嘈杂环境最清楚", "亲和、熟悉，不需要学习成本"],
        "cons": ["容易和微信、QQ 消息音混淆", "高频密集触发时最刺耳"],
        "hint": "最像微信",
    },
    {
        "id": "arpeggio",
        "name": "三连上行琶音",
        "en": "Triad Arpeggio",
        "total": 0.42,
        "primary": 1046,
        "notes": [
            {"freq": 1046.5, "at": 0.000, "dur": 0.170, "tau": 0.062, "gain": 0.80, "wave": "sine"},
            {"freq": 1318.5, "at": 0.065, "dur": 0.180, "tau": 0.068, "gain": 0.85, "wave": "sine"},
            {"freq": 1568.0, "at": 0.130, "dur": 0.290, "tau": 0.095, "gain": 1.00, "wave": "sine"},
            {"freq": 3136.0, "at": 0.130, "dur": 0.090, "tau": 0.035, "gain": 0.10, "wave": "sine"},
        ],
        "traits": "C6-E6-G6 大三和弦琶音，三个音依次进来。完成感最强，像系统级的收尾提示。",
        "scene": "一天只扫几次（比如扫码登录），需要明确知道这一步真的结束了。",
        "pros": ["完成感最强，有仪式感", "三音有层次，不容易和别的音效撞"],
        "cons": ["420ms 最长，连扫时会互相盖住", "偏音效，有人会觉得吵而直接关掉"],
        "hint": "最有仪式感",
    },
]


def loudness_trim(samples, target_rms=0.16, ceiling=0.95):
    """
    按「最响的 50ms 窗口 RMS」对齐响度，再返回补偿系数。
    不这么做的话，等 peak 归一的结果是：木叩听起来几乎没声、双叮震耳朵。
    这个 trim 会写进配方，正式播放时按 trim × master 播放，保证试听与实机一致。
    """
    win = int(0.05 * SR)
    best = 0.0
    for i in range(0, max(1, len(samples) - win), win // 2 or 1):
        seg = samples[i:i + win]
        if not seg:
            continue
        rms = math.sqrt(sum(v * v for v in seg) / len(seg))
        best = max(best, rms)
    if best <= 1e-9:
        return 1.0
    trim = target_rms / best
    peak = max(max(samples), -min(samples))
    if peak * trim > ceiling:
        trim = ceiling / peak
    return trim


def render(recipe):
    """MASTER=1.0 渲染 -> 量响度 -> 乘 trim 再乘预览音量。"""
    n = int(recipe["total"] * SR) + int(0.02 * SR)
    buf = [0.0] * n
    for note in recipe.get("notes", []):
        cnt = int(note["dur"] * SR)
        sig = osc(note["wave"], note["freq"], cnt)
        e = env(cnt, 0.003, note["tau"])
        add(buf, [s * g * note["gain"] for s, g in zip(sig, e)], note["at"])
    tone = recipe.get("tone")
    if tone:
        cnt = int(tone["dur"] * SR)
        sig = osc(tone["wave"], tone["freq"], cnt)
        e = env(cnt, 0.002, tone["tau"])
        add(buf, [s * g * tone["gain"] for s, g in zip(sig, e)], tone["at"])
    for nz in recipe.get("noise", []):
        cnt = int(nz["dur"] * SR)
        raw = [random.uniform(-1, 1) for _ in range(cnt)]
        filt = biquad_bp(raw, nz["f0"], nz["q"])
        e = env(cnt, 0.001, nz["tau"])
        add(buf, [s * g * nz["gain"] for s, g in zip(filt, e)], nz["at"])
    # 20ms 尾巴淡出，避免爆音
    fade = int(0.02 * SR)
    for i in range(min(fade, n)):
        buf[n - 1 - i] *= i / fade
    trim = loudness_trim(buf)
    return [max(-1.0, min(1.0, v * trim * MASTER)) for v in buf], trim


def write_wav(path, samples):
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(b"".join(struct.pack("<h", int(v * 32767)) for v in samples))


def wave_polyline(samples, width=150, height=36):
    """
    给试听页画包络折线：每列取该段绝对值峰值，再按本条最大值归一。
    不归一的话短促的音（木叩）会被压成一条几乎看不见的横线，看不出形状。
    """
    step = max(1, len(samples) // width)
    amps = []
    for x in range(width):
        seg = samples[x * step:(x + 1) * step] or [0.0]
        amps.append(max(max(seg), -min(seg)))
    top = max(amps) or 1.0
    amps = [a / top for a in amps]

    half = height / 2 - 1
    pts = []
    for x, a in enumerate(amps):
        pts.append(f"{x},{height / 2 - a * half:.1f}")
    for x in range(width - 1, -1, -1):
        pts.append(f"{x},{height / 2 + amps[x] * half:.1f}")
    return " ".join(pts)


HTML = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>提示音候选方案 · 试听</title>
<style>
  :root {
    --bg:#0c1017; --panel:#141a23; --panel-2:#18202c; --line:rgba(255,255,255,.075);
    --line-2:rgba(255,255,255,.14); --txt:#e9eef7; --dim:#8a97ac; --dimmer:#5f6d82;
    --accent:#3b82f6; --ok:#34d399; --warn:#fbbf24; --bad:#f87171;
    --hover:rgba(255,255,255,.06);
  }
  * { box-sizing: border-box; }
  body {
    margin:0; padding:26px 22px 40px; background:var(--bg); color:var(--txt);
    font:14px/1.6 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
    -webkit-font-smoothing:antialiased;
  }
  .wrap { max-width:760px; margin:0 auto; }
  h1 { font-size:19px; margin:0 0 6px; letter-spacing:.2px; }
  .sub { color:var(--dim); font-size:12.5px; margin-bottom:20px; }
  .sub b { color:var(--txt); font-weight:600; }
  .card {
    background:var(--panel); border:1px solid var(--line); border-radius:12px;
    padding:14px 16px 13px; margin-bottom:12px; cursor:pointer;
    transition:border-color .15s, background .15s, box-shadow .15s;
  }
  .card:hover { background:var(--panel-2); border-color:var(--line-2); }
  .card.sel { border-color:rgba(59,130,246,.55); box-shadow:0 0 0 1px rgba(59,130,246,.25) inset; }
  .top { display:flex; align-items:center; gap:12px; }
  .idx {
    width:26px; height:26px; flex:0 0 auto; border-radius:8px; display:flex;
    align-items:center; justify-content:center; font-size:12px; font-weight:600;
    background:rgba(59,130,246,.16); color:#b3cfff; border:1px solid rgba(59,130,246,.32);
  }
  .name { font-size:14.5px; font-weight:600; }
  .en { color:var(--dimmer); font-size:11.5px; margin-left:6px; font-weight:400; }
  .chips { display:flex; gap:6px; margin-left:auto; flex:0 0 auto; }
  .chip {
    font-size:11px; padding:2px 7px; border-radius:6px; color:var(--dim);
    background:rgba(255,255,255,.05); border:1px solid var(--line); white-space:nowrap;
  }
  .chip.hl { color:#b3cfff; background:rgba(59,130,246,.14); border-color:rgba(59,130,246,.3); }
  .mid { display:flex; align-items:center; gap:14px; margin-top:10px; }
  .wave { flex:1 1 auto; height:36px; display:block; }
  .wave polyline { fill:rgba(59,130,246,.22); stroke:#4f8ff5; stroke-width:1; }
  .card.sel .wave polyline { fill:rgba(59,130,246,.34); stroke:#6aa6ff; }
  .play {
    flex:0 0 auto; width:38px; height:34px; border-radius:9px; border:1px solid rgba(59,130,246,.4);
    background:rgba(59,130,246,.16); color:#cfe2ff; cursor:pointer; font-size:12px;
    display:flex; align-items:center; justify-content:center; transition:.14s;
  }
  .play:hover { background:rgba(59,130,246,.3); color:#fff; }
  .play.on { background:#3b82f6; border-color:#3b82f6; color:#fff; }
  .desc { margin-top:10px; font-size:12.8px; color:#c3ccdb; }
  .desc .k { color:var(--dimmer); margin-right:5px; }
  .row { display:flex; gap:16px; margin-top:7px; flex-wrap:wrap; }
  .pc { font-size:12px; color:var(--dim); }
  .pc i { font-style:normal; margin-right:5px; }
  .pc.good i { color:var(--ok); }
  .pc.bad i { color:var(--bad); }
  .foot {
    margin-top:18px; padding:12px 14px; border-radius:10px; font-size:12.4px; color:var(--dim);
    background:linear-gradient(180deg, rgba(59,130,246,.09), rgba(59,130,246,.03));
    border:1px solid rgba(59,130,246,.22);
  }
  .foot b { color:var(--txt); }
  .pick { color:var(--warn); font-weight:600; }

  /* ---- 设置页接入示意（静态）---- */
  .mock {
    margin-top:22px; padding:14px; border-radius:12px;
    background:var(--panel); border:1px solid var(--line);
  }
  .mock .cap { font-size:11.5px; color:var(--dimmer); margin-bottom:10px; }
  .mock .cap b { color:var(--txt); font-weight:600; }
  .mk-pane { background:#101720; border:1px solid var(--line); border-radius:9px; padding:2px 12px 10px; }
  .mk-row {
    display:flex; align-items:center; gap:10px; min-height:39px;
    border-bottom:1px solid var(--line);
  }
  .mk-row:last-child { border-bottom:0; }
  .mk-l { flex:1; min-width:0; font-size:11.8px; color:var(--txt); }
  .mk-l em { display:block; font-style:normal; font-size:9.8px; color:var(--dimmer); margin-top:2px; }
  .mk-btn {
    flex:0 0 auto; font:inherit; font-size:10.5px; line-height:1; padding:6px 9px; border-radius:7px;
    color:#b3cfff; background:rgba(59,130,246,.16); border:1px solid rgba(59,130,246,.4); cursor:pointer;
    display:inline-flex; align-items:center; gap:4px; white-space:nowrap;
  }
  .mk-btn:hover { background:rgba(59,130,246,.28); color:#fff; }
  .mk-sw {
    flex:0 0 auto; width:34px; height:19px; border-radius:99px; background:#3b82f6; position:relative;
  }
  .mk-sw i {
    position:absolute; top:2px; right:2px; width:15px; height:15px; border-radius:50%;
    background:#fff; display:block;
  }
  .mk-sel {
    flex:0 0 auto; font:inherit; font-size:10.5px; color:var(--txt); cursor:pointer;
    background:rgba(255,255,255,.05); border:1px solid var(--line-2); border-radius:7px;
    padding:6px 9px; display:inline-flex; align-items:center; gap:6px;
  }
  .mk-list { padding:4px 0 2px; }
  .mk-it {
    display:flex; align-items:center; gap:8px; padding:5px 8px; border-radius:7px;
    font-size:11px; color:var(--dim); cursor:pointer;
  }
  .mk-it:hover { background:var(--hover); color:var(--txt); }
  .mk-it.on { background:rgba(59,130,246,.14); color:#cfe2ff; }
  .mk-it .ck { width:12px; flex:0 0 12px; color:#3b82f6; font-size:10px; }
  .mk-it .nm { flex:1; }
  .mk-it .dur { font-size:9.8px; color:var(--dimmer); }
  .mk-it .sp { color:var(--dim); font-size:10px; }
</style>
</head>
<body>
<div class="wrap">
  <h1>识别成功提示音 · 6 个候选</h1>
  <div class="sub">
    点卡片试听（卡片本体也能点选，方便你告诉我选哪个）。全部是 <b>WebAudio 现场合成</b>，
    不打包任何音频文件，所以这些听起来就是装好之后的样子；预览音量约为实机播放的 20 倍。
  </div>
  __CARDS__
  __MOCK__
  <div class="foot">
    已选：<span class="pick" id="pick">还没选</span> ·
    回复「选 03」这样的编号就行，我再把选中的音色接进设置页：<b>提示音开关右侧加「试听」按钮</b>，
    并在它下面新增一行音色选择（6 选 1），改完立刻试听，配置照旧落 <b>settings.json</b>。
  </div>
</div>
<script>
  var cards = Array.prototype.slice.call(document.querySelectorAll('.card'));
  var audios = Array.prototype.slice.call(document.querySelectorAll('audio'));
  function stopAll(except) {
    audios.forEach(function (a) {
      if (a !== except) { a.pause(); a.currentTime = 0; }
    });
    document.querySelectorAll('.play').forEach(function (b) { b.classList.remove('on'); });
  }
  cards.forEach(function (card) {
    var audio = card.querySelector('audio');
    var btn = card.querySelector('.play');
    function play(e) {
      if (e) e.stopPropagation();
      stopAll(audio);
      audio.currentTime = 0;
      audio.play().then(function () { btn.classList.add('on'); }).catch(function () {});
    }
    btn.addEventListener('click', play);
    audio.addEventListener('ended', function () { btn.classList.remove('on'); });
    card.addEventListener('click', function () {
      cards.forEach(function (c) { c.classList.remove('sel'); });
      card.classList.add('sel');
      document.getElementById('pick').textContent = card.getAttribute('data-idx') + ' · ' + card.getAttribute('data-name');
      play();
    });
  });

  // ---- 设置页接入示意：点列表项也能试听，和上面卡片联动 ----
  var selIdx = 1;
  var mkVoice = document.getElementById('mkVoice');
  var mkItems = Array.prototype.slice.call(document.querySelectorAll('.mk-it'));
  function paintMock() {
    mkItems.forEach(function (it, i) {
      it.classList.toggle('on', i === selIdx);
      it.querySelector('.ck').textContent = i === selIdx ? '✓' : '';
    });
    mkVoice.textContent = mkItems[selIdx].querySelector('.nm').textContent;
  }
  function playIdx(i) {
    stopAll(audios[i]);
    audios[i].currentTime = 0;
    audios[i].play().catch(function () {});
  }
  mkItems.forEach(function (it, i) {
    it.addEventListener('click', function () { selIdx = i; paintMock(); playIdx(i); });
  });
  document.getElementById('mkTry').addEventListener('click', function () { playIdx(selIdx); });
  paintMock();
</script>
</body>
</html>
"""

CARD = """  <div class="card" data-idx="{idx}" data-name="{name}">
    <div class="top">
      <div class="idx">{idx}</div>
      <div><span class="name">{name}</span><span class="en">{en}</span></div>
      <div class="chips">
        <span class="chip">{ms}ms</span>
        <span class="chip">{freq}</span>
        <span class="chip hl">{hint}</span>
      </div>
    </div>
    <div class="mid">
      <svg class="wave" viewBox="0 0 148 36" preserveAspectRatio="none">
        <polyline points="{wave}"></polyline>
      </svg>
      <button class="play" title="试听">▶</button>
    </div>
    <div class="desc"><span class="k">音色</span>{traits}</div>
    <div class="desc"><span class="k">适合</span>{scene}</div>
    <div class="row">
      <div class="pc good"><i>＋</i>{pro}</div>
      <div class="pc bad"><i>－</i>{con}</div>
    </div>
    <audio preload="auto" src="{file}"></audio>
  </div>"""


MOCK = """  <div class="mock">
    <div class="cap">
      接入设置页后长这样 · <b>「试听」放在开关左边</b>，音色改成下面这行点开再选（默认收起，不占高度；
      展开时面板自己滚动，不挤压上下内容）。换音色或点试听都会立刻发声。静态示意，列表项可点，能试听。
    </div>
    <div class="mk-pane">
      <div class="mk-row">
        <div class="mk-l">识别成功时提示音<em>读到二维码立即播放，不影响其他提示</em></div>
        <button class="mk-btn" id="mkTry">▶ 试听</button>
        <div class="mk-sw"><i></i></div>
      </div>
      <div class="mk-row" style="border-bottom:0;min-height:36px">
        <div class="mk-l" style="color:var(--dim)">提示音音色</div>
        <button class="mk-sel"><span id="mkVoice">双音上行</span><span style="color:var(--dimmer)">▴</span></button>
      </div>
      <div class="mk-list">__ITEMS__</div>
    </div>
  </div>"""

MOCK_ITEM = """        <div class="mk-it" data-i="{i}">
          <span class="ck"></span>
          <span class="nm">{name}</span>
          <span class="dur">{ms}ms</span>
          <span class="sp">▶</span>
        </div>"""


def emit_html(items, path):
    cards = []
    for it in items:
        cards.append(CARD.format(
            idx=it["idx"], name=it["name"], en=it["en"], ms=it["ms"],
            freq=f'{it["primary"]} Hz',
            hint=it["hint"], wave=it["wave"], file=it["file"],
            traits=it["traits"], scene=it["scene"],
            pro="；".join(it["pros"]), con="；".join(it["cons"]),
        ))
    rows = "\n".join(
        MOCK_ITEM.format(i=i, name=it["name"], ms=it["ms"])
        for i, it in enumerate(items)
    )
    html = HTML.replace("__CARDS__", "\n".join(cards)).replace("__MOCK__", MOCK.replace("__ITEMS__", rows))
    with open(path, "w", encoding="utf-8") as f:
        f.write(html)


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    out = []
    for i, r in enumerate(RECIPES, 1):
        path = os.path.join(here, f"{i:02d}-{r['name']}.wav")
        s, trim = render(r)
        write_wav(path, s)
        r2 = dict(r)
        r2["idx"] = f"{i:02d}"
        r2["file"] = os.path.basename(path)
        r2["ms"] = round(len(s) / SR * 1000)
        r2["wave"] = wave_polyline(s)
        r2["trim"] = round(trim, 4)
        r2["peak"] = round(max(max(s), -min(s)), 3)
        out.append(r2)
        print(f"{i:02d} {r['name']}: {r2['ms']}ms trim={r2['trim']} peak={r2['peak']} -> {os.path.basename(path)}")
    with open(os.path.join(here, "recipes.json"), "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    emit_html(out, os.path.join(here, "提示音试听.html"))
    print("page -> 提示音试听.html")


if __name__ == "__main__":
    main()

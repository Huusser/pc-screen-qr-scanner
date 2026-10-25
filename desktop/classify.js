/**
 * 码型判别 v2：把解码结果归类，并给出「电脑能否替代手机」的结论 + 可直接执行的动作。
 * 浏览器与 Electron 渲染进程共用（window.classifyCode）。
 *
 * 关键事实（决定结论对错，不要凭直觉改）：
 * 1) 微信 3.9.11 for Windows+ / 4.0.0 for Mac+ 起，网站应用发起登录时，
 *    若本机微信已登录且未锁屏，会优先提供「快速登录」——不需要扫码。
 *    技术上是网页经 https://localhost.weixin.qq.com:14013 与本地微信通信。
 *    => qrconnect 类码在 PC 上「可以」完成，前提是本机有已登录的微信。
 * 2) 公众号网页授权（oauth2/authorize）只能在微信内置浏览器里拿到 code，
 *    普通浏览器打开会提示「请在微信客户端打开」。
 * 3) 小程序 openid 与设备无关（同一微信账号在 PC/手机拿到同一个 openid），
 *    所以「PC 端打开小程序」这件事本身就已经具备微信身份。
 */
(function (root) {
  "use strict";

  var ACTION = {
    WECHAT_FAST: "wechat-fast",   // 用浏览器打开，走微信快捷登录（免扫码）
    OPEN_IN_WECHAT: "open-in-wechat", // 必须微信内置浏览器
    OPEN_BROWSER: "open-browser", // 普通浏览器打开即可
    WAKE_WECHAT: "wake-wechat",   // 唤起微信 / 小程序
    COPY_ONLY: "copy-only",       // 只需要复制取值
    NONE: "none"
  };

  function isWechatReady(env) {
    return !!(env && (env.fastLogin || env.wechatRunning));
  }

  /**
   * 哪些码型「在 PC 原生环境下大概率领不到结果」，需要把 UA 伪装成手机微信。
   * 这个标记只影响 UI 把哪个按钮做成主按钮，不会自动启动任何东西 ——
   * 是否启用代理永远由用户当场决定。
   */
  var MOBILE_KINDS = {
    wxoauth: "服务端按 UA 分流，PC 版会落到「请在微信客户端打开」或直接 404。",
    wxconfirm: "确认页会按设备类型给不同入口，PC 入口常要求手机扫码。",
    "self-scanqr": "实测这类系统（北森 91paas 等）按 UA 下发两套前端包：" +
      "结果页 /wxAuthResult/* 只在移动端包里注册，PC UA 打开就是「页面不存在」。" +
      "授权本身能过，卡在回跳后的结果页。",
    "bizurl-oauth": "带授权参数的页面普遍按 UA 分流，PC 分支可能没有对应路由。"
  };

  function classifyCodeRaw(text, env) {
    var t = (text || "").trim();
    env = env || {};
    var ready = isWechatReady(env);

    // ---- 1. 网站应用扫码登录（qrconnect）：可走快捷登录 ----
    if (/^https?:\/\/open\.weixin\.qq\.com\/connect\/qrconnect/i.test(t)) {
      return {
        kind: "qrconnect",
        label: "微信网站应用登录（qrconnect）",
        verdict: ready ? "good" : "warn",
        verdictText: ready ? "能，走快捷登录，不用手机" : "先登录 PC 微信",
        action: ACTION.WECHAT_FAST,
        actionText: "用微信快捷登录",
        steps: [
          "点下面的按钮，用浏览器打开这条登录链接",
          "若浏览器弹出「允许访问本地网络/设备」提示，点允许（Chrome 142+ 必须）",
          "登录框会自动认出头像，显示「微信快捷登录」",
          "点自己的头像确认，全程不扫码"
        ],
        tip: ready
          ? "这条不用手机。检测到你的 PC 微信已登录，且快速登录通道（端口 14013）在监听。" +
            "在浏览器里打开后，微信会主动把二维码换成「当前账号快捷登录」，点头像即完成。"
          : "没检测到可用的快捷登录通道（需要 Windows 微信 3.9.11 以上且处于登录状态）。" +
            "先打开并登录 PC 微信，再点按钮重试。"
      };
    }

    // ---- 2. 公众号网页授权：只能在微信内置浏览器里完成 ----
    if (/^https?:\/\/open\.weixin\.qq\.com\/connect\/oauth2\/authorize/i.test(t)) {
      return {
        kind: "wxoauth",
        label: "公众号网页授权（oauth2/authorize）",
        verdict: "warn",
        verdictText: "只能在微信内打开",
        action: ACTION.OPEN_IN_WECHAT,
        actionText: "复制并唤起微信",
        steps: [
          "点「复制并唤起微信」：链接进剪贴板，微信弹到前台",
          "打开「文件传输助手」，粘贴发送",
          "在聊天里点开这条链接（走微信内置浏览器，自带登录态）"
        ],
        tip: "这个链接在普通浏览器里打开只会提示「请在微信客户端打开」。必须让它运行在微信内置浏览器中，" +
          "才会有你的微信登录态。走文件传输助手是最稳的方式。"
      };
    }

    // ---- 3. 微信确认页 ----
    if (/^https?:\/\/(mp|lp\.open|login)\.weixin\.qq\.com\//i.test(t)) {
      return {
        kind: "wxconfirm",
        label: "微信登录确认页",
        verdict: "warn",
        verdictText: "试一次，可能被拦",
        action: ACTION.OPEN_BROWSER,
        actionText: "浏览器打开试试",
        steps: ["点按钮在浏览器打开", "若页面要求手机确认，此码无法用 PC 替代"],
        tip: "这类页面通常要求「一台已登录微信的移动端」点确认。可以先在浏览器打开试一次，" +
          "如果直接出现确认按钮就能过；若提示用手机扫，说明服务端强制校验移动端，此码无解。"
      };
    }

    // ---- 4. 微信 scheme / URL Link ----
    if (/^weixin:\/\//i.test(t)) {
      return {
        kind: "scheme",
        label: "微信内部链接（scheme / URL Link）",
        verdict: ready ? "good" : "warn",
        verdictText: ready ? "能，直接唤起" : "需先登录微信",
        action: ACTION.WAKE_WECHAT,
        actionText: "唤起微信打开",
        steps: ["点按钮唤起微信", "若提示需要手机确认，则此码强制移动端"],
        tip: "这是微信的深链，会直接用本机微信打开对应页面或小程序，携带你当前的微信身份。" +
          "如果唤起后仍然要求扫码，说明业务侧强制校验移动端。"
      };
    }

    // ---- 4.5 自建扫码登录（北森 zhiye / 91paas 及同型系统）----
    // 实测（2026-10-22，<tenant>.zhiye.com）：二维码内容是自有域名的
    //   https://<租户>.zhiye.com/api/Login/ScanQR?key=xx&userId=0
    // 普通 UA 访问被拒（「查看方式有误 / 请前往微信进行查看」）；
    // 微信 UA 下 302 → NewPortalWechat/authorize
    //      → open.weixin.qq.com/connect/oauth2/authorize（公众号网页授权）。
    // => 身份由「打开它的浏览器」提供。PC 微信 4.x 内置浏览器同样支持网页授权，
    //    所以不需要手机：把链接发到文件传输助手点开，即可完成确认。
    if (/\/login\/scanqr\b/i.test(t)) {
      return {
        kind: "self-scanqr",
        label: "自建扫码登录（北森等 SaaS）",
        verdict: "warn",
        verdictText: ready ? "能，但要换成手机环境" : "先登录 PC 微信再操作",
        action: ACTION.OPEN_IN_WECHAT,
        actionText: "在微信里打开",
        steps: [
          "点「手机环境打开」→ 选「模拟手机微信」",
          "代理起好后链接自动进剪贴板，微信被唤到前台，取景框自动收起",
          "在「文件传输助手」里粘贴发送 → 点开这条链接",
          "授权完成后会自动回到结果页；若仍 404，说明代理没生效，换「兼容模式」重试"
        ],
        tip: ready
          ? "身份由「打开它的浏览器」提供，这点没问题。真正的坑在回跳之后：" +
            "这类系统（北森 91paas 实测）按 UA 下发两套前端包，" +
            "/wxAuthResult/success|timeout|fail 这些结果路由只注册在移动端包里，" +
            "PC UA 打开就是「页面不存在，请点击导航菜单查看其他页面信息」。" +
            "所以需要把微信内置浏览器的 UA 临时改成 Android 微信。"
          : "流程要在微信内置浏览器里完成。先打开并登录 PC 微信，再重新扫一次。"
      };
    }

    // ---- 5. 普通链接 ----
    if (/^https?:\/\//i.test(t)) {
      var looksOAuth = /[?&](redirect_uri|code|state|ticket|scene)=/i.test(t);
      var isWxDomain = /weixin\.qq\.com|wechat\.com/i.test(t);

      if (looksOAuth || isWxDomain) {
        return {
          kind: "bizurl-oauth",
          label: "带授权参数的链接",
          verdict: ready ? "good" : "warn",
          verdictText: ready ? "有机会，用微信登录" : "先登录 PC 微信",
          action: ready ? ACTION.WECHAT_FAST : ACTION.OPEN_BROWSER,
          actionText: ready ? "用微信快捷登录" : "浏览器打开",
          steps: [
            "点按钮在浏览器打开",
            "若页面出现「微信快捷登录 / 快捷登录」，点头像确认",
            "若只显示二维码，改成发到文件传输助手，用微信内置浏览器打开"
          ],
          tip: "链接里带授权参数，说明它要把你的微信身份交给服务端。优先试快捷登录；" +
            "不出现快捷登录时退回微信内置浏览器（自带登录态）。"
        };
      }

      return {
        kind: "bizurl",
        label: "业务链接",
        verdict: "good",
        verdictText: "能读出来，按下面走",
        action: ACTION.OPEN_BROWSER,
        actionText: "浏览器打开",
        steps: [
          "先在浏览器打开，看它要什么",
          "要微信身份 → 发到文件传输助手，在微信里点开",
          "只要 token → 直接复制粘贴到绑定输入框"
        ],
        tip: "这条链接本身能直接访问。它是否还需要「手机确认」，取决于页面背后的业务逻辑：" +
          "要微信身份就让它跑在微信内置浏览器里；只要一个值就直接复制。" +
          "如果页面明确写着「请用手机微信扫描」，那是业务侧强制的，PC 端绕不过。"
      };
    }

    // ---- 6. 纯 token ----
    if (t.length <= 64 && /^[A-Za-z0-9_\-\/+=]+$/.test(t)) {
      return {
        kind: "token",
        label: "纯码值 / token",
        verdict: "good",
        verdictText: "最好的情况，直接用",
        action: ACTION.COPY_ONLY,
        actionText: "复制",
        steps: ["复制这串值", "粘贴到小程序/网页的绑定输入框"],
        tip: "码里只有一串 token，说明服务端只关心「谁提交了它」。" +
          "直接粘贴到绑定输入处即可，不需要任何微信端确认。"
      };
    }

    return {
      kind: "other",
      label: "未识别的码内容",
      verdict: "warn",
      verdictText: "需人工判断",
      action: ACTION.COPY_ONLY,
      actionText: "复制原文",
      steps: ["复制原文", "看它像链接、token 还是别的"],
      tip: "内容不是常见形态，先复制原文再人工判断用途。"
    };
  }

  // 统一挂上「是否需要手机环境」标记，避免每个分支里重复写
  function classifyCode(text, env) {
    var r = classifyCodeRaw(text, env);
    if (r) {
      r.needsMobile = !!MOBILE_KINDS[r.kind];
      r.mobileWhy = MOBILE_KINDS[r.kind] || "";
    }
    return r;
  }

  root.classifyCode = classifyCode;
  root.QR_ACTION = ACTION;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = classifyCode;
    module.exports.ACTION = ACTION;
  }
})(typeof window !== "undefined" ? window : this);

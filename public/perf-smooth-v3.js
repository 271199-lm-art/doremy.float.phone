// 流畅模式 v3 · 小手机聊天插件（apiVersion 1）
//
// 这一版在 v2 的基础上多了两样东西：
//   1) 极限档：可选关掉全站的 filter 与大面积阴影（这两项在 WebView 里同样很贵）
//   2) 屏幕角上的实时浮标：FPS / 最长卡顿 / 掉帧次数，直接看得见，方便截图
// 都是为了同一个目的：先量出到底是「绘制慢」还是「JS 卡住」，再对症下药。

const STYLE_ID = "perf-smooth-plugin-style";
const HUD_ID = "perf-smooth-hud";
const HTML_FLAG = "data-perf-smooth";

export default {
  manifest: {
    id: "perf-smooth",
    name: "流畅模式",
    apiVersion: 1,
    version: "3.0.0",
    author: "豆包",
    description:
      "关闭毛玻璃/滤镜/阴影与装饰动效、列表离屏不渲染，并在屏幕角上显示实时帧率与卡顿，用于定位全局卡顿来源。",
    permissions: ["ui"],
    settings: [
      { key: "blur", label: "关闭毛玻璃模糊", type: "boolean", default: true },
      { key: "anim", label: "关闭装饰动效与长过渡", type: "boolean", default: true },
      { key: "filter", label: "极限：关闭全站 filter（模糊/发光）", type: "boolean", default: true },
      { key: "shadow", label: "极限：关闭大面积阴影", type: "boolean", default: false },
      { key: "composer", label: "输入条独立合成层", type: "boolean", default: true },
      { key: "offscreen", label: "消息列表离屏不渲染", type: "boolean", default: true },
      { key: "hud", label: "屏幕角显示实时帧率浮标", type: "boolean", default: true },
    ],
  },
  setup(ctx) {
    const root = document.documentElement;

    const read = (key, fallback) => {
      try {
        const value = ctx.system.settings.get(key);
        return value === undefined || value === null ? fallback : value;
      } catch {
        return fallback;
      }
    };
    const log = (...args) => {
      try { ctx.system.log(...args); } catch { /* 日志不可用不影响主流程 */ }
    };

    root.setAttribute(HTML_FLAG, "1");

    let style = document.getElementById(STYLE_ID);
    if (!style) {
      style = document.createElement("style");
      style.id = STYLE_ID;
      document.head.appendChild(style);
    }

    const render = () => {
      const parts = [];
      if (read("blur", true)) {
        parts.push(
          `html[${HTML_FLAG}="1"]{--ui-blur:0px;--ui-blur-light:0px;--ui-blur-heavy:0px}`,
          `html[${HTML_FLAG}="1"] *{-webkit-backdrop-filter:none!important;backdrop-filter:none!important}`,
        );
      }
      if (read("filter", true)) {
        // filter 会为每个元素建一个离屏渲染层，动态内容一多就很贵。
        parts.push(`html[${HTML_FLAG}="1"] *{filter:none!important;-webkit-filter:none!important}`);
      }
      if (read("shadow", false)) {
        parts.push(`html[${HTML_FLAG}="1"] *{box-shadow:none!important;text-shadow:none!important}`);
      }
      if (read("anim", true)) {
        parts.push(
          `html[${HTML_FLAG}="1"] *{animation-duration:.001ms!important;animation-iteration-count:1!important;transition-duration:.05s!important}`,
        );
      }
      if (read("composer", true)) {
        parts.push(
          `html[${HTML_FLAG}="1"] .chat-input-bar{transform:translateZ(0);contain:layout style paint}`,
          `html[${HTML_FLAG}="1"] .chat-input-textarea{transform:translateZ(0);contain:layout paint style;touch-action:manipulation}`,
        );
      }
      if (read("offscreen", true)) {
        parts.push(
          `html[${HTML_FLAG}="1"] .chat-msg-wrapper{content-visibility:auto;contain-intrinsic-size:auto 140px}`,
        );
      }
      style.textContent = parts.join("\n");
    };
    render();

    let offSettings = null;
    try { offSettings = ctx.system.settings.onChange(() => render()); } catch { /* 忽略 */ }

    // ── 实时帧率浮标 ───────────────────────────────────────
    let hud = document.getElementById(HUD_ID);
    const ensureHud = () => {
      if (!read("hud", true)) {
        hud && hud.remove();
        return null;
      }
      if (!hud) {
        hud = document.createElement("div");
        hud.id = HUD_ID;
        hud.style.cssText = [
          "position:fixed",
          "right:8px",
          "top:96px",
          "z-index:2147483000",
          "padding:6px 9px",
          "border-radius:9px",
          "font:600 11px/1.35 -apple-system,system-ui,sans-serif",
          "color:#fff",
          "background:rgba(0,0,0,.62)",
          "pointer-events:none",
          "white-space:pre",
        ].join(";");
        (document.body || document.documentElement).appendChild(hud);
      }
      return hud;
    };

    let frames = 0;
    let windowStart = performance.now();
    let worstGap = 0;
    let lastFrame = performance.now();
    let totalDrops = 0;
    let rafId = 0;
    let lastReport = performance.now();

    const step = now => {
      const gap = now - lastFrame;
      lastFrame = now;
      if (gap > 50) {
        totalDrops += 1;
        if (gap > worstGap) worstGap = Math.round(gap);
      }
      frames += 1;

      // 每 1 秒刷新一次浮标
      if (now - windowStart >= 1000) {
        const fps = Math.round((frames * 1000) / (now - windowStart));
        const node = ensureHud();
        if (node) {
          node.textContent = `FPS ${fps}\n卡顿 ${totalDrops} 次 / 最长 ${worstGap}ms`;
        }
        // 每 30 秒汇总一行进日志
        if (now - lastReport >= 30000) {
          log(`帧率 ${fps}fps / 累计掉帧 ${totalDrops} 次 / 最长卡顿 ${worstGap}ms`);
          lastReport = now;
          totalDrops = 0;
          worstGap = 0;
        }
        frames = 0;
        windowStart = now;
      }
      rafId = requestAnimationFrame(step);
    };

    const startHud = () => {
      if (rafId) return;
      lastFrame = performance.now();
      windowStart = lastFrame;
      rafId = requestAnimationFrame(step);
    };
    const stopHud = () => {
      if (!rafId) return;
      cancelAnimationFrame(rafId);
      rafId = 0;
      const node = document.getElementById(HUD_ID);
      node && node.remove();
      hud = null;
    };

    ensureHud();
    startHud();
    const watchHud = window.setInterval(() => {
      if (read("hud", true)) {
        ensureHud();
        startHud();
      } else {
        stopHud();
      }
    }, 1500);

    return () => {
      window.clearInterval(watchHud);
      stopHud();
      try { offSettings && offSettings(); } catch { /* 忽略 */ }
      root.removeAttribute(HTML_FLAG);
      style && style.remove();
    };
  },
};

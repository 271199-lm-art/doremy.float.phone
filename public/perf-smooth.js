// 流畅模式 v2 · 小手机聊天插件（apiVersion 1）
//
// 做三件事：
//  1) 关掉大面积毛玻璃与装饰动效（WebView 里最贵的合成开销）
//  2) 消息列表离屏不渲染（content-visibility），长会话滚动/重绘大降
//  3) 在你操作时采样帧率，把「帧率 / 长卡顿次数 / 最长卡顿」写进插件日志
//     —— 用来判断到底是「渲染慢（帧率低）」还是「JS 阻塞（整段卡住）」
//
// 安装：聊天设置 →「扩展插件」→「导入插件」选本文件，或粘贴整段代码。

const STYLE_ID = "perf-smooth-plugin-style";
const HTML_FLAG = "data-perf-smooth";

export default {
  manifest: {
    id: "perf-smooth",
    name: "流畅模式",
    apiVersion: 1,
    version: "2.0.0",
    author: "豆包",
    description:
      "关闭毛玻璃与装饰动效、消息列表离屏不渲染，并采样帧率/卡顿写进日志，便于定位全局卡的来源。",
    permissions: ["ui"],
    settings: [
      { key: "blur", label: "关闭毛玻璃模糊（最有效）", type: "boolean", default: true },
      { key: "anim", label: "关闭装饰动效与长过渡", type: "boolean", default: true },
      { key: "composer", label: "输入条独立合成层", type: "boolean", default: true },
      { key: "offscreen", label: "消息列表离屏不渲染", type: "boolean", default: true },
      { key: "probe", label: "采样帧率与卡顿（写进插件日志）", type: "boolean", default: true },
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
        // 关键：把每条消息变成「离屏不参与布局/绘制」的容器。
        // 长会话里几十上百条消息时，这一步能直接砍掉大部分重排成本。
        parts.push(
          `html[${HTML_FLAG}="1"] .chat-msg-wrapper{content-visibility:auto;contain-intrinsic-size:auto 140px}`,
        );
      }
      style.textContent = parts.join("\n");
    };
    render();

    let offSettings = null;
    try { offSettings = ctx.system.settings.onChange(() => render()); } catch { /* 忽略 */ }

    // ── 采样：操作期间测 2 秒的帧间隔 ─────────────────────────
    // 帧率低 = 渲染/绘制太重；出现一次几百毫秒的空档 = JS 主线程被阻塞。
    let sampling = false;
    let batch = 0;
    let samples = [];

    const summarize = () => {
      const gaps = samples.slice();
      if (!gaps.length) return;
      const total = gaps.reduce((a, b) => a + b, 0);
      const avgFps = Math.round((gaps.length / total) * 1000);
      const longFrames = gaps.filter(g => g > 50).length;
      const worst = Math.round(Math.max.apply(null, gaps));
      batch += 1;
      log(`帧率 ${avgFps}fps / 掉帧 ${longFrames} 次 / 最长卡顿 ${worst}ms（第 ${batch} 批）`);
      samples = [];
    };

    const startSample = () => {
      if (sampling || read("probe", true) === false) return;
      sampling = true;
      samples = [];
      let last = performance.now();
      const deadline = last + 2000;
      const step = now => {
        if (now > deadline) {
          sampling = false;
          summarize();
          return;
        }
        samples.push(now - last);
        last = now;
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    };

    const onTouch = () => startSample();
    const onInput = event => {
      const target = event.target;
      if (!target || typeof target.closest !== "function") return;
      if (!target.closest("textarea, input[type=text]")) return;
      startSample();
    };

    document.addEventListener("touchstart", onTouch, { capture: true, passive: true });
    document.addEventListener("input", onInput, true);

    return () => {
      document.removeEventListener("touchstart", onTouch, { capture: true });
      document.removeEventListener("input", onInput, true);
      try { offSettings && offSettings(); } catch { /* 忽略 */ }
      root.removeAttribute(HTML_FLAG);
      style && style.remove();
    };
  },
};

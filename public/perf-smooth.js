// 流畅模式 · 小手机聊天插件（apiVersion 1）
//
// 作用：把「让 WebView 每次重绘都要重新合成的大面积毛玻璃」和装饰动效关掉，
// 并把聊天输入条独立成一个合成层。全是减法：不改数据、不改布局、不联网。
// 卸载后在 setup 返回的清理函数里全部还原。
//
// 安装：聊天设置 →「扩展插件」→「导入插件」（选本文件），或把整段代码粘贴进去。

const STYLE_ID = "perf-smooth-plugin-style";
const HTML_FLAG = "data-perf-smooth";

export default {
  manifest: {
    id: "perf-smooth",
    name: "流畅模式",
    apiVersion: 1,
    version: "1.1.0",
    author: "豆包",
    description:
      "关闭毛玻璃模糊与装饰动效、输入条独立合成层，降低 Android WebView 打字与滚动的重绘开销。",
    permissions: ["ui"],
    settings: [
      { key: "blur", label: "关闭毛玻璃模糊（最有效）", type: "boolean", default: true },
      { key: "anim", label: "关闭装饰动效与长过渡", type: "boolean", default: true },
      { key: "composer", label: "输入条独立合成层", type: "boolean", default: true },
      { key: "probe", label: "统计打字响应延迟（写进插件日志）", type: "boolean", default: true },
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
      style.textContent = parts.join("\n");
    };
    render();

    // 设置变更时立即重算样式
    let offSettings = null;
    try {
      offSettings = ctx.system.settings.onChange(() => render());
    } catch { /* 没有订阅能力就靠下次启用生效 */ }

    // 打字延迟自检：从 input 事件到两帧后真正画出来花了多久。
    // 只在日志里记录中位数，不打扰界面，用来判断还有没有别的东西在拖后腿。
    // 长任务探针：记录每次超过 150ms 的主线程阻塞，以及它的来源脚本。
    // 打字"中位数很稳但偶尔抽一下"就是这种长任务造成的。
    let longTaskObserver = null;
    const onLongTask = list => {
      for (const entry of list.getEntries()) {
        if (entry.duration < 150) continue;
        const attribution = (entry.attribution || [])
          .map(item => item.name || item.containerType || item.containerSrc || "?")
          .filter(Boolean)
          .join(", ");
        log(`长任务 ${Math.round(entry.duration)}ms 起始 ${Math.round(entry.startTime)}ms 来源 ${attribution || "未知"}`);
      }
    };
    try {
      if (typeof PerformanceObserver !== "undefined") {
        longTaskObserver = new PerformanceObserver(onLongTask);
        longTaskObserver.observe({ type: "longtask", buffered: false });
      }
    } catch { /* 环境不支持就算了 */ }

    let samples = [];
    let seq = 0;
    const onInput = event => {
      const target = event.target;
      if (!target || typeof target.closest !== "function") return;
      if (!target.closest("textarea, input[type=text]")) return;
      if (read("probe", true) === false) return;
      const t0 = performance.now();
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          samples.push(performance.now() - t0);
          if (samples.length < 20) return;
          const sorted = samples.slice().sort((a, b) => a - b);
          const median = Math.round(sorted[Math.floor(sorted.length / 2)]);
          const worst = Math.round(sorted[sorted.length - 1]);
          seq += 1;
          log(`打字响应 中位数 ${median}ms / 最慢 ${worst}ms（第 ${seq} 批）`);
          samples = [];
        });
      });
    };
    document.addEventListener("input", onInput, true);

    return () => {
      document.removeEventListener("input", onInput, true);
      try { longTaskObserver && longTaskObserver.disconnect(); } catch { /* 忽略 */ }
      try { offSettings && offSettings(); } catch { /* 忽略 */ }
      root.removeAttribute(HTML_FLAG);
      style && style.remove();
    };
  },
};

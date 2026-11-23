// 流畅模式 v5 · 小手机聊天插件（apiVersion 1）
//
// 和 v3/v4 的最大区别：**本版不改变任何外观**。
//   v3/v4 会关掉毛玻璃、动效、滤镜、阴影——那是"用观感换流畅"。
//   这一版把这些视觉改动全部撤销（装上升级后毛玻璃和动效会原样回来），
//   只保留两类东西：
//
//   1) 纯不可见的优化：输入条提升为独立合成层、图片延迟解码、
//      离屏的小组件页面不参与渲染。这些都不改可见区域的像素。
//   2) 诊断：长任务（>400ms 的主线程停顿）连同来源记进日志，
//      每 60 秒记一次 DOM 节点数 / iframe 数 / 图片数 / 内存。
//
// 目的：在"美化不动、插件全开"的前提下，先量清楚那 1 秒到底卡在谁身上。

const HUD_ID = "perf-smooth-hud";
const STYLE_ID = "perf-smooth-a11y-style";

export default {
  manifest: {
    id: "perf-smooth",
    name: "流畅模式",
    apiVersion: 1,
    version: "5.0.0",
    author: "豆包",
    description:
      "在不改变任何外观的前提下做不可见的渲染优化，并记录长任务来源与 DOM 规模，用于定位全局卡顿。",
    permissions: ["ui"],
    settings: [
      { key: "composer", label: "输入条独立合成层（不可见优化）", type: "boolean", default: true },
      { key: "imgdecode", label: "图片延迟解码（不可见优化）", type: "boolean", default: true },
      { key: "offscreenWidgets", label: "离屏小组件页面不渲染（不可见优化）", type: "boolean", default: true },
      { key: "diagnose", label: "记录长任务与环境快照（诊断用）", type: "boolean", default: true },
      { key: "hud", label: "屏幕角显示实时帧率浮标", type: "boolean", default: true },
    ],
  },
  setup(ctx) {
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
    const now = () => (typeof performance !== "undefined" && performance.now ? performance.now() : Date.now());

    // ── 不可见样式：只影响合成与渲染时机，不改可见像素 ────
    let style = document.getElementById(STYLE_ID);
    if (!style) {
      style = document.createElement("style");
      style.id = STYLE_ID;
      document.head.appendChild(style);
    }
    const renderStyle = () => {
      const parts = [];
      if (read("composer", true)) {
        parts.push(
          `.chat-input-bar{transform:translateZ(0);contain:layout style paint}`,
          `.chat-input-textarea{transform:translateZ(0);contain:layout paint style;touch-action:manipulation}`,
        );
      }
      if (read("imgdecode", true)) {
        parts.push(`img{content-visibility:auto}`);
      }
      if (read("offscreenWidgets", true)) {
        // 只作用于「非当前页」的桌面页容器，可见页完全不受影响。
        parts.push(
          `.desktop-page[aria-hidden="true"]{content-visibility:hidden;contain:strict}`,
          `.desktop-page[data-page-hidden="true"]{content-visibility:hidden;contain:strict}`,
        );
      }
      style.textContent = parts.join("\n");
    };
    renderStyle();

    let offSettings = null;
    try { offSettings = ctx.system.settings.onChange(() => renderStyle()); } catch { /* 忽略 */ }

    // 图片延迟解码：只补属性，不换图、不裁切。
    const patchImages = () => {
      if (!read("imgdecode", true)) return;
      try {
        const imgs = document.getElementsByTagName("img");
        for (let i = 0; i < imgs.length; i++) {
          const img = imgs[i];
          if (!img.getAttribute("decoding")) img.setAttribute("decoding", "async");
          if (!img.getAttribute("loading")) img.setAttribute("loading", "lazy");
        }
      } catch { /* 忽略 */ }
    };
    patchImages();

    let imgObserver = null;
    try {
      imgObserver = new MutationObserver(() => patchImages());
      imgObserver.observe(document.body || document.documentElement, { childList: true, subtree: true });
    } catch { /* 忽略 */ }

    // ── 环境快照 ───────────────────────────────────────────
    const snapshot = () => {
      let nodes = 0;
      let iframes = 0;
      let images = 0;
      try {
        nodes = document.getElementsByTagName("*").length;
        iframes = document.getElementsByTagName("iframe").length;
        images = document.getElementsByTagName("img").length;
      } catch { /* 忽略 */ }
      let mem = "";
      try {
        const m = performance.memory;
        if (m && m.usedJSHeapSize) mem = ` / 内存 ${Math.round(m.usedJSHeapSize / 1048576)}MB`;
      } catch { /* 忽略 */ }
      return `节点 ${nodes} / iframe ${iframes} / 图片 ${images}${mem}`;
    };

    // ── 长任务归因 ─────────────────────────────────────────
    let observer = null;
    let worstTask = 0;
    let worstTaskFrom = "";
    let lastLongTask = 0;
    let lastLongTaskFrom = "";
    let longTaskCount = 0;

    const describeAttribution = entry => {
      try {
        const list = entry.attribution || [];
        if (!list.length) return "主线程";
        const names = [];
        for (const a of list) {
          const type = a.containerType || "";
          if (type === "iframe" || a.containerId || a.containerSrc) {
            names.push(a.containerId ? `iframe#${a.containerId}` : "iframe");
          } else {
            names.push("主线程");
          }
        }
        return names.join("+") || "主线程";
      } catch {
        return "未知";
      }
    };

    const onEntry = entry => {
      const ms = Math.round(entry.duration || 0);
      const from = describeAttribution(entry);
      lastLongTask = ms;
      lastLongTaskFrom = from;
      longTaskCount += 1;
      if (ms > worstTask) {
        worstTask = ms;
        worstTaskFrom = from;
      }
      if (ms >= 400) log(`长任务 ${ms}ms · 来源 ${from} · 当时 ${snapshot()}`);
    };

    const startObserver = () => {
      if (observer) return;
      try {
        observer = new PerformanceObserver(list => {
          if (!read("diagnose", true)) return;
          for (const entry of list.getEntries()) onEntry(entry);
        });
        observer.observe({ entryTypes: ["longtask"] });
      } catch {
        observer = null;
        log("本机不支持 longtask 观测，仅保留帧率浮标");
      }
    };
    startObserver();

    // ── 实时帧率浮标 ───────────────────────────────────────
    let hud = document.getElementById(HUD_ID);
    const ensureHud = () => {
      if (!read("hud", true)) {
        hud && hud.remove();
        hud = null;
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
    let windowStart = now();
    let worstGap = 0;
    let lastFrame = now();
    let totalDrops = 0;
    let windowDrops = 0;
    let rafId = 0;
    let lastReport = now();
    let lastSnap = now();

    const step = t => {
      const gap = t - lastFrame;
      lastFrame = t;
      if (gap > 50) {
        totalDrops += 1;
        windowDrops += 1;
        if (gap > worstGap) worstGap = Math.round(gap);
      }
      frames += 1;

      if (t - windowStart >= 1000) {
        const fps = Math.round((frames * 1000) / (t - windowStart));
        const node = ensureHud();
        if (node) {
          const tail = read("diagnose", true) && lastLongTask
            ? `\n长任务 ${lastLongTask}ms ${lastLongTaskFrom}`
            : "";
          node.textContent = `FPS ${fps}\n卡顿 ${totalDrops} 次 / 最长 ${worstGap}ms${tail}`;
        }
        if (read("diagnose", true) && t - lastSnap >= 60000) {
          lastSnap = t;
          log(`环境 ${snapshot()} / 最近 1 分钟掉帧 ${windowDrops} 次 / 最慢帧 ${worstGap}ms`);
          windowDrops = 0;
        }
        if (t - lastReport >= 30000) {
          lastReport = t;
          log(
            `帧率 ${fps}fps / 累计掉帧 ${totalDrops} 次 / 最长卡顿 ${worstGap}ms / 长任务 ${longTaskCount} 次` +
              (worstTask ? ` / 最慢 ${worstTask}ms(${worstTaskFrom})` : ""),
          );
          totalDrops = 0;
          worstGap = 0;
          longTaskCount = 0;
        }
        frames = 0;
        windowStart = t;
      }
      rafId = requestAnimationFrame(step);
    };

    const startHud = () => {
      if (rafId) return;
      lastFrame = now();
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

    log(`已启用 v5（不改变外观）· ${snapshot()}`);

    return () => {
      window.clearInterval(watchHud);
      stopHud();
      try { observer && observer.disconnect(); } catch { /* 忽略 */ }
      try { imgObserver && imgObserver.disconnect(); } catch { /* 忽略 */ }
      try { offSettings && offSettings(); } catch { /* 忽略 */ }
      style && style.remove();
    };
  },
};

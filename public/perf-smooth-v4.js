// 流畅模式 v4 · 小手机聊天插件（apiVersion 1）
//
// v3 已经能测出「FPS 多少、卡了多久」，但测不出「卡在谁身上」。
// 这一版补上长任务归因 + 环境快照，并且会在真的卡爆时自动降级：
//
//   1) PerformanceObserver('longtask')：任何超过 100ms 的任务都会记进日志，
//      附带来源（主线程 / 同源 iframe / 跨域 iframe）——桌面上每个"自定义小组件"
//      都是一个 iframe，这条能直接指出是不是它们在拖后腿。
//   2) 环境快照：每 60 秒记一行 DOM 节点数 / iframe 数 / 图片数 / 内存占用，
//      节点数爆炸和"越用越卡"是同义词。
//   3) 自动降级：检测到单次 >400ms 的停顿，自动把阴影与 filter 也关掉（不用手动点）。
//   4) 浮标升级：多一行「最近一次长任务」的毫秒数与来源。

const STYLE_ID = "perf-smooth-plugin-style";
const HUD_ID = "perf-smooth-hud";
const HTML_FLAG = "data-perf-smooth";
const HTML_STALL = "data-perf-stall";

export default {
  manifest: {
    id: "perf-smooth",
    name: "流畅模式",
    apiVersion: 1,
    version: "4.0.0",
    author: "豆包",
    description:
      "关闭毛玻璃/滤镜/阴影与装饰动效、列表离屏不渲染；实时帧率浮标 + 长任务归因，并把卡顿来源记进运行日志。",
    permissions: ["ui"],
    settings: [
      { key: "blur", label: "关闭毛玻璃模糊", type: "boolean", default: true },
      { key: "anim", label: "关闭装饰动效与长过渡", type: "boolean", default: true },
      { key: "filter", label: "极限：关闭全站 filter（模糊/发光）", type: "boolean", default: true },
      { key: "shadow", label: "极限：关闭大面积阴影", type: "boolean", default: false },
      { key: "composer", label: "输入条独立合成层", type: "boolean", default: true },
      { key: "offscreen", label: "消息列表离屏不渲染", type: "boolean", default: true },
      { key: "diagnose", label: "记录长任务与环境快照（诊断用）", type: "boolean", default: true },
      { key: "autoheal", label: "卡爆时自动再降级一档", type: "boolean", default: true },
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
    const now = () => (typeof performance !== "undefined" && performance.now ? performance.now() : Date.now());

    root.setAttribute(HTML_FLAG, "1");

    let style = document.getElementById(STYLE_ID);
    if (!style) {
      style = document.createElement("style");
      style.id = STYLE_ID;
      document.head.appendChild(style);
    }

    // ── 自动降级状态：一旦触发，本会话内一直生效 ──────────
    let autoHealed = false;

    const render = () => {
      const forceLimit = autoHealed && read("autoheal", true);
      const parts = [];
      if (read("blur", true)) {
        parts.push(
          `html[${HTML_FLAG}="1"]{--ui-blur:0px;--ui-blur-light:0px;--ui-blur-heavy:0px}`,
          `html[${HTML_FLAG}="1"] *{-webkit-backdrop-filter:none!important;backdrop-filter:none!important}`,
        );
      }
      if (read("filter", true) || forceLimit) {
        // filter 会为每个元素建一个离屏渲染层，动态内容一多就很贵。
        parts.push(`html[${HTML_FLAG}="1"] *{filter:none!important;-webkit-filter:none!important}`);
      }
      if (read("shadow", false) || forceLimit) {
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
      root.setAttribute(HTML_STALL, forceLimit ? "1" : "0");
    };
    render();

    let offSettings = null;
    try { offSettings = ctx.system.settings.onChange(() => render()); } catch { /* 忽略 */ }

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
        if (m && m.usedJSHeapSize) {
          mem = ` / 内存 ${Math.round(m.usedJSHeapSize / 1048576)}MB`;
        }
      } catch { /* 忽略 */ }
      return `节点 ${nodes} / iframe ${iframes} / 图片 ${images}${mem}`;
    };

    // ── 长任务归因 ─────────────────────────────────────────
    let observer = null;
    let worstTask = 0;
    let worstTaskFrom = "";
    let lastLongTask = 0;
    let lastLongTaskFrom = "";

    const describeAttribution = entry => {
      try {
        const list = entry.attribution || [];
        if (!list.length) return "主线程";
        const names = [];
        for (const a of list) {
          const type = a.containerType || "";
          if (type === "iframe" || a.containerId || a.containerSrc) {
            names.push(a.containerId ? `iframe#${a.containerId}` : "iframe");
          } else if (type === "window" || type === "self") {
            names.push("主线程");
          } else {
            names.push(type || "主线程");
          }
        }
        return names.join("+") || "主线程";
      } catch {
        return "未知";
      }
    };

    const onLongTask = entry => {
      const ms = Math.round(entry.duration || 0);
      const from = describeAttribution(entry);
      lastLongTask = ms;
      lastLongTaskFrom = from;
      if (ms > worstTask) {
        worstTask = ms;
        worstTaskFrom = from;
      }
      if (ms >= 400) {
        log(`长任务 ${ms}ms · 来源 ${from} · 当时 ${snapshot()}`);
        // 一次性自动降级，避免反复改样式
        if (!autoHealed && read("autoheal", true)) {
          autoHealed = true;
          render();
          log("检测到严重停顿，已自动再降一档（关阴影与滤镜）");
        }
      }
    };

    const startObserver = () => {
      if (observer) return;
      try {
        observer = new PerformanceObserver(list => {
          if (!read("diagnose", true)) return;
          for (const entry of list.getEntries()) onLongTask(entry);
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
            `帧率 ${fps}fps / 累计掉帧 ${totalDrops} 次 / 最长卡顿 ${worstGap}ms` +
              (worstTask ? ` / 最长长任务 ${worstTask}ms(${worstTaskFrom})` : ""),
          );
          totalDrops = 0;
          worstGap = 0;
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

    log(`已启用 v4 · ${snapshot()}`);

    return () => {
      window.clearInterval(watchHud);
      stopHud();
      try { observer && observer.disconnect(); } catch { /* 忽略 */ }
      try { offSettings && offSettings(); } catch { /* 忽略 */ }
      root.removeAttribute(HTML_FLAG);
      root.removeAttribute(HTML_STALL);
      style && style.remove();
    };
  },
};

import { run, arm } from "./page.js";
import { canvasTool } from "./canvas.js";

// one rAF loop per page, only alive while a rule is active.
// it grabs the un-spied rAF so reflex ticks never show up as canvas frames.
const RUNTIME = `(() => {
  if (window.__wt_rf) return 1;
  const nativeRaf = (window.__wt_cv && window.__wt_cv.raf) || window.requestAnimationFrame;
  const rf = window.__wt_rf = { rules: {}, on: false };

  const CODES = { ' ': ['Space', 32], Enter: ['Enter', 13], Escape: ['Escape', 27], Tab: ['Tab', 9],
    ArrowLeft: ['ArrowLeft', 37], ArrowUp: ['ArrowUp', 38], ArrowRight: ['ArrowRight', 39], ArrowDown: ['ArrowDown', 40] };
  const press = (k, hold) => {
    if (k === 'Space') k = ' ';
    const c = CODES[k] || (/^[a-z]$/i.test(k) ? ['Key' + k.toUpperCase(), k.toUpperCase().charCodeAt(0)]
      : /^[0-9]$/.test(k) ? ['Digit' + k, k.charCodeAt(0)] : [k, 0]);
    const o = { key: k, code: c[0], keyCode: c[1], which: c[1], bubbles: true, cancelable: true };
    const tgt = document.activeElement || document.body;
    tgt.dispatchEvent(new KeyboardEvent('keydown', o));
    if (tgt !== document) document.dispatchEvent(new KeyboardEvent('keydown', o));
    setTimeout(() => {
      tgt.dispatchEvent(new KeyboardEvent('keyup', o));
      if (tgt !== document) document.dispatchEvent(new KeyboardEvent('keyup', o));
    }, hold);
  };
  const click = (el, x, y) => {
    if (x == null) { const b = el.getBoundingClientRect(); x = b.left + b.width / 2; y = b.top + b.height / 2; }
    const o = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, view: window, button: 0 };
    for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'])
      el.dispatchEvent(t.startsWith('pointer') ? new PointerEvent(t, o) : new MouseEvent(t, o));
  };
  const shown = (el) => {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none';
  };
  const isNew = (el, since) => {
    const rt = window.__wt_rt;
    if (!rt) return false;
    for (let n = el; n; n = n.parentElement) { const b = rt.born.get(n); if (b !== undefined) return b >= since; }
    return false;
  };
  const find = (r) => {
    for (const el of document.querySelectorAll(r.sel)) {
      if (r.enabled && (el.disabled || el.getAttribute('aria-disabled') === 'true')) continue;
      if (r.text && !((el.getAttribute('aria-label') || '') + ' ' + (el.value || '') + ' ' + el.textContent).toLowerCase().includes(r.text)) continue;
      if (r.onlyNew && !isNew(el, r.t0)) continue;
      if (shown(el)) return el;
    }
    return null;
  };
  const dist = (a, b) => (a && b) ? Math.hypot(a.x + a.w / 2 - b.x - b.w / 2, a.y + a.h / 2 - b.y - b.h / 2) : Infinity;
  const gap = (a, b) => (a && b) ? b.x - (a.x + a.w) : Infinity;
  const E = new Proxy({}, { get: (_, k) => {
    const cv = window.__wt_cv;
    if (!cv) return [];
    if (k === 'all') return cv.track('*', 2);
    if (k === 'moving') return cv.track('*', 2).filter((e) => Math.abs(e.vx) > 0.1 || Math.abs(e.vy) > 0.1);
    const sig = rf.names && rf.names[k];
    return sig ? cv.track(sig, 2) : [];
  } });

  const tick = () => {
    const now = performance.now();
    let live = 0;
    for (const id in rf.rules) {
      const r = rf.rules[id];
      if (r.done) continue;
      try {
        if (now - r.t0 > r.ttl) { r.done = 'ttl'; continue; }
        if (r.stop && document.querySelector(r.stop)) { r.done = 'stop_selector'; continue; }
        live++;
        if (now - r.last < r.cooldown) continue;
        rf.names = r.names;
        let el = null;
        if (r.sel) { el = find(r); if (!el) continue; }
        else if (!r.whenFn(E, dist, gap)) continue;
        const a = r.act;
        if (a.type === 'click') click(el);
        else if (a.type === 'click_xy') click(document.elementFromPoint(a.x, a.y) || document.body, a.x, a.y);
        else if (a.type === 'key') press(a.key, a.hold);
        else r.jsFn();
        r.hits++; r.last = now;
        if (r.hits >= r.max) { r.done = 'max_hits'; live--; }
      } catch (e) { r.done = 'error'; r.err = String((e && e.message) || e); }
    }
    if (live) nativeRaf.call(window, tick); else rf.on = false;
  };
  rf.add = (rule, whenFn, jsFn) => {
    rf.rules[rule.id] = Object.assign({}, rule, { t0: performance.now(), last: -1e9, hits: 0, done: null, err: null, whenFn, jsFn });
    if (!rf.on) { rf.on = true; nativeRaf.call(window, tick); }
  };
  rf.snap = () => {
    const now = performance.now();
    return Object.keys(rf.rules).map((id) => {
      const r = rf.rules[id];
      return { id, kind: r.sel ? 'dom' : 'canvas', hits: r.hits, done: r.done, error: r.err,
        last_hit_ms_ago: r.hits ? Math.round(now - r.last) : null, age_ms: Math.round(now - r.t0) };
    });
  };
  return 0;
})()`;

type Rule = {
  action: "add" | "remove" | "list" | "clear";
  id?: string;
  when?: { selector?: string; text?: string; only_new?: boolean; enabled?: boolean; canvas?: { names: Record<string, string | string[]>; js: string } };
  do?: { type: "click" | "click_xy" | "key" | "js"; x?: number; y?: number; key?: string; hold_ms?: number; code?: string };
  cooldown_ms?: number;
  max_hits?: number;
  ttl_ms?: number;
  stop_selector?: string;
};

let seq = 0;

export async function reflexTool(sess: any, a: Rule) {
  await arm(sess);
  await run(sess, RUNTIME);

  if (a.action === "list") return run(sess, "__wt_rf.snap()");
  if (a.action === "clear") {
    await run(sess, "(() => { for (const k in __wt_rf.rules) delete __wt_rf.rules[k]; })()");
    return { cleared: true };
  }
  if (a.action === "remove") {
    if (!a.id) throw new Error("id required");
    const had = await run(sess, `(() => { const had = ${JSON.stringify(a.id)} in __wt_rf.rules; delete __wt_rf.rules[${JSON.stringify(a.id)}]; return had; })()`);
    return { removed: had };
  }

  if (!a.when || !a.do) throw new Error("add needs both when and do");
  const w = a.when, d = a.do;
  const cv = w.canvas;
  if (!!w.selector === !!cv) throw new Error("when needs exactly one of selector or canvas");
  if (d.type === "click" && !w.selector) throw new Error("do.click only works with a selector trigger, use click_xy");
  if (d.type === "click_xy" && (d.x == null || d.y == null)) throw new Error("click_xy needs x and y");
  if (d.type === "key" && !d.key) throw new Error("key needs a key");
  if (d.type === "js" && !d.code) throw new Error("js needs code");

  const id = a.id || `r${++seq}`;
  const rule = {
    id,
    sel: w.selector || null,
    text: w.text ? w.text.toLowerCase() : null,
    onlyNew: Boolean(w.only_new),
    enabled: w.enabled !== false,
    names: cv?.names ?? null,
    act: { type: d.type, x: d.x, y: d.y, key: d.key, hold: d.hold_ms ?? 40 },
    cooldown: a.cooldown_ms ?? 100,
    max: a.max_hits ?? 50,
    ttl: Math.min(a.ttl_ms ?? 30000, 600000),
    stop: a.stop_selector || null,
  };

  if (cv) await canvasTool(sess, { action: "attach" });
  // fns go in as source so page CSP (no unsafe-eval) can't block them
  const whenFn = cv ? `(E, dist, gap) => (\n${cv.js}\n)` : "null";
  const jsFn = d.type === "js" ? `() => {\n${d.code}\n}` : "null";
  await run(sess, `__wt_rf.add(${JSON.stringify(rule)}, ${whenFn}, ${jsFn})`);
  return { id, armed: true };
}

export function statusTool(sess: any, waitMs = 0) {
  const ms = Math.min(Math.max(waitMs, 0), 30000);
  return run(
    sess,
    `new Promise((res) => {
      const t0 = performance.now();
      const snap = () => ({
        probe: Boolean(window.__wt_rt),
        canvas: window.__wt_cv ? { attached: true, frames_seen: window.__wt_cv.n } : { attached: false },
        reflexes: window.__wt_rf ? window.__wt_rf.snap() : []
      });
      const tick = () => {
        const s = snap();
        if (!${ms} || !s.reflexes.some((r) => !r.done) || performance.now() - t0 > ${ms}) res(s);
        else setTimeout(tick, 50);
      };
      tick();
    })`,
    true
  );
}

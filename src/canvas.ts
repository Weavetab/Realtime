import { run } from "./page.js";

// recorder hooks CanvasRenderingContext2D.prototype and window.requestAnimationFrame.
// draws are only kept while a rAF callback is running, that is what defines a frame.
const SPY = `(() => {
  if (window.__wt_cv) return 1;
  const cv = window.__wt_cv = { frames: [], n: 0, cur: null, orig: {}, canvases: [], bg: 0, raf: window.requestAnimationFrame };
  const P = CanvasRenderingContext2D.prototype;

  const rec = (ctx, kind, key, x, y, w, h) => {
    const m = ctx.getTransform();
    const x1 = m.a * x + m.c * y + m.e, y1 = m.b * x + m.d * y + m.f;
    const x2 = m.a * (x + w) + m.c * (y + h) + m.e, y2 = m.b * (x + w) + m.d * (y + h) + m.f;
    let ci = cv.canvases.indexOf(ctx.canvas);
    if (ci < 0) ci = cv.canvases.push(ctx.canvas) - 1;
    const ww = Math.abs(x2 - x1), hh = Math.abs(y2 - y1);
    cv.cur.push({ sig: kind + '|' + Math.round(ww) + 'x' + Math.round(hh) + '|' + key,
      x: Math.min(x1, x2), y: Math.min(y1, y2), w: ww, h: hh, c: ci });
  };
  const styleKey = (s) => typeof s === 'string' ? s : 'grad';
  const imgKey = (im) => {
    const s = im.currentSrc || im.src;
    return s ? s.split('?')[0].split('/').pop() : (im.id || im.tagName || 'bmp');
  };
  const wrap = (name, fn) => {
    const o = P[name];
    cv.orig[name] = o;
    P[name] = function () {
      const r = o.apply(this, arguments);
      // the spy must never break the game's own draw call
      try { if (cv.cur && this.canvas.isConnected && cv.cur.length < 2000) fn(this, arguments); } catch (e) {}
      return r;
    };
  };

  wrap('fillRect', (c, a) => rec(c, 'rect', styleKey(c.fillStyle), a[0], a[1], a[2], a[3]));
  wrap('strokeRect', (c, a) => rec(c, 'frame', styleKey(c.strokeStyle), a[0], a[1], a[2], a[3]));
  wrap('drawImage', (c, a) => {
    const im = a[0], n = a.length;
    if (n >= 9) rec(c, 'img', imgKey(im) + '@' + a[1] + ',' + a[2], a[5], a[6], a[7], a[8]);
    else if (n >= 5) rec(c, 'img', imgKey(im), a[1], a[2], a[3], a[4]);
    else rec(c, 'img', imgKey(im), a[1], a[2], im.naturalWidth || im.videoWidth || im.width || 0, im.naturalHeight || im.videoHeight || im.height || 0);
  });
  const text = (c, a) => {
    const m = c.measureText(a[0]);
    rec(c, 'text', String(a[0]).slice(0, 24), a[1], a[2] - m.actualBoundingBoxAscent, m.width, m.actualBoundingBoxAscent + m.actualBoundingBoxDescent);
  };
  wrap('fillText', text);
  wrap('strokeText', text);
  wrap('beginPath', (c) => { c.__wtp = []; });
  wrap('arc', (c, a) => {
    if (Math.abs(a[4] - a[3]) >= 6.2) (c.__wtp || (c.__wtp = [])).push([a[0], a[1], a[2]]);
  });
  const commit = (style) => (c) => {
    for (const p of (c.__wtp || [])) rec(c, 'arc', styleKey(c[style]), p[0] - p[2], p[1] - p[2], p[2] * 2, p[2] * 2);
    c.__wtp = [];
  };
  wrap('fill', commit('fillStyle'));
  wrap('stroke', commit('strokeStyle'));

  window.requestAnimationFrame = function (cb) {
    return cv.raf.call(window, function (ts) {
      cv.cur = [];
      try { return cb(ts); } finally {
        cv.frames.push({ t: ts, d: cv.cur });
        if (cv.frames.length > 16) cv.frames.shift();
        cv.cur = null;
        cv.n++;
      }
    });
  };

  cv.track = (sig, depth) => {
    const fr = cv.frames;
    if (!fr.length) return [];
    const last = fr[fr.length - 1].d.filter((d) => d.sig === sig);
    if (last.length > 200) return last.map((d) => Object.assign({ vx: 0, vy: 0 }, d));
    const prevs = fr.slice(Math.max(0, fr.length - 1 - depth), -1).reverse().map((f) => f.d.filter((d) => d.sig === sig));
    return last.map((d) => {
      let cur = d, steps = 0;
      for (const p of prevs) {
        let best = null, bd = 1e9;
        for (const q of p) {
          const dd = (q.x - cur.x) * (q.x - cur.x) + (q.y - cur.y) * (q.y - cur.y);
          if (dd < bd) { bd = dd; best = q; }
        }
        if (!best || bd > 40000) break;
        cur = best; steps++;
      }
      return Object.assign({}, d, { vx: steps ? (d.x - cur.x) / steps : 0, vy: steps ? (d.y - cur.y) / steps : 0 });
    });
  };
  return 0;
})()`;

const WAIT = (frames: number) => `new Promise((res) => {
  const cv = window.__wt_cv, start = cv.n, t0 = performance.now();
  const tick = () => (cv.n - start >= ${frames} || performance.now() - t0 > 3000) ? res(cv.n - start) : setTimeout(tick, 8);
  tick();
})`;

const REPORT = `(() => {
  const cv = window.__wt_cv;
  const fr = cv.frames, last = fr[fr.length - 1];
  const r1 = (v) => Math.round(v * 10) / 10;
  const dt = fr.length > 1 ? fr[fr.length - 1].t - fr[0].t : 0;
  const cans = [];
  const info = (i) => {
    let o = cans.find((c) => c.i === i);
    if (!o) {
      const el = cv.canvases[i], r = el.getBoundingClientRect();
      o = { i, id: el.id || null, w: el.width, h: el.height, left: r.left, top: r.top, sx: r.width / el.width, sy: r.height / el.height };
      cans.push(o);
    }
    return o;
  };
  const sigs = {};
  for (const d of last.d) (sigs[d.sig] || (sigs[d.sig] = [])).push(d);
  const ents = [], groups = [];
  let bg = 0;
  for (const sig of Object.keys(sigs).slice(0, 200)) {
    const inst = sigs[sig];
    const kind = sig.split('|')[0];
    const tr = cv.track(sig, 5);
    if (inst.length > 6) {
      groups.push({ sig, count: inst.length, moving: tr.filter((t) => t.vx || t.vy).length });
      continue;
    }
    for (const t of tr) {
      const cn = info(t.c);
      if ((kind === 'rect') && t.w >= cn.w * 0.9 && t.h >= cn.h * 0.9) { bg++; continue; }
      ents.push({ sig, canvas: t.c, x: r1(t.x), y: r1(t.y), w: r1(t.w), h: r1(t.h), vx: r1(t.vx), vy: r1(t.vy) });
    }
  }
  ents.sort((a, b) => (Math.abs(b.vx) + Math.abs(b.vy)) - (Math.abs(a.vx) + Math.abs(a.vy)));
  return { frames: fr.length, fps: dt ? Math.round((fr.length - 1) * 1000 / dt) : null, canvases: cans,
    entities: ents.slice(0, 40), groups: groups.slice(0, 20), background_fills: bg, truncated: ents.length > 40 };
})()`;

const OFF = `(() => {
  const cv = window.__wt_cv;
  if (!cv) return 0;
  const P = CanvasRenderingContext2D.prototype;
  for (const k of Object.keys(cv.orig)) P[k] = cv.orig[k];
  window.requestAnimationFrame = cv.raf;
  delete window.__wt_cv;
  return 1;
})()`;

export async function canvasTool(sess: any, a: { action: "sample" | "attach" | "detach"; frames?: number }) {
  if (a.action === "detach") return { detached: Boolean(await run(sess, OFF)) };

  const fresh = (await run(sess, SPY)) === 0;
  if (a.action === "attach") return { attached: true, already: !fresh };

  const want = Math.min(Math.max(a.frames ?? 6, 2), 15);
  const got = await run(sess, WAIT(want), true);
  if (!got) throw new Error("no frames seen: tab hidden, or the game does not use requestAnimationFrame");
  return run(sess, REPORT);
}

export function canvasSnap(sess: any) {
  return run(sess, `window.__wt_cv && window.__wt_cv.frames.length ? ${REPORT} : null`);
}

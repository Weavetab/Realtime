import { run, arm } from "./page.js";
import { canvasSnap } from "./canvas.js";
import { statusTool } from "./reflex.js";

const RECENT = `((win) => {
  const rt = window.__wt_rt;
  if (!rt) return { click: null, last_mut_ms_ago: null, fresh: [] };
  const now = performance.now();
  const clk = rt.click && now - rt.click.t < 15000
    ? { x: Math.round(rt.click.x), y: Math.round(rt.click.y), age_ms: Math.round(now - rt.click.t) }
    : null;
  const sel = 'button, a[href], input, select, textarea, summary, dialog[open], [role=button], [role=link], [role=menuitem], [role=tab], [role=dialog], [role=alertdialog], [onclick]';
  const fresh = [];
  for (const el of document.querySelectorAll(sel)) {
    let b;
    for (let n = el; n && b === undefined; n = n.parentElement) b = rt.born.get(n);
    if (b === undefined || now - b > win) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    const s = getComputedStyle(el);
    if (s.visibility === 'hidden' || s.display === 'none') continue;
    const label = (el.getAttribute('aria-label') || el.innerText || el.value || el.title || '').trim().replace(/\\s+/g, ' ').slice(0, 60);
    const dist = clk ? Math.round(Math.hypot(r.left + r.width / 2 - clk.x, r.top + r.height / 2 - clk.y)) : null;
    fresh.push({
      tag: el.getAttribute('role') || el.tagName.toLowerCase(),
      id: el.id || null,
      wt_id: el.dataset && el.dataset.wtId || null,
      label,
      age_ms: Math.round(now - b),
      dist_from_click_px: dist
    });
    if (fresh.length >= 25) break;
  }
  fresh.sort((a, b) => a.age_ms - b.age_ms);
  return {
    url: location.href,
    click: clk,
    last_mut_ms_ago: rt.lastMut ? Math.round(now - rt.lastMut) : null,
    fresh
  };
})`;

export async function readFeed(sess: any, winMs: number) {
  if (!sess?.Runtime) return { active_tab: false };
  await arm(sess);
  const [st, dom, cv] = await Promise.all([
    statusTool(sess, 0),
    run(sess, `${RECENT}(${winMs})`),
    canvasSnap(sess),
  ]);
  return {
    url: dom.url,
    probe: st.probe,
    last_click: dom.click,
    last_mut_ms_ago: dom.last_mut_ms_ago,
    recent_elements: dom.fresh,
    reflexes: st.reflexes,
    canvas: cv || st.canvas,
  };
}

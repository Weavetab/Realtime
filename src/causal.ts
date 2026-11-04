import { run } from "./page.js";

const LINE = /^(\s*)\[w:(\d+)\]/;

function probeIds(ids: string[], winMs: number) {
  return `((ids, win) => {
    const rt = window.__wt_rt;
    if (!rt) return [];
    const now = performance.now();
    const clk = rt.click && now - rt.click.t < 15000 ? rt.click : null;
    const out = [];
    for (const id of ids) {
      const el = document.querySelector('[data-wt-id="' + id + '"]');
      if (!el) continue;
      let b;
      for (let n = el; n && b === undefined; n = n.parentElement) b = rt.born.get(n);
      if (b === undefined || now - b > win) continue;
      let dist = null;
      if (clk) {
        const r = el.getBoundingClientRect();
        dist = Math.round(Math.hypot(r.left + r.width / 2 - clk.x, r.top + r.height / 2 - clk.y));
      }
      out.push([id, Math.round(now - b), dist]);
    }
    return out;
  })(${JSON.stringify(ids)}, ${winMs})`;
}

async function tagText(sess: any, text: string, winMs: number) {
  const lines = text.split("\n");
  const ids = new Set<string>();
  for (const ln of lines) {
    const m = LINE.exec(ln);
    if (m) ids.add(m[2]);
  }
  if (!ids.size) return text;

  const hits: [string, number, number | null][] = await run(sess, probeIds([...ids], winMs));
  if (!hits.length) return text;
  const byId = new Map(hits.map((h) => [h[0], h]));

  return lines
    .map((ln) => {
      const m = LINE.exec(ln);
      const h = m && byId.get(m[2]);
      if (!h) return ln;
      return `${ln} {new ${h[1]}ms${h[2] == null ? "" : `, ${h[2]}px from click`}}`;
    })
    .join("\n");
}

// returns undefined when nothing changed so the pipeline keeps the original result
export async function tagMap(sess: any, res: any, winMs: number) {
  if (typeof res === "string") {
    const t = await tagText(sess, res, winMs);
    return t === res ? undefined : t;
  }
  if (!Array.isArray(res?.content)) return;

  let touched = false;
  const content = [];
  for (const blk of res.content) {
    if (blk?.type === "text" && typeof blk.text === "string") {
      const t = await tagText(sess, blk.text, winMs);
      if (t !== blk.text) touched = true;
      content.push({ ...blk, text: t });
    } else {
      content.push(blk);
    }
  }
  return touched ? { ...res, content } : undefined;
}

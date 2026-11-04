import { run, arm } from "./page.js";

const NOISE = new Set("the and then until all any click press tap button link please that this with from into when once done after before for".split(" "));
const RISKY = /delete|remove|\bpay\b|purchase|place order|sign out|log ?out|unsubscribe|deactivate/i;

const COLLECT = `(() => {
  const rt = window.__wt_rt, now = performance.now();
  const sel = 'button, a[href], input[type=button], input[type=submit], input[type=checkbox], input[type=radio], summary, [role=button], [role=link], [role=menuitem], [role=tab], [role=checkbox], [onclick]';
  const dlg = [...document.querySelectorAll('dialog[open], [role=dialog], [role=alertdialog], [aria-modal=true]')]
    .find((d) => d.getBoundingClientRect().width > 0);
  const els = window.__wt_ap = [];
  const cands = [];
  for (const el of document.querySelectorAll(sel)) {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2 || r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) continue;
    const s = getComputedStyle(el);
    if (s.visibility === 'hidden' || s.display === 'none') continue;
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const top = document.elementFromPoint(x, y);
    if (!top || !(top === el || el.contains(top) || top.contains(el))) continue;
    let born;
    for (let n = el; n && born === undefined; n = n.parentElement) born = rt.born.get(n);
    const label = (el.getAttribute('aria-label') || el.innerText || el.value || el.title || '').trim().replace(/\\s+/g, ' ').slice(0, 60);
    els.push(el);
    cands.push({ i: els.length - 1, label, role: el.getAttribute('role') || el.tagName.toLowerCase(), x, y,
      age: born === undefined ? null : Math.round(now - born), dlg: Boolean(dlg && dlg.contains(el)),
      off: Boolean(el.disabled || el.getAttribute('aria-disabled') === 'true') });
  }
  const c = rt.click && now - rt.click.t < 15000 ? rt.click : null;
  return { cands, hasDlg: Boolean(dlg), click: c && { x: c.x, y: c.y }, url: location.href, t: now };
})()`;

type Cand = { i: number; label: string; role: string; x: number; y: number; age: number | null; dlg: boolean; off: boolean };

type Args = {
  goal: string;
  max_steps?: number;
  stop_when_selector?: string;
  stop_when_text?: string;
  stop_when_url?: string;
  avoid_labels?: string;
  model_url?: string;
  model?: string;
  model_timeout_ms?: number;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// a click that navigates kills the execution context for a moment
async function steady<T>(fn: () => Promise<T>): Promise<T> {
  for (let n = 0; ; n++) {
    try {
      return await fn();
    } catch (e: any) {
      if (n >= 8 || !/context|destroyed|detached|navigat/i.test(e?.message || "")) throw e;
      await sleep(120);
    }
  }
}

function words(s: string) {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !NOISE.has(w));
}

function score(c: Cand, goal: string[], hasDlg: boolean, click: { x: number; y: number } | null) {
  const lab = words(c.label);
  let hit = 0;
  for (const g of goal) if (lab.some((t) => t.startsWith(g) || g.startsWith(t))) hit++;
  if (!hit) return 0;
  let s = hit * 3;
  if (c.age != null && c.age <= 3000) s += 2;
  if (hasDlg) s += c.dlg ? 3 : -3;
  if (click && Math.hypot(c.x - click.x, c.y - click.y) < 250) s += 1;
  return s;
}

async function askModel(a: Args, list: Cand[]): Promise<{ pick: number | null; done: boolean }> {
  const lines = list.map((c, n) => `${n}: [${c.role}] "${c.label}"${c.age != null && c.age <= 3000 ? " (new)" : ""}${c.dlg ? " (dialog)" : ""}`);
  const res = await fetch(a.model_url!, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(a.model_timeout_ms ?? 1500),
    body: JSON.stringify({
      model: a.model || "local",
      temperature: 0,
      max_tokens: 40,
      messages: [
        { role: "system", content: 'You pick the next click in a browser. Reply with JSON only: {"pick": <number or null>, "done": <true|false>}.' },
        { role: "user", content: `Goal: ${a.goal}\nClickable elements:\n${lines.join("\n")}` },
      ],
    }),
  });
  if (!res.ok) throw new Error(`model http ${res.status}`);
  const body: any = await res.json();
  const txt: string = body?.choices?.[0]?.message?.content ?? "";
  const m = /\{[\s\S]*\}/.exec(txt);
  if (!m) throw new Error("model gave no json");
  const out = JSON.parse(m[0]);
  const pick = Number.isInteger(out.pick) && out.pick >= 0 && out.pick < list.length ? out.pick : null;
  return { pick, done: out.done === true };
}

export async function autopilotTool(sess: any, a: Args) {
  const goal = words(a.goal);
  if (!goal.length && !a.model_url) throw new Error("goal has no usable words");
  const extra = a.avoid_labels ? new RegExp(a.avoid_labels, "i") : null;
  const riskOk = RISKY.test(a.goal);
  const dead = new Set<string>();
  const steps: unknown[] = [];
  let modelErr: string | undefined;
  let stopped = "max_steps";
  const cap = Math.min(Math.max(a.max_steps ?? 8, 1), 25);

  const stopNow = () =>
    steady(() =>
      run(
        sess,
        `((sel, txt, re) => {
          if (sel) { const e = document.querySelector(sel); if (e) { const r = e.getBoundingClientRect(); if (r.width || r.height) return 'selector'; } }
          if (txt && document.body.innerText.toLowerCase().includes(txt)) return 'text';
          if (re && new RegExp(re).test(location.href)) return 'url';
          return null;
        })(${JSON.stringify(a.stop_when_selector ?? null)}, ${JSON.stringify(a.stop_when_text?.toLowerCase() ?? null)}, ${JSON.stringify(a.stop_when_url ?? null)})`
      )
    );

  for (let n = 1; n <= cap; n++) {
    await steady(() => arm(sess));
    const hit = await stopNow();
    if (hit) { stopped = hit; break; }

    const pg = await steady(() => run(sess, COLLECT));
    const keyOf = (c: Cand) => `${c.role}|${c.label}|${Math.round(c.x / 10)}|${Math.round(c.y / 10)}`;
    const pool: Cand[] = pg.cands.filter(
      (c: Cand) => !c.off && !dead.has(keyOf(c)) && !(extra && extra.test(c.label)) && !(!riskOk && RISKY.test(c.label))
    );
    const ranked = pool
      .map((c) => ({ c, s: score(c, goal, pg.hasDlg, pg.click) }))
      .sort((p, q) => q.s - p.s);

    let pick: Cand | undefined;
    let how = "scorer";
    let sc = 0;

    if (a.model_url && !modelErr) {
      try {
        const list = ranked.slice(0, 12).map((r) => r.c);
        const m = await askModel(a, list);
        if (m.done) { stopped = "model_done"; break; }
        if (m.pick == null) { stopped = "no_match"; break; }
        pick = list[m.pick];
        how = "model";
      } catch (e: any) {
        modelErr = e?.message || String(e);
      }
    }
    if (!pick) {
      if (!ranked.length || ranked[0].s < 3) { stopped = "no_match"; break; }
      pick = ranked[0].c;
      sc = ranked[0].s;
    }

    const pre = pg.t;
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
      await sess.Input.dispatchMouseEvent({ type, x: pick.x, y: pick.y, button: "left", clickCount: type === "mouseMoved" ? 0 : 1 });
    }

    await sleep(80);
    let quiet = false;
    for (let w = 0; w < 8 && !quiet; w++) {
      const st = await steady(() => run(sess, "window.__wt_rt ? performance.now() - window.__wt_rt.lastMut : 1e9"));
      quiet = st >= 120;
      if (!quiet) await sleep(60);
    }
    const after = await steady(() => run(sess, "[location.href, window.__wt_rt ? window.__wt_rt.lastMut : 1e9]"));
    const changed = after[0] !== pg.url || after[1] > pre;
    if (!changed) dead.add(keyOf(pick));
    steps.push({ n, label: pick.label, via: how, score: how === "scorer" ? sc : undefined, changed });
  }

  const url = await steady(() => run(sess, "location.href"));
  return { stopped, steps, url, ...(modelErr ? { model_error: modelErr } : {}) };
}

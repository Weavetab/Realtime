// page-side probe shared by every tool in here. one per document, survives until navigation.
const PROBE = `(() => {
  if (window.__wt_rt) return 1;
  const rt = window.__wt_rt = { born: new WeakMap(), click: null, lastMut: 0 };
  new MutationObserver(recs => {
    const now = performance.now();
    for (const r of recs) {
      if (r.type === 'childList') {
        for (const n of r.addedNodes) if (n.nodeType === 1 && !rt.born.has(n)) rt.born.set(n, now);
      }
    }
    rt.lastMut = now;
  }).observe(document.documentElement, {
    childList: true, subtree: true, characterData: true, attributes: true,
    attributeFilter: ['class', 'hidden', 'aria-expanded', 'aria-hidden', 'open', 'disabled']
  });
  addEventListener('pointerdown', e => { rt.click = { x: e.clientX, y: e.clientY, t: performance.now() }; }, true);
  return 0;
})()`;

export function sessOf(ctx: any) {
  return ctx?.tab?.session || ctx?.session || ctx;
}

export async function run(sess: any, expression: string, awaitPromise = false): Promise<any> {
  const out = await sess.Runtime.evaluate({ expression, returnByValue: true, awaitPromise });
  if (out.exceptionDetails) {
    const ex = out.exceptionDetails;
    throw new Error(ex.exception?.description?.split("\n")[0] || ex.text || "page eval failed");
  }
  return out.result?.value;
}

export function arm(sess: any) {
  return run(sess, PROBE);
}

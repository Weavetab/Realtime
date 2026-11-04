# @weavetab/plugin-realtime

Weavetab plugin for pages that change faster than an LLM can look at them. Four tools and one hook:

| | what it does |
|---|---|
| `browser_map` hook | appends `{new 180ms, 64px from click}` to elements that appeared recently, so two identical "Confirm" buttons stop being ambiguous |
| `realtime_canvas` | records Canvas2D draw calls for a few frames and returns entities with bbox and px/frame velocity |
| `realtime_reflex` | registers a rule that runs inside the page every animation frame, no LLM round-trip |
| `realtime_autopilot` | bounded click loop for short sub-goals ("accept cookies") |
| `realtime_status` | state of the above; can block until reflexes finish |

Nothing in `@weavetab/mcp` or `@weavetab/sdk` is modified. It only uses the plugin hooks and the CDP session Weavetab already hands to plugins.

## Install

```
npm install @weavetab/plugin-realtime
```

Requires Weavetab `>=2.6.0` and Node `>=18`. The plugin declares `cdp.evaluate`, `cdp.input`, `tools.add`, `hooks.onBeforeAction/onAfterAction` and a `network` permission for `127.0.0.1`/`localhost` (only used by `model_url`).

## Causal tags

A `MutationObserver` is injected into the page on the first tool call after each navigation and records when nodes were added. After `browser_map`, lines for elements added within the last `causalWindowMs` (default 4000, set in the plugin config) get a tag, plus the distance from the last pointer click if there was one in the last 15 s:

```
[w:1] button "Confirm"
[w:2] button "Confirm" {new 210ms, 48px from click}
```

Limits:
- Only nodes added **after** the probe was installed can be tagged. Whatever was on the page before the first tool call is never "new".
- The tag looks elements up through the `data-wt-id` attribute Weavetab's walker writes. Elements inside shadow roots that `document.querySelector` can't reach are left untagged.
- A framework that re-renders a node makes it look new. That is accurate, it is a new node.

## realtime_canvas

`action: "sample"` (default) watches `frames` frames (2–15, default 6) and returns:

```json
{
  "frames": 6, "fps": 60,
  "canvases": [{ "i": 0, "id": null, "w": 400, "h": 120, "left": 8, "top": 8, "sx": 1, "sy": 1 }],
  "entities": [{ "sig": "rect|20x20|#ff0000", "canvas": 0, "x": 85, "y": 40, "w": 20, "h": 20, "vx": 5, "vy": 0 }],
  "groups": [{ "sig": "img|16x16|tile.png", "count": 120, "moving": 0 }],
  "background_fills": 1
}
```

Coordinates are canvas pixels. Viewport position is `left + x * sx`, `top + y * sy`. `sig` is `kind|WxH|key` where key is the fill colour, text, or image file name (and source rect for sprite sheets). Velocity comes from nearest-neighbour matching of same-signature draws across frames. Signatures with more than 6 instances are summarised under `groups`. Full-canvas rect fills are counted in `background_fills` instead of listed.

`attach` starts recording early, `detach` restores `CanvasRenderingContext2D.prototype` and `requestAnimationFrame`.

What it cannot see:
- **WebGL / WebGPU.** Only the 2D context is hooked.
- Draws made outside a `requestAnimationFrame` callback, and games that cached `requestAnimationFrame` or a context method before attaching.
- Arcs are recorded only when they are full circles and get filled/stroked. `drawImage` of offscreen canvases that are not in the document is ignored.
- Text position ignores `textAlign`.

## realtime_reflex

```jsonc
// click a button the moment a new "Claim" button shows up
{ "action": "add",
  "when": { "selector": "button", "text": "claim", "only_new": true },
  "do": { "type": "click" }, "max_hits": 1 }

// jump when the cactus is close (signatures come from realtime_canvas)
{ "action": "add",
  "when": { "canvas": { "names": { "p": "rect|20x20|#ff0000", "o": "rect|10x30|#00ff00" },
                        "js": "gap(E.p[0], E.o[0]) < 50" } },
  "do": { "type": "key", "key": "Space" }, "cooldown_ms": 300, "max_hits": 20 }
```

In `canvas.js`, `E.<name>` is an array of `{x, y, w, h, vx, vy}` for that signature in the last completed frame. `dist(a, b)` is centre distance, `gap(a, b)` is `b.x - (a.x + a.w)`; both return `Infinity` if either argument is `undefined`, so a missing obstacle does not kill the rule. Any other exception disables the rule and shows up as `error` in `realtime_status`.

Defaults: `cooldown_ms` 100, `max_hits` 50, `ttl_ms` 30000 (max 600000). `stop_selector` ends the rule when that selector exists. Actions: `click` (selector triggers only), `click_xy` (viewport coordinates), `key` (`hold_ms` default 40), `js`.

Limits you should know before relying on it:
- **Events are synthetic.** Anything that checks `event.isTrusted` ignores them. Keys go to `document.activeElement` (the body if nothing is focused), so a game that listens on an unfocused canvas will not see them.
- The loop runs on `requestAnimationFrame`, which browsers pause in hidden or background tabs.
- Canvas rules react to the last completed frame, so expect up to one frame of lag.
- Rules live in the page. Navigation wipes them.
- `when.canvas.js` and `do.js` are sent as source through CDP, so page CSP without `unsafe-eval` does not block them. They run with full page privileges, same as `browser_eval`.

## realtime_autopilot

Loop of: collect visible, un-occluded clickables, pick one, click it with real CDP mouse events, wait for the DOM to go quiet, repeat. Stops on `stop_when_selector`, `stop_when_text`, `stop_when_url` (regex), `max_steps` (default 8, max 25) or `no_match`.

Ranking is a heuristic, not a planner: each goal word (3+ letters, common filler dropped) that prefix-matches a word in the label scores 3. Elements that appeared in the last 3 s get +2, elements inside an open dialog +3 (others −3), elements within 250 px of the last click +1. Below 3 total, the loop stops with `no_match`. A button whose click changed neither the DOM nor the URL is not clicked again.

Labels matching `delete|remove|pay|purchase|place order|sign out|log out|unsubscribe|deactivate` are skipped unless the goal contains one of those words. `avoid_labels` adds your own regex.

`model_url` (optional) points at an OpenAI-compatible `/v1/chat/completions` endpoint (llama.cpp server, Ollama, LM Studio). The top 12 candidates are sent with the goal and the reply must contain `{"pick": n|null, "done": bool}`. Any HTTP error, timeout (`model_timeout_ms`, default 1500) or unparsable reply falls back to the ranker for the rest of the run and is reported as `model_error`. Needle (Cactus) has not been tested against this; it is a tool-calling model with its own interface and is not assumed to speak this protocol.

Offscreen elements are not considered. Scroll first.

## Development

```
npm install
npm run build
npm test
npx weavetab preflight
```

`npm test` drives a real headless Chrome through CDP (set `CHROME_PATH` if it is not in a default location; the browser tests are skipped when none is found). It covers the tags, canvas sampling, both reflex trigger types, and the autopilot guards.

## License

Apache-2.0, see [LICENSE](LICENSE).

import { definePlugin, defineTool, definePrompt, defineResource, z, type PluginContext } from "@weavetab/sdk";
import { arm, sessOf } from "./page.js";
import { tagMap } from "./causal.js";
import { canvasTool } from "./canvas.js";
import { reflexTool, statusTool } from "./reflex.js";
import { autopilotTool } from "./autopilot.js";
import { readFeed } from "./surface.js";

let winMs = 4000;

const asText = (v: unknown) => ({ content: [{ type: "text", text: JSON.stringify(v, null, 2) }] });

const plugin = definePlugin({
  name: "@weavetab/plugin-realtime",
  version: "0.2.0",
  description: "Causal tags for browser_map, in-page reflex rules, canvas entity sampling, bounded click loop.",
  defaultConfig: { causalWindowMs: 4000 },
  permissions: {
    cdp: { evaluate: true, input: true, reason: "Page probe, canvas spy, 60Hz reflex loop, and trusted CDP mouse clicks." },
    tools: { add: true, reason: "Registers realtime_canvas, realtime_reflex, realtime_autopilot and realtime_status." },
    prompts: { add: true, reason: "Registers /realtime_watch to guide setting up 60Hz DOM or canvas reflexes." },
    resources: { add: true, reason: "Registers @realtime_feed (realtime://feed) for live reflex, DOM, and canvas telemetry." },
    hooks: { onBeforeAction: true, onAfterAction: true, reason: "Arms page probe and appends {new ...} causal tags to browser_map." },
    network: { hosts: ["127.0.0.1", "localhost"], reason: "Optional local model_url in realtime_autopilot." },
  },

  async onBeforeAction(_tool: string, _args: Record<string, any>, sess?: any) {
    if (sess?.Runtime) await arm(sess).catch(() => {}); // page may be mid-navigation, next call retries
  },

  async onAfterAction(tool: string, res: any, sess?: any) {
    if (tool !== "browser_map" || !sess?.Runtime) return;
    return tagMap(sess, res, winMs).catch(() => undefined);
  },

  async onLoad(ctx: PluginContext) {
    winMs = Number(ctx.config?.causalWindowMs) || 4000;
    const reg = ctx.mcp.registerTool;

    reg(
      defineTool({
        name: "realtime_canvas",
        description:
          "Sample what a 2D <canvas> game draws. 'sample' watches a few frames and returns entities (signature, bbox, px/frame velocity) in canvas pixels, plus canvas position/scale to convert to viewport coords. Only sees Canvas2D draw calls made inside requestAnimationFrame; WebGL is invisible to it. 'attach' starts recording early, 'detach' restores the page.",
        requiresSession: true,
        schema: {
          action: z.enum(["sample", "attach", "detach"]).default("sample"),
          frames: z.number().int().min(2).max(15).optional().describe("frames to watch, default 6"),
        },
        handler: async (a, ctx) => asText(await canvasTool(sessOf(ctx), a)),
      })
    );

    reg(
      defineTool({
        name: "realtime_reflex",
        description:
          "Register a rule that runs inside the page every animation frame, no LLM round-trip. Trigger is either a DOM selector (optionally text / only_new) or a canvas expression over named entity signatures from realtime_canvas: names {player:'rect|20x20|#f00'}, js \"gap(E.player[0], E.cactus[0]) < 50\" (E.name = array of {x,y,w,h,vx,vy}; dist() and gap() return Infinity when an entity is missing). Action: click, click_xy, key, or js. Events are synthetic, sites that check isTrusted ignore them. Needs a visible tab.",
        requiresSession: true,
        schema: {
          action: z.enum(["add", "remove", "list", "clear"]).default("add"),
          id: z.string().optional(),
          when: z
            .object({
              selector: z.string().optional(),
              text: z.string().optional().describe("case-insensitive substring of label/text"),
              only_new: z.boolean().optional().describe("only elements added after this rule was created"),
              enabled: z.boolean().optional().describe("skip disabled elements, default true"),
              canvas: z.object({ names: z.record(z.string()), js: z.string() }).optional(),
            })
            .optional(),
          do: z
            .object({
              type: z.enum(["click", "click_xy", "key", "js"]),
              x: z.number().optional(),
              y: z.number().optional(),
              key: z.string().optional(),
              hold_ms: z.number().optional().describe("key hold time, default 40"),
              code: z.string().optional(),
            })
            .optional(),
          cooldown_ms: z.number().optional().describe("default 100"),
          max_hits: z.number().optional().describe("default 50"),
          ttl_ms: z.number().optional().describe("default 30000, max 600000"),
          stop_selector: z.string().optional(),
        },
        handler: async (a, ctx) => asText(await reflexTool(sessOf(ctx), a)),
      })
    );

    reg(
      defineTool({
        name: "realtime_autopilot",
        description:
          "Bounded click loop for short UI sub-goals ('accept cookies', 'click next until Order summary shows'). Ranks visible, unoccluded clickable elements by word overlap with the goal, boosts ones that just appeared and ones inside an open dialog, and never re-clicks a button whose last click changed nothing. Trusted CDP mouse clicks. Skips delete/pay/sign-out style labels unless the goal says so. Not a planner: stops with no_match when no label overlaps the goal. Optional model_url = OpenAI-compatible chat endpoint to pick instead; falls back to the ranker on any failure.",
        requiresSession: true,
        schema: {
          goal: z.string().min(3),
          max_steps: z.number().int().min(1).max(25).optional().describe("default 8"),
          stop_when_selector: z.string().optional(),
          stop_when_text: z.string().optional(),
          stop_when_url: z.string().optional().describe("regex tested against location.href"),
          avoid_labels: z.string().optional().describe("regex of extra labels never to click"),
          model_url: z.string().url().optional(),
          model: z.string().optional(),
          model_timeout_ms: z.number().optional().describe("default 1500"),
        },
        handler: async (a, ctx) => asText(await autopilotTool(sessOf(ctx), a)),
      })
    );

    reg(
      defineTool({
        name: "realtime_status",
        description:
          "Probe/canvas/reflex state for the current page. wait_ms (max 30000) blocks until every active reflex has finished, so the agent can sleep through a game or a drop-watch.",
        requiresSession: true,
        schema: { wait_ms: z.number().optional() },
        handler: async (a, ctx) => asText(await statusTool(sessOf(ctx), a.wait_ms)),
      })
    );

    ctx.mcp.registerPrompt?.(
      definePrompt({
        name: "realtime_watch",
        title: "Watch & React (60Hz Reflex)",
        description: "Set up an in-page 60Hz reflex rule or canvas game loop and wait until it finishes.",
        arguments: {
          goal: z.string().describe("What to watch for and trigger (e.g. 'click Claim as soon as it appears' or 'jump over green obstacles in the canvas game')"),
          mode: z.string().optional().describe("'dom', 'canvas', or 'auto' (default 'auto')"),
        },
        handler: async ({ goal, mode }, sctx) => {
          const feed = await readFeed(sessOf(sctx), winMs).catch(() => ({ active_tab: false }));
          const m = (mode || "auto").toLowerCase();
          return [
            `Goal: ${goal}`,
            `Mode: ${m}`,
            `Live state: ${JSON.stringify(feed)}`,
            m === "canvas"
              ? "1. Call realtime_canvas with action='sample' to inspect moving entity signatures and velocities.\n2. Arm realtime_reflex with when.canvas ({ names, js }) using gap(E.a[0], E.b[0]) or dist(E.a[0], E.b[0]).\n3. Call realtime_status with wait_ms to block until the reflex completes."
              : "1. If targeting a 2D <canvas>, run realtime_canvas (action='sample') first to grab entity signatures; if targeting DOM changes, pick a selector/text filter (set only_new=true to ignore elements already on screen).\n2. Arm the rule with realtime_reflex (action='add').\n3. Call realtime_status with wait_ms (up to 30000) to sleep until the reflex hits max_hits or stop_selector.",
          ].join("\n\n");
        },
      })
    );

    ctx.mcp.registerResource?.(
      defineResource({
        name: "realtime_feed",
        title: "Realtime Page Feed",
        uri: "realtime://feed",
        mimeType: "application/json",
        description: "Live snapshot of active 60Hz reflex rules, recently mutated DOM elements with click distance, and tracked Canvas2D entities.",
        read: async (_uri, _vars, sctx) => JSON.stringify(await readFeed(sessOf(sctx), winMs), null, 2),
      })
    );

    ctx.logger?.info("realtime up");
  },
});

export default plugin;
export { plugin };

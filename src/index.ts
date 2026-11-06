import {
  definePlugin,
  defineTool,
  defineCommand,
  definePrompt,
  defineResource,
  z,
  type PluginContext,
} from "@weavetab/sdk";
import { sessOf, arm } from "./page.js";
import { tagMap } from "./causal.js";
import { canvasTool } from "./canvas.js";
import { reflexTool, statusTool } from "./reflex.js";
import { autopilotTool } from "./autopilot.js";
import { readFeed } from "./surface.js";

const statusCommand = defineCommand({
  name: "status",
  description: "Read the in-page realtime probe state, canvas frame counter, and active 60Hz reflex rules.",
  usage: "weavetab plugin use realtime status [--wait_ms <ms>]",
  requiresSession: true,
  schema: {
    wait_ms: z.number().optional().describe("Block up to wait_ms until active reflexes finish"),
  },
  handler: async (args: { wait_ms?: number }, ctx: any) => {
    const sess = sessOf(ctx);
    return await statusTool(sess, Number(args.wait_ms || 0));
  },
});

const reflexClearCommand = defineCommand({
  name: "reflex-clear",
  description: "Clear all active 60Hz reflex rules on the active browser tab via CLI.",
  usage: "weavetab plugin use realtime reflex-clear",
  requiresSession: true,
  handler: async (_args: Record<string, never>, ctx: any) => {
    const sess = sessOf(ctx);
    return await reflexTool(sess, { action: "clear" });
  },
});

const autopilotCommand = defineCommand({
  name: "autopilot",
  description: "Run bounded in-page autopilot toward a goal directly via CLI.",
  usage: "weavetab plugin use realtime autopilot --goal <text> [--max_steps <n>]",
  requiresSession: true,
  schema: {
    goal: z.string().describe("Natural language click goal"),
    max_steps: z.number().optional().describe("Maximum click steps (default 5)"),
    stop_when_text: z.string().optional().describe("Stop when this text appears"),
  },
  handler: async (args: { goal: string; max_steps?: number; stop_when_text?: string }, ctx: any) => {
    const sess = sessOf(ctx);
    return await autopilotTool(sess, {
      goal: args.goal,
      max_steps: args.max_steps ?? 5,
      stop_when_text: args.stop_when_text,
    });
  },
});

export const realtimePlugin = definePlugin({
  name: "@weavetab/plugin-realtime",
  version: "0.3.0",
  description:
    "Causal age/proximity tags for browser_map, 60Hz in-page reflex rules, canvas entity sampling and a bounded click loop.",
  agentsMd: "AGENTS.md",
  defaultConfig: {
    causalWindowMs: 4000,
  },
  permissions: {
    cdp: {
      evaluate: true,
      input: true,
      reason: "Installs the in-page MutationObserver, hooks Canvas2D/rAF, and dispatches click/key events.",
    },
    tools: {
      add: true,
      reason: "Registers realtime_canvas, realtime_reflex, realtime_autopilot, and realtime_status.",
    },
    commands: {
      add: true,
      reason: "Registers status and reflex-clear CLI commands.",
    },
    prompts: {
      add: true,
      reason: "Registers the /realtime_watch prompt utility.",
    },
    resources: {
      add: true,
      reason: "Registers the @realtime_feed resource utility.",
    },
    hooks: {
      onBeforeAction: true,
      onAfterAction: true,
      reason: "Arms the in-page mutation probe before actions and tags newly added nodes in browser_map output.",
    },
    network: {
      domains: ["127.0.0.1", "localhost"],
      reason: "Allows realtime_autopilot to query an optional local OpenAI-compatible model endpoint.",
    },
  },
  commands: [statusCommand, reflexClearCommand, autopilotCommand],

  async onLoad(ctx: PluginContext): Promise<void> {
    const winMs = typeof ctx.config?.causalWindowMs === "number" ? ctx.config.causalWindowMs : 4000;

    ctx.cli?.registerCommand?.(statusCommand);
    ctx.cli?.registerCommand?.(reflexClearCommand);
    ctx.cli?.registerCommand?.(autopilotCommand);

    ctx.mcp.registerTool(
      defineTool({
        name: "realtime_canvas",
        description:
          "Records Canvas2D draw calls across requestAnimationFrame ticks and returns moving/static entities with bounding boxes and px/frame velocity.",
        requiresSession: true,
        schema: {
          action: z.enum(["sample", "attach", "detach"]).optional().describe("sample (default), attach, or detach"),
          frames: z.number().optional().describe("Frames to sample (2-15, default 6)"),
        },
        handler: async (args: { action?: "sample" | "attach" | "detach"; frames?: number }, rawCtx: any) => {
          const out = await canvasTool(sessOf(rawCtx), {
            action: args.action || "sample",
            frames: args.frames,
          });
          return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
        },
      })
    );

    ctx.mcp.registerTool(
      defineTool({
        name: "realtime_reflex",
        description:
          "Registers, removes, lists, or clears in-page 60Hz requestAnimationFrame rules that click or press keys on DOM or Canvas2D triggers without an LLM round-trip.",
        requiresSession: true,
        schema: {
          action: z.enum(["add", "remove", "list", "clear"]).describe("Operation to perform"),
          id: z.string().optional().describe("Rule identifier"),
          when: z
            .object({
              selector: z.string().optional(),
              text: z.string().optional(),
              only_new: z.boolean().optional(),
              enabled: z.boolean().optional(),
              canvas: z
                .object({
                  names: z.record(z.string(), z.union([z.string(), z.array(z.string())])),
                  js: z.string(),
                })
                .optional(),
            })
            .optional(),
          do: z
            .object({
              type: z.enum(["click", "click_xy", "key", "js"]),
              x: z.number().optional(),
              y: z.number().optional(),
              key: z.string().optional(),
              hold_ms: z.number().optional(),
              code: z.string().optional(),
            })
            .optional(),
          cooldown_ms: z.number().optional(),
          max_hits: z.number().optional(),
          ttl_ms: z.number().optional(),
          stop_selector: z.string().optional(),
        },
        handler: async (args: any, rawCtx: any) => {
          const out = await reflexTool(sessOf(rawCtx), args);
          return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
        },
      })
    );

    ctx.mcp.registerTool(
      defineTool({
        name: "realtime_autopilot",
        description:
          "Runs a bounded in-page click loop toward a short goal ('accept cookies', 'continue') with causal age/dialog scoring and optional local model pick.",
        requiresSession: true,
        schema: {
          goal: z.string().describe("Short natural-language click goal"),
          max_steps: z.number().optional(),
          stop_when_selector: z.string().optional(),
          stop_when_text: z.string().optional(),
          stop_when_url: z.string().optional(),
          avoid_labels: z.string().optional(),
          model_url: z.string().optional(),
          model: z.string().optional(),
          model_timeout_ms: z.number().optional(),
        },
        handler: async (args: any, rawCtx: any) => {
          const out = await autopilotTool(sessOf(rawCtx), args);
          return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
        },
      })
    );

    ctx.mcp.registerTool(
      defineTool({
        name: "realtime_status",
        description:
          "Returns the live state of the in-page probe, Canvas2D spy, and active 60Hz reflex rules. Optionally waits until reflexes complete.",
        requiresSession: true,
        schema: {
          wait_ms: z.number().optional().describe("Wait up to wait_ms (max 30000) for active reflexes to finish"),
        },
        handler: async (args: { wait_ms?: number }, rawCtx: any) => {
          const out = await statusTool(sessOf(rawCtx), args.wait_ms ?? 0);
          return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
        },
      })
    );

    ctx.mcp.registerPrompt(
      definePrompt({
        name: "realtime_watch",
        description:
          "Snapshot live DOM mutations, active reflexes, and Canvas2D entities, then guide the agent to wire a 60Hz reflex rule.",
        arguments: {
          goal: z.string().describe("What the reflex should watch for and do"),
          mode: z.enum(["auto", "dom", "canvas"]).optional().describe("Trigger mode (default: auto)"),
        },
        handler: async (args: { goal: string; mode?: string }, rawCtx: any) => {
          const feed = await readFeed(sessOf(rawCtx), winMs);
          return [
            `Goal: ${args.goal}`,
            `Mode: ${args.mode || "auto"}`,
            `Live feed: ${JSON.stringify(feed)}`,
            `Use realtime_canvas, realtime_reflex, and realtime_status to arm and verify the rule.`,
          ].join("\n");
        },
      })
    );

    ctx.mcp.registerResource(
      defineResource({
        name: "realtime_canvas_feed",
        uri: "realtime://canvas",
        description:
          "Live snapshot of Canvas2D draw counts, rAF frame rate, and active moving entity bounding boxes.",
        mimeType: "application/json",
        read: async (_uri: string, _vars: Record<string, string | string[]>, rawCtx: any) => {
          const sess = sessOf(rawCtx);
          const canvasData = await canvasTool(sess, { action: "sample", frames: 3 });
          return JSON.stringify(canvasData, null, 2);
        },
      })
    );

    ctx.mcp.registerResource(
      defineResource({
        name: "realtime_feed",
        uri: "realtime://feed",
        description:
          "Live snapshot of newly mutated DOM elements (with click distance), active 60Hz reflex rules, and tracked Canvas2D entities.",
        mimeType: "application/json",
        read: async (_uri: string, _vars: Record<string, string | string[]>, rawCtx: any) => {
          const feed = await readFeed(sessOf(rawCtx), winMs);
          return JSON.stringify(feed, null, 2);
        },
      })
    );

    ctx.logger?.info("@weavetab/plugin-realtime loaded");
  },

  async onBeforeAction(_action: string, _args: any, rawCtx?: any): Promise<void> {
    const sess = sessOf(rawCtx);
    if (sess?.Runtime) {
      await arm(sess).catch(() => {});
    }
  },

  async onAfterAction(action: string, result: any, rawCtx?: any): Promise<any> {
    if (action !== "browser_map") return;
    const sess = sessOf(rawCtx);
    if (!sess?.Runtime) return;
    const winMs = typeof rawCtx?.config?.causalWindowMs === "number" ? rawCtx.config.causalWindowMs : 4000;
    return await tagMap(sess, result, winMs).catch(() => undefined);
  },
});

export default realtimePlugin;
export const plugin = realtimePlugin;

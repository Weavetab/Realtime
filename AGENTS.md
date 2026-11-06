# Realtime Plugin — Agent Playbook

60Hz in-page reflex engine, causal DOM age/proximity tagging, Canvas2D entity tracking, and bounded click autopilot (`@weavetab/plugin-realtime`).

## MCP Tools
- `realtime_canvas`: Sample Canvas2D draw calls (`sample`, `attach`, `detach`, `frames`) to get entities and px/frame velocity.
- `realtime_reflex`: Arm, remove, list, or clear 60Hz `requestAnimationFrame` DOM or Canvas2D reflex rules (`action`, `when`, `do`).
- `realtime_autopilot`: Run a bounded click loop toward a short goal (`goal`, `stop_when_selector`, `stop_when_text`).
- `realtime_status`: Inspect probe status, canvas frame count, and reflex hits (`wait_ms`).

## CLI Commands (`weavetab plugin use realtime <cmd>`)
- `weavetab plugin use realtime status [--wait_ms 2000]`: Inspect live probe and reflex rules.
- `weavetab plugin use realtime reflex-clear`: Clear all active 60Hz reflex rules on the active tab.
- `weavetab plugin use realtime autopilot --goal <text>`: Run bounded click autopilot via CLI.

## Utilities (`/` Prompts & `@` Resources)
- `/realtime_watch`: Snapshot live DOM/canvas state and wire a 60Hz reflex rule.
- `@realtime://feed`: Live JSON feed of newly added DOM elements, reflexes, and canvas entities.
- `@realtime://canvas`: Live inspection of Canvas2D draw count, rAF FPS, and moving bounding boxes.

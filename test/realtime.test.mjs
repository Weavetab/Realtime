import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import CDP from "chrome-remote-interface";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = (f) => import(pathToFileURL(path.join(root, "dist", f)).href);

const chromePath = [
  process.env.CHROME_PATH,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].find((p) => p && fs.existsSync(p));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = 9341;

let proc, tab, profile;

before(async () => {
  if (!chromePath) return;
  profile = fs.mkdtempSync(path.join(os.tmpdir(), "wtrt-"));
  proc = spawn(chromePath, [
    "--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
    "--no-first-run", "--disable-gpu", "about:blank",
  ], { stdio: "ignore" });
  for (let i = 0; i < 60; i++) {
    try {
      tab = await CDP({ port: PORT });
      break;
    } catch {
      await sleep(250);
    }
  }
  assert.ok(tab, "chrome never came up");
  await tab.Page.enable();
  await tab.Runtime.enable();
});

after(async () => {
  await tab?.close();
  proc?.kill();
  await sleep(800);
  // chrome helpers can still hold the profile on windows, it's in tmp so leave it
  if (profile) try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
});

async function open(html) {
  await tab.Page.navigate({ url: "data:text/html;charset=utf-8," + encodeURIComponent(html) });
  await tab.Page.loadEventFired();
}
const ev = async (expr) => (await tab.Runtime.evaluate({ expression: expr, returnByValue: true, awaitPromise: true })).result.value;
const click = async (x, y) => {
  for (const type of ["mousePressed", "mouseReleased"]) {
    await tab.Input.dispatchMouseEvent({ type, x, y, button: "left", clickCount: 1 });
  }
};
const skip = !chromePath && "no chrome found";

test("manifest passes sdk preflight and matches registered tools", async () => {
  const { runPreflight } = await import("@weavetab/sdk");
  const pf = runPreflight(root);
  assert.deepEqual(pf.errors, []);
  // the scope warning goes away with WEAVETAB_OFFICIAL_RELEASE=1, which is how releases run
  const scope = process.env.WEAVETAB_OFFICIAL_RELEASE ? [] : [/reserved for first-party/];
  assert.equal(pf.warnings.length, scope.length, pf.warnings.join("; "));
  scope.forEach((re, i) => assert.match(pf.warnings[i], re));

  const mod = await dist("index.js");
  const names = [];
  await mod.default.onLoad({ config: {}, mcp: { registerTool: (t) => names.push(t.name) }, logger: { info() {} } });
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "weavetab.json"), "utf8"));
  assert.deepEqual(names.sort(), manifest.tools.map((t) => t.name).sort());
  assert.equal(manifest.license, "Apache-2.0");
});

test("only the button that appeared after the click gets a {new} tag", { skip }, async () => {
  const { arm } = await dist("page.js");
  const { tagMap } = await dist("causal.js");
  await open(`<body style="margin:0">
    <button id=old style="position:absolute;left:600px;top:10px;width:80px;height:30px">Confirm</button>
    <button id=del style="position:absolute;left:20px;top:200px;width:80px;height:30px"
      onclick="document.body.insertAdjacentHTML('beforeend','<div id=dlg><button id=nw style=&quot;position:absolute;left:70px;top:230px;width:80px;height:30px&quot;>Confirm</button></div>')">Delete</button></body>`);
  await arm(tab);
  await click(60, 215);
  await sleep(150);
  await ev(`document.getElementById('old').dataset.wtId='1'; document.getElementById('nw').dataset.wtId='2'; 0`);

  const text = '[w:1] button "Confirm"\n[w:2] button "Confirm"';
  const out = await tagMap(tab, { content: [{ type: "text", text }] }, 4000);
  const [l1, l2] = out.content[0].text.split("\n");
  assert.equal(l1, '[w:1] button "Confirm"');
  assert.match(l2, /^\[w:2\] button "Confirm" \{new \d+ms, \d+px from click\}$/);
  const px = Number(/(\d+)px/.exec(l2)[1]);
  assert.ok(px < 80, `distance ${px}`);

  assert.equal(await tagMap(tab, text, 0), undefined, "window of 0 tags nothing");
});

const GAME = `<canvas id=c width=400 height=120 style="position:absolute;left:0;top:0"></canvas><script>
  const x = c.getContext('2d'); let px = 10, ox = 330; window.jumps = 0;
  addEventListener('keydown', e => { if (e.code === 'Space') window.jumps++; });
  (function f(){
    x.fillStyle = '#000'; x.fillRect(0, 0, 400, 120);
    x.fillStyle = '#f00'; x.fillRect(px, 40, 20, 20); px = (px + 5) % 380;
    x.fillStyle = '#0f0'; x.fillRect(ox, 80, 10, 30); ox = ox > 0 ? ox - 4 : 330;
    x.fillStyle = '#fff'; x.fillText('score 1', 5, 15);
    requestAnimationFrame(f);
  })();
</script>`;

test("canvas sample finds the mover, its velocity and ignores the background fill", { skip }, async () => {
  const { canvasTool } = await dist("canvas.js");
  await open(GAME);
  const rep = await canvasTool(tab, { action: "sample", frames: 8 });
  assert.ok(rep.frames >= 2);
  assert.ok(rep.background_fills >= 1);
  const red = rep.entities.find((e) => e.sig.startsWith("rect|20x20|"));
  assert.ok(red, JSON.stringify(rep.entities));
  assert.ok(Math.abs(red.vx - 5) < 0.6 || red.vx < 0, `vx ${red.vx}`); // wrap-around frame can flip sign
  assert.equal(red.vy, 0);
  const green = rep.entities.find((e) => e.sig.startsWith("rect|10x30|"));
  assert.ok(Math.abs(green.vx + 4) < 0.6 || green.vx > 0, `vx ${green.vx}`);
  assert.equal(rep.canvases[0].w, 400);

  assert.equal((await canvasTool(tab, { action: "detach" })).detached, true);
  assert.equal(await ev("typeof window.__wt_cv"), "undefined");
});

test("canvas reflex presses space when the gap closes", { skip }, async () => {
  const { canvasTool } = await dist("canvas.js");
  const { reflexTool, statusTool } = await dist("reflex.js");
  await open(GAME);
  const rep = await canvasTool(tab, { action: "sample", frames: 4 });
  const sigR = rep.entities.find((e) => e.sig.startsWith("rect|20x20|")).sig;
  const sigG = rep.entities.find((e) => e.sig.startsWith("rect|10x30|")).sig;

  await reflexTool(tab, {
    action: "add", id: "jump",
    when: { canvas: { names: { p: sigR, o: sigG }, js: "Math.abs(gap(E.p[0], E.o[0])) < 25" } },
    do: { type: "key", key: "Space" },
    max_hits: 2, cooldown_ms: 50,
  });
  const st = await statusTool(tab, 6000);
  const r = st.reflexes.find((x) => x.id === "jump");
  assert.equal(r.done, "max_hits", JSON.stringify(st));
  assert.ok((await ev("window.jumps")) >= 2);
});

test("reflex with only_new ignores the old button", { skip }, async () => {
  const { reflexTool, statusTool } = await dist("reflex.js");
  await open(`<button id=old onclick="window.o=(window.o||0)+1">Go now</button>`);
  await reflexTool(tab, {
    action: "add", id: "n", when: { selector: "button", text: "go", only_new: true },
    do: { type: "click" }, max_hits: 3, cooldown_ms: 20,
  });
  await sleep(200);
  assert.equal(await ev("window.o || 0"), 0);
  await ev(`document.body.insertAdjacentHTML('beforeend', '<button id=nw onclick="window.n=(window.n||0)+1">Go now</button>'); 0`);
  const st = await statusTool(tab, 3000);
  assert.equal(st.reflexes[0].done, "max_hits");
  assert.equal(await ev("window.n"), 3);
  assert.equal(await ev("window.o || 0"), 0);
});

test("reflex rejects bad input before touching the page", { skip }, async () => {
  const { reflexTool } = await dist("reflex.js");
  await open("<p>x</p>");
  await assert.rejects(reflexTool(tab, { action: "add", when: { selector: "a" }, do: { type: "click_xy" } }), /click_xy needs/);
  await assert.rejects(reflexTool(tab, { action: "add", when: { selector: "a", canvas: { names: {}, js: "1" } }, do: { type: "key", key: "a" } }), /exactly one/);
  await assert.rejects(
    reflexTool(tab, { action: "add", when: { canvas: { names: {}, js: "gap(" } }, do: { type: "key", key: "a" } }),
    /Syntax|Unexpected/i
  );
});

const BANNER = `<button id=del>Delete account</button>
  <div role=dialog id=bn style="position:fixed;left:0;top:100px;background:#eee;padding:10px">
    <button id=set>Settings</button> <button id=acc onclick="bn.remove(); document.body.append('Welcome back')">Accept cookies</button>
  </div>`;

test("autopilot accepts the banner and stops on text", { skip }, async () => {
  const { autopilotTool } = await dist("autopilot.js");
  await open(BANNER);
  const out = await autopilotTool(tab, { goal: "accept cookies", stop_when_text: "welcome" });
  assert.equal(out.stopped, "text");
  assert.equal(out.steps.length, 1);
  assert.equal(out.steps[0].label, "Accept cookies");
  assert.equal(out.steps[0].changed, true);
});

test("autopilot will not click delete unless the goal says so", { skip }, async () => {
  const { autopilotTool } = await dist("autopilot.js");
  await open(`<button onclick="window.hit=1">Delete account</button>`);
  const out = await autopilotTool(tab, { goal: "open account page" });
  assert.equal(out.stopped, "no_match");
  assert.equal(await ev("window.hit || 0"), 0);
  const out2 = await autopilotTool(tab, { goal: "delete account", max_steps: 1 });
  assert.equal(out2.steps.length, 1);
  assert.equal(await ev("window.hit"), 1);
});

test("autopilot gives up on a button whose click changes nothing", { skip }, async () => {
  const { autopilotTool } = await dist("autopilot.js");
  await open(`<button>Next</button>`);
  const out = await autopilotTool(tab, { goal: "click next", max_steps: 5 });
  assert.equal(out.steps.length, 1);
  assert.equal(out.steps[0].changed, false);
  assert.equal(out.stopped, "no_match");
});

test("autopilot takes the model's pick, and falls back when the model is down", { skip }, async () => {
  const { autopilotTool } = await dist("autopilot.js");
  const srv = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: 'sure: {"pick": 1, "done": false}' } }] }));
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${srv.address().port}/v1/chat/completions`;
  const page = `<button onclick="document.body.append('alpha-hit')">Alpha</button><button onclick="document.body.append('beta-hit')">Beta</button>`;
  try {
    await open(page);
    const out = await autopilotTool(tab, { goal: "zzz unrelated", model_url: url, stop_when_text: "beta-hit", max_steps: 3 });
    assert.equal(out.stopped, "text");
    assert.equal(out.steps[0].label, "Beta");
    assert.equal(out.steps[0].via, "model");
  } finally {
    srv.close();
  }

  await open(`<button onclick="document.body.append('welcome')">Welcome tour</button>`);
  const dead = await autopilotTool(tab, { goal: "start welcome tour", model_url: "http://127.0.0.1:9/x", model_timeout_ms: 300, max_steps: 2 });
  assert.ok(dead.model_error);
  assert.equal(dead.steps[0].via, "scorer");
});

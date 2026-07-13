---
name: run-particles-simulator
description: Build, run, and drive the Particles Simulator (Vite + TypeScript + Three.js WebGPU/TSL). Use when asked to start the app, run its dev server, take a screenshot of the 3D scene, check console errors, or run its tests.
---

This is a Vite + TypeScript web app (Three.js `WebGPURenderer`/TSL). Drive it by starting the Vite dev server, then piping commands to the bundled Playwright driver at `.claude/skills/run-particles-simulator/driver.mjs` — `chromium-cli` is not available on this (Windows) host, so this driver is the substitute, with the same "pipe a small command script to a browser session" shape.

All paths below are relative to the repo root (`c:\GoogleDrive\dev\ParticlesSimulator`).

## Prerequisites

Verified on native Windows (Git Bash), not a Linux container — no `xvfb` needed; Playwright's headless Chromium runs directly.

- Node.js (verified with v24.16.0) and npm.
- Playwright's Chromium browser binary, downloaded once per machine (not per-clone — it's cached under `%LOCALAPPDATA%\ms-playwright\`, outside the repo):

```bash
npx playwright install chromium
```

## Setup

```bash
npm install
```

`playwright` is already a `devDependency`, so plain `npm install` pulls in the driver's runtime — only the browser binary above is a separate step.

## Build

No build step needed to run/drive the app in dev mode. `npm run build` (runs `tsc -b && vite build`) exists for a production bundle but isn't part of the agent driving path.

## Run (agent path)

**Keep the dev server running across the whole session** rather than starting/killing it around every check — restarting repeatedly is slower and not needed since the driver opens a fresh page/session each invocation anyway. Only start it if it isn't already up, and only kill it if it's actually misbehaving (stale build, port conflict) or the user asks.

1. Check whether it's already serving before starting a new one:

```bash
curl -sf http://localhost:5173 >/dev/null && echo "already up" || echo "needs start"
```

If it needs starting, launch it in the background and wait for it to actually serve (don't fixed-`sleep`):

```bash
npm run dev &
timeout 30 bash -c 'until curl -sf http://localhost:5173 >/dev/null; do sleep 1; done'
```

2. Pipe a command script to the driver. Each command is one line; `#` starts a comment:

```bash
node .claude/skills/run-particles-simulator/driver.mjs <<'EOF'
nav /
wait-for text=renderer:
screenshot my-check
orbit-drag
screenshot my-check-after-orbit
console --errors
EOF
```

Screenshots land in `.claude/skills/run-particles-simulator/screenshots/<name>.png`, with the most recent always also copied to `.claude/skills/run-particles-simulator/screenshots/latest.png`.

3. Leave the server running for the next check. If you do need to stop it (e.g. before a `git`-affecting operation, or because it's genuinely stuck): find the PID listening on 5173 and kill it — on Windows: `netstat -ano | grep 5173` then `taskkill //F //PID <pid>`; on a real Unix shell: `pkill -f "vite"`.

Driver commands:

| command | what it does |
|---|---|
| `nav <path>` | navigate to `http://localhost:5173<path>` (default `/`) |
| `wait <ms>` | fixed wait |
| `wait-for text=<text>` | poll `document.body.innerText` until it contains `<text>` (30s timeout) |
| `screenshot [name]` | save a PNG; also updates `screenshots/latest.png` |
| `orbit-drag` | drag from canvas center to rotate the `OrbitControls` camera — the one interaction this app always has |
| `click <selector>` | click an element (default position: its center) |
| `click-at <selector> <fraction>` | real click at a fractional x-position within an element's bounding box — e.g. `click-at .tp-sldv 0.5` to set a Tweakpane slider to its midpoint. Unreliable at extreme fractions (≈0.95+); prefer `fill` for exact/edge values |
| `fill <selector> <value>` | fill an `<input>` and press Enter — e.g. Tweakpane's paired `.tp-txtv_i` number field next to a slider. More reliable than `click-at` for exact values |
| `eval <js>` | evaluate JS in the page and print the (JSON-serializable) result |
| `console` | print all captured console/page messages so far |
| `console --errors` | print only `error`/`warning`/`pageerror` messages |

## Run (human path)

```bash
npm run dev   # → prints a http://localhost:5173 URL; open it in a real browser. Ctrl-C to stop.
```

In a real browser with a real GPU, the top-left status line should read `renderer: WebGPU` rather than the WebGL2 fallback (see Gotchas).

## Test

```bash
npx vitest run
```

As of this writing there are no test files yet (`vitest` exits with code 1 and "No test files found" — expected at this stage of the project, not a driver problem). Per the project plan, math-only unit tests (grid indexing, gravity formula, inertia-tensor solve) are intended to land in later milestones alongside the physics code.

---

## Gotchas

- **The panel now has multiple `.tp-txtv_i` / `.tp-sldv` elements (one pair per slider)** — a bare `click .tp-sldv` or `fill .tp-txtv_i` always hits the *first* match in DOM order (folder order top-to-bottom), which silently targets the wrong control as more sliders get added. Playwright's `>> nth=N` selector chaining works directly in any driver command's selector argument (0-indexed) — e.g. `fill .tp-txtv_i >> nth=1 0.005` to hit the second number field. No driver code changes needed; this is native Playwright selector syntax.
- **`chromium-cli` isn't installed on this host** — that's why `driver.mjs` exists instead of the usual heredoc-to-`chromium-cli` pattern. If a future environment does have `chromium-cli` on PATH, prefer it and treat this driver as the fallback.
- **The driver script must run from inside the repo, not a temp/scratch directory.** It's an ESM script that does `import { chromium } from 'playwright'`, resolved via `node_modules` — running it from a path without that `node_modules` in scope fails with `ERR_MODULE_NOT_FOUND`.
- **Playwright's headless Chromium reports `navigator.gpu` as available but then fails adapter negotiation** in this environment specifically (`[warning] No available adapters.`) — `WebGPURenderer` correctly falls back to WebGL2 and logs `THREE.WebGPURenderer: WebGPU is not available, running under WebGL2 backend.`. This is expected in this sandboxed/software-rendered environment, not an app bug — the whole point of `renderer.init()`'s fallback path is to handle exactly this. Don't be alarmed if a screenshot's status line says `WebGL2 (fallback)`; a real user's browser on real GPU hardware is expected to say `WebGPU`.
- **`GPU stall due to ReadPixels` driver-console warnings** show up after every `screenshot` command under the WebGL2 fallback path (screenshotting forces a readback). Harmless noise specific to the fallback path; filter with `console --errors` rather than `console` if it's cluttering output.
- **Installing playwright's browsers is not `npm install`-scoped** — `npx playwright install chromium` downloads to a machine-wide cache (`%LOCALAPPDATA%\ms-playwright\`), not into `node_modules` or the repo. A fresh clone still needs this run once per machine, even though `node_modules/playwright` itself comes from `npm install`.
- **Tweakpane sliders (`.tp-sldv`) silently ignore raw `page.mouse.down/move/up` drag sequences and scripted `dispatchEvent` calls** — no error, the value just doesn't change. A real Playwright `click`/`click-at` (trusted synthetic input) works. `click-at` also becomes unreliable at extreme fractions (observed failing intermittently above ≈0.95, and the failure isn't even consistent run-to-run at the same fraction) — use `fill` on the paired `.tp-txtv_i` number input instead when you need an exact or extreme value (e.g. testing N at exactly 1,000,000).
- **`@types/three` doesn't type `renderer.backend.isWebGPUBackend`** (only declares the base `Backend` class, not the concrete `WebGPUBackend` subclass that has this discriminator at runtime) — see the narrow-cast workaround in `src/utils/backend.ts`. Also, `tweakpane`'s published `.d.ts` files import from `@tweakpane/core`, which isn't pulled in automatically — install it explicitly as a devDependency (`npm install -D @tweakpane/core`) or `tsc` fails with "Property 'addFolder'/'addBinding' does not exist on type 'Pane'" even though it works fine at runtime.
- **Tweakpane boolean bindings render a real `<input type="checkbox" class="tp-ckbv_i">` that Playwright refuses to click ("element is not visible")** — it's visually hidden and a sibling `<label class="tp-ckbv_l">` is the actual clickable surface. Click `.tp-ckbv_l`, not `.tp-ckbv_i`.
- **`window.__debug` is a dev-only hook** (`src/main.ts`, gated on `import.meta.env.DEV`) exposing `{ app, backend, params }` for numeric verification via `eval` — e.g. `eval window.__debug.backend.getSnapshot().positions[0]` to check a value changed, or `eval window.__debug.app.playing` / `eval window.__debug.app.timeScale = 5` to inspect or drive simulation state directly instead of fighting DOM selectors. Prefer this over screenshots whenever the thing being verified is numeric (physics correctness) rather than visual.

## Troubleshooting

- **`Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'playwright'`** when running `driver.mjs`: you ran it from outside the repo (e.g. a scratch/temp directory) or without ever running `npm install` in the repo. Run it via the path shown above, from the repo root.
- **`curl: (7) Failed to connect`** while polling port 5173: the dev server hasn't finished booting yet, or a previous instance is already bound to 5173 and the new one failed to start — check for a stale process on that port (`netstat -ano | grep 5173`) and kill it before retrying.

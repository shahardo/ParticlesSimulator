#!/usr/bin/env node
// Minimal chromium-cli-alike driver for this project, used because the
// `chromium-cli` binary isn't available on this Windows host. Reads a small
// command script from stdin (or a file given as argv[2]), one command per
// line, and runs it against a single persistent browser/page session --
// same shape as a chromium-cli pipe session.
//
// Commands:
//   nav <path>            navigate to BASE_URL + <path> (default path "/")
//   wait <ms>              fixed wait
//   wait-for text=<text>   poll body innerText until it contains <text> (30s timeout)
//   screenshot [name]      save PNG under screenshots/<name|timestamp>.png + screenshots/latest.png
//   orbit-drag             drag from canvas center to rotate the OrbitControls camera
//   click <selector>       click an element
//   click-at <selector> <fraction>   real click at fractional x-position within an
//                          element's bounding box (e.g. to set a Tweakpane slider)
//   fill <selector> <value>   fill an <input> and press Enter (e.g. Tweakpane's
//                          paired number text field -- more reliable than
//                          click-at for exact/extreme values)
//   eval <js>              evaluate JS in page context, print the result
//   console                print all captured console/page messages so far
//   console --errors       print only console errors/warnings + pageerrors
//
// Lines starting with # are comments. Blank lines are ignored.

import { chromium } from 'playwright';
import { mkdirSync, createReadStream, readFileSync, existsSync } from 'node:fs';
import { copyFileSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:5173';
const SCREENSHOT_DIR = path.join(import.meta.dirname, 'screenshots');
mkdirSync(SCREENSHOT_DIR, { recursive: true });

const scriptArg = process.argv[2];
const input = scriptArg && existsSync(scriptArg)
  ? createReadStream(scriptArg)
  : process.stdin;

const browser = await chromium.launch({
  args: ['--no-sandbox', '--enable-unsafe-webgpu', '--enable-features=Vulkan'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

const messages = [];
page.on('console', (msg) => messages.push({ type: msg.type(), text: msg.text() }));
page.on('pageerror', (err) => messages.push({ type: 'pageerror', text: err.message }));

const rl = readline.createInterface({ input, crlfDelay: Infinity });

for await (const raw of rl) {
  const line = raw.trim();
  if (!line || line.startsWith('#')) continue;
  const sp = line.indexOf(' ');
  const cmd = sp === -1 ? line : line.slice(0, sp);
  const rest = sp === -1 ? '' : line.slice(sp + 1).trim();

  try {
    switch (cmd) {
      case 'nav': {
        const url = new URL(rest || '/', BASE_URL).toString();
        await page.goto(url, { waitUntil: 'networkidle' });
        console.log(`[nav] ${url}`);
        break;
      }
      case 'wait': {
        await page.waitForTimeout(Number(rest));
        console.log(`[wait] ${rest}ms`);
        break;
      }
      case 'wait-for': {
        const text = rest.replace(/^text=/, '');
        await page.waitForFunction(
          (t) => document.body.innerText.includes(t),
          text,
          { timeout: 30000 },
        );
        console.log(`[wait-for] found "${text}"`);
        break;
      }
      case 'screenshot': {
        const name = rest || `shot-${Date.now()}`;
        const file = path.join(SCREENSHOT_DIR, `${name}.png`);
        await page.screenshot({ path: file });
        copyFileSync(file, path.join(SCREENSHOT_DIR, 'latest.png'));
        console.log(`[screenshot] ${file}`);
        break;
      }
      case 'orbit-drag': {
        const box = await page.viewportSize();
        const cx = box.width / 2;
        const cy = box.height / 2;
        await page.mouse.move(cx, cy);
        await page.mouse.down();
        await page.mouse.move(cx + 160, cy - 100, { steps: 12 });
        await page.mouse.up();
        await page.waitForTimeout(300);
        console.log('[orbit-drag] done');
        break;
      }
      case 'click-at': {
        // rest = "<css-selector> <fraction 0..1>" -- a real (trusted,
        // Playwright-native) click at that fractional x position within the
        // matched element's bounding box. This is how to set a Tweakpane
        // slider (e.g. `.tp-sldv`) to a specific value: Tweakpane recomputes
        // the value from the absolute click position, but only reacts to
        // genuine trusted input (raw `page.mouse` drag sequences and
        // scripted `dispatchEvent` calls were both silently ignored).
        const idx = rest.lastIndexOf(' ');
        const selector = rest.slice(0, idx);
        const frac = Number(rest.slice(idx + 1));
        const el = await page.$(selector);
        if (!el) throw new Error(`selector not found: ${selector}`);
        const box = await el.boundingBox();
        const x = Math.max(1, Math.min(box.width - 1, box.width * frac));
        await el.click({ position: { x, y: box.height / 2 } });
        console.log(`[click-at] ${selector} -> ${frac}`);
        break;
      }
      case 'fill': {
        // rest = "<css-selector> <value>" -- fills a real <input> (e.g.
        // Tweakpane's paired `.tp-txtv_i` number field next to a slider) and
        // presses Enter. More reliable than clicking at an exact slider
        // fraction, especially near the extreme ends of the range.
        const idx = rest.lastIndexOf(' ');
        const selector = rest.slice(0, idx);
        const value = rest.slice(idx + 1);
        await page.fill(selector, value);
        await page.press(selector, 'Enter');
        console.log(`[fill] ${selector} = ${value}`);
        break;
      }
      case 'click': {
        await page.click(rest);
        console.log(`[click] ${rest}`);
        break;
      }
      case 'eval': {
        const result = await page.evaluate(rest);
        console.log(`[eval] ${JSON.stringify(result)}`);
        break;
      }
      case 'console': {
        const errorsOnly = rest.trim() === '--errors';
        const filtered = errorsOnly
          ? messages.filter((m) => m.type === 'error' || m.type === 'warning' || m.type === 'pageerror')
          : messages;
        for (const m of filtered) console.log(`[${m.type}] ${m.text}`);
        break;
      }
      default:
        console.log(`[!] unknown command: ${cmd}`);
    }
  } catch (err) {
    console.log(`[error running "${line}"] ${err.message}`);
  }
}

await browser.close();

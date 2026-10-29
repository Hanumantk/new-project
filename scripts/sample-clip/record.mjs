// Captures the frames of the sample clip. Needs Playwright (not a project
// dependency): `npx playwright install chromium` once, then see README.md.
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const [url = 'http://localhost:5173/scripts/sample-clip/render.html', outDir = 'sample-clip-frames'] =
  process.argv.slice(2);
const FPS = 30;
const SECONDS = 6;

mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.goto(url);
await page.waitForFunction(() => window.ready, null, { timeout: 30000 });
for (let i = 0; i < FPS * SECONDS; i++) {
  await page.evaluate((t) => window.renderFrame(t), i / FPS);
  await page.locator('canvas').screenshot({ path: `${outDir}/f${String(i).padStart(4, '0')}.png` });
}
await browser.close();
console.log(`Wrote ${FPS * SECONDS} frames to ${outDir}/`);

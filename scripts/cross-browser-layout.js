const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { chromium, firefox, webkit } = require("playwright");

const engines = { chromium, firefox, webkit };
const requested = (process.env.BROWSER_ENGINES || "chromium")
  .split(",")
  .map((name) => name.trim())
  .filter(Boolean);
let serverProcess;

(async () => {
  serverProcess = spawn(process.execPath, ["server.js"], {
    cwd: require("node:path").join(__dirname, ".."),
    env: { ...process.env, PORT: "3110" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitForServer("http://127.0.0.1:3110");

  const results = [];
  for (const name of requested) {
    const browserType = engines[name];
    if (!browserType) throw new Error(`Unsupported browser engine: ${name}`);
    const browser = await browserType.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    const errors = [];
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });

    await page.goto("http://127.0.0.1:3110", { waitUntil: "domcontentloaded" });
    await page.locator("#create-name").fill(`${name} check`);
    await page.locator("#create-form button[type=submit]").click();
    await page.locator("[data-add-ai]").click();
    await page.waitForFunction(() => document.querySelectorAll(".lobby-player").length === 2);
    await page.locator('[data-dice-mode="choice"]').click();
    await page.locator("[data-start]").click();
    await page.locator("#game-view").waitFor({ state: "visible" });
    await page.locator(".board-cell").first().waitFor({ state: "visible" });
    await page.locator("#language-select").selectOption("en");
    await page.waitForFunction(() => document.querySelector('[data-space-index="1"] .cell-name')?.textContent === "Begonia Road");

    const desktop = await layoutMetrics(page);
    assert.equal(desktop.overflowX, 0);
    assert.deepEqual(desktop.clippedLabels, []);
    assert.equal(desktop.prompt, "Opening turn order");
    assert.equal(desktop.zoom, "100%");

    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator("#game-view").waitFor({ state: "visible" });
    const mobile = await layoutMetrics(page);
    assert.equal(mobile.overflowX, 0);
    assert.deepEqual(mobile.clippedLabels, []);
    assert.ok(mobile.board.left >= 0 && mobile.board.right <= 391);
    assert.ok(mobile.toolbar.left >= 0 && mobile.toolbar.right <= 391);
    assert.deepEqual(errors, []);

    results.push({ name, desktop, mobile });
    await context.close();
    await browser.close();
  }

  console.log(JSON.stringify(results, null, 2));
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  if (serverProcess && !serverProcess.killed) serverProcess.kill();
});

async function layoutMetrics(page) {
  return page.evaluate(() => {
    const board = document.querySelector("#board").getBoundingClientRect();
    const toolbar = document.querySelector("#board-toolbar").getBoundingClientRect();
    return {
      board: { left: board.left, right: board.right, width: board.width, height: board.height },
      toolbar: { left: toolbar.left, right: toolbar.right },
      overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      clippedLabels: [...document.querySelectorAll(".cell-name")].filter(
        (label) => label.scrollHeight > label.clientHeight + 1 || label.scrollWidth > label.clientWidth + 1,
      ).map((label) => label.textContent),
      prompt: document.querySelector(".turn-prompt, .opening-order-screen")?.getAttribute("aria-label"),
      zoom: document.querySelector("#board-zoom-value")?.textContent,
    };
  });
}

async function waitForServer(url) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The server normally needs a few hundred milliseconds to bind.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Layout test server did not start");
}

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const path = require("node:path");
const { chromium, firefox, webkit } = require("playwright");

let browser;
let serverProcess;

(async () => {
  const browserEngine = process.env.BROWSER_ENGINE || "chromium";
  const browserType = { chromium, firefox, webkit }[browserEngine];
  if (!browserType) throw new Error(`Unsupported browser engine: ${browserEngine}`);
  const projectDir = path.join(__dirname, "..");
  const outputDir = path.join(projectDir, "test-output");
  await fs.mkdir(outputDir, { recursive: true });
  serverProcess = spawn(process.execPath, ["server.js"], {
    cwd: projectDir,
    env: { ...process.env, PORT: "3107" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitForServer("http://127.0.0.1:3107");
  browser = await browserType.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH }
      : {}),
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });

  await page.goto("http://127.0.0.1:3107", { waitUntil: "domcontentloaded" });
  assert.equal((await page.locator("#language-toggle").textContent()).trim(), "English");
  assert.equal(await page.locator("#language-toggle").getAttribute("aria-label"), "切换到英文");
  await page.locator("#create-name").fill("E2E Player");
  await page.locator("#create-form button[type=submit]").click();
  await page.locator("#lobby-view").waitFor({ state: "visible" });
  const roomCode = await page.locator("#lobby-code").textContent();
  assert.match(roomCode, /^[A-Z2-9]{5}$/);

  await page.locator('[data-dice-mode="choice"]').click();
  await page.waitForFunction(() => document.querySelector('[data-dice-mode="choice"]')?.classList.contains("active"));
  assert.ok(await page.locator('[data-dice-mode="choice"]').evaluate((button) => button.classList.contains("active")));
  const partnerContext = await browser.newContext({ viewport: { width: 1100, height: 800 } });
  const partnerPage = await partnerContext.newPage();
  partnerPage.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(`partner: ${message.text()}`);
  });
  await partnerPage.goto(`http://127.0.0.1:3107?room=${roomCode}`, { waitUntil: "domcontentloaded" });
  await partnerPage.locator("#join-name").fill("Partner");
  await partnerPage.locator("#join-form button[type=submit]").click();
  await partnerPage.locator("#lobby-view").waitFor({ state: "visible" });
  await page.waitForFunction(() => document.querySelectorAll(".lobby-player").length === 2);
  assert.equal(await page.locator(".lobby-player").count(), 2);
  await page.locator("[data-start]").click();
  await page.locator("#game-view").waitFor({ state: "visible" });
  await partnerPage.locator("#game-view").waitFor({ state: "visible" });

  const spectatorContext = await browser.newContext({ viewport: { width: 1100, height: 800 } });
  const spectatorPage = await spectatorContext.newPage();
  spectatorPage.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(`spectator: ${message.text()}`);
  });
  await spectatorPage.goto(`http://127.0.0.1:3107?room=${roomCode}`, { waitUntil: "domcontentloaded" });
  await spectatorPage.locator('[data-entry-tab="watch"]').click();
  await spectatorPage.locator("#watch-name").fill("Observer");
  await spectatorPage.locator("#watch-form button[type=submit]").click();
  await spectatorPage.locator("#game-view").waitFor({ state: "visible" });
  assert.equal(await spectatorPage.locator(".spectator-badge").textContent(), "观战中");
  assert.equal(await spectatorPage.locator(".opening-roll-button").count(), 0);
  assert.equal(await spectatorPage.locator(".lobby-player").count(), 0);
  await spectatorPage.screenshot({ path: path.join(outputDir, "spectator-desktop.png"), fullPage: true });
  await spectatorPage.setViewportSize({ width: 390, height: 844 });
  assert.equal(await spectatorPage.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 0);
  await spectatorPage.screenshot({ path: path.join(outputDir, "spectator-mobile.png"), fullPage: true });
  await spectatorContext.close();

  assert.equal(await page.locator(".opening-order-row").count(), 2);
  for (let attempt = 0; attempt < 6; attempt += 1) {
    for (const candidate of [page, partnerPage]) {
      const orderRoll = candidate.locator('[data-action="roll_for_order"]');
      if (await orderRoll.isVisible()) await orderRoll.click();
    }
    await page.waitForTimeout(650);
    if (await page.locator(".opening-countdown").isVisible()) break;
  }
  await page.locator(".opening-countdown").waitFor({ state: "visible" });
  const countdownValue = Number(await page.locator(".opening-countdown > strong").textContent());
  assert.ok(countdownValue >= 1 && countdownValue <= 3);
  assert.equal(await page.locator(".opening-order-row.is-first").count(), 1);
  await page.screenshot({ path: path.join(outputDir, "opening-order.png"), fullPage: true });
  await page.waitForFunction(() => !document.querySelector(".opening-order-screen"), null, { timeout: 6_000 });
  const currentName = await page.locator(".player-row.current .player-main strong").textContent();
  const hostActsFirst = currentName.includes("E2E Player");
  const turnPage = hostActsFirst ? page : partnerPage;
  const nextPage = hostActsFirst ? partnerPage : page;
  const turnName = hostActsFirst ? "E2E Player" : "Partner";
  const nextName = hostActsFirst ? "Partner" : "E2E Player";
  const turnInitial = turnName.slice(0, 1);
  await turnPage.locator('[data-action="roll"]').waitFor({ state: "visible" });
  await page.locator(".board-cell").first().waitFor();
  assert.equal(await page.locator(".board-cell").count(), 40);

  const desktopLayout = await page.evaluate(() => {
    const board = document.querySelector("#board").getBoundingClientRect();
    const center = document.querySelector("#board-center").getBoundingClientRect();
    const panel = document.querySelector(".game-panel").getBoundingClientRect();
    return {
      board: { width: board.width, height: board.height },
      center: { width: center.width, height: center.height },
      panel: { width: panel.width, height: panel.height },
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
  assert.ok(desktopLayout.board.width > 580);
  assert.ok(Math.abs(desktopLayout.board.width - desktopLayout.board.height) < 2);
  assert.ok(desktopLayout.center.width > 400);
  assert.equal(desktopLayout.overflow, 0);
  assert.equal(await turnPage.locator(".turn-prompt.is-mine").count(), 1);
  assert.equal(await turnPage.locator("#fast-move").isChecked(), false);

  await page.locator('[data-board-zoom="in"]').click();
  await page.locator('[data-board-zoom="in"]').click();
  await page.locator('[data-board-zoom="in"]').click();
  await page.waitForFunction(() => document.querySelector("#board-zoom-value")?.textContent === "145%");
  const zoomedLayout = await page.evaluate(() => ({
    stageWidth: document.querySelector("#board-stage").getBoundingClientRect().width,
    viewportWidth: document.querySelector("#board-viewport").clientWidth,
    scrollWidth: document.querySelector("#board-viewport").scrollWidth,
  }));
  assert.ok(zoomedLayout.stageWidth > desktopLayout.board.width);
  assert.ok(zoomedLayout.scrollWidth > zoomedLayout.viewportWidth);
  const viewportBox = await page.locator("#board-viewport").boundingBox();
  const scrollBeforeDrag = await page.locator("#board-viewport").evaluate((viewport) => viewport.scrollLeft);
  await page.mouse.move(viewportBox.x + viewportBox.width / 2, viewportBox.y + viewportBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(viewportBox.x + viewportBox.width / 2 - 90, viewportBox.y + viewportBox.height / 2, { steps: 5 });
  await page.mouse.up();
  const scrollAfterDrag = await page.locator("#board-viewport").evaluate((viewport) => viewport.scrollLeft);
  assert.ok(scrollAfterDrag > scrollBeforeDrag);
  await page.locator('[data-board-zoom="reset"]').click();
  await page.waitForFunction(() => document.querySelector("#board-zoom-value")?.textContent === "100%");

  const rollButton = turnPage.locator('[data-action="roll"]');
  if (await rollButton.isVisible()) {
    await turnPage.locator("#die-one").selectOption("2");
    await turnPage.locator("#die-two").selectOption("3");
    await rollButton.click();
    await turnPage.locator(".last-move").waitFor({ state: "visible" });
    await turnPage.locator("#moving-token").waitFor({ state: "visible" });
  }
  assert.deepEqual(await turnPage.locator(".die").allTextContents(), ["2", "3"]);
  assert.equal(await turnPage.locator(".cell-token").count(), 2);
  assert.equal(await turnPage.locator('[data-player-token][data-token-space="5"]').textContent(), turnInitial);
  assert.equal(await turnPage.locator(".movement-trail").count(), 1);
  assert.equal((await turnPage.locator(".movement-trail").getAttribute("points")).trim().split(/\s+/).length, 6);
  await turnPage.locator("#moving-token").waitFor({ state: "hidden" });
  const tokenTrackLayout = await turnPage.evaluate(() => {
    const cell = document.querySelector('[data-space-index="5"]').getBoundingClientRect();
    const token = document.querySelector('[data-player-token][data-token-space="5"]').getBoundingClientRect();
    const name = document.querySelector('[data-space-index="5"] .cell-name').getBoundingClientRect();
    return {
      distanceFromOuterEdge: Math.abs(cell.bottom - (token.top + token.height / 2)),
      overlapsName: token.left < name.right && token.right > name.left && token.top < name.bottom && token.bottom > name.top,
    };
  });
  assert.ok(tokenTrackLayout.distanceFromOuterEdge < 7);
  assert.equal(tokenTrackLayout.overlapsName, false);
  await turnPage.evaluate(async () => {
    await document.fonts.ready;
    fitBoardLabels();
  });
  const clippedDesktopLabels = await turnPage.evaluate(() => [...document.querySelectorAll(".cell-name")].filter(
    (label) => label.scrollHeight > label.clientHeight + 1 || label.scrollWidth > label.clientWidth + 1,
  ).map((label) => label.textContent));
  assert.deepEqual(clippedDesktopLabels, []);

  await turnPage.locator("#fast-move").check();
  assert.equal(await turnPage.evaluate(() => localStorage.getItem("classic-estate-fast-movement")), "true");
  await turnPage.locator("#fast-move").uncheck();
  await turnPage.screenshot({ path: path.join(outputDir, "desktop.png"), fullPage: true });

  await turnPage.locator('[data-action="buy"]').click();
  const ownedFill = await turnPage.evaluate(() => ({
    owned: getComputedStyle(document.querySelector('[data-space-index="5"]')).backgroundColor,
    unowned: getComputedStyle(document.querySelector('[data-space-index="15"]')).backgroundColor,
  }));
  assert.notEqual(ownedFill.owned, ownedFill.unowned);
  await turnPage.locator('[data-action="end_turn"]').click();
  await turnPage.waitForFunction(() => document.querySelectorAll(".movement-trail").length === 0);
  await turnPage.waitForFunction((name) => document.querySelector(".turn-summary header strong")?.textContent === name, nextName);
  assert.match(await turnPage.locator(".turn-summary").textContent(), new RegExp(turnName));
  assert.match(await turnPage.locator(".turn-summary").textContent(), /-\$200/);
  assert.equal(await turnPage.locator(".turn-summary-row").count(), 1);
  await nextPage.locator('[data-action="roll"]').waitFor({ state: "visible" });
  await nextPage.locator("#die-one").selectOption("3");
  await nextPage.locator("#die-two").selectOption("3");
  await nextPage.locator('[data-action="roll"]').click();
  await nextPage.locator('[data-action="buy"]').click();
  await nextPage.locator("#die-one").selectOption("1");
  await nextPage.locator("#die-two").selectOption("3");
  await nextPage.locator('[data-action="roll"]').click();
  assert.equal(await nextPage.locator(".turn-summary header strong").textContent(), nextName);
  await nextPage.locator('[data-action="end_turn"]').click();

  await turnPage.locator('[data-action="roll"]').waitFor({ state: "visible" });
  await turnPage.waitForFunction((name) => document.querySelector(".turn-summary header strong")?.textContent === name, turnName);
  assert.equal(await turnPage.locator(".turn-summary header strong").textContent(), turnName);
  assert.match(await turnPage.locator(".turn-summary").textContent(), /-\$100/);
  await turnPage.locator('[data-panel-tab="assets"]').click();
  await turnPage.locator("[data-open-trade]").click();
  await turnPage.locator('#trade-dialog input[name="offerProperty"][value="5"]').check();
  await turnPage.locator('#trade-dialog input[name="requestProperty"][value="6"]').check();
  await turnPage.screenshot({ path: path.join(outputDir, "trade.png"), fullPage: true });
  await turnPage.locator("#trade-form button[type=submit]").click();
  await turnPage.locator('[data-action="reject_trade"]').waitFor({ state: "visible" });
  await nextPage.bringToFront();
  await nextPage.reload({ waitUntil: "domcontentloaded" });
  await nextPage.locator('[data-action="accept_trade"]').waitFor({ state: "visible" });
  assert.equal(await nextPage.locator(".phase-message .trade-asset-chip").count(), 2);
  const tradeChipColors = await nextPage.locator(".phase-message .trade-asset-chip i").evaluateAll((markers) => (
    markers.map((marker) => getComputedStyle(marker).backgroundColor)
  ));
  assert.equal(new Set(tradeChipColors).size, 2);
  assert.ok(tradeChipColors.every((color) => color !== "rgba(0, 0, 0, 0)"));
  await nextPage.locator(".phase-message .trade-asset-chip").first().click();
  await nextPage.locator("#property-dialog").waitFor({ state: "visible" });
  await nextPage.locator("#property-dialog .dialog-close").click();
  await nextPage.locator('[data-action="accept_trade"]').click();
  await turnPage.locator('[data-asset-index="6"]').waitFor({ state: "visible" });
  assert.equal(await turnPage.locator('[data-asset-index="5"]').count(), 0);

  await turnPage.locator('[data-panel-tab="stats"]').click();
  assert.equal(await turnPage.locator(".ownership-cell").count(), 28);
  await turnPage.locator(".ownership-table.vertical").waitFor();
  const groupHeadings = await turnPage.locator(".ownership-table.vertical tbody th").allTextContents();
  assert.deepEqual(groupHeadings.slice(0, 4), ["铁路", "公共设施", "旧城区", "滨水区"]);
  const ownershipColors = await turnPage.evaluate(() => ({
    cell: getComputedStyle(document.querySelector('[data-stats-asset-index="6"]').closest("td")).backgroundColor,
    player: getComputedStyle(document.querySelector('[data-player-token][data-token-space="5"]')).backgroundColor,
  }));
  assert.equal(ownershipColors.cell, ownershipColors.player);
  await turnPage.screenshot({ path: path.join(outputDir, "ownership-stats-desktop.png"), fullPage: true });
  await turnPage.locator('[data-stats-orientation="horizontal"]').click();
  await turnPage.locator(".ownership-table.horizontal").waitFor();
  await turnPage.locator('[data-panel-tab="rules"]').click();
  assert.equal(await turnPage.locator(".rules-section").count(), 7);
  assert.match(await turnPage.locator(".rules-guide").textContent(), /目标与开局/);
  assert.match(await turnPage.locator(".rules-guide").textContent(), /抵押、交易与债务/);

  await turnPage.setViewportSize({ width: 390, height: 844 });
  await turnPage.reload({ waitUntil: "domcontentloaded" });
  await turnPage.locator("#game-view").waitFor({ state: "visible" });
  await turnPage.evaluate(() => {
    const target = document.querySelector('[data-space-index="6"] .building-count');
    target.outerHTML = buildingCountMarkup({ houses: 4 });
    window.I18N?.localize(document.querySelector('[data-space-index="6"]'));
  });
  const mobileBuildingLayout = await turnPage.evaluate(() => {
    const cell = document.querySelector('[data-space-index="6"]').getBoundingClientRect();
    const badge = document.querySelector('[data-space-index="6"] .building-count').getBoundingClientRect();
    const badgeStyle = getComputedStyle(document.querySelector('[data-space-index="6"] .building-count'));
    return {
      display: badgeStyle.display,
      markerCount: document.querySelectorAll('[data-space-index="6"] .building-markers i').length,
      width: badge.width,
      height: badge.height,
      insideCell: badge.left >= cell.left - 1 && badge.right <= cell.right + 1
        && badge.top >= cell.top - 1 && badge.bottom <= cell.bottom + 1,
    };
  });
  assert.equal(mobileBuildingLayout.display, "flex");
  assert.equal(mobileBuildingLayout.markerCount, 4);
  assert.ok(mobileBuildingLayout.width > 0);
  assert.ok(mobileBuildingLayout.height > 0);
  assert.equal(mobileBuildingLayout.insideCell, true);
  const mobileLayout = await turnPage.evaluate(() => {
    const board = document.querySelector("#board").getBoundingClientRect();
    const center = document.querySelector("#board-center").getBoundingClientRect();
    return {
      board: { left: board.left, right: board.right, width: board.width, height: board.height },
      center: { width: center.width, height: center.height, scrollHeight: document.querySelector("#board-center").scrollHeight },
      viewport: document.documentElement.clientWidth,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
  assert.ok(mobileLayout.board.left >= 0);
  assert.ok(mobileLayout.board.right <= mobileLayout.viewport + 1);
  assert.ok(Math.abs(mobileLayout.board.width - mobileLayout.board.height) < 2);
  assert.equal(mobileLayout.overflow, 0);
  await turnPage.evaluate(async () => {
    await document.fonts.ready;
    fitBoardLabels();
  });
  const clippedMobileLabels = await turnPage.evaluate(() => [...document.querySelectorAll(".cell-name")].filter(
    (label) => label.scrollHeight > label.clientHeight + 1 || label.scrollWidth > label.clientWidth + 1,
  ).map((label) => label.textContent));
  assert.deepEqual(clippedMobileLabels, []);
  await turnPage.screenshot({ path: path.join(outputDir, "mobile.png"), fullPage: true });
  await turnPage.locator('[data-panel-tab="stats"]').click();
  const statsMobileLayout = await turnPage.evaluate(() => {
    const panel = document.querySelector(".game-panel").getBoundingClientRect();
    const scroller = document.querySelector(".ownership-scroll");
    return {
      panelLeft: panel.left,
      panelRight: panel.right,
      viewport: document.documentElement.clientWidth,
      tableScrolls: scroller.scrollWidth > scroller.clientWidth,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
  assert.ok(statsMobileLayout.panelLeft >= 0);
  assert.ok(statsMobileLayout.panelRight <= statsMobileLayout.viewport + 1);
  assert.equal(statsMobileLayout.tableScrolls, true);
  assert.equal(statsMobileLayout.overflow, 0);
  await turnPage.screenshot({ path: path.join(outputDir, "ownership-stats-mobile.png"), fullPage: true });
  await turnPage.locator('[data-panel-tab="rules"]').click();
  assert.equal(await turnPage.locator(".rules-section").count(), 7);
  assert.equal(await turnPage.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 0);
  await turnPage.screenshot({ path: path.join(outputDir, "rules-mobile.png"), fullPage: true });

  await turnPage.setViewportSize({ width: 1280, height: 900 });
  await turnPage.evaluate(({ bankruptName, creditorName }) => {
    const bankrupt = ui.state.players.find((player) => player.name === bankruptName);
    const creditor = ui.state.players.find((player) => player.name === creditorName);
    ui.state.lastBankruptcy = {
      id: "e2e-bankruptcy",
      playerId: bankrupt.id,
      creditorId: creditor.id,
      properties: [1, 5],
      at: Date.now(),
    };
    render();
  }, { bankruptName: nextName, creditorName: turnName });
  await turnPage.locator("#bankruptcy-notice").waitFor({ state: "visible" });
  assert.match(await turnPage.locator("#bankruptcy-content").textContent(), new RegExp(nextName));
  assert.match(await turnPage.locator("#bankruptcy-content").textContent(), new RegExp(turnName));
  assert.equal(await turnPage.locator("[data-bankruptcy-space-index]").count(), 2);
  await turnPage.screenshot({ path: path.join(outputDir, "bankruptcy-desktop.png"), fullPage: true });
  await turnPage.locator("#bankruptcy-notice").waitFor({ state: "hidden", timeout: 4_000 });

  await turnPage.evaluate(() => {
    ui.state.status = "finished";
    ui.state.phase = "finished";
    ui.state.winnerId = ui.state.viewerId;
    render();
  });
  await turnPage.locator("#victory-dialog").waitFor({ state: "visible" });
  assert.match(await turnPage.locator("#victory-content").textContent(), new RegExp(turnName));
  assert.equal(await turnPage.locator("[data-victory-close]").count(), 1);
  assert.equal(await turnPage.locator("[data-victory-home]").count(), 1);
  await turnPage.screenshot({ path: path.join(outputDir, "victory-desktop.png"), fullPage: true });

  await turnPage.setViewportSize({ width: 390, height: 844 });
  const victoryMobileLayout = await turnPage.evaluate(() => {
    const dialog = document.querySelector("#victory-dialog").getBoundingClientRect();
    return {
      left: dialog.left,
      right: dialog.right,
      viewport: document.documentElement.clientWidth,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
  assert.ok(victoryMobileLayout.left >= 0);
  assert.ok(victoryMobileLayout.right <= victoryMobileLayout.viewport + 1);
  assert.equal(victoryMobileLayout.overflow, 0);
  await turnPage.screenshot({ path: path.join(outputDir, "victory-mobile.png"), fullPage: true });
  await turnPage.locator("[data-victory-close]").click();
  await turnPage.locator("#victory-dialog").waitFor({ state: "hidden" });

  const quoteContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const quotePage = await quoteContext.newPage();
  quotePage.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(`quote: ${message.text()}`);
  });
  await quotePage.goto("http://127.0.0.1:3107", { waitUntil: "domcontentloaded" });
  await quotePage.locator("#create-name").fill("Quote Player");
  await quotePage.locator("#create-form button[type=submit]").click();
  await quotePage.locator("#lobby-view").waitFor({ state: "visible" });
  await quotePage.locator("[data-add-ai]").click();
  await quotePage.waitForFunction(() => document.querySelectorAll(".lobby-player").length === 2);
  await quotePage.locator('[data-dice-mode="choice"]').click();
  await quotePage.locator("[data-start]").click();
  await quotePage.locator("#game-view").waitFor({ state: "visible" });
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const orderRoll = quotePage.locator('[data-action="roll_for_order"]');
    if (await orderRoll.isVisible()) await orderRoll.click();
    await quotePage.waitForTimeout(650);
    if (await quotePage.locator(".opening-countdown").isVisible()) break;
  }
  await quotePage.locator(".opening-countdown").waitFor({ state: "visible" });
  await quotePage.locator('[data-action="roll"]').waitFor({ state: "visible", timeout: 20_000 });
  const quoteSpaceIndex = await quotePage.evaluate(() => (
    [3, 5, 6, 8, 9, 11, 12].find((index) => !document.querySelector(`[data-space-index="${index}"]`).classList.contains("owned"))
  ));
  const quoteDieOne = Math.min(6, quoteSpaceIndex - 1);
  const quoteDieTwo = quoteSpaceIndex - quoteDieOne;
  await quotePage.locator("#die-one").selectOption(String(quoteDieOne));
  await quotePage.locator("#die-two").selectOption(String(quoteDieTwo));
  await quotePage.locator('[data-action="roll"]').click();
  await quotePage.locator('[data-action="buy"]').click();
  await quotePage.locator('[data-panel-tab="assets"]').click();
  await quotePage.locator("[data-open-trade]").click();
  await quotePage.locator(`#trade-dialog input[name="offerProperty"][value="${quoteSpaceIndex}"]`).check();
  await quotePage.locator("[data-ai-quote]").click();
  await quotePage.waitForFunction(
    () => Number(document.querySelector('input[name="requestCash"]')?.value) > 0,
  );
  const quotedCash = Number(await quotePage.locator('input[name="requestCash"]').inputValue());
  assert.equal(await quotePage.locator('input[name="offerCash"]').inputValue(), "0");
  assert.ok(quotedCash > 0);
  assert.match(await quotePage.locator("[data-ai-quote-status]").textContent(), new RegExp(`AI 愿意支付你 \\$${quotedCash}`));
  await quotePage.screenshot({ path: path.join(outputDir, "ai-quote-desktop.png"), fullPage: true });

  await quotePage.setViewportSize({ width: 390, height: 844 });
  const quoteMobileLayout = await quotePage.evaluate(() => {
    const dialog = document.querySelector("#trade-dialog").getBoundingClientRect();
    return {
      left: dialog.left,
      right: dialog.right,
      viewport: document.documentElement.clientWidth,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
  assert.ok(quoteMobileLayout.left >= 0);
  assert.ok(quoteMobileLayout.right <= quoteMobileLayout.viewport + 1);
  assert.equal(quoteMobileLayout.overflow, 0);
  await quotePage.screenshot({ path: path.join(outputDir, "ai-quote-mobile.png"), fullPage: true });
  await quoteContext.close();

  const cardContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const cardPage = await cardContext.newPage();
  cardPage.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(`card: ${message.text()}`);
  });
  await cardPage.goto("http://127.0.0.1:3107", { waitUntil: "domcontentloaded" });
  await cardPage.locator("#create-name").fill("Card Player");
  await cardPage.locator("#create-form button[type=submit]").click();
  await cardPage.locator("#lobby-view").waitFor({ state: "visible" });
  await cardPage.locator("[data-add-ai]").click();
  await cardPage.waitForFunction(() => document.querySelectorAll(".lobby-player").length === 2);
  await cardPage.locator('[data-dice-mode="choice"]').click();
  await cardPage.waitForFunction(() => document.querySelector('[data-dice-mode="choice"]')?.classList.contains("active"));
  await cardPage.locator("[data-start]").click();
  await cardPage.locator("#game-view").waitFor({ state: "visible" });
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const orderRoll = cardPage.locator('[data-action="roll_for_order"]');
    if (await orderRoll.isVisible()) await orderRoll.click();
    await cardPage.waitForTimeout(650);
    if (await cardPage.locator(".opening-countdown").isVisible()) break;
  }
  await cardPage.locator('[data-action="roll"]').waitFor({ state: "visible", timeout: 20_000 });
  await cardPage.locator("#die-one").selectOption("3");
  await cardPage.locator("#die-two").selectOption("4");
  await cardPage.locator('[data-action="roll"]').click();
  await cardPage.locator("#card-dialog").waitFor({ state: "visible" });
  assert.match(await cardPage.locator("#card-content").textContent(), /机会卡/);
  assert.equal(await cardPage.locator("[data-confirm-card]").count(), 1);
  await cardPage.screenshot({ path: path.join(outputDir, "chance-confirm-desktop.png"), fullPage: true });
  await cardPage.setViewportSize({ width: 390, height: 844 });
  const cardMobileLayout = await cardPage.evaluate(() => {
    const dialog = document.querySelector("#card-dialog").getBoundingClientRect();
    return {
      left: dialog.left,
      right: dialog.right,
      viewport: document.documentElement.clientWidth,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
  assert.ok(cardMobileLayout.left >= 0);
  assert.ok(cardMobileLayout.right <= cardMobileLayout.viewport + 1);
  assert.equal(cardMobileLayout.overflow, 0);
  await cardPage.screenshot({ path: path.join(outputDir, "chance-confirm-mobile.png"), fullPage: true });
  await cardPage.locator("[data-confirm-card]").click();
  await cardPage.locator("#card-dialog").waitFor({ state: "hidden" });
  await cardContext.close();

  const englishContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await englishContext.addInitScript(() => localStorage.setItem("classic-estate-language", "en"));
  const englishPage = await englishContext.newPage();
  englishPage.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(`english: ${message.text()}`);
  });
  await englishPage.goto("http://127.0.0.1:3107", { waitUntil: "domcontentloaded" });
  assert.equal(await englishPage.locator("html").getAttribute("lang"), "en");
  assert.equal((await englishPage.locator("#language-toggle").textContent()).trim(), "中文");
  assert.equal(await englishPage.locator("#language-toggle").getAttribute("aria-label"), "Switch to Chinese");
  assert.equal(await englishPage.locator('[data-entry-tab="create"]').textContent(), "Create Room");
  assert.equal(await englishPage.locator('[data-entry-tab="join"]').textContent(), "Join Room");
  assert.equal(await englishPage.locator('[data-entry-tab="watch"]').textContent(), "Watch");
  await englishPage.screenshot({ path: path.join(outputDir, "english-home.png"), fullPage: true });
  await englishPage.locator("#create-name").fill("English Player");
  await englishPage.locator("#create-form button[type=submit]").click();
  await englishPage.locator("#lobby-view").waitFor({ state: "visible" });
  await englishPage.locator("[data-add-ai]").click();
  await englishPage.waitForFunction(() => document.querySelectorAll(".lobby-player").length === 2);
  assert.match(await englishPage.locator("#lobby-players").textContent(), /Alpha/);
  assert.match(await englishPage.locator("#lobby-mode").textContent(), /Dice mode/);
  await englishPage.locator("[data-start]").click();
  await englishPage.locator("#game-view").waitFor({ state: "visible" });
  assert.match(await englishPage.locator(".opening-order-screen").textContent(), /Roll for turn order/);
  assert.doesNotMatch(await englishPage.locator(".opening-order-screen").textContent(), /[\p{Script=Han}]/u);
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const orderRoll = englishPage.locator('[data-action="roll_for_order"]');
    if (await orderRoll.isVisible()) await orderRoll.click();
    await englishPage.waitForTimeout(650);
    if (await englishPage.locator(".opening-countdown").isVisible()) break;
  }
  await englishPage.locator(".opening-countdown").waitFor({ state: "visible" });
  await englishPage.locator('[data-action="roll"]').waitFor({ state: "visible", timeout: 20_000 });
  assert.equal(await englishPage.locator('[data-space-index="1"] .cell-name').textContent(), "Begonia Road");
  const englishPanelTabs = (await englishPage.locator(".panel-tab").allTextContents()).map((label) => label.trim());
  assert.deepEqual(englishPanelTabs, ["Players", "Assets", "Log", "Stats", "Rules"]);
  await englishPage.locator('[data-panel-tab="rules"]').click();
  assert.equal(await englishPage.locator(".rules-section").count(), 7);
  assert.match(await englishPage.locator(".rules-guide").textContent(), /Goal and setup/);
  assert.doesNotMatch(await englishPage.locator(".rules-guide").textContent(), /[\p{Script=Han}]/u);
  await englishPage.locator('[data-space-index="1"]').click();
  assert.match(await englishPage.locator("#property-content").textContent(), /Purchase price/);
  assert.doesNotMatch(await englishPage.locator("#property-content").textContent(), /[\p{Script=Han}]/u);
  await englishPage.locator("#property-dialog .dialog-close").click();
  await englishPage.locator('[data-panel-tab="assets"]').click();
  await englishPage.locator("[data-open-trade]").click();
  assert.match(await englishPage.locator("#trade-content").textContent(), /Start Trade/);
  assert.match(await englishPage.locator("#trade-content").textContent(), /Ask AI for Price/);
  assert.doesNotMatch(await englishPage.locator("#trade-content").textContent(), /[\p{Script=Han}]/u);
  await englishPage.locator("#trade-dialog .trade-close").click();
  await englishPage.screenshot({ path: path.join(outputDir, "english-game-desktop.png"), fullPage: true });
  await englishPage.setViewportSize({ width: 390, height: 844 });
  await englishPage.reload({ waitUntil: "domcontentloaded" });
  const englishMobileLayout = await englishPage.evaluate(() => ({
    width: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    languageRight: document.querySelector(".language-control").getBoundingClientRect().right,
    connectionRight: document.querySelector("#connection").getBoundingClientRect().right,
  }));
  assert.equal(englishMobileLayout.scrollWidth, englishMobileLayout.width);
  assert.ok(englishMobileLayout.languageRight <= englishMobileLayout.width);
  assert.ok(englishMobileLayout.connectionRight <= englishMobileLayout.width);
  await englishPage.screenshot({ path: path.join(outputDir, "english-game-mobile.png"), fullPage: true });
  await englishContext.close();

  const toggleContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const togglePage = await toggleContext.newPage();
  await togglePage.goto("http://127.0.0.1:3107", { waitUntil: "domcontentloaded" });
  assert.equal((await togglePage.locator("#language-toggle").textContent()).trim(), "English");
  await togglePage.locator("#language-toggle").click();
  await togglePage.waitForFunction(() => document.documentElement.lang === "en");
  assert.equal((await togglePage.locator("#language-toggle").textContent()).trim(), "中文");
  await toggleContext.close();

  assert.deepEqual(consoleErrors, []);
  console.log(JSON.stringify({ browserEngine, roomCode, desktopLayout, mobileLayout, statsMobileLayout, victoryMobileLayout, quoteMobileLayout, englishMobileLayout }, null, 2));
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(async () => {
  if (browser) await browser.close();
  if (serverProcess && !serverProcess.killed) serverProcess.kill();
});

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
  throw new Error("本地测试服务器未能启动");
}

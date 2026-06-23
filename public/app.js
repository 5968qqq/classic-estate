const ui = {
  state: null,
  session: loadSession(),
  entryTab: "create",
  panelTab: "players",
  statsOrientation: "vertical",
  tradeTargetId: null,
  pollBusy: false,
  toastTimer: null,
  victoryShownFor: null,
  boardZoom: loadNumber("classic-estate-board-zoom", 1),
  fastMovement: localStorage.getItem("classic-estate-fast-movement") === "true",
  movementQueue: Promise.resolve(),
  movementBusy: false,
  suppressBoardClick: false,
  labelFitFrame: null,
  orderCountdownTimer: null,
};

const elements = {
  home: document.querySelector("#home-view"),
  lobby: document.querySelector("#lobby-view"),
  game: document.querySelector("#game-view"),
  roomMeta: document.querySelector("#room-meta"),
  connection: document.querySelector("#connection"),
  board: document.querySelector("#board"),
  boardToolbar: document.querySelector("#board-toolbar"),
  boardViewport: document.querySelector("#board-viewport"),
  boardStage: document.querySelector("#board-stage"),
  movementTrails: document.querySelector("#movement-trails"),
  playerTokens: document.querySelector("#player-tokens"),
  movingToken: document.querySelector("#moving-token"),
  zoomValue: document.querySelector("#board-zoom-value"),
  fastMove: document.querySelector("#fast-move"),
  center: document.querySelector("#board-center"),
  panel: document.querySelector("#panel-content"),
  bank: document.querySelector("#bank-status"),
  dialog: document.querySelector("#property-dialog"),
  propertyContent: document.querySelector("#property-content"),
  tradeDialog: document.querySelector("#trade-dialog"),
  tradeContent: document.querySelector("#trade-content"),
  victoryDialog: document.querySelector("#victory-dialog"),
  victoryContent: document.querySelector("#victory-content"),
  toast: document.querySelector("#toast"),
};

const languageSelect = document.querySelector("#language-select");
languageSelect.value = window.I18N?.locale || "zh-CN";
languageSelect.addEventListener("change", () => window.I18N?.setLocale(languageSelect.value));
window.I18N?.localize(document);

document.querySelectorAll("[data-entry-tab]").forEach((button) => {
  button.addEventListener("click", () => switchEntryTab(button.dataset.entryTab));
});

document.querySelector("#create-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const name = new FormData(event.currentTarget).get("name");
  await enterRoom(() => api("/api/rooms", { method: "POST", body: { name } }));
});

document.querySelector("#join-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const code = String(form.get("code") || "").trim().toUpperCase();
  const name = form.get("name");
  await enterRoom(() => api(`/api/rooms/${encodeURIComponent(code)}/join`, { method: "POST", body: { name } }));
});

document.querySelector("#copy-room").addEventListener("click", copyInvite);
document.querySelector("#lobby-actions").addEventListener("click", handleLobbyClick);
document.querySelector("#lobby-players").addEventListener("click", handleLobbyClick);
document.querySelector("#lobby-mode").addEventListener("click", handleLobbyClick);
elements.roomMeta.addEventListener("click", handleRoomMetaClick);
elements.board.addEventListener("click", handleBoardClick);
elements.boardToolbar.addEventListener("click", handleBoardToolbarClick);
elements.fastMove.addEventListener("change", handleFastMovementChange);
elements.center.addEventListener("click", handleCenterClick);
elements.panel.addEventListener("click", handlePanelClick);
elements.propertyContent.addEventListener("click", handlePropertyAction);
elements.tradeContent.addEventListener("change", handleTradeChange);
elements.tradeContent.addEventListener("click", handleTradeClick);
elements.tradeContent.addEventListener("submit", handleTradeSubmit);
document.querySelector(".dialog-close").addEventListener("click", () => elements.dialog.close());
document.querySelector(".trade-close").addEventListener("click", () => elements.tradeDialog.close());
elements.victoryDialog.addEventListener("click", handleVictoryClick);
document.querySelectorAll("[data-panel-tab]").forEach((button) => {
  button.addEventListener("click", () => {
    ui.panelTab = button.dataset.panelTab;
    document.querySelectorAll("[data-panel-tab]").forEach((candidate) => {
      const active = candidate.dataset.panelTab === ui.panelTab;
      candidate.classList.toggle("active", active);
      candidate.setAttribute("aria-selected", String(active));
    });
    renderPanel();
  });
});

window.addEventListener("online", () => setConnection(true));
window.addEventListener("offline", () => setConnection(false));
window.addEventListener("resize", scheduleBoardLayout);
installBoardPanning();
elements.fastMove.checked = ui.fastMovement;
document.fonts?.ready.then(scheduleBoardLayout);

initialize();

async function initialize() {
  const roomFromUrl = new URLSearchParams(location.search).get("room");
  if (roomFromUrl) {
    document.querySelector("#join-code").value = roomFromUrl.toUpperCase().slice(0, 5);
    switchEntryTab("join");
  }

  if (ui.session) {
    try {
      ui.state = await fetchState();
      setConnection(true);
    } catch (error) {
      clearSession();
      showToast(error.message, true);
    }
  }
  render();
  window.setInterval(pollState, 500);
}

function switchEntryTab(tab) {
  ui.entryTab = tab;
  document.querySelectorAll("[data-entry-tab]").forEach((button) => {
    const active = button.dataset.entryTab === tab;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  });
  document.querySelector("#create-form").hidden = tab !== "create";
  document.querySelector("#join-form").hidden = tab !== "join";
}

async function enterRoom(request) {
  try {
    const result = await request();
    ui.session = { code: result.code, token: result.token };
    ui.state = result.state;
    localStorage.setItem("classic-estate-session", JSON.stringify(ui.session));
    history.replaceState(null, "", `?room=${encodeURIComponent(result.code)}`);
    setConnection(true);
    render();
  } catch (error) {
    showToast(error.message, true);
  }
}

async function pollState() {
  if (!ui.session || ui.pollBusy || document.hidden) return;
  ui.pollBusy = true;
  try {
    const next = await fetchState();
    setConnection(true);
    if (!ui.state || next.version !== ui.state.version) {
      applyState(next, true);
    }
  } catch (error) {
    setConnection(false);
    if (/不存在|凭证|does not exist|session is invalid/i.test(error.message)) {
      clearSession();
      render();
      showToast(error.message, true);
    }
  } finally {
    ui.pollBusy = false;
  }
}

function fetchState() {
  return api(`/api/rooms/${encodeURIComponent(ui.session.code)}/state?token=${encodeURIComponent(ui.session.token)}`);
}

function applyState(next, animateMovements) {
  const previousIds = new Set((ui.state?.turn?.movements || []).map((movement) => movement.id));
  const newMovements = (next.turn?.movements || []).filter((movement) => !previousIds.has(movement.id));
  ui.state = next;
  render();
  if (animateMovements && newMovements.length && !ui.fastMovement) {
    ui.movementQueue = ui.movementQueue.then(() => playMovementSequence(newMovements));
  }
}

async function sendAction(action) {
  if (!ui.session) return false;
  try {
    const next = await api(`/api/rooms/${encodeURIComponent(ui.session.code)}/action`, {
      method: "POST",
      body: { token: ui.session.token, action },
    });
    applyState(next, true);
    return true;
  } catch (error) {
    showToast(error.message, true);
    return false;
  }
}

function setBoardZoom(value) {
  const viewport = elements.boardViewport;
  const oldWidth = Math.max(viewport.scrollWidth, 1);
  const oldHeight = Math.max(viewport.scrollHeight, 1);
  const focusX = (viewport.scrollLeft + viewport.clientWidth / 2) / oldWidth;
  const focusY = (viewport.scrollTop + viewport.clientHeight / 2) / oldHeight;
  ui.boardZoom = Math.max(0.65, Math.min(1.6, Math.round(value * 20) / 20));
  localStorage.setItem("classic-estate-board-zoom", String(ui.boardZoom));
  updateBoardLayout();
  requestAnimationFrame(() => {
    viewport.scrollLeft = focusX * viewport.scrollWidth - viewport.clientWidth / 2;
    viewport.scrollTop = focusY * viewport.scrollHeight - viewport.clientHeight / 2;
  });
}

function scheduleBoardLayout() {
  requestAnimationFrame(() => {
    updateBoardLayout();
    fitBoardLabels();
  });
}

function updateBoardLayout() {
  if (!elements.board || elements.game.hidden) return;
  const baseSize = elements.board.offsetWidth;
  elements.boardStage.style.width = `${Math.round(baseSize * ui.boardZoom)}px`;
  elements.boardStage.style.height = `${Math.round(baseSize * ui.boardZoom)}px`;
  elements.board.style.transform = `scale(${ui.boardZoom})`;
  elements.zoomValue.textContent = `${Math.round(ui.boardZoom * 100)}%`;
}

function installBoardPanning() {
  const viewport = elements.boardViewport;
  let drag = null;
  viewport.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    drag = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      left: viewport.scrollLeft,
      top: viewport.scrollTop,
      active: false,
    };
  });
  viewport.addEventListener("pointermove", (event) => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - drag.x;
    const deltaY = event.clientY - drag.y;
    if (!drag.active && Math.hypot(deltaX, deltaY) < 5) return;
    if (!drag.active) viewport.setPointerCapture?.(event.pointerId);
    drag.active = true;
    ui.suppressBoardClick = true;
    viewport.classList.add("dragging");
    viewport.scrollLeft = drag.left - deltaX;
    viewport.scrollTop = drag.top - deltaY;
    event.preventDefault();
  });
  const finishDrag = (event) => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    const wasActive = drag.active;
    drag = null;
    viewport.classList.remove("dragging");
    if (wasActive) setTimeout(() => { ui.suppressBoardClick = false; }, 0);
  };
  viewport.addEventListener("pointerup", finishDrag);
  viewport.addEventListener("pointercancel", finishDrag);
}

async function handleLobbyClick(event) {
  const addAi = event.target.closest("[data-add-ai]");
  const start = event.target.closest("[data-start]");
  const remove = event.target.closest("[data-remove-player]");
  const diceMode = event.target.closest("[data-dice-mode]");
  try {
    if (diceMode) {
      await sendAction({ type: "set_dice_mode", mode: diceMode.dataset.diceMode });
      return;
    } else if (addAi) {
      ui.state = await api(`/api/rooms/${ui.session.code}/ai`, {
        method: "POST",
        body: { token: ui.session.token },
      });
    } else if (start) {
      await sendAction({ type: "start" });
      return;
    } else if (remove) {
      ui.state = await api(`/api/rooms/${ui.session.code}/remove`, {
        method: "POST",
        body: { token: ui.session.token, playerId: remove.dataset.removePlayer },
      });
    } else {
      return;
    }
    render();
  } catch (error) {
    showToast(error.message, true);
  }
}

function handleRoomMetaClick(event) {
  if (event.target.closest("[data-copy-room]")) copyInvite();
  if (event.target.closest("[data-leave-room]")) {
    clearSession();
    history.replaceState(null, "", "/");
    render();
  }
}

function handleBoardClick(event) {
  if (ui.suppressBoardClick) return;
  const cell = event.target.closest("[data-space-index]");
  if (cell) openProperty(Number(cell.dataset.spaceIndex));
}

function handleBoardToolbarClick(event) {
  const button = event.target.closest("[data-board-zoom]");
  if (!button) return;
  const action = button.dataset.boardZoom;
  const next = action === "reset" ? 1 : ui.boardZoom + (action === "in" ? 0.15 : -0.15);
  setBoardZoom(next);
}

function handleFastMovementChange() {
  ui.fastMovement = elements.fastMove.checked;
  localStorage.setItem("classic-estate-fast-movement", String(ui.fastMovement));
}

function handlePanelClick(event) {
  const asset = event.target.closest("[data-asset-index]");
  const position = event.target.closest("[data-position-index]");
  const trade = event.target.closest("[data-open-trade]");
  const statsAsset = event.target.closest("[data-stats-asset-index]");
  const statsOrientation = event.target.closest("[data-stats-orientation]");
  if (asset) openProperty(Number(asset.dataset.assetIndex));
  if (position) openProperty(Number(position.dataset.positionIndex));
  if (trade) openTradeDialog();
  if (statsAsset) openProperty(Number(statsAsset.dataset.statsAssetIndex));
  if (statsOrientation) {
    ui.statsOrientation = statsOrientation.dataset.statsOrientation;
    renderStats();
  }
}

function handleCenterClick(event) {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const type = button.dataset.action;
  if (type === "bid") {
    const amount = Number(document.querySelector("#auction-bid")?.value);
    sendAction({ type, amount });
  } else if (type === "roll" && ui.state.settings?.diceMode === "choice") {
    const dieOne = Number(document.querySelector("#die-one")?.value);
    const dieTwo = Number(document.querySelector("#die-two")?.value);
    sendAction({ type, dice: [dieOne, dieTwo] });
  } else {
    sendAction({ type });
  }
}

async function handlePropertyAction(event) {
  const button = event.target.closest("[data-property-action]");
  if (!button) return;
  await sendAction({
    type: button.dataset.propertyAction,
    spaceIndex: Number(button.dataset.spaceIndex),
  });
  elements.dialog.close();
}

function handleTradeChange(event) {
  if (event.target.matches("#trade-target")) {
    ui.tradeTargetId = event.target.value;
    renderTradeDialog();
  } else if (event.target.matches('input[name="offerProperty"], input[name="requestProperty"]')) {
    clearAiQuote(true);
  } else if (event.target.matches('input[name="offerCash"], input[name="requestCash"]')) {
    clearAiQuote(false);
  }
}

async function handleTradeClick(event) {
  const button = event.target.closest("[data-ai-quote]");
  if (!button) return;
  const form = button.closest("form");
  const status = form.querySelector("[data-ai-quote-status]");
  const data = new FormData(form);
  button.disabled = true;
  status.hidden = false;
  status.classList.remove("error");
  status.textContent = "AI 正在估价...";
  try {
    const quote = await api(`/api/rooms/${encodeURIComponent(ui.session.code)}/trade-quote`, {
      method: "POST",
      body: {
        token: ui.session.token,
        targetId: String(data.get("targetId") || ""),
        offerProperties: data.getAll("offerProperty").map(Number),
        requestProperties: data.getAll("requestProperty").map(Number),
      },
    });
    form.elements.offerCash.value = quote.offerCash;
    form.elements.requestCash.value = quote.requestCash;
    form.dataset.aiQuote = "true";
    if (quote.offerCash > 0) {
      status.textContent = `AI 报价：你需要支付 $${money(quote.offerCash)}。`;
    } else if (quote.requestCash > 0) {
      status.textContent = `AI 报价：AI 愿意支付你 $${money(quote.requestCash)}。`;
    } else {
      status.textContent = "AI 报价：当前地块可以直接交换，不需要补现金。";
    }
  } catch (error) {
    status.classList.add("error");
    status.textContent = error.message;
  } finally {
    button.disabled = false;
    window.I18N?.localize(status);
  }
}

function clearAiQuote(resetCash) {
  const form = elements.tradeContent.querySelector("#trade-form");
  if (!form || form.dataset.aiQuote !== "true") return;
  if (resetCash) {
    form.elements.offerCash.value = 0;
    form.elements.requestCash.value = 0;
  }
  form.dataset.aiQuote = "false";
  const status = form.querySelector("[data-ai-quote-status]");
  if (status) status.hidden = true;
}

async function handleTradeSubmit(event) {
  event.preventDefault();
  const form = new FormData(event.target);
  const offer = {
    cash: Number(form.get("offerCash") || 0),
    properties: form.getAll("offerProperty").map(Number),
  };
  const request = {
    cash: Number(form.get("requestCash") || 0),
    properties: form.getAll("requestProperty").map(Number),
  };
  if ((!offer.cash && !offer.properties.length) || (!request.cash && !request.properties.length)) {
    showToast("交易双方都要提供现金或地产", true);
    return;
  }
  const success = await sendAction({
    type: "offer_trade",
    targetId: String(form.get("targetId") || ""),
    offer,
    request,
  });
  if (success) elements.tradeDialog.close();
}

function render() {
  const hasRoom = Boolean(ui.state && ui.session);
  elements.home.hidden = hasRoom;
  elements.lobby.hidden = !hasRoom || ui.state.status !== "lobby";
  elements.game.hidden = !hasRoom || ui.state.status === "lobby";
  elements.roomMeta.hidden = !hasRoom;

  if (!hasRoom) {
    elements.roomMeta.innerHTML = "";
    window.I18N?.localize(document);
    return;
  }

  elements.roomMeta.innerHTML = `
    <span>房间 <strong>${escapeHtml(ui.state.code)}</strong></span>
    <button class="icon-button" type="button" data-copy-room title="复制邀请链接" aria-label="复制邀请链接">
      <svg aria-hidden="true"><use href="/icons.svg#copy"></use></svg>
    </button>
    <button class="icon-button" type="button" data-leave-room title="离开房间" aria-label="离开房间">
      <svg aria-hidden="true"><use href="/icons.svg#log-in"></use></svg>
    </button>`;

  if (ui.state.status === "lobby") renderLobby();
  else renderGame();
  window.I18N?.localize(document);
}

function renderLobby() {
  document.querySelector("#lobby-code").textContent = ui.state.code;
  document.querySelector("#lobby-count").textContent = `${ui.state.players.length} / 6`;
  const isHost = ui.state.viewerId === ui.state.hostId;
  document.querySelector("#lobby-players").innerHTML = ui.state.players.map((player) => `
    <div class="lobby-player">
      <span class="token-dot" style="background:${player.color}"></span>
      <div class="lobby-player-name">
        <strong>${escapeHtml(player.name)}</strong>
        <span class="subtext">${player.id === ui.state.hostId ? "房主" : player.kind === "ai" ? "电脑玩家" : "玩家"}</span>
      </div>
      ${player.kind === "ai" ? '<span class="status-tag">AI</span>' : ""}
      ${isHost && player.id !== ui.state.viewerId ? `
        <button class="icon-button" type="button" data-remove-player="${player.id}" title="移除玩家" aria-label="移除玩家">
          <svg aria-hidden="true"><use href="/icons.svg#trash"></use></svg>
        </button>` : ""}
    </div>`).join("");

  const diceMode = ui.state.settings?.diceMode || "random";
  document.querySelector("#lobby-mode").innerHTML = `
    <div class="mode-setting">
      <div>
        <strong>骰子模式</strong>
        <span class="subtext">${diceMode === "choice" ? "真人玩家选择两颗骰子的点数" : "每回合由服务器随机掷骰"}</span>
      </div>
      <div class="segmented-control" role="group" aria-label="骰子模式">
        <button type="button" data-dice-mode="random" class="${diceMode === "random" ? "active" : ""}" ${isHost ? "" : "disabled"}>随机</button>
        <button type="button" data-dice-mode="choice" class="${diceMode === "choice" ? "active" : ""}" ${isHost ? "" : "disabled"}>自选</button>
      </div>
    </div>`;

  document.querySelector("#lobby-actions").innerHTML = isHost ? `
    <button class="secondary-button" type="button" data-add-ai ${ui.state.players.length >= 6 ? "disabled" : ""}>
      <svg aria-hidden="true"><use href="/icons.svg#bot"></use></svg>添加 AI
    </button>
    <button class="primary-button" type="button" data-start ${ui.state.players.length < 2 ? "disabled" : ""}>
      <svg aria-hidden="true"><use href="/icons.svg#play"></use></svg>开始游戏
    </button>` : '<span class="subtext">等待房主开始游戏</span>';
}

function renderGame() {
  renderBoard();
  renderCenter();
  renderPanel();
  elements.bank.innerHTML = `<span>银行房屋 <strong>${ui.state.bank.houses}</strong></span><span>银行旅馆 <strong>${ui.state.bank.hotels}</strong></span>`;
  renderVictoryDialog();
  scheduleBoardLayout();
}

function renderVictoryDialog() {
  if (ui.state.status !== "finished" || !ui.state.winnerId) return;
  const key = `${ui.state.code}:${ui.state.winnerId}`;
  if (ui.victoryShownFor === key) return;
  const winner = playerById(ui.state.winnerId);
  const assets = Object.values(ui.state.properties).filter((state) => state.ownerId === winner?.id).length;
  ui.victoryShownFor = key;
  if (elements.dialog.open) elements.dialog.close();
  if (elements.tradeDialog.open) elements.tradeDialog.close();
  elements.victoryContent.innerHTML = `
    <div class="victory-banner" style="--winner-color:${winner?.color || "#d8a91f"}">
      <div class="victory-trophy"><svg aria-hidden="true"><use href="/icons.svg#trophy"></use></svg></div>
      <span>本局胜者</span>
      <h2>${escapeHtml(winner?.name || "胜者")}</h2>
      <p>${winner?.id === ui.state.viewerId ? "你赢得了这场地产争夺" : "赢得了这场地产争夺"}</p>
    </div>
    <div class="victory-stats">
      <span>最终现金<strong>$${money(winner?.cash)}</strong></span>
      <span>持有资产<strong>${assets}</strong></span>
    </div>
    <footer class="victory-actions">
      <button class="secondary-button" type="button" data-victory-close>查看棋盘</button>
      <button class="primary-button" type="button" data-victory-home><svg aria-hidden="true"><use href="/icons.svg#home"></use></svg>返回首页</button>
    </footer>`;
  elements.victoryDialog.showModal();
}

function handleVictoryClick(event) {
  if (event.target.closest("[data-victory-close]")) elements.victoryDialog.close();
  if (event.target.closest("[data-victory-home]")) {
    elements.victoryDialog.close();
    clearSession();
    history.replaceState(null, "", "/");
    render();
  }
}

function renderBoard() {
  elements.board.querySelectorAll(".board-cell").forEach((cell) => cell.remove());
  const fragment = document.createDocumentFragment();
  ui.state.board.forEach((space) => {
    const state = ui.state.properties[space.index];
    const owner = state?.ownerId ? playerById(state.ownerId) : null;
    const cell = document.createElement("button");
    const position = boardPosition(space.index);
    cell.type = "button";
    const tokens = ui.state.players.filter((player) => !player.bankrupt && player.position === space.index);
    const isLastMove = ui.state.lastMove?.to === space.index;
    const hasCurrentPlayer = tokens.some((player) => player.id === ui.state.currentPlayerId);
    cell.className = `board-cell ${position.side} ${isCorner(space.index) ? "corner" : ""} ${owner ? "owned" : ""} ${tokens.length ? "occupied" : ""} ${isLastMove ? "last-move" : ""} ${hasCurrentPlayer ? "current-position" : ""}`;
    cell.style.gridRow = position.row;
    cell.style.gridColumn = position.column;
    if (owner) {
      cell.style.setProperty("--owner-color", owner.color);
      cell.style.setProperty("--owner-fill", colorWithAlpha(owner.color, 0.14));
      cell.style.setProperty("--owner-fill-hover", colorWithAlpha(owner.color, 0.2));
    }
    cell.dataset.spaceIndex = space.index;
    cell.setAttribute("aria-label", `${space.name}${space.price ? `，价格 $${space.price}` : ""}`);
    const groupColor = space.group ? ui.state.groups[space.group].color : null;
    cell.innerHTML = `
      ${groupColor ? `<span class="group-strip" style="--group-color:${groupColor}"></span>` : ""}
      ${specialIcon(space)}
      <span class="cell-name">${escapeHtml(space.name)}</span>
      ${state?.houses ? `<span class="building-count">${state.houses === 5 ? "旅馆" : `房屋×${state.houses}`}</span>` : '<span class="building-count"></span>'}
      ${space.price ? `<span class="cell-price">$${space.price}</span>` : ""}
      ${state?.mortgaged ? '<span class="mortgage-mark">已抵押</span>' : ""}
      ${isLastMove ? '<span class="arrival-mark">刚到</span>' : ""}`;
    fragment.appendChild(cell);
  });
  elements.board.insertBefore(fragment, elements.center);
  renderPlayerTokens();
  renderMovementTrails();
  scheduleLabelFit();
}

function renderPlayerTokens() {
  const activePlayers = ui.state.players.filter((player) => !player.bankrupt);
  const playersBySpace = new Map();
  for (const player of activePlayers) {
    const occupants = playersBySpace.get(player.position) || [];
    occupants.push(player);
    playersBySpace.set(player.position, occupants);
  }
  elements.playerTokens.innerHTML = [...playersBySpace.entries()].flatMap(([spaceIndex, players]) => {
    const position = boardPosition(Number(spaceIndex));
    const point = spacePoint(spaceIndex);
    return players.map((player, slot) => {
      const offset = (slot - (players.length - 1) / 2) * 13;
      const horizontalSide = position.side.includes("side-top") || position.side.includes("side-bottom");
      const shiftX = horizontalSide ? offset : 0;
      const shiftY = horizontalSide ? 0 : offset;
      return `<span class="cell-token track-token" data-player-token="${player.id}" data-token-space="${spaceIndex}"
        style="left:${point.x / 11}%;top:${point.y / 11}%;--token-shift-x:${shiftX}px;--token-shift-y:${shiftY}px;background:${player.color}"
        title="${escapeHtml(player.name)}">${escapeHtml(playerInitial(player.name))}</span>`;
    });
  }).join("");
}

function renderMovementTrails() {
  const movements = ui.state.turn?.movements || [];
  elements.movementTrails.innerHTML = movements.map((movement, index) => {
    const player = playerById(movement.playerId);
    const points = movement.path.map(spacePoint).map((point) => `${point.x},${point.y}`).join(" ");
    const markerId = `trail-arrow-${movement.id.replace(/[^a-zA-Z0-9_-]/g, "")}`;
    const color = player?.color || "#59666d";
    return `<defs>
      <marker id="${markerId}" markerWidth="34" markerHeight="34" refX="23" refY="12" orient="auto" markerUnits="userSpaceOnUse">
        <path d="M2,2 L24,12 L2,22 Z" fill="${color}"></path>
      </marker>
    </defs>
    <polyline class="movement-trail-shadow" points="${points}"></polyline>
    <polyline class="movement-trail" points="${points}" style="--trail-color:${color};--trail-opacity:${Math.max(0.58, 0.92 - index * 0.08)}" marker-end="url(#${markerId})"></polyline>`;
  }).join("");
}

function spacePoint(index) {
  const position = boardPosition(Number(index));
  let x = (position.column - 0.5) * 100;
  let y = (position.row - 0.5) * 100;
  if (position.side.includes("side-bottom")) y = 1092;
  else if (position.side.includes("side-top")) y = 8;
  else if (position.side.includes("side-left")) x = 8;
  else if (position.side.includes("side-right")) x = 1092;
  return { x, y };
}

async function playMovementSequence(movements) {
  if (!movements.length || ui.fastMovement || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  ui.movementBusy = true;
  elements.board.classList.add("movement-active");
  elements.center.querySelectorAll("[data-action]").forEach((button) => { button.disabled = true; });
  try {
    for (const movement of movements) {
      const player = playerById(movement.playerId);
      const path = Array.isArray(movement.path) && movement.path.length > 1
        ? movement.path
        : [movement.from, movement.to];
      if (!player || path.length < 2) continue;
      const keyframes = path.map((spaceIndex) => {
        const point = spacePoint(spaceIndex);
        return { left: `${point.x / 11}%`, top: `${point.y / 11}%` };
      });
      elements.movingToken.textContent = playerInitial(player.name);
      elements.movingToken.style.background = player.color;
      elements.movingToken.hidden = false;
      setStaticPlayerTokenVisibility(player.id, false);
      const duration = path.length === 2 ? 420 : Math.min(1400, Math.max(320, (path.length - 1) * 95));
      if (typeof elements.movingToken.animate === "function") {
        const animation = elements.movingToken.animate(keyframes, { duration, easing: "linear", fill: "forwards" });
        await animation.finished.catch(() => {});
      } else {
        Object.assign(elements.movingToken.style, keyframes.at(-1));
        await new Promise((resolve) => setTimeout(resolve, Math.min(duration, 450)));
      }
      setStaticPlayerTokenVisibility(player.id, true);
    }
  } finally {
    elements.movingToken.hidden = true;
    elements.movingToken.removeAttribute("style");
    elements.board.classList.remove("movement-active");
    ui.movementBusy = false;
    renderCenter();
    window.I18N?.localize(elements.center);
  }
}

function setStaticPlayerTokenVisibility(playerId, visible) {
  elements.board.querySelectorAll("[data-player-token]").forEach((token) => {
    if (token.dataset.playerToken === playerId) token.style.visibility = visible ? "" : "hidden";
  });
}

function scheduleLabelFit() {
  if (ui.labelFitFrame) cancelAnimationFrame(ui.labelFitFrame);
  ui.labelFitFrame = requestAnimationFrame(fitBoardLabels);
}

function fitBoardLabels() {
  ui.labelFitFrame = null;
  elements.board.querySelectorAll(".cell-name").forEach((label) => {
    label.style.fontSize = "";
    let size = Number.parseFloat(getComputedStyle(label).fontSize);
    const minimum = 5;
    while (size > minimum && (label.scrollHeight > label.clientHeight + 1 || label.scrollWidth > label.clientWidth + 1)) {
      size -= 0.5;
      label.style.fontSize = `${size}px`;
    }
  });
}

function renderCenter() {
  if (["determining_order", "order_countdown"].includes(ui.state.phase)) {
    renderOpeningOrder();
    return;
  }
  elements.center.classList.remove("opening-order");
  if (ui.orderCountdownTimer) {
    clearTimeout(ui.orderCountdownTimer);
    ui.orderCountdownTimer = null;
  }
  const current = playerById(ui.state.currentPlayerId);
  const dice = ui.state.turn?.dice || [];
  const isViewerTurn = viewerNeedsDecision();
  elements.center.classList.toggle("has-summary", Boolean(ui.state.turnSummary));
  elements.center.innerHTML = `
    <img class="center-mark" src="/board-mark.svg" alt="" />
    <h1 class="center-title">地产风云</h1>
    <div class="turn-line">
      ${current ? `<span class="token-dot" style="background:${current.color}"></span><span>${escapeHtml(current.name)}</span>` : ""}
    </div>
    <div class="dice-row" aria-label="骰子点数">
      <span class="die">${dice[0] || "-"}</span><span class="die">${dice[1] || "-"}</span>
    </div>
    <section class="turn-prompt ${isViewerTurn ? "is-mine" : "is-waiting"}" aria-label="${isViewerTurn ? "需要你决定" : "其他玩家回合"}">
      <header><span class="prompt-status-dot"></span><strong>${isViewerTurn ? "需要你决定" : "其他玩家回合"}</strong></header>
      <p class="phase-message">${phaseMessage()}</p>
      <div class="center-actions">${centerActions()}</div>
    </section>
    ${turnSummaryMarkup()}`;
  if (ui.movementBusy) {
    elements.center.querySelectorAll("[data-action]").forEach((button) => { button.disabled = true; });
  }
}

function renderOpeningOrder() {
  const order = ui.state.openingOrder;
  if (!order) return;
  const countdown = ui.state.phase === "order_countdown";
  const pending = new Set(order.pendingIds || []);
  const orderedIds = countdown ? order.order : ui.state.players.map((player) => player.id);
  const first = playerById(order.order?.[0]);
  const viewerPending = pending.has(ui.state.viewerId);
  const seconds = Math.max(0, Math.ceil(((order.countdownEndsAt || 0) - Date.now()) / 1000));
  elements.center.classList.remove("has-summary");
  elements.center.classList.add("opening-order");
  elements.center.innerHTML = `
    <section class="opening-order-screen" aria-label="开局行动顺序">
      <header class="opening-order-header">
        <span>开局排序</span>
        <h1>掷骰决定行动顺序</h1>
        <p>${countdown ? "行动顺序已经确定" : order.round > 1 ? `第 ${order.round} 轮：同分玩家继续掷骰` : "两颗骰子总点数越高，行动越靠前"}</p>
      </header>
      <div class="opening-order-list">
        ${orderedIds.map((playerId, index) => openingOrderRow(playerId, index, order, pending, countdown)).join("")}
      </div>
      <footer class="opening-order-footer">
        ${countdown ? `
          <div class="opening-countdown" aria-live="polite">
            <strong>${seconds}</strong>
            <span>${seconds} 秒后由 ${escapeHtml(first?.name || "第一名")} 开始行动</span>
          </div>` : viewerPending ? `
          <button class="primary-button opening-roll-button" type="button" data-action="roll_for_order">
            <svg aria-hidden="true"><use href="/icons.svg#dice"></use></svg>掷骰决定顺序
          </button>` : '<p class="opening-waiting">等待其他玩家完成排序骰</p>'}
      </footer>
    </section>`;
  scheduleOpeningOrderTick();
}

function openingOrderRow(playerId, index, order, pending, countdown) {
  const player = playerById(playerId);
  const entry = order.entries.find((candidate) => candidate.playerId === playerId);
  const rolls = entry?.rolls || [];
  const latest = rolls.at(-1);
  const needsRoll = pending.has(playerId);
  const hasCurrentRoundRoll = latest?.round === order.round;
  const score = rolls.map((roll) => roll.total).join(" / ");
  let status = "等待掷骰";
  if (countdown) status = `第 ${index + 1} 名`;
  else if (needsRoll && rolls.length) status = "平局加赛";
  else if (needsRoll && player?.kind === "ai") status = "AI 正在掷骰";
  else if (!needsRoll || hasCurrentRoundRoll) status = "已完成";
  return `<div class="opening-order-row ${countdown && index === 0 ? "is-first" : ""} ${needsRoll ? "is-pending" : ""}">
    <span class="opening-rank">${countdown ? index + 1 : "-"}</span>
    <span class="token-dot" style="background:${player?.color || "#7e8a91"}"></span>
    <strong class="opening-player-name">${escapeHtml(player?.name || "玩家")}</strong>
    <span class="opening-mini-dice" aria-label="排序骰子">
      <i>${latest?.dice?.[0] || "-"}</i><i>${latest?.dice?.[1] || "-"}</i>
    </span>
    <strong class="opening-score">${score || "-"}</strong>
    <span class="opening-status">${status}</span>
  </div>`;
}

function scheduleOpeningOrderTick() {
  if (ui.orderCountdownTimer) clearTimeout(ui.orderCountdownTimer);
  ui.orderCountdownTimer = null;
  if (ui.state.phase !== "order_countdown") return;
  ui.orderCountdownTimer = setTimeout(() => {
    ui.orderCountdownTimer = null;
    if (ui.state?.phase !== "order_countdown") return;
    renderCenter();
    window.I18N?.localize(elements.center);
  }, 120);
}

function viewerNeedsDecision() {
  const viewerId = ui.state.viewerId;
  if (!viewerId || ui.state.status !== "playing") return false;
  if (ui.state.phase === "determining_order") return ui.state.openingOrder?.pendingIds.includes(viewerId);
  if (ui.state.phase === "trade") return ui.state.trade?.targetId === viewerId || ui.state.trade?.proposerId === viewerId;
  if (ui.state.phase === "auction") return ui.state.auction?.currentPlayerId === viewerId;
  if (ui.state.phase === "debt") return ui.state.debt?.payerId === viewerId;
  return ui.state.currentPlayerId === viewerId;
}

function turnSummaryMarkup() {
  const summary = ui.state.turnSummary;
  if (!summary) return "";
  const recipient = playerById(summary.playerId);
  return `<section class="turn-summary" aria-label="本回合开始前的变化">
    <header><span>本回合开始前</span><strong>${escapeHtml(recipient?.name || "玩家")}</strong></header>
    <div class="turn-summary-list">
      ${summary.players.map((entry) => {
        const player = playerById(entry.playerId);
        if (!player) return "";
        const from = ui.state.board[entry.fromPosition];
        const to = ui.state.board[entry.toPosition];
        const movement = entry.fromPosition === entry.toPosition
          ? "位置未变"
          : `${escapeHtml(from.name)} → ${escapeHtml(to.name)}`;
        const cashClass = entry.cashDelta > 0 ? "positive" : entry.cashDelta < 0 ? "negative" : "unchanged";
        const cashText = entry.cashDelta > 0 ? `+$${money(entry.cashDelta)}` : entry.cashDelta < 0
          ? `-$${money(Math.abs(entry.cashDelta))}`
          : "$0";
        return `<div class="turn-summary-row">
          <span class="token-dot" style="background:${player.color}"></span>
          <strong class="turn-summary-name">${escapeHtml(player.name)}</strong>
          <span class="turn-summary-move">${movement}</span>
          <strong class="cash-delta ${cashClass}">${cashText}</strong>
        </div>`;
      }).join("")}
    </div>
  </section>`;
}

function phaseMessage() {
  const viewer = playerById(ui.state.viewerId);
  const current = playerById(ui.state.currentPlayerId);
  if (ui.state.status === "finished") {
    const winner = playerById(ui.state.winnerId);
    return `${escapeHtml(winner?.name || "胜者")} 赢得本局游戏`;
  }
  if (ui.state.phase === "determining_order") return "掷骰决定行动顺序";
  if (ui.state.phase === "order_countdown") return "行动顺序已经确定";
  if (ui.state.phase === "trade" && ui.state.trade) {
    const proposer = playerById(ui.state.trade.proposerId);
    const target = playerById(ui.state.trade.targetId);
    return `${escapeHtml(proposer?.name || "玩家")} 向 ${escapeHtml(target?.name || "玩家")} 提议：${tradeBundleText(ui.state.trade.offer)}，换取 ${tradeBundleText(ui.state.trade.request)}`;
  }
  if (ui.state.phase === "auction") {
    const space = ui.state.board[ui.state.auction.spaceIndex];
    const bidder = playerById(ui.state.auction.bidderId);
    const actor = playerById(ui.state.auction.currentPlayerId);
    return `${escapeHtml(space.name)} 拍卖中，当前 $${ui.state.auction.currentBid}${bidder ? `（${escapeHtml(bidder.name)}）` : ""}；等待 ${escapeHtml(actor?.name || "结算")}`;
  }
  if (ui.state.phase === "debt") {
    const payer = playerById(ui.state.debt.payerId);
    return `${escapeHtml(payer?.name || "玩家")} 需要支付 $${ui.state.debt.amount}：${escapeHtml(ui.state.debt.reason)}`;
  }
  if (ui.state.lastCard) return escapeHtml(ui.state.lastCard.text);
  if (!viewer || viewer.id !== current?.id) return `等待 ${escapeHtml(current?.name || "其他玩家")} 操作`;
  if (ui.state.phase === "awaiting_roll") {
    if (viewer.inJail) return "可缴费、使用卡片或尝试掷出双骰离所";
    return ui.state.settings?.diceMode === "choice" ? "分别选择两颗骰子的点数" : "掷骰开始本次行动";
  }
  if (ui.state.phase === "awaiting_purchase") {
    const space = ui.state.board[ui.state.pendingPurchase];
    return `${escapeHtml(space.name)} 售价 $${space.price}`;
  }
  if (ui.state.phase === "turn_complete") return ui.state.turn?.extraRoll ? "双骰奖励：再次掷骰" : "本回合行动完成";
  return "等待操作";
}

function centerActions() {
  const viewer = playerById(ui.state.viewerId);
  if (!viewer || viewer.bankrupt || ui.state.status === "finished") return "";

  if (ui.state.phase === "determining_order") {
    if (!ui.state.openingOrder?.pendingIds.includes(viewer.id)) return "";
    return `<button class="primary-button" type="button" data-action="roll_for_order">
      <svg aria-hidden="true"><use href="/icons.svg#dice"></use></svg>掷骰决定顺序
    </button>`;
  }

  if (ui.state.phase === "trade" && ui.state.trade) {
    if (ui.state.trade.targetId === viewer.id) {
      return `
        <button class="primary-button" type="button" data-action="accept_trade"><svg aria-hidden="true"><use href="/icons.svg#banknote"></use></svg>接受交易</button>
        <button class="danger-button" type="button" data-action="reject_trade">拒绝</button>`;
    }
    if (ui.state.trade.proposerId === viewer.id) {
      return '<button class="secondary-button" type="button" data-action="reject_trade">取消交易</button>';
    }
    return "";
  }

  if (ui.state.phase === "auction") {
    if (ui.state.auction.currentPlayerId !== viewer.id) return "";
    const minimum = ui.state.auction.currentBid + 1;
    const suggested = Math.ceil(Math.max(minimum, ui.state.auction.currentBid + 10) / 10) * 10;
    return `<div class="bid-control">
      <input id="auction-bid" type="number" min="${minimum}" max="${viewer.cash}" value="${Math.min(suggested, viewer.cash)}" aria-label="拍卖出价" />
      <button class="primary-button" type="button" data-action="bid"><svg aria-hidden="true"><use href="/icons.svg#hammer"></use></svg>出价</button>
      <button class="secondary-button" type="button" data-action="pass_auction">退出</button>
    </div>`;
  }

  if (ui.state.phase === "debt") {
    if (ui.state.debt.payerId !== viewer.id) return "";
    return `
      <button class="primary-button" type="button" data-action="pay_debt" ${viewer.cash < ui.state.debt.amount ? "disabled" : ""}>
        <svg aria-hidden="true"><use href="/icons.svg#banknote"></use></svg>支付 $${ui.state.debt.amount}
      </button>
      <button class="danger-button" type="button" data-action="bankrupt">宣告破产</button>`;
  }

  if (ui.state.currentPlayerId !== viewer.id) return "";
  if (ui.state.phase === "awaiting_roll") {
    if (ui.state.settings?.diceMode === "choice") {
      const options = [1, 2, 3, 4, 5, 6].map((value) => `<option value="${value}">${value} 点</option>`).join("");
      return `${viewer.inJail ? `
        <button class="secondary-button" type="button" data-action="pay_bail" ${viewer.cash < 50 ? "disabled" : ""}>支付 $50</button>
        <button class="secondary-button" type="button" data-action="use_jail_card" ${viewer.jailCards < 1 ? "disabled" : ""}>使用离所卡</button>` : ""}
        <div class="dice-choice">
          <label>骰子 A<select id="die-one">${options}</select></label>
          <label>骰子 B<select id="die-two">${options}</select></label>
          <button class="primary-button" type="button" data-action="roll"><svg aria-hidden="true"><use href="/icons.svg#dice"></use></svg>确认移动</button>
        </div>`;
    }
    return `${viewer.inJail ? `
      <button class="secondary-button" type="button" data-action="pay_bail" ${viewer.cash < 50 ? "disabled" : ""}>支付 $50</button>
      <button class="secondary-button" type="button" data-action="use_jail_card" ${viewer.jailCards < 1 ? "disabled" : ""}>使用离所卡</button>` : ""}
      <button class="primary-button" type="button" data-action="roll"><svg aria-hidden="true"><use href="/icons.svg#dice"></use></svg>掷骰</button>`;
  }
  if (ui.state.phase === "awaiting_purchase") {
    const space = ui.state.board[ui.state.pendingPurchase];
    return `
      <button class="primary-button" type="button" data-action="buy" ${viewer.cash < space.price ? "disabled" : ""}>
        <svg aria-hidden="true"><use href="/icons.svg#banknote"></use></svg>购买 $${space.price}
      </button>
      <button class="secondary-button" type="button" data-action="decline"><svg aria-hidden="true"><use href="/icons.svg#hammer"></use></svg>进入拍卖</button>`;
  }
  if (ui.state.phase === "turn_complete") {
    return `<button class="primary-button" type="button" data-action="end_turn"><svg aria-hidden="true"><use href="/icons.svg#play"></use></svg>结束回合</button>`;
  }
  return "";
}

function renderPanel() {
  if (!ui.state || ui.state.status === "lobby") return;
  if (ui.panelTab === "assets") renderAssets();
  else if (ui.panelTab === "log") renderLog();
  else if (ui.panelTab === "stats") renderStats();
  else renderPlayers();
  window.I18N?.localize(elements.panel);
}

function renderPlayers() {
  elements.panel.innerHTML = ui.state.players.map((player) => {
    const owned = Object.values(ui.state.properties).filter((state) => state.ownerId === player.id).length;
    const position = ui.state.board[player.position];
    return `<button type="button" data-position-index="${player.position}" class="player-row ${player.id === ui.state.currentPlayerId ? "current" : ""} ${player.bankrupt ? "bankrupt" : ""}">
      <span class="token-dot" style="background:${player.color}"></span>
      <div class="player-main">
        <strong>${escapeHtml(player.name)} ${player.id === ui.state.viewerId ? "（你）" : ""}</strong>
        <span class="subtext">${escapeHtml(position.name)} · ${player.inJail ? `留置 ${player.jailTurns}/3 · ` : ""}${owned} 项资产${player.jailCards ? ` · ${player.jailCards} 张离所卡` : ""}</span>
      </div>
      ${player.kind === "ai" ? '<span class="status-tag">AI</span>' : ""}
      <span class="player-money">$${money(player.cash)}</span>
    </button>`;
  }).join("");
}

function renderAssets() {
  const assets = ui.state.board.filter((space) => ui.state.properties[space.index]?.ownerId === ui.state.viewerId);
  const viewerCanTrade = ui.state.currentPlayerId === ui.state.viewerId
    && ["awaiting_roll", "turn_complete"].includes(ui.state.phase)
    && ui.state.players.some((player) => player.id !== ui.state.viewerId && !player.bankrupt);
  const toolbar = viewerCanTrade ? `
    <div class="asset-toolbar">
      <button class="primary-button" type="button" data-open-trade>
        <svg aria-hidden="true"><use href="/icons.svg#briefcase"></use></svg>发起交易
      </button>
    </div>` : "";
  if (!assets.length) {
    elements.panel.innerHTML = `${toolbar}<div class="empty-state">尚未持有资产</div>`;
    return;
  }
  elements.panel.innerHTML = toolbar + assets.map((space) => {
    const state = ui.state.properties[space.index];
    const color = space.group ? ui.state.groups[space.group].color : "#7c878d";
    return `<button class="asset-row" type="button" data-asset-index="${space.index}">
      <span class="asset-color" style="--asset-color:${color}"></span>
      <span class="asset-name">
        <strong>${escapeHtml(space.name)}</strong>
        <span>${state.mortgaged ? "已抵押" : state.houses === 5 ? "旅馆" : state.houses ? `房屋 × ${state.houses}` : assetType(space)}</span>
      </span>
      <strong>$${space.price}</strong>
    </button>`;
  }).join("");
}

function renderLog() {
  const logs = [...ui.state.log].reverse();
  elements.panel.innerHTML = logs.map((entry) => {
    const time = new Date(entry.at).toLocaleTimeString(window.I18N?.locale || "zh-CN", { hour: "2-digit", minute: "2-digit" });
    return `<div class="log-row"><span class="log-time">${time}</span><span>${escapeHtml(entry.text)}</span></div>`;
  }).join("");
}

function renderStats() {
  const categories = ownershipCategories();
  const horizontal = ui.statsOrientation === "horizontal";
  const maximumItems = Math.max(...categories.map((category) => category.spaces.length));
  const table = horizontal
    ? `<table class="ownership-table horizontal">
        <thead><tr>${categories.map(ownershipHeader).join("")}</tr></thead>
        <tbody>${Array.from({ length: maximumItems }, (_, itemIndex) => `
          <tr>${categories.map((category) => ownershipCell(category.spaces[itemIndex], category)).join("")}</tr>`).join("")}</tbody>
      </table>`
    : `<table class="ownership-table vertical">
        <thead><tr><th class="ownership-corner">类别</th>${Array.from({ length: maximumItems }, (_, index) => `<th>${index + 1}</th>`).join("")}</tr></thead>
        <tbody>${categories.map((category) => `
          <tr>${ownershipHeader(category)}${Array.from({ length: maximumItems }, (_, itemIndex) => ownershipCell(category.spaces[itemIndex], category)).join("")}</tr>`).join("")}</tbody>
      </table>`;
  elements.panel.innerHTML = `
    <div class="stats-toolbar">
      <div class="stats-legend">${ui.state.players.map((player) => `
        <span><i style="background:${player.color}"></i>${escapeHtml(player.name)}</span>`).join("")}</div>
      <div class="segmented-control stats-orientation" role="group" aria-label="产权表排列方向">
        <button type="button" data-stats-orientation="horizontal" class="${horizontal ? "active" : ""}">横排</button>
        <button type="button" data-stats-orientation="vertical" class="${horizontal ? "" : "active"}">竖排</button>
      </div>
    </div>
    <div class="ownership-scroll">${table}</div>`;
  window.I18N?.localize(elements.panel);
}

function ownershipCategories() {
  const railroads = ui.state.board.filter((space) => space.type === "railroad");
  const utilities = ui.state.board.filter((space) => space.type === "utility");
  const propertyGroups = Object.entries(ui.state.groups).map(([id, group]) => ({
    id,
    name: group.name,
    color: group.color,
    spaces: ui.state.board.filter((space) => space.group === id).sort((a, b) => a.price - b.price),
  })).sort((a, b) => a.spaces[0].price - b.spaces[0].price);
  return [
    { id: "railroads", name: "铁路", color: "#66737a", spaces: railroads },
    { id: "utilities", name: "公共设施", color: "#3f7f87", spaces: utilities },
    ...propertyGroups,
  ];
}

function ownershipHeader(category) {
  return `<th class="ownership-group" style="--category-color:${category.color}">${escapeHtml(category.name)}</th>`;
}

function ownershipCell(space, category) {
  if (!space) return '<td class="ownership-empty"></td>';
  const state = ui.state.properties[space.index];
  const owner = state?.ownerId ? playerById(state.ownerId) : null;
  return `<td class="ownership-cell ${owner ? "owned" : ""}" style="--category-color:${category.color};--owner-color:${owner?.color || "transparent"}">
    <button type="button" data-stats-asset-index="${space.index}" title="${escapeHtml(space.name)} · $${space.price}${owner ? ` · ${escapeHtml(owner.name)}` : " · 银行"}">
      <strong>${escapeHtml(space.name)}</strong>
      <span>$${space.price}${owner ? ` · ${escapeHtml(playerInitial(owner.name))}` : ""}</span>
    </button>
  </td>`;
}

function openTradeDialog() {
  const targets = ui.state.players.filter((player) => player.id !== ui.state.viewerId && !player.bankrupt);
  if (!targets.length) {
    showToast("当前没有可交易的玩家", true);
    return;
  }
  if (!targets.some((player) => player.id === ui.tradeTargetId)) ui.tradeTargetId = targets[0].id;
  renderTradeDialog();
  if (!elements.tradeDialog.open) elements.tradeDialog.showModal();
}

function renderTradeDialog() {
  const viewer = playerById(ui.state.viewerId);
  const targets = ui.state.players.filter((player) => player.id !== viewer.id && !player.bankrupt);
  const target = targets.find((player) => player.id === ui.tradeTargetId) || targets[0];
  if (!target) return;
  ui.tradeTargetId = target.id;
  const offerAssets = tradeableAssetsFor(viewer.id);
  const requestAssets = tradeableAssetsFor(target.id);

  elements.tradeContent.innerHTML = `
    <form id="trade-form" class="trade-form">
      <header class="trade-header">
        <h2>发起交易</h2>
        <label for="trade-target">交易对象</label>
        <select id="trade-target" name="targetId">
          ${targets.map((player) => `<option value="${player.id}" ${player.id === target.id ? "selected" : ""}>${escapeHtml(player.name)}${player.kind === "ai" ? "（AI）" : ""}</option>`).join("")}
        </select>
      </header>
      <div class="trade-columns">
        <section class="trade-side">
          <h3>${escapeHtml(viewer.name)} 提供</h3>
          <label class="trade-cash">现金
            <input type="number" name="offerCash" min="0" max="${viewer.cash}" value="0" />
          </label>
          <div class="trade-property-list">
            ${tradePropertyOptions(offerAssets, "offerProperty")}
          </div>
        </section>
        <section class="trade-side request-side">
          <h3>希望 ${escapeHtml(target.name)} 提供</h3>
          <label class="trade-cash">现金
            <input type="number" name="requestCash" min="0" max="${target.cash}" value="0" />
          </label>
          <div class="trade-property-list">
            ${tradePropertyOptions(requestAssets, "requestProperty")}
          </div>
        </section>
      </div>
      <p class="trade-note">有建筑的颜色组不能交易；抵押地产由接收方另付抵押价值 10% 的手续费。</p>
      ${target.kind === "ai" ? '<p class="trade-quote-result" data-ai-quote-status role="status" aria-live="polite" hidden></p>' : ""}
      <footer class="trade-actions">
        <button class="secondary-button" type="button" data-close-trade>取消</button>
        ${target.kind === "ai" ? '<button class="secondary-button" type="button" data-ai-quote><svg aria-hidden="true"><use href="/icons.svg#banknote"></use></svg>询问 AI 报价</button>' : ""}
        <button class="primary-button" type="submit"><svg aria-hidden="true"><use href="/icons.svg#briefcase"></use></svg>发送提案</button>
      </footer>
    </form>`;

  elements.tradeContent.querySelector("[data-close-trade]").addEventListener("click", () => elements.tradeDialog.close());
  window.I18N?.localize(elements.tradeContent);
}

function tradeableAssetsFor(playerId) {
  return ui.state.board.filter((space) => {
    const state = ui.state.properties[space.index];
    if (!state || state.ownerId !== playerId) return false;
    if (space.type !== "property") return true;
    return !ui.state.board.some(
      (candidate) => candidate.group === space.group && ui.state.properties[candidate.index].houses > 0,
    );
  });
}

function tradePropertyOptions(spaces, fieldName) {
  if (!spaces.length) return '<div class="trade-empty">没有可交易地产</div>';
  return spaces.map((space) => {
    const state = ui.state.properties[space.index];
    const color = space.group ? ui.state.groups[space.group].color : "#7c878d";
    const fee = state.mortgaged ? Math.ceil((space.price / 2) * 0.1) : 0;
    return `<label class="trade-property-row">
      <input type="checkbox" name="${fieldName}" value="${space.index}" />
      <span class="asset-color" style="--asset-color:${color}"></span>
      <span><strong>${escapeHtml(space.name)}</strong><small>${state.mortgaged ? `已抵押 · 接收手续费 $${fee}` : `$${space.price}`}</small></span>
    </label>`;
  }).join("");
}

function tradeBundleText(bundle) {
  const parts = bundle.properties.map((index) => escapeHtml(ui.state.board[index].name));
  if (bundle.cash > 0) parts.push(`$${money(bundle.cash)} 现金`);
  return parts.join(" + ") || "无内容";
}

function openProperty(index) {
  const space = ui.state.board[index];
  const state = ui.state.properties[index];
  const owner = state?.ownerId ? playerById(state.ownerId) : null;
  const color = space.group ? ui.state.groups[space.group].color : "#7c878d";
  const viewer = playerById(ui.state.viewerId);
  const manageable = viewer && viewer.id === ui.state.currentPlayerId && ["awaiting_roll", "awaiting_purchase", "turn_complete", "debt"].includes(ui.state.phase);
  const owns = state?.ownerId === ui.state.viewerId;
  const mortgageValue = space.price ? Math.floor(space.price / 2) : 0;
  const unmortgageCost = Math.ceil(mortgageValue * 1.1);

  elements.propertyContent.innerHTML = `
    <header class="property-header" style="--property-color:${color}">
      <h2>${escapeHtml(space.name)}</h2>
      <span class="subtext">第 ${space.index} 格 · ${assetType(space)}</span>
    </header>
    <div class="property-body">
      <dl class="property-facts">
        <dt>所有者</dt><dd>${owner ? escapeHtml(owner.name) : state ? "银行" : "公共区域"}</dd>
        ${space.price ? `<dt>购买价格</dt><dd>$${space.price}</dd>` : ""}
        ${state ? `<dt>状态</dt><dd>${state.mortgaged ? "已抵押" : "正常"}</dd>` : ""}
        ${space.buildCost ? `<dt>建筑价格</dt><dd>$${space.buildCost}</dd><dt>当前建筑</dt><dd>${state.houses === 5 ? "1 家旅馆" : `${state.houses} 栋房屋`}</dd>` : ""}
        ${space.price ? `<dt>抵押价值</dt><dd>$${mortgageValue}</dd>` : ""}
      </dl>
      ${rentTable(space)}
      ${manageable && owns ? `<div class="property-actions">
        ${space.type === "property" && !state.mortgaged ? `
          <button class="action-button" type="button" data-property-action="build" data-space-index="${index}">
            <svg aria-hidden="true"><use href="/icons.svg#building"></use></svg>建造
          </button>
          <button class="action-button" type="button" data-property-action="sell_building" data-space-index="${index}" ${state.houses < 1 ? "disabled" : ""}>出售建筑</button>` : ""}
        ${state.mortgaged ? `
          <button class="action-button" type="button" data-property-action="unmortgage" data-space-index="${index}" ${viewer.cash < unmortgageCost || ui.state.phase === "debt" ? "disabled" : ""}>赎回 $${unmortgageCost}</button>` : `
          <button class="action-button" type="button" data-property-action="mortgage" data-space-index="${index}">抵押 $${mortgageValue}</button>`}
      </div>` : ""}
    </div>`;
  window.I18N?.localize(elements.propertyContent);
  if (!elements.dialog.open) elements.dialog.showModal();
}

function rentTable(space) {
  if (space.type === "property") {
    const labels = ["基础租金", "1 栋房屋", "2 栋房屋", "3 栋房屋", "4 栋房屋", "旅馆"];
    return `<table class="rent-table"><tbody>${space.rents.map((rent, index) => `<tr><th>${labels[index]}</th><td>$${rent}</td></tr>`).join("")}</tbody></table>`;
  }
  if (space.type === "railroad") {
    return '<table class="rent-table"><tbody><tr><th>拥有 1 条铁路</th><td>$25</td></tr><tr><th>拥有 2 条铁路</th><td>$50</td></tr><tr><th>拥有 3 条铁路</th><td>$100</td></tr><tr><th>拥有 4 条铁路</th><td>$200</td></tr></tbody></table>';
  }
  if (space.type === "utility") {
    return '<table class="rent-table"><tbody><tr><th>拥有 1 家公共事业</th><td>骰点 × 4</td></tr><tr><th>拥有 2 家公共事业</th><td>骰点 × 10</td></tr></tbody></table>';
  }
  return "";
}

function boardPosition(index) {
  if (index === 0) return { row: 11, column: 11, side: "corner side-bottom" };
  if (index < 10) return { row: 11, column: 11 - index, side: "side-bottom" };
  if (index === 10) return { row: 11, column: 1, side: "corner side-left" };
  if (index < 20) return { row: 21 - index, column: 1, side: "side-left" };
  if (index === 20) return { row: 1, column: 1, side: "corner side-top" };
  if (index < 30) return { row: 1, column: index - 19, side: "side-top" };
  if (index === 30) return { row: 1, column: 11, side: "corner side-right" };
  return { row: index - 29, column: 11, side: "side-right" };
}

function isCorner(index) {
  return index % 10 === 0;
}

function specialIcon(space) {
  const icons = {
    go: "home",
    railroad: "train",
    utility: "zap",
    chance: "help",
    chest: "briefcase",
    tax: "banknote",
    jail: "landmark",
    goToJail: "landmark",
    parking: "building",
  };
  const icon = icons[space.type];
  return icon ? `<svg class="cell-icon" aria-hidden="true"><use href="/icons.svg#${icon}"></use></svg>` : "";
}

function assetType(space) {
  if (space.type === "property") return `${ui.state.groups[space.group]?.name || "地产"}`;
  if (space.type === "railroad") return "铁路";
  if (space.type === "utility") return "公共事业";
  const names = { go: "起点", chance: "机会卡", chest: "公益基金卡", tax: "税费", jail: "留置所", goToJail: "留置指令", parking: "公共区域" };
  return names[space.type] || "公共区域";
}

function playerById(id) {
  return ui.state?.players.find((player) => player.id === id) || null;
}

async function copyInvite() {
  if (!ui.state) return;
  const invite = `${location.origin}${location.pathname}?room=${ui.state.code}`;
  try {
    await navigator.clipboard.writeText(invite);
    showToast("邀请链接已复制");
  } catch {
    showToast(`房间码：${ui.state.code}`);
  }
}

function setConnection(online) {
  elements.connection.classList.toggle("online", online);
  elements.connection.classList.toggle("offline", !online);
  elements.connection.innerHTML = `<span></span>${online ? "已连接" : "连接中断"}`;
  window.I18N?.localize(elements.connection);
}

function showToast(message, error = false) {
  clearTimeout(ui.toastTimer);
  elements.toast.textContent = window.I18N?.text(message) || message;
  elements.toast.classList.toggle("error", error);
  elements.toast.classList.add("show");
  ui.toastTimer = setTimeout(() => elements.toast.classList.remove("show"), 2600);
}

function loadSession() {
  try {
    return JSON.parse(localStorage.getItem("classic-estate-session"));
  } catch {
    return null;
  }
}

function loadNumber(key, fallback) {
  const stored = localStorage.getItem(key);
  if (stored === null || stored === "") return fallback;
  const value = Number(stored);
  return Number.isFinite(value) ? value : fallback;
}

function clearSession() {
  localStorage.removeItem("classic-estate-session");
  ui.session = null;
  ui.state = null;
  ui.victoryShownFor = null;
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    method: options.method || "GET",
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(window.I18N?.text(payload.error || "请求失败") || payload.error || "请求失败");
  return payload;
}

function money(value) {
  return Number(value || 0).toLocaleString(window.I18N?.locale || "zh-CN");
}

function playerInitial(name) {
  const displayName = window.I18N?.text(name) || name;
  return String(displayName || "?").trim().slice(0, 1) || "?";
}

function colorWithAlpha(color, alpha) {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(color));
  if (!match) return "rgba(124, 135, 141, 0.14)";
  return `rgba(${parseInt(match[1], 16)}, ${parseInt(match[2], 16)}, ${parseInt(match[3], 16)}, ${alpha})`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

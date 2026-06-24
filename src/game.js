const crypto = require("node:crypto");
const { BOARD, GROUPS, OWNABLE_TYPES, groupSpaces } = require("./board");

const PLAYER_COLORS = ["#d33f49", "#2d68c4", "#26966b", "#d58b20", "#8b55b7", "#168c9b"];
const OPENING_ORDER_COUNTDOWN_MS = 3_000;

const CHANCE_CARDS = [
  { id: "chance-go", text: "前进到起点，领取 $200", effect: { type: "moveTo", target: 0 } },
  { id: "chance-crown", text: "前进到皇冠大道", effect: { type: "moveTo", target: 39 } },
  { id: "chance-rail-1", text: "前往最近的铁路；若有主人，支付双倍租金", effect: { type: "nearestRail" } },
  { id: "chance-utility", text: "前往最近的公共事业；若有主人，支付骰点十倍租金", effect: { type: "nearestUtility" } },
  { id: "chance-dividend", text: "银行支付股息 $50", effect: { type: "money", amount: 50 } },
  { id: "chance-jail-card", text: "免费离开留置所卡", effect: { type: "jailCard", deck: "chance" } },
  { id: "chance-back", text: "后退三格", effect: { type: "move", steps: -3 } },
  { id: "chance-jail", text: "立即前往留置所", effect: { type: "jail" } },
  { id: "chance-repairs", text: "道路维修：每栋房屋 $25，每家旅馆 $100", effect: { type: "repairs", house: 25, hotel: 100 } },
  { id: "chance-fine", text: "缴纳交通罚款 $15", effect: { type: "money", amount: -15 } },
  { id: "chance-star", text: "前进到星河大道", effect: { type: "moveTo", target: 24 } },
  { id: "chance-loan", text: "建设贷款到期，领取 $150", effect: { type: "money", amount: 150 } },
  { id: "chance-garden", text: "前进到花园大道；经过起点照常领取 $200", effect: { type: "moveTo", target: 11 } },
  { id: "chance-rail-2", text: "前往最近的铁路；若有主人，支付双倍租金", effect: { type: "nearestRail" } },
  { id: "chance-tax", text: "缴纳城市建设费 $40", effect: { type: "money", amount: -40 } },
  { id: "chance-award", text: "获得城市贡献奖 $100", effect: { type: "money", amount: 100 } },
];

const CHEST_CARDS = [
  { id: "chest-go", text: "前进到起点，领取 $200", effect: { type: "moveTo", target: 0 } },
  { id: "chest-error", text: "银行结算有误，领取 $200", effect: { type: "money", amount: 200 } },
  { id: "chest-doctor", text: "支付医疗费 $50", effect: { type: "money", amount: -50 } },
  { id: "chest-stock", text: "出售股票，领取 $50", effect: { type: "money", amount: 50 } },
  { id: "chest-jail-card", text: "免费离开留置所卡", effect: { type: "jailCard", deck: "chest" } },
  { id: "chest-jail", text: "立即前往留置所", effect: { type: "jail" } },
  { id: "chest-fund", text: "假日基金到期，领取 $100", effect: { type: "money", amount: 100 } },
  { id: "chest-refund", text: "所得税退税，领取 $20", effect: { type: "money", amount: 20 } },
  { id: "chest-insurance", text: "人寿保险到期，领取 $100", effect: { type: "money", amount: 100 } },
  { id: "chest-hospital", text: "支付住院费 $100", effect: { type: "money", amount: -100 } },
  { id: "chest-school", text: "支付学校费用 $50", effect: { type: "money", amount: -50 } },
  { id: "chest-consult", text: "获得咨询费 $25", effect: { type: "money", amount: 25 } },
  { id: "chest-repairs", text: "街区维修：每栋房屋 $40，每家旅馆 $115", effect: { type: "repairs", house: 40, hotel: 115 } },
  { id: "chest-prize", text: "获得社区竞赛奖金 $10", effect: { type: "money", amount: 10 } },
  { id: "chest-inherit", text: "继承遗产，领取 $100", effect: { type: "money", amount: 100 } },
  { id: "chest-service", text: "退还公共服务押金 $60", effect: { type: "money", amount: 60 } },
];

function uid(prefix) {
  return `${prefix}_${crypto.randomBytes(6).toString("hex")}`;
}

function shuffle(items, rng = Math.random) {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(rng() * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}

function createGame(code) {
  const properties = {};
  for (const space of BOARD) {
    if (OWNABLE_TYPES.has(space.type)) {
      properties[space.index] = { ownerId: null, mortgaged: false, houses: 0 };
    }
  }

  return {
    code,
    status: "lobby",
    phase: "lobby",
    hostId: null,
    players: [],
    currentIndex: 0,
    properties,
    turn: null,
    pendingPurchase: null,
    auction: null,
    debt: null,
    winnerId: null,
    lastCard: null,
    pendingCard: null,
    lastLanding: null,
    lastBankruptcy: null,
    lastMove: null,
    trade: null,
    aiTradeCooldowns: {},
    turnCounts: {},
    openingOrder: null,
    turnSummary: null,
    turnSummaryBaselines: {},
    settings: { diceMode: "random" },
    decks: { chance: [], chest: [] },
    log: [],
    version: 1,
  };
}

function addPlayer(game, name, kind = "human") {
  if (game.status !== "lobby") throw new Error("游戏已经开始");
  if (game.players.length >= 6) throw new Error("房间最多支持 6 名玩家");
  const player = {
    id: uid(kind === "ai" ? "ai" : "player"),
    name,
    kind,
    color: PLAYER_COLORS[game.players.length],
    cash: 1500,
    position: 0,
    inJail: false,
    jailTurns: 0,
    jailCards: 0,
    bankrupt: false,
  };
  game.players.push(player);
  game.turnCounts[player.id] = 0;
  if (!game.hostId && kind === "human") game.hostId = player.id;
  addLog(game, `${player.name} 加入了房间`);
  touch(game);
  return player;
}

function removePlayer(game, requesterId, playerId) {
  if (game.status !== "lobby") throw new Error("游戏开始后不能移除玩家");
  if (requesterId !== game.hostId) throw new Error("只有房主可以移除玩家");
  const index = game.players.findIndex((player) => player.id === playerId);
  if (index < 0) throw new Error("玩家不存在");
  const [removed] = game.players.splice(index, 1);
  if (removed.id === game.hostId) {
    game.hostId = game.players.find((player) => player.kind === "human")?.id || null;
  }
  game.players.forEach((player, playerIndex) => {
    player.color = PLAYER_COLORS[playerIndex];
  });
  addLog(game, `${removed.name} 离开了房间`);
  touch(game);
}

function switchPlayerToSpectator(game, playerId, spectatorId) {
  if (game.status !== "lobby") throw new Error("只能在开局前切换参与身份");
  const index = game.players.findIndex((player) => player.id === playerId && player.kind === "human");
  if (index < 0) throw new Error("玩家不存在");
  const [player] = game.players.splice(index, 1);
  delete game.turnCounts[player.id];
  if (game.hostId === player.id) game.hostId = spectatorId;
  game.players.forEach((candidate, playerIndex) => {
    candidate.color = PLAYER_COLORS[playerIndex];
  });
  addLog(game, `${player.name} 改为观察者`);
  touch(game);
}

function switchSpectatorToPlayer(game, name, isHost = false) {
  if (game.status !== "lobby") throw new Error("只能在开局前切换参与身份");
  const player = addPlayer(game, name);
  if (isHost) game.hostId = player.id;
  addLog(game, `${player.name} 改为玩家`);
  touch(game);
  return player;
}

function startGame(game, requesterId, rng = Math.random) {
  if (requesterId !== game.hostId) throw new Error("只有房主可以开始游戏");
  if (game.status !== "lobby") throw new Error("游戏已经开始");
  if (game.players.length < 2) throw new Error("至少需要 2 名玩家");
  game.status = "playing";
  game.decks.chance = shuffle(CHANCE_CARDS.map((card) => card.id), rng);
  game.decks.chest = shuffle(CHEST_CARDS.map((card) => card.id), rng);
  game.currentIndex = 0;
  game.phase = "determining_order";
  game.openingOrder = {
    stage: "rolling",
    round: 1,
    pendingIds: game.players.map((player) => player.id),
    order: [],
    countdownEndsAt: null,
    entries: game.players.map((player) => ({ playerId: player.id, rolls: [] })),
  };
  addLog(game, "游戏开始，每位玩家持有 $1500");
  addLog(game, "所有玩家掷骰决定行动顺序");
  touch(game);
}

function rollForOpeningOrder(game, playerId, rng = Math.random) {
  assertPhase(game, "determining_order");
  const player = game.players.find((candidate) => candidate.id === playerId);
  if (!player || player.bankrupt) throw new Error("玩家不存在");
  const order = game.openingOrder;
  if (!order?.pendingIds.includes(playerId)) throw new Error("本轮已经掷过排序骰子");

  const dice = [rollDie(rng), rollDie(rng)];
  const total = dice[0] + dice[1];
  const entry = order.entries.find((candidate) => candidate.playerId === playerId);
  entry.rolls.push({ round: order.round, dice, total });
  order.pendingIds = order.pendingIds.filter((id) => id !== playerId);
  addLog(game, `${player.name} 排序掷骰 ${dice[0]} + ${dice[1]} = ${total}`);

  if (order.pendingIds.length === 0) resolveOpeningOrderRound(game);
}

function resolveOpeningOrderRound(game) {
  const order = game.openingOrder;
  const groups = new Map();
  for (const entry of order.entries) {
    const key = entry.rolls.map((roll) => roll.total).join(":");
    const members = groups.get(key) || [];
    members.push(entry.playerId);
    groups.set(key, members);
  }
  const tiedIds = [...groups.values()].filter((members) => members.length > 1).flat();
  if (tiedIds.length) {
    order.round += 1;
    order.pendingIds = tiedIds;
    const names = tiedIds.map((id) => game.players.find((player) => player.id === id)?.name).filter(Boolean);
    addLog(game, `${names.join("、")} 排序同分，进行第 ${order.round} 轮加赛`);
    return;
  }

  order.order = [...order.entries]
    .sort((left, right) => compareOpeningRolls(right.rolls, left.rolls))
    .map((entry) => entry.playerId);
  const positions = new Map(order.order.map((id, index) => [id, index]));
  game.players.sort((left, right) => positions.get(left.id) - positions.get(right.id));
  game.currentIndex = 0;
  game.phase = "order_countdown";
  order.stage = "countdown";
  order.countdownEndsAt = Date.now() + OPENING_ORDER_COUNTDOWN_MS;
  addLog(game, `行动顺序：${game.players.map((player) => player.name).join(" → ")}`);
}

function compareOpeningRolls(left, right) {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (left[index]?.total || 0) - (right[index]?.total || 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function completeOpeningOrder(game, now = Date.now()) {
  if (game.phase !== "order_countdown" || !game.openingOrder) return false;
  if (now < game.openingOrder.countdownEndsAt) return false;
  game.openingOrder.stage = "complete";
  const initialSnapshot = playerSnapshot(game);
  game.turnSummaryBaselines = Object.fromEntries(
    game.players.map((player) => [player.id, initialSnapshot]),
  );
  beginTurn(game);
  touch(game);
  return true;
}

function setDiceMode(game, requesterId, mode) {
  if (game.status !== "lobby") throw new Error("只能在开局前修改骰子模式");
  if (requesterId !== game.hostId) throw new Error("只有房主可以修改骰子模式");
  if (!new Set(["random", "choice"]).has(mode)) throw new Error("骰子模式无效");
  game.settings.diceMode = mode;
  addLog(game, `骰子模式已设为${mode === "choice" ? "自选点数" : "随机掷骰"}`);
}

function beginTurn(game) {
  const player = currentPlayer(game);
  game.turnSummary = buildTurnSummary(game, player.id);
  game.phase = "awaiting_roll";
  game.turn = {
    playerId: player.id,
    dice: null,
    doublesCount: 0,
    extraRoll: false,
    aiTradeAttempted: false,
    movements: [],
  };
  game.pendingPurchase = null;
  game.auction = null;
  game.debt = null;
  game.trade = null;
  game.lastCard = null;
  game.pendingCard = null;
  game.lastLanding = null;
  addLog(game, `轮到 ${player.name}`);
}

function playerSnapshot(game) {
  return Object.fromEntries(
    game.players.map((player) => [player.id, { position: player.position, cash: player.cash }]),
  );
}

function buildTurnSummary(game, playerId) {
  const snapshot = game.turnSummaryBaselines[playerId];
  if (!snapshot) return null;
  const changes = game.players.map((player) => {
    const before = snapshot[player.id] || { position: player.position, cash: player.cash };
    return {
      playerId: player.id,
      fromPosition: before.position,
      toPosition: player.position,
      cashBefore: before.cash,
      cashAfter: player.cash,
      cashDelta: player.cash - before.cash,
    };
  }).filter((entry) => entry.fromPosition !== entry.toPosition || entry.cashDelta !== 0);
  if (!changes.length) return null;
  return {
    playerId,
    at: Date.now(),
    players: changes,
  };
}

function completeTurnSummary(game) {
  const player = currentPlayer(game);
  if (player) game.turnSummaryBaselines[player.id] = playerSnapshot(game);
}

function currentPlayer(game) {
  return game.players[game.currentIndex];
}

function activePlayers(game) {
  return game.players.filter((player) => !player.bankrupt);
}

function assertCurrent(game, playerId) {
  const player = currentPlayer(game);
  if (!player || player.id !== playerId) throw new Error("还没有轮到你");
  if (player.bankrupt) throw new Error("该玩家已经破产");
  return player;
}

function assertPhase(game, ...phases) {
  if (!phases.includes(game.phase)) throw new Error("当前阶段不能执行这个操作");
}

function addLog(game, text) {
  game.log.push({ id: uid("log"), text, at: Date.now() });
  if (game.log.length > 120) game.log.splice(0, game.log.length - 120);
}

function touch(game) {
  game.version += 1;
}

function rollDie(rng) {
  return Math.floor(rng() * 6) + 1;
}

function roll(game, playerId, rng = Math.random, chosenDice = null) {
  const player = assertCurrent(game, playerId);
  assertPhase(game, "awaiting_roll");
  const dice = game.settings.diceMode === "choice" && player.kind === "human"
    ? validateChosenDice(chosenDice)
    : [rollDie(rng), rollDie(rng)];
  const total = dice[0] + dice[1];
  const isDouble = dice[0] === dice[1];
  game.turn.dice = dice;
  addLog(game, `${player.name} 掷出 ${dice[0]} + ${dice[1]} = ${total}`);

  if (player.inJail) {
    handleJailRoll(game, player, dice, isDouble);
    return;
  }

  if (isDouble) {
    game.turn.doublesCount += 1;
    if (game.turn.doublesCount >= 3) {
      addLog(game, `${player.name} 连续三次掷出双骰`);
      sendToJail(game, player);
      return;
    }
    game.turn.extraRoll = true;
  } else {
    game.turn.extraRoll = false;
  }

  movePlayer(game, player, total);
  resolveLanding(game, player);
}

function validateChosenDice(dice) {
  if (!Array.isArray(dice) || dice.length !== 2) throw new Error("请选择两颗骰子的点数");
  const values = dice.map(Number);
  if (values.some((value) => !Number.isInteger(value) || value < 1 || value > 6)) {
    throw new Error("每颗骰子的点数必须在 1 到 6 之间");
  }
  return values;
}

function handleJailRoll(game, player, dice, isDouble) {
  const total = dice[0] + dice[1];
  game.turn.extraRoll = false;
  if (isDouble) {
    player.inJail = false;
    player.jailTurns = 0;
    addLog(game, `${player.name} 掷出双骰，离开留置所`);
    movePlayer(game, player, total);
    resolveLanding(game, player);
    return;
  }

  player.jailTurns += 1;
  if (player.jailTurns < 3) {
    addLog(game, `${player.name} 未掷出双骰，继续留置（${player.jailTurns}/3）`);
    game.phase = "turn_complete";
    return;
  }

  const after = { kind: "jailMove", dice };
  charge(game, player, 50, null, "第三次未掷出双骰，缴纳离所费", after);
}

function payBail(game, playerId) {
  const player = assertCurrent(game, playerId);
  assertPhase(game, "awaiting_roll");
  if (!player.inJail) throw new Error("当前玩家不在留置所");
  charge(game, player, 50, null, "离所费", { kind: "leaveJail" });
}

function useJailCard(game, playerId) {
  const player = assertCurrent(game, playerId);
  assertPhase(game, "awaiting_roll");
  if (!player.inJail) throw new Error("当前玩家不在留置所");
  if (player.jailCards < 1) throw new Error("没有免费离所卡");
  player.jailCards -= 1;
  player.inJail = false;
  player.jailTurns = 0;
  addLog(game, `${player.name} 使用免费离所卡`);
}

function movePlayer(game, player, steps, collectGo = true) {
  const oldPosition = player.position;
  const rawPosition = oldPosition + steps;
  if (collectGo && steps > 0 && rawPosition >= BOARD.length) {
    player.cash += 200;
    addLog(game, `${player.name} 经过起点，领取 $200`);
  }
  player.position = ((rawPosition % BOARD.length) + BOARD.length) % BOARD.length;
  const path = [oldPosition];
  const direction = steps < 0 ? -1 : 1;
  for (let offset = 1; offset <= Math.abs(steps); offset += 1) {
    path.push(((oldPosition + offset * direction) % BOARD.length + BOARD.length) % BOARD.length);
  }
  recordMove(game, player, oldPosition, player.position, path);
}

function moveTo(game, player, target, options = {}) {
  const oldPosition = player.position;
  if (options.collectGo !== false && target < player.position) {
    player.cash += 200;
    addLog(game, `${player.name} 经过起点，领取 $200`);
  }
  player.position = target;
  recordMove(game, player, oldPosition, player.position, boardPath(oldPosition, target));
}

function boardPath(from, to) {
  const path = [from];
  let current = from;
  while (current !== to && path.length <= BOARD.length) {
    current = (current + 1) % BOARD.length;
    path.push(current);
  }
  return path;
}

function recordMove(game, player, from, to, path = [from, to]) {
  const movement = {
    id: uid("move"),
    playerId: player.id,
    from,
    to,
    path,
    at: Date.now(),
  };
  game.lastMove = movement;
  if (game.turn?.movements) game.turn.movements.push(movement);
}

function postLandingPhase(game) {
  return game.turn.extraRoll ? "awaiting_roll" : "turn_complete";
}

function finishLanding(game) {
  game.phase = postLandingPhase(game);
}

function resolveLanding(game, player, options = {}) {
  const space = BOARD[player.position];
  addLog(game, `${player.name} 到达 ${space.name}`);

  if (OWNABLE_TYPES.has(space.type)) {
    const state = game.properties[space.index];
    if (!state.ownerId) {
      setLastLanding(game, player, space, { kind: "purchase", amount: space.price });
      game.pendingPurchase = space.index;
      game.phase = "awaiting_purchase";
      return;
    }
    if (state.ownerId === player.id || state.mortgaged) {
      const owner = game.players.find((candidate) => candidate.id === state.ownerId);
      setLastLanding(game, player, space, {
        kind: state.ownerId === player.id ? "own" : "mortgaged",
        recipientId: owner?.id || null,
      });
      if (state.mortgaged) addLog(game, `${space.name} 已抵押，不收取租金`);
      finishLanding(game);
      return;
    }
    const owner = game.players.find((candidate) => candidate.id === state.ownerId);
    if (!owner || owner.bankrupt) {
      setLastLanding(game, player, space, { kind: "noRent" });
      finishLanding(game);
      return;
    }
    const rent = calculateRent(game, space, options);
    setLastLanding(game, player, space, { kind: "rent", amount: rent, recipientId: owner.id });
    charge(game, player, rent, owner.id, `${space.name} 租金`, { kind: "phase", phase: postLandingPhase(game) });
    return;
  }

  if (space.type === "tax") {
    setLastLanding(game, player, space, { kind: "tax", amount: space.amount });
    charge(game, player, space.amount, null, space.name, { kind: "phase", phase: postLandingPhase(game) });
  } else if (space.type === "chance" || space.type === "chest") {
    setLastLanding(game, player, space, { kind: space.type });
    drawCard(game, player, space.type);
  } else if (space.type === "goToJail") {
    setLastLanding(game, player, space, { kind: "goToJail" });
    sendToJail(game, player);
  } else {
    setLastLanding(game, player, space, { kind: "neutral" });
    finishLanding(game);
  }
}

function setLastLanding(game, player, space, details = {}) {
  game.lastLanding = {
    id: uid("landing"),
    playerId: player.id,
    spaceIndex: space.index,
    kind: details.kind || "neutral",
    amount: Number(details.amount || 0),
    recipientId: details.recipientId || null,
    at: Date.now(),
  };
}

function calculateRent(game, space, options = {}) {
  const state = game.properties[space.index];
  const ownerId = state.ownerId;
  if (space.type === "railroad") {
    const count = BOARD.filter(
      (candidate) => candidate.type === "railroad" && game.properties[candidate.index].ownerId === ownerId,
    ).length;
    return 25 * 2 ** (count - 1) * (options.railroadMultiplier || 1);
  }
  if (space.type === "utility") {
    const count = BOARD.filter(
      (candidate) => candidate.type === "utility" && game.properties[candidate.index].ownerId === ownerId,
    ).length;
    const diceTotal = game.turn.dice ? game.turn.dice[0] + game.turn.dice[1] : 7;
    return diceTotal * (options.utilityMultiplier || (count === 2 ? 10 : 4));
  }
  let rent = space.rents[state.houses];
  if (state.houses === 0 && ownsGroup(game, ownerId, space.group)) rent *= 2;
  return rent;
}

function ownsGroup(game, playerId, group) {
  return groupSpaces(group).every((space) => game.properties[space.index].ownerId === playerId);
}

function charge(game, payer, amount, creditorId, reason, after) {
  const roundedAmount = Math.max(0, Math.round(amount));
  if (payer.cash >= roundedAmount) {
    payer.cash -= roundedAmount;
    const creditor = creditorId ? game.players.find((player) => player.id === creditorId) : null;
    if (creditor && !creditor.bankrupt) creditor.cash += roundedAmount;
    addLog(game, `${payer.name} 支付 $${roundedAmount}${reason ? `（${reason}）` : ""}`);
    resumeAfterDebt(game, payer, after);
    return true;
  }
  game.debt = { payerId: payer.id, amount: roundedAmount, creditorId, reason, after };
  game.phase = "debt";
  addLog(game, `${payer.name} 需要筹集 $${roundedAmount} 支付${reason}`);
  return false;
}

function payDebt(game, playerId) {
  assertPhase(game, "debt");
  if (!game.debt || game.debt.payerId !== playerId) throw new Error("当前债务不属于该玩家");
  const player = game.players.find((candidate) => candidate.id === playerId);
  if (player.cash < game.debt.amount) throw new Error("现金不足，请出售建筑或抵押资产");
  const debt = game.debt;
  player.cash -= debt.amount;
  const creditor = debt.creditorId ? game.players.find((candidate) => candidate.id === debt.creditorId) : null;
  if (creditor && !creditor.bankrupt) creditor.cash += debt.amount;
  game.debt = null;
  addLog(game, `${player.name} 支付 $${debt.amount}（${debt.reason}）`);
  resumeAfterDebt(game, player, debt.after);
}

function resumeAfterDebt(game, player, after) {
  if (!after || after.kind === "phase") {
    game.phase = after?.phase || postLandingPhase(game);
    return;
  }
  if (after.kind === "leaveJail") {
    player.inJail = false;
    player.jailTurns = 0;
    game.phase = "awaiting_roll";
    addLog(game, `${player.name} 缴费离开留置所`);
    return;
  }
  if (after.kind === "jailMove") {
    player.inJail = false;
    player.jailTurns = 0;
    game.turn.extraRoll = false;
    const total = after.dice[0] + after.dice[1];
    addLog(game, `${player.name} 缴费离开留置所并移动 ${total} 格`);
    movePlayer(game, player, total);
    resolveLanding(game, player);
  }
}

function sendToJail(game, player) {
  const oldPosition = player.position;
  player.position = 10;
  recordMove(game, player, oldPosition, player.position, [oldPosition, player.position]);
  player.inJail = true;
  player.jailTurns = 0;
  game.turn.extraRoll = false;
  game.phase = "turn_complete";
  setLastLanding(game, player, BOARD[10], { kind: "jail" });
  addLog(game, `${player.name} 被送往留置所`);
}

function drawCard(game, player, deckName) {
  const definitions = deckName === "chance" ? CHANCE_CARDS : CHEST_CARDS;
  const deck = game.decks[deckName];
  const cardId = deck.shift();
  const card = definitions.find((candidate) => candidate.id === cardId);
  if (!card) throw new Error("卡牌数据无效");
  if (card.effect.type !== "jailCard") deck.push(cardId);
  game.lastCard = { deck: deckName, text: card.text };
  addLog(game, `${player.name} 抽到：${card.text}`);
  if (deckName === "chance") {
    game.pendingCard = { playerId: player.id, deck: deckName, cardId, text: card.text };
    game.phase = "card_confirmation";
    return;
  }
  applyCard(game, player, card.effect);
}

function confirmCard(game, playerId) {
  assertPhase(game, "card_confirmation");
  const pending = game.pendingCard;
  if (!pending || pending.playerId !== playerId) throw new Error("只有抽到机会卡的玩家可以确认");
  const player = game.players.find((candidate) => candidate.id === playerId && !candidate.bankrupt);
  const card = CHANCE_CARDS.find((candidate) => candidate.id === pending.cardId);
  if (!player || !card) throw new Error("卡牌数据无效");
  game.pendingCard = null;
  addLog(game, `${player.name} 确认了机会卡`);
  applyCard(game, player, card.effect);
}

function applyCard(game, player, effect) {
  if (effect.type === "money") {
    if (effect.amount >= 0) {
      player.cash += effect.amount;
      finishLanding(game);
    } else {
      charge(game, player, -effect.amount, null, "卡牌费用", { kind: "phase", phase: postLandingPhase(game) });
    }
    return;
  }
  if (effect.type === "moveTo") {
    moveTo(game, player, effect.target);
    resolveLanding(game, player);
    return;
  }
  if (effect.type === "move") {
    movePlayer(game, player, effect.steps, false);
    resolveLanding(game, player);
    return;
  }
  if (effect.type === "jail") {
    sendToJail(game, player);
    return;
  }
  if (effect.type === "jailCard") {
    player.jailCards += 1;
    finishLanding(game);
    return;
  }
  if (effect.type === "nearestRail" || effect.type === "nearestUtility") {
    const targets = effect.type === "nearestRail" ? [5, 15, 25, 35] : [12, 28];
    const target = targets.find((index) => index > player.position) ?? targets[0];
    moveTo(game, player, target);
    resolveLanding(game, player, effect.type === "nearestRail" ? { railroadMultiplier: 2 } : { utilityMultiplier: 10 });
    return;
  }
  if (effect.type === "repairs") {
    let amount = 0;
    for (const [index, state] of Object.entries(game.properties)) {
      if (state.ownerId !== player.id || BOARD[index].type !== "property") continue;
      amount += state.houses === 5 ? effect.hotel : state.houses * effect.house;
    }
    charge(game, player, amount, null, "建筑维修", { kind: "phase", phase: postLandingPhase(game) });
  }
}

function buyProperty(game, playerId) {
  const player = assertCurrent(game, playerId);
  assertPhase(game, "awaiting_purchase");
  const space = BOARD[game.pendingPurchase];
  const state = game.properties[space.index];
  if (state.ownerId) throw new Error("该资产已经有主人");
  if (player.cash < space.price) throw new Error("现金不足，不能购买");
  player.cash -= space.price;
  state.ownerId = player.id;
  addLog(game, `${player.name} 以 $${space.price} 购买 ${space.name}`);
  game.pendingPurchase = null;
  finishLanding(game);
}

function declineProperty(game, playerId) {
  assertCurrent(game, playerId);
  assertPhase(game, "awaiting_purchase");
  const spaceIndex = game.pendingPurchase;
  game.pendingPurchase = null;
  startAuction(game, spaceIndex, postLandingPhase(game));
}

function startAuction(game, spaceIndex, returnPhase) {
  const startIndex = game.currentIndex;
  const ordered = [];
  for (let offset = 1; offset <= game.players.length; offset += 1) {
    const player = game.players[(startIndex + offset) % game.players.length];
    if (!player.bankrupt) ordered.push(player.id);
  }
  game.auction = {
    spaceIndex,
    activeIds: ordered,
    turnPos: 0,
    currentBid: 0,
    bidderId: null,
    returnPhase,
  };
  game.phase = "auction";
  addLog(game, `${BOARD[spaceIndex].name} 进入公开拍卖`);
}

function auctionCurrentPlayerId(game) {
  if (!game.auction || game.auction.activeIds.length === 0) return null;
  if (game.auction.activeIds.length === 1 && game.auction.bidderId === game.auction.activeIds[0]) return null;
  for (let offset = 0; offset < game.auction.activeIds.length; offset += 1) {
    const pos = (game.auction.turnPos + offset) % game.auction.activeIds.length;
    const candidate = game.auction.activeIds[pos];
    if (candidate !== game.auction.bidderId) {
      game.auction.turnPos = pos;
      return candidate;
    }
  }
  return null;
}

function bidAuction(game, playerId, amount) {
  assertPhase(game, "auction");
  if (auctionCurrentPlayerId(game) !== playerId) throw new Error("还没有轮到你出价");
  const player = game.players.find((candidate) => candidate.id === playerId);
  const bid = Number(amount);
  if (!Number.isInteger(bid) || bid <= game.auction.currentBid) throw new Error("出价必须高于当前价格");
  if (bid > player.cash) throw new Error("出价不能超过你的现金");
  game.auction.currentBid = bid;
  game.auction.bidderId = playerId;
  addLog(game, `${player.name} 出价 $${bid}`);
  game.auction.turnPos = (game.auction.turnPos + 1) % game.auction.activeIds.length;
  settleAuctionIfReady(game);
}

function passAuction(game, playerId) {
  assertPhase(game, "auction");
  if (auctionCurrentPlayerId(game) !== playerId) throw new Error("还没有轮到你操作");
  const player = game.players.find((candidate) => candidate.id === playerId);
  const index = game.auction.activeIds.indexOf(playerId);
  game.auction.activeIds.splice(index, 1);
  if (index < game.auction.turnPos) game.auction.turnPos -= 1;
  if (game.auction.activeIds.length) game.auction.turnPos %= game.auction.activeIds.length;
  addLog(game, `${player.name} 退出拍卖`);
  settleAuctionIfReady(game);
}

function settleAuctionIfReady(game) {
  if (!game.auction) return;
  if (game.auction.activeIds.length === 0) {
    endAuction(game, null);
    return;
  }
  if (game.auction.activeIds.length === 1 && game.auction.bidderId === game.auction.activeIds[0]) {
    endAuction(game, game.auction.bidderId);
  }
}

function endAuction(game, winnerId) {
  const auction = game.auction;
  const space = BOARD[auction.spaceIndex];
  if (winnerId) {
    const winner = game.players.find((player) => player.id === winnerId);
    winner.cash -= auction.currentBid;
    game.properties[space.index].ownerId = winner.id;
    addLog(game, `${winner.name} 以 $${auction.currentBid} 拍得 ${space.name}`);
  } else {
    addLog(game, `${space.name} 本轮流拍`);
  }
  game.auction = null;
  game.phase = auction.returnPhase;
}

function offerTrade(game, proposerId, action) {
  const proposer = assertCurrent(game, proposerId);
  assertPhase(game, "awaiting_roll", "turn_complete");
  if (game.trade) throw new Error("已经有一笔交易等待处理");
  const target = game.players.find(
    (player) => player.id === action.targetId && !player.bankrupt && player.id !== proposer.id,
  );
  if (!target) throw new Error("交易对象无效");

  const trade = {
    id: uid("trade"),
    proposerId: proposer.id,
    targetId: target.id,
    offer: normalizeTradeBundle(action.offer),
    request: normalizeTradeBundle(action.request),
    returnPhase: game.phase,
    createdAt: Date.now(),
  };
  validateTrade(game, trade);
  if (proposer.kind === "ai" && game.turn) game.turn.aiTradeAttempted = true;
  game.trade = trade;
  game.phase = "trade";
  addLog(game, `${proposer.name} 向 ${target.name} 发起交易`);
}

function normalizeTradeBundle(bundle) {
  const cash = Number(bundle?.cash || 0);
  if (!Number.isInteger(cash) || cash < 0 || cash > 1_000_000) throw new Error("交易现金金额无效");
  const properties = [...new Set((Array.isArray(bundle?.properties) ? bundle.properties : []).map(Number))];
  if (properties.some((index) => !Number.isInteger(index) || !OWNABLE_TYPES.has(BOARD[index]?.type))) {
    throw new Error("交易资产无效");
  }
  return { cash, properties };
}

function validateTrade(game, trade) {
  const proposer = game.players.find((player) => player.id === trade.proposerId && !player.bankrupt);
  const target = game.players.find((player) => player.id === trade.targetId && !player.bankrupt);
  if (!proposer || !target || proposer.id === target.id) throw new Error("交易双方状态无效");
  if (!hasTradeValue(trade.offer) || !hasTradeValue(trade.request)) {
    throw new Error("交易双方都必须提供现金或地产");
  }
  validateTradeBundle(game, proposer, trade.offer);
  validateTradeBundle(game, target, trade.request);
  if (proposer.cash < trade.offer.cash) throw new Error(`${proposer.name} 的现金不足`);
  if (target.cash < trade.request.cash) throw new Error(`${target.name} 的现金不足`);

  const settlement = tradeSettlement(game, trade);
  if (settlement.proposerCash < 0) throw new Error(`${proposer.name} 无法支付抵押资产手续费`);
  if (settlement.targetCash < 0) throw new Error(`${target.name} 无法支付抵押资产手续费`);
  return settlement;
}

function hasTradeValue(bundle) {
  return bundle.cash > 0 || bundle.properties.length > 0;
}

function validateTradeBundle(game, owner, bundle) {
  for (const index of bundle.properties) {
    const space = BOARD[index];
    const state = game.properties[index];
    if (!state || state.ownerId !== owner.id) throw new Error(`${space?.name || "资产"} 已不属于 ${owner.name}`);
    if (space.type === "property") {
      const hasBuildings = groupSpaces(space.group).some((item) => game.properties[item.index].houses > 0);
      if (hasBuildings) throw new Error(`${GROUPS[space.group].name}有建筑，必须先全部出售`);
    }
  }
}

function tradeSettlement(game, trade) {
  const proposer = game.players.find((player) => player.id === trade.proposerId);
  const target = game.players.find((player) => player.id === trade.targetId);
  const proposerFee = mortgageTransferFee(game, trade.request.properties);
  const targetFee = mortgageTransferFee(game, trade.offer.properties);
  return {
    proposerFee,
    targetFee,
    proposerCash: proposer.cash - trade.offer.cash + trade.request.cash - proposerFee,
    targetCash: target.cash - trade.request.cash + trade.offer.cash - targetFee,
  };
}

function mortgageTransferFee(game, propertyIndexes) {
  return propertyIndexes.reduce((total, index) => {
    const state = game.properties[index];
    return total + (state.mortgaged ? Math.ceil((BOARD[index].price / 2) * 0.1) : 0);
  }, 0);
}

function acceptTrade(game, playerId) {
  assertPhase(game, "trade");
  if (!game.trade || game.trade.targetId !== playerId) throw new Error("只有交易接收方可以接受");
  const trade = game.trade;
  const settlement = validateTrade(game, trade);
  const proposer = game.players.find((player) => player.id === trade.proposerId);
  const target = game.players.find((player) => player.id === trade.targetId);

  proposer.cash = settlement.proposerCash;
  target.cash = settlement.targetCash;
  for (const index of trade.offer.properties) game.properties[index].ownerId = target.id;
  for (const index of trade.request.properties) game.properties[index].ownerId = proposer.id;

  game.trade = null;
  game.phase = trade.returnPhase;
  addLog(game, `${target.name} 接受了 ${proposer.name} 的交易`);
  if (settlement.proposerFee > 0) addLog(game, `${proposer.name} 支付抵押转让手续费 $${settlement.proposerFee}`);
  if (settlement.targetFee > 0) addLog(game, `${target.name} 支付抵押转让手续费 $${settlement.targetFee}`);
}

function rejectTrade(game, playerId) {
  assertPhase(game, "trade");
  const trade = game.trade;
  if (!trade || ![trade.proposerId, trade.targetId].includes(playerId)) throw new Error("当前玩家不能处理这笔交易");
  const actor = game.players.find((player) => player.id === playerId);
  const cancelled = playerId === trade.proposerId;
  if (!cancelled) recordAiTradeRejection(game, trade);
  game.trade = null;
  game.phase = trade.returnPhase;
  addLog(game, `${actor.name} ${cancelled ? "取消" : "拒绝"}了交易`);
}

function tradeGoalKeys(propertyIndexes) {
  const goals = propertyIndexes.map((index) => {
    const space = BOARD[index];
    if (space?.type === "property") return `property:${space.group}`;
    if (space?.type === "railroad") return "railroad";
    if (space?.type === "utility") return "utility";
    return `asset:${index}`;
  });
  return [...new Set(goals)];
}

function aiTradeCooldownKey(proposerId, targetId, goal) {
  return `${proposerId}|${targetId}|${goal}`;
}

function recordAiTradeRejection(game, trade) {
  const proposer = game.players.find((player) => player.id === trade.proposerId);
  if (proposer?.kind !== "ai") return;
  game.aiTradeCooldowns ||= {};
  const completedTurns = game.turnCounts?.[proposer.id] || 0;
  for (const goal of tradeGoalKeys(trade.request.properties)) {
    game.aiTradeCooldowns[aiTradeCooldownKey(proposer.id, trade.targetId, goal)] = completedTurns + 4;
  }
}

function aiTradeOnCooldown(game, proposerId, targetId, propertyIndexes) {
  const completedTurns = game.turnCounts?.[proposerId] || 0;
  return tradeGoalKeys(propertyIndexes).some((goal) => {
    const expiresAt = game.aiTradeCooldowns?.[aiTradeCooldownKey(proposerId, targetId, goal)] || 0;
    return completedTurns < expiresAt;
  });
}

function canManage(game, playerId) {
  const player = assertCurrent(game, playerId);
  if (game.phase === "debt") {
    if (game.debt.payerId !== playerId) throw new Error("当前不能管理资产");
    return player;
  }
  assertPhase(game, "awaiting_roll", "awaiting_purchase", "turn_complete");
  return player;
}

function build(game, playerId, spaceIndex) {
  const player = canManage(game, playerId);
  if (game.phase === "debt") throw new Error("负债时不能建造建筑");
  const space = BOARD[spaceIndex];
  if (!space || space.type !== "property") throw new Error("该地块不能建造");
  const state = game.properties[spaceIndex];
  if (state.ownerId !== player.id) throw new Error("你不拥有该地块");
  const group = groupSpaces(space.group);
  if (!ownsGroup(game, player.id, space.group)) throw new Error("必须拥有完整颜色组才能建造");
  if (group.some((item) => game.properties[item.index].mortgaged)) throw new Error("同组有资产抵押时不能建造");
  const levels = group.map((item) => game.properties[item.index].houses);
  if (state.houses !== Math.min(...levels)) throw new Error("必须在同色地块上均匀建造");
  if (state.houses >= 5) throw new Error("该地块已经有旅馆");
  if (player.cash < space.buildCost) throw new Error("现金不足");
  const supply = bankSupply(game);
  if (state.houses === 4 && supply.hotels < 1) throw new Error("银行没有可用旅馆");
  if (state.houses < 4 && supply.houses < 1) throw new Error("银行没有可用房屋");
  player.cash -= space.buildCost;
  state.houses += 1;
  addLog(game, `${player.name} 在 ${space.name} 建造${state.houses === 5 ? "旅馆" : "房屋"}`);
}

function sellBuilding(game, playerId, spaceIndex) {
  const player = canManage(game, playerId);
  const space = BOARD[spaceIndex];
  if (!space || space.type !== "property") throw new Error("该地块没有建筑");
  const state = game.properties[spaceIndex];
  if (state.ownerId !== player.id || state.houses < 1) throw new Error("没有可出售的建筑");
  const group = groupSpaces(space.group);
  const levels = group.map((item) => game.properties[item.index].houses);
  if (state.houses !== Math.max(...levels)) throw new Error("必须均匀出售同色地块上的建筑");
  if (state.houses === 5 && bankSupply(game).houses < 4) throw new Error("银行房屋不足，暂时不能拆分旅馆");
  state.houses -= 1;
  player.cash += Math.floor(space.buildCost / 2);
  addLog(game, `${player.name} 出售 ${space.name} 的一层建筑`);
}

function mortgage(game, playerId, spaceIndex) {
  const player = canManage(game, playerId);
  const space = BOARD[spaceIndex];
  if (!space || !OWNABLE_TYPES.has(space.type)) throw new Error("该资产不能抵押");
  const state = game.properties[spaceIndex];
  if (state.ownerId !== player.id) throw new Error("你不拥有该资产");
  if (state.mortgaged) throw new Error("该资产已经抵押");
  if (space.type === "property") {
    const hasBuildings = groupSpaces(space.group).some((item) => game.properties[item.index].houses > 0);
    if (hasBuildings) throw new Error("必须先出售同色组的全部建筑");
  }
  state.mortgaged = true;
  const value = Math.floor(space.price / 2);
  player.cash += value;
  addLog(game, `${player.name} 抵押 ${space.name}，获得 $${value}`);
}

function unmortgage(game, playerId, spaceIndex) {
  const player = canManage(game, playerId);
  if (game.phase === "debt") throw new Error("负债时不能赎回资产");
  const space = BOARD[spaceIndex];
  const state = game.properties[spaceIndex];
  if (!space || !state || state.ownerId !== player.id || !state.mortgaged) throw new Error("该资产不能赎回");
  const cost = Math.ceil((space.price / 2) * 1.1);
  if (player.cash < cost) throw new Error("现金不足");
  player.cash -= cost;
  state.mortgaged = false;
  addLog(game, `${player.name} 以 $${cost} 赎回 ${space.name}`);
}

function bankSupply(game) {
  let usedHouses = 0;
  let usedHotels = 0;
  for (const state of Object.values(game.properties)) {
    if (state.houses === 5) usedHotels += 1;
    else usedHouses += state.houses;
  }
  return { houses: 32 - usedHouses, hotels: 12 - usedHotels };
}

function declareBankruptcy(game, playerId) {
  assertPhase(game, "debt");
  if (!game.debt || game.debt.payerId !== playerId) throw new Error("当前不能宣告破产");
  const player = game.players.find((candidate) => candidate.id === playerId);
  const creditor = game.debt.creditorId
    ? game.players.find((candidate) => candidate.id === game.debt.creditorId && !candidate.bankrupt)
    : null;
  const transferredProperties = Object.entries(game.properties)
    .filter(([, state]) => state.ownerId === player.id)
    .map(([index]) => Number(index));

  for (const [index, state] of Object.entries(game.properties)) {
    if (state.ownerId !== player.id) continue;
    const space = BOARD[index];
    if (space.type === "property" && state.houses > 0) {
      player.cash += Math.floor((space.buildCost * state.houses) / 2);
      state.houses = 0;
    }
    state.ownerId = creditor?.id || null;
    if (!creditor) state.mortgaged = false;
  }
  if (creditor) creditor.cash += player.cash;
  player.cash = 0;
  player.bankrupt = true;
  player.inJail = false;
  game.debt = null;
  game.lastBankruptcy = {
    id: uid("bankruptcy"),
    playerId: player.id,
    creditorId: creditor?.id || null,
    properties: transferredProperties,
    at: Date.now(),
  };
  addLog(game, `${player.name} 宣告破产${creditor ? `，资产转交给 ${creditor.name}` : "，资产归还银行"}`);

  const remaining = activePlayers(game);
  if (remaining.length === 1) {
    completeTurnSummary(game);
    game.status = "finished";
    game.phase = "finished";
    game.winnerId = remaining[0].id;
    addLog(game, `${remaining[0].name} 获得胜利`);
    return;
  }
  advanceTurn(game);
}

function endTurn(game, playerId) {
  assertCurrent(game, playerId);
  assertPhase(game, "turn_complete");
  game.turnCounts ||= {};
  game.turnCounts[playerId] = (game.turnCounts[playerId] || 0) + 1;
  advanceTurn(game);
}

function advanceTurn(game) {
  completeTurnSummary(game);
  for (let offset = 1; offset <= game.players.length; offset += 1) {
    const nextIndex = (game.currentIndex + offset) % game.players.length;
    if (!game.players[nextIndex].bankrupt) {
      game.currentIndex = nextIndex;
      beginTurn(game);
      return;
    }
  }
}

function performAction(game, playerId, action, rng = Math.random) {
  if (!action || typeof action.type !== "string") throw new Error("操作格式无效");
  if (game.status !== "playing" && !["start", "set_dice_mode"].includes(action.type)) throw new Error("游戏尚未开始");
  switch (action.type) {
    case "start":
      startGame(game, playerId, rng);
      break;
    case "roll_for_order":
      rollForOpeningOrder(game, playerId, rng);
      break;
    case "roll":
      roll(game, playerId, rng, action.dice);
      break;
    case "confirm_card":
      confirmCard(game, playerId);
      break;
    case "set_dice_mode":
      setDiceMode(game, playerId, action.mode);
      break;
    case "offer_trade":
      offerTrade(game, playerId, action);
      break;
    case "accept_trade":
      acceptTrade(game, playerId);
      break;
    case "reject_trade":
      rejectTrade(game, playerId);
      break;
    case "buy":
      buyProperty(game, playerId);
      break;
    case "decline":
      declineProperty(game, playerId);
      break;
    case "bid":
      bidAuction(game, playerId, action.amount);
      break;
    case "pass_auction":
      passAuction(game, playerId);
      break;
    case "end_turn":
      endTurn(game, playerId);
      break;
    case "pay_bail":
      payBail(game, playerId);
      break;
    case "use_jail_card":
      useJailCard(game, playerId);
      break;
    case "pay_debt":
      payDebt(game, playerId);
      break;
    case "bankrupt":
      declareBankruptcy(game, playerId);
      break;
    case "build":
      build(game, playerId, Number(action.spaceIndex));
      break;
    case "sell_building":
      sellBuilding(game, playerId, Number(action.spaceIndex));
      break;
    case "mortgage":
      mortgage(game, playerId, Number(action.spaceIndex));
      break;
    case "unmortgage":
      unmortgage(game, playerId, Number(action.spaceIndex));
      break;
    default:
      throw new Error("未知操作");
  }
  touch(game);
  return game;
}

function publicState(game, viewerId, viewer = {}) {
  const auction = game.auction
    ? { ...game.auction, currentPlayerId: auctionCurrentPlayerId(game) }
    : null;
  return {
    code: game.code,
    status: game.status,
    phase: game.phase,
    hostId: game.hostId,
    players: game.players,
    currentIndex: game.currentIndex,
    currentPlayerId: ["determining_order", "order_countdown"].includes(game.phase)
      ? null
      : currentPlayer(game)?.id || null,
    properties: game.properties,
    turn: game.turn,
    pendingPurchase: game.pendingPurchase,
    auction,
    debt: game.debt,
    winnerId: game.winnerId,
    lastCard: game.lastCard,
    pendingCard: game.pendingCard,
    lastLanding: game.lastLanding,
    lastBankruptcy: game.lastBankruptcy,
    lastMove: game.lastMove,
    trade: game.trade,
    openingOrder: game.openingOrder,
    turnSummary: game.turnSummary,
    settings: game.settings,
    bank: bankSupply(game),
    log: game.log,
    version: game.version,
    board: BOARD,
    groups: GROUPS,
    viewerId,
    viewerRole: viewer.role || "player",
    viewerName: viewer.name || null,
    spectatorId: viewer.spectatorId || null,
    viewerIsHost: Boolean(viewer.isHost),
    spectators: viewer.spectators || [],
  };
}

module.exports = {
  addPlayer,
  aiTradeOnCooldown,
  auctionCurrentPlayerId,
  bankSupply,
  BOARD,
  completeOpeningOrder,
  createGame,
  currentPlayer,
  GROUPS,
  performAction,
  publicState,
  removePlayer,
  startGame,
  switchPlayerToSpectator,
  switchSpectatorToPlayer,
};

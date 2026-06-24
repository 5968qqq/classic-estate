const test = require("node:test");
const assert = require("node:assert/strict");
const { addPlayer, completeOpeningOrder, createGame, performAction, publicState } = require("../src/game");
const { aiAcceptsTrade, chooseAiAction, quoteAiTrade } = require("../src/ai");
const { RoomStore } = require("../src/rooms");

function sequence(values) {
  let index = 0;
  return () => values[index++] ?? values.at(-1) ?? 0;
}

function finishOpeningOrder(game) {
  const dicePairs = [[6, 6], [6, 5], [6, 4], [6, 3], [6, 2], [6, 1]];
  for (const [index, player] of [...game.players].entries()) {
    const dice = dicePairs[index];
    performAction(game, player.id, { type: "roll_for_order" }, sequence(
      dice.map((value) => (value - 0.5) / 6),
    ));
  }
  completeOpeningOrder(game, game.openingOrder.countdownEndsAt);
}

function startedGame() {
  const game = createGame("TEST1");
  const first = addPlayer(game, "甲");
  const second = addPlayer(game, "乙");
  performAction(game, first.id, { type: "start" }, () => 0.5);
  finishOpeningOrder(game);
  return { game, first, second };
}

test("开局掷骰按总点数决定顺序并展示三秒倒计时", () => {
  const game = createGame("ORDER");
  const first = addPlayer(game, "甲");
  const second = addPlayer(game, "乙");
  performAction(game, first.id, { type: "start" }, () => 0.5);

  assert.equal(game.phase, "determining_order");
  assert.equal(publicState(game, first.id).currentPlayerId, null);
  assert.throws(() => performAction(game, first.id, { type: "roll" }), /当前阶段/);

  performAction(game, first.id, { type: "roll_for_order" }, sequence([0, 0]));
  assert.deepEqual(game.openingOrder.pendingIds, [second.id]);
  const countdownStartedAt = Date.now();
  performAction(game, second.id, { type: "roll_for_order" }, sequence([0.5, 0.5]));

  assert.equal(game.phase, "order_countdown");
  assert.ok(game.openingOrder.countdownEndsAt - countdownStartedAt >= 2_900);
  assert.ok(game.openingOrder.countdownEndsAt - countdownStartedAt <= 3_100);
  assert.deepEqual(game.openingOrder.order, [second.id, first.id]);
  assert.equal(game.players[0].id, second.id);
  assert.equal(completeOpeningOrder(game, game.openingOrder.countdownEndsAt - 1), false);
  assert.equal(game.phase, "order_countdown");
  assert.equal(completeOpeningOrder(game, game.openingOrder.countdownEndsAt), true);
  assert.equal(game.phase, "awaiting_roll");
  assert.equal(game.turn.playerId, second.id);
});

test("开局排序同分玩家会单独加赛并保留上一轮点数层级", () => {
  const game = createGame("TIE01");
  const first = addPlayer(game, "甲");
  const second = addPlayer(game, "乙");
  performAction(game, first.id, { type: "start" }, () => 0.5);

  performAction(game, first.id, { type: "roll_for_order" }, sequence([0, 0.5]));
  performAction(game, second.id, { type: "roll_for_order" }, sequence([0.34, 0.2]));
  assert.equal(game.openingOrder.round, 2);
  assert.deepEqual(game.openingOrder.pendingIds, [first.id, second.id]);
  performAction(game, first.id, { type: "roll_for_order" }, sequence([0, 0]));
  assert.deepEqual(game.openingOrder.pendingIds, [second.id]);
  assert.throws(
    () => performAction(game, first.id, { type: "roll_for_order" }, sequence([0, 0])),
    /本轮已经掷过/,
  );
  performAction(game, second.id, { type: "roll_for_order" }, sequence([0.99, 0.99]));
  assert.equal(game.phase, "order_countdown");
  assert.deepEqual(game.openingOrder.order, [second.id, first.id]);
  assert.deepEqual(game.openingOrder.entries.map((entry) => entry.rolls.length), [2, 2]);
});

test("玩家可以买地，其他玩家落地后向所有者支付租金", () => {
  const { game, first, second } = startedGame();
  performAction(game, first.id, { type: "roll" }, sequence([0, 0.2]));
  assert.equal(game.pendingPurchase, 3);
  assert.deepEqual(
    {
      playerId: game.lastLanding.playerId,
      spaceIndex: game.lastLanding.spaceIndex,
      kind: game.lastLanding.kind,
      amount: game.lastLanding.amount,
      recipientId: game.lastLanding.recipientId,
    },
    { playerId: first.id, spaceIndex: 3, kind: "purchase", amount: 60, recipientId: null },
  );
  performAction(game, first.id, { type: "buy" });
  assert.equal(game.properties[3].ownerId, first.id);
  assert.equal(first.cash, 1440);

  performAction(game, first.id, { type: "end_turn" });
  performAction(game, second.id, { type: "roll" }, sequence([0, 0.2]));
  assert.equal(second.cash, 1496);
  assert.equal(first.cash, 1444);
  assert.deepEqual(
    {
      playerId: game.lastLanding.playerId,
      spaceIndex: game.lastLanding.spaceIndex,
      kind: game.lastLanding.kind,
      amount: game.lastLanding.amount,
      recipientId: game.lastLanding.recipientId,
    },
    { playerId: second.id, spaceIndex: 3, kind: "rent", amount: 4, recipientId: first.id },
  );
  assert.equal(game.phase, "turn_complete");
});

test("拒绝购买会进入全员拍卖", () => {
  const { game, first, second } = startedGame();
  performAction(game, first.id, { type: "roll" }, sequence([0, 0.2]));
  performAction(game, first.id, { type: "decline" });
  assert.equal(game.phase, "auction");
  assert.equal(game.auction.activeIds[0], second.id);

  performAction(game, second.id, { type: "pass_auction" });
  performAction(game, first.id, { type: "bid", amount: 10 });
  assert.equal(game.properties[3].ownerId, first.id);
  assert.equal(first.cash, 1490);
  assert.equal(game.phase, "turn_complete");
});

test("连续三次双骰会直接进入留置所", () => {
  const { game, first } = startedGame();
  game.decks.chest = ["chest-error"];
  const doubleOnes = () => 0;
  performAction(game, first.id, { type: "roll" }, doubleOnes);
  assert.equal(game.phase, "awaiting_roll");
  performAction(game, first.id, { type: "roll" }, doubleOnes);
  assert.equal(game.phase, "awaiting_roll");
  performAction(game, first.id, { type: "roll" }, doubleOnes);
  assert.equal(first.inJail, true);
  assert.equal(first.position, 10);
  assert.equal(game.phase, "turn_complete");
});

test("本回合保留多段移动路径并在下一回合清空", () => {
  const { game, first, second } = startedGame();
  game.decks.chance = ["chance-back"];

  performAction(game, first.id, { type: "roll" }, sequence([0.34, 0.51]));

  assert.equal(first.position, 7);
  assert.equal(game.phase, "card_confirmation");
  assert.equal(game.pendingCard.playerId, first.id);
  assert.equal(game.turn.movements.length, 1);
  performAction(game, first.id, { type: "confirm_card" });

  assert.equal(first.position, 4);
  assert.equal(game.turn.movements.length, 2);
  assert.deepEqual(game.turn.movements[0].path, [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(game.turn.movements[1].path, [7, 6, 5, 4]);
  assert.equal(game.lastMove.id, game.turn.movements[1].id);

  performAction(game, first.id, { type: "end_turn" });
  assert.equal(game.players[game.currentIndex].id, second.id);
  assert.deepEqual(game.turn.movements, []);
});

test("机会卡必须由抽卡玩家确认后才结算", () => {
  const { game, first, second } = startedGame();
  game.decks.chance = ["chance-dividend"];

  performAction(game, first.id, { type: "roll" }, sequence([0.34, 0.51]));

  assert.equal(first.position, 7);
  assert.equal(first.cash, 1500);
  assert.equal(game.phase, "card_confirmation");
  assert.equal(publicState(game, second.id).pendingCard.text, "银行支付股息 $50");
  assert.throws(
    () => performAction(game, second.id, { type: "confirm_card" }),
    /只有抽到机会卡的玩家/,
  );

  performAction(game, first.id, { type: "confirm_card" });
  assert.equal(first.cash, 1550);
  assert.equal(game.pendingCard, null);
  assert.equal(game.phase, "turn_complete");
});

test("AI 抽到机会卡后会先确认再继续行动", () => {
  const game = createGame("AICRD");
  const human = addPlayer(game, "真人");
  const ai = addPlayer(game, "电脑", "ai");
  performAction(game, human.id, { type: "start" }, () => 0.5);
  finishOpeningOrder(game);
  game.currentIndex = game.players.indexOf(ai);
  game.turn = { playerId: ai.id, dice: [3, 4], extraRoll: false, movements: [] };
  game.phase = "card_confirmation";
  game.pendingCard = {
    playerId: ai.id,
    deck: "chance",
    cardId: "chance-dividend",
    text: "银行支付股息 $50",
  };

  assert.deepEqual(chooseAiAction(game, ai.id), { type: "confirm_card" });
});

test("观察者可在游戏开始后进入但不能执行游戏操作", () => {
  const rooms = new RoomStore();
  const host = rooms.create("房主");
  const guest = rooms.join(host.code, "玩家二");
  rooms.action(host.code, host.token, { type: "start" });

  const spectator = rooms.watch(host.code, "观察者");
  assert.equal(spectator.state.viewerRole, "spectator");
  assert.equal(spectator.state.viewerId, null);
  assert.equal(spectator.state.viewerName, "观察者");
  assert.equal(spectator.state.players.length, 2);
  assert.equal(spectator.state.players.some((player) => player.name === "观察者"), false);
  assert.throws(
    () => rooms.action(host.code, spectator.token, { type: "roll_for_order" }),
    /观战者不能执行游戏操作/,
  );
  assert.throws(
    () => rooms.tradeQuote(host.code, spectator.token, { targetId: guest.playerId }),
    /观战者不能执行游戏操作/,
  );
});

test("房主可在大厅切换为观察者并启动纯 AI 对局", () => {
  const rooms = new RoomStore();
  const host = rooms.create("房主");

  let state = rooms.setRole(host.code, host.token, "spectator");
  assert.equal(state.viewerRole, "spectator");
  assert.equal(state.viewerIsHost, true);
  assert.equal(state.viewerId, null);
  assert.equal(state.players.length, 0);
  assert.equal(state.spectators[0].name, "房主");

  state = rooms.addAi(host.code, host.token);
  state = rooms.addAi(host.code, host.token);
  assert.equal(state.players.length, 2);
  assert.ok(state.players.every((player) => player.kind === "ai"));

  state = rooms.action(host.code, host.token, { type: "start" });
  assert.equal(state.status, "playing");
  assert.equal(state.viewerRole, "spectator");
  assert.throws(
    () => rooms.action(host.code, host.token, { type: "roll_for_order" }),
    /观战者不能执行游戏操作/,
  );

  const room = rooms.rooms.get(host.code);
  if (room?.timer) clearTimeout(room.timer);
});

test("公益基金卡直接结算，不进入机会卡确认阶段", () => {
  const { game, first } = startedGame();
  game.decks.chest = ["chest-error"];

  performAction(game, first.id, { type: "roll" }, sequence([0, 0]));

  assert.equal(first.position, 2);
  assert.equal(first.cash, 1700);
  assert.equal(game.lastLanding.kind, "chest");
  assert.equal(game.pendingCard, null);
  assert.notEqual(game.phase, "card_confirmation");
});

test("房屋必须在完整颜色组中均匀建造", () => {
  const { game, first } = startedGame();
  game.properties[1].ownerId = first.id;
  game.properties[3].ownerId = first.id;

  performAction(game, first.id, { type: "build", spaceIndex: 1 });
  assert.equal(game.properties[1].houses, 1);
  assert.throws(
    () => performAction(game, first.id, { type: "build", spaceIndex: 1 }),
    /均匀建造/,
  );
  performAction(game, first.id, { type: "build", spaceIndex: 3 });
  assert.equal(game.properties[3].houses, 1);
  assert.throws(
    () => performAction(game, first.id, { type: "mortgage", spaceIndex: 1 }),
    /出售同色组的全部建筑/,
  );
});

test("无法支付租金时可宣告破产，最后一名玩家获胜", () => {
  const { game, first, second } = startedGame();
  game.properties[39].ownerId = second.id;
  game.properties[1].ownerId = first.id;
  game.properties[5].ownerId = first.id;
  first.cash = 20;
  first.position = 33;

  performAction(game, first.id, { type: "roll" }, () => 0.34);
  assert.equal(game.phase, "debt");
  assert.equal(game.debt.amount, 50);
  performAction(game, first.id, { type: "bankrupt" });
  assert.equal(first.bankrupt, true);
  assert.equal(game.properties[1].ownerId, second.id);
  assert.equal(game.properties[5].ownerId, second.id);
  assert.equal(game.lastBankruptcy.playerId, first.id);
  assert.equal(game.lastBankruptcy.creditorId, second.id);
  assert.deepEqual(game.lastBankruptcy.properties, [1, 5]);
  assert.deepEqual(publicState(game, second.id).lastBankruptcy, game.lastBankruptcy);
  assert.equal(game.status, "finished");
  assert.equal(game.winnerId, second.id);
});

test("自选骰子模式由房主设置，并按玩家选择的点数移动", () => {
  const game = createGame("PICK1");
  const first = addPlayer(game, "甲");
  const second = addPlayer(game, "乙");

  assert.throws(
    () => performAction(game, second.id, { type: "set_dice_mode", mode: "choice" }),
    /只有房主/,
  );
  performAction(game, first.id, { type: "set_dice_mode", mode: "choice" });
  assert.equal(game.settings.diceMode, "choice");
  performAction(game, first.id, { type: "start" }, () => 0.5);
  finishOpeningOrder(game);

  assert.throws(
    () => performAction(game, first.id, { type: "roll", dice: [0, 7] }),
    /1 到 6/,
  );
  performAction(game, first.id, { type: "roll", dice: [1, 2] });
  assert.deepEqual(game.turn.dice, [1, 2]);
  assert.equal(first.position, 3);
  assert.deepEqual(
    { playerId: game.lastMove.playerId, from: game.lastMove.from, to: game.lastMove.to },
    { playerId: first.id, from: 0, to: 3 },
  );
});

test("多地产和双方现金可以原子交换", () => {
  const { game, first, second } = startedGame();
  game.properties[1].ownerId = first.id;
  game.properties[3].ownerId = first.id;
  game.properties[6].ownerId = second.id;
  game.properties[8].ownerId = second.id;

  performAction(game, first.id, {
    type: "offer_trade",
    targetId: second.id,
    offer: { cash: 100, properties: [1, 3] },
    request: { cash: 25, properties: [6, 8] },
  });
  assert.equal(game.phase, "trade");
  performAction(game, second.id, { type: "accept_trade" });

  assert.equal(game.properties[1].ownerId, second.id);
  assert.equal(game.properties[3].ownerId, second.id);
  assert.equal(game.properties[6].ownerId, first.id);
  assert.equal(game.properties[8].ownerId, first.id);
  assert.equal(first.cash, 1425);
  assert.equal(second.cash, 1575);
  assert.equal(game.phase, "awaiting_roll");
  assert.equal(game.trade, null);
});

test("有建筑的颜色组不能交易，抵押地产转手收取百分之十手续费", () => {
  const { game, first, second } = startedGame();
  game.properties[1].ownerId = first.id;
  game.properties[3].ownerId = first.id;
  game.properties[6].ownerId = second.id;
  game.properties[1].houses = 1;

  assert.throws(
    () => performAction(game, first.id, {
      type: "offer_trade",
      targetId: second.id,
      offer: { cash: 0, properties: [1] },
      request: { cash: 0, properties: [6] },
    }),
    /必须先全部出售/,
  );

  game.properties[1].houses = 0;
  game.properties[1].mortgaged = true;
  performAction(game, first.id, {
    type: "offer_trade",
    targetId: second.id,
    offer: { cash: 0, properties: [1] },
    request: { cash: 0, properties: [6] },
  });
  performAction(game, second.id, { type: "accept_trade" });
  assert.equal(second.cash, 1497);
  assert.equal(game.properties[1].mortgaged, true);
});

test("AI 会接受能补全颜色组的合理交易并拒绝明显吃亏的交易", () => {
  const game = createGame("AITR1");
  const human = addPlayer(game, "真人");
  const ai = addPlayer(game, "电脑", "ai");
  performAction(game, human.id, { type: "start" }, () => 0.5);
  finishOpeningOrder(game);
  game.properties[3].ownerId = human.id;
  game.properties[1].ownerId = ai.id;
  game.properties[6].ownerId = ai.id;

  performAction(game, human.id, {
    type: "offer_trade",
    targetId: ai.id,
    offer: { cash: 25, properties: [3] },
    request: { cash: 0, properties: [6] },
  });
  assert.equal(aiAcceptsTrade(game, ai.id), true);
  performAction(game, human.id, { type: "reject_trade" });

  game.properties[39].ownerId = ai.id;
  performAction(game, human.id, {
    type: "offer_trade",
    targetId: ai.id,
    offer: { cash: 1, properties: [] },
    request: { cash: 0, properties: [39] },
  });
  assert.equal(aiAcceptsTrade(game, ai.id), false);
});

test("AI 报价给出购买地产的最低付款并且不改变游戏状态", () => {
  const game = createGame("AIQ01");
  const human = addPlayer(game, "真人");
  const ai = addPlayer(game, "电脑", "ai");
  performAction(game, human.id, { type: "start" }, () => 0.5);
  finishOpeningOrder(game);
  game.properties[39].ownerId = ai.id;

  const quote = quoteAiTrade(game, human.id, {
    targetId: ai.id,
    offerProperties: [],
    requestProperties: [39],
  });

  assert.deepEqual(quote, { offerCash: 420, requestCash: 0, targetId: ai.id });
  assert.equal(game.trade, null);
  performAction(game, human.id, {
    type: "offer_trade",
    targetId: ai.id,
    offer: { cash: quote.offerCash, properties: [] },
    request: { cash: 0, properties: [39] },
  });
  assert.equal(aiAcceptsTrade(game, ai.id), true);
});

test("AI 报价给出收购玩家地产时愿付的最高现金", () => {
  const game = createGame("AIQ02");
  const human = addPlayer(game, "真人");
  const ai = addPlayer(game, "电脑", "ai");
  performAction(game, human.id, { type: "start" }, () => 0.5);
  finishOpeningOrder(game);
  game.properties[39].ownerId = human.id;

  const quote = quoteAiTrade(game, human.id, {
    targetId: ai.id,
    offerProperties: [39],
    requestProperties: [],
  });

  assert.deepEqual(quote, { offerCash: 0, requestCash: 420, targetId: ai.id });
  assert.equal(game.trade, null);
});

test("商业区补组溢价显著高于旧城区和天际区", () => {
  const game = createGame("AIQ03");
  const human = addPlayer(game, "真人");
  const ai = addPlayer(game, "电脑", "ai");
  performAction(game, human.id, { type: "start" }, () => 0.5);
  finishOpeningOrder(game);

  const completionQuote = (ownedIndexes, missingIndex) => {
    for (const state of Object.values(game.properties)) state.ownerId = null;
    for (const index of ownedIndexes) game.properties[index].ownerId = human.id;
    game.properties[missingIndex].ownerId = ai.id;
    return quoteAiTrade(game, human.id, {
      targetId: ai.id,
      offerProperties: [],
      requestProperties: [missingIndex],
    }).offerCash;
  };

  const oldTownPrice = completionQuote([1], 3);
  const commercialPrice = completionQuote([16, 18], 19);
  const skylinePrice = completionQuote([37], 39);
  assert.ok(commercialPrice / 200 > 3);
  assert.ok(oldTownPrice / 60 < 1.4);
  assert.ok(skylinePrice / 400 > 1.4);
  assert.ok(skylinePrice / 400 < 2.2);
  assert.ok(commercialPrice / 200 > oldTownPrice / 60);
  assert.ok(commercialPrice / 200 > skylinePrice / 400);
});

test("轮到玩家时汇总其上次结束后发生的有效变化", () => {
  const { game, first, second } = startedGame();
  performAction(game, first.id, { type: "roll" }, sequence([0, 0.2]));
  performAction(game, first.id, { type: "buy" });
  performAction(game, first.id, { type: "end_turn" });

  assert.equal(game.turnSummary.playerId, second.id);
  assert.deepEqual(game.turnSummary.players, [
    {
      playerId: first.id,
      fromPosition: 0,
      toPosition: 3,
      cashBefore: 1500,
      cashAfter: 1440,
      cashDelta: -60,
    },
  ]);

  const firstSummary = structuredClone(game.turnSummary);
  performAction(game, second.id, { type: "roll" }, sequence([0, 0.2]));
  assert.deepEqual(game.turnSummary, firstSummary);

  performAction(game, second.id, { type: "end_turn" });
  assert.equal(game.turnSummary.playerId, first.id);
  assert.deepEqual(game.turnSummary.players.map((entry) => entry.cashDelta), [4, -4]);
});

test("AI 会主动向真人提出有收益的补组交易且同回合不重复", () => {
  const game = createGame("AIP01");
  const human = addPlayer(game, "真人");
  const ai = addPlayer(game, "电脑", "ai");
  performAction(game, human.id, { type: "set_dice_mode", mode: "choice" });
  performAction(game, human.id, { type: "start" }, () => 0.5);
  finishOpeningOrder(game);
  game.properties[1].ownerId = ai.id;
  game.properties[3].ownerId = human.id;
  performAction(game, human.id, { type: "roll", dice: [1, 3] });
  performAction(game, human.id, { type: "end_turn" });

  const proposal = chooseAiAction(game, ai.id);
  assert.equal(proposal.type, "offer_trade");
  assert.equal(proposal.targetId, human.id);
  assert.deepEqual(proposal.offer.properties, []);
  assert.deepEqual(proposal.request.properties, [3]);
  assert.ok(proposal.offer.cash > 0);

  performAction(game, ai.id, proposal);
  assert.equal(game.phase, "trade");
  performAction(game, human.id, { type: "reject_trade" });
  game.turn.aiTradeAttempted = false;
  assert.equal(chooseAiAction(game, ai.id).type, "roll");
  for (let completedTurns = 1; completedTurns <= 3; completedTurns += 1) {
    game.turnCounts[ai.id] = completedTurns;
    assert.equal(chooseAiAction(game, ai.id).type, "roll");
  }
  game.turnCounts[ai.id] = 4;
  assert.equal(chooseAiAction(game, ai.id).type, "offer_trade");
});

test("AI 拍卖上限按散地、补组、铁路和公共设施的战略价值递增", () => {
  const game = createGame("AIAUC");
  const human = addPlayer(game, "真人");
  const ai = addPlayer(game, "电脑", "ai");
  performAction(game, human.id, { type: "start" }, () => 0.5);
  finishOpeningOrder(game);
  ai.cash = 1500;

  const auctionAction = (spaceIndex, currentBid) => {
    game.phase = "auction";
    game.auction = {
      spaceIndex,
      activeIds: [ai.id, human.id],
      turnPos: 0,
      currentBid,
      bidderId: human.id,
      returnPhase: "turn_complete",
    };
    return chooseAiAction(game, ai.id);
  };

  const ceiling = (spaceIndex) => {
    let accepted = 0;
    for (let bid = 0; bid < 1_500; bid += 10) {
      if (auctionAction(spaceIndex, bid).type === "pass_auction") return accepted;
      accepted = bid + 10;
    }
    return accepted;
  };

  const singleProperty = ceiling(6);
  game.properties[1].ownerId = ai.id;
  const oldTownCompletion = ceiling(3);

  game.properties[16].ownerId = ai.id;
  game.properties[18].ownerId = ai.id;
  const commercialCompletion = ceiling(19);

  game.properties[37].ownerId = ai.id;
  const skylineCompletion = ceiling(39);

  game.properties[5].ownerId = ai.id;
  game.properties[15].ownerId = ai.id;
  const thirdRailroad = ceiling(25);

  game.properties[12].ownerId = ai.id;
  const secondUtility = ceiling(28);

  assert.ok(oldTownCompletion > singleProperty);
  assert.ok(commercialCompletion > skylineCompletion);
  assert.ok(skylineCompletion > oldTownCompletion);
  assert.ok(thirdRailroad > secondUtility);
});

test("AI 建房优先把高收益商业区从两房推进到三房", () => {
  const game = createGame("AIBLD");
  const human = addPlayer(game, "真人");
  const ai = addPlayer(game, "电脑", "ai");
  performAction(game, human.id, { type: "start" }, () => 0.5);
  finishOpeningOrder(game);
  game.currentIndex = game.players.indexOf(ai);
  game.turn = { playerId: ai.id, aiTradeAttempted: true, movements: [] };
  game.phase = "turn_complete";
  ai.cash = 2_000;

  for (const index of [6, 8, 9, 16, 18, 19]) {
    game.properties[index].ownerId = ai.id;
    game.properties[index].houses = 2;
  }

  const action = chooseAiAction(game, ai.id);
  assert.equal(action.type, "build");
  assert.ok([16, 18, 19].includes(action.spaceIndex));
});

test("AI 后期面对三房威胁时留在监狱，早期仍会主动离开", () => {
  const game = createGame("AIJAIL");
  const human = addPlayer(game, "真人");
  const ai = addPlayer(game, "电脑", "ai");
  performAction(game, human.id, { type: "start" }, () => 0.5);
  finishOpeningOrder(game);
  game.currentIndex = game.players.indexOf(ai);
  game.turn = { playerId: ai.id, aiTradeAttempted: true, movements: [] };
  game.phase = "awaiting_roll";
  ai.inJail = true;
  ai.cash = 1_000;

  assert.equal(chooseAiAction(game, ai.id).type, "pay_bail");

  for (const [index, state] of Object.entries(game.properties)) {
    state.ownerId = Number(index) % 2 === 0 ? ai.id : human.id;
  }
  for (const index of [16, 18, 19]) {
    game.properties[index].ownerId = human.id;
    game.properties[index].houses = 3;
  }
  assert.equal(chooseAiAction(game, ai.id).type, "roll");
});

test("AI 欠债时先抵押弱资产，不轻易把三房核心组拆回两房", () => {
  const game = createGame("AIDEV");
  const human = addPlayer(game, "真人");
  const ai = addPlayer(game, "电脑", "ai");
  performAction(game, human.id, { type: "start" }, () => 0.5);
  finishOpeningOrder(game);
  game.currentIndex = game.players.indexOf(ai);
  game.turn = { playerId: ai.id, aiTradeAttempted: true, movements: [] };
  for (const index of [16, 18, 19]) {
    game.properties[index].ownerId = ai.id;
    game.properties[index].houses = 3;
  }
  game.properties[12].ownerId = ai.id;
  ai.cash = 0;
  game.phase = "debt";
  game.debt = { payerId: ai.id, creditorId: null, amount: 60, reason: "测试债务" };

  assert.deepEqual(chooseAiAction(game, ai.id), { type: "mortgage", spaceIndex: 12 });
});

test("AI 直购与拍卖共用同一现金安全线", () => {
  const game = createGame("AIBUY");
  const human = addPlayer(game, "真人");
  const ai = addPlayer(game, "电脑", "ai");
  performAction(game, human.id, { type: "start" }, () => 0.5);
  finishOpeningOrder(game);
  game.currentIndex = game.players.indexOf(ai);
  game.turn = { playerId: ai.id, aiTradeAttempted: true, movements: [] };
  game.phase = "awaiting_purchase";
  game.pendingPurchase = 6;

  ai.cash = 280;
  assert.equal(chooseAiAction(game, ai.id).type, "buy");
  ai.cash = 279;
  assert.equal(chooseAiAction(game, ai.id).type, "decline");

  game.phase = "auction";
  game.auction = {
    spaceIndex: 6,
    activeIds: [ai.id, human.id],
    turnPos: 0,
    currentBid: 90,
    bidderId: human.id,
    returnPhase: "turn_complete",
  };
  assert.equal(chooseAiAction(game, ai.id).type, "pass_auction");
});

test("AI 主动向另一个 AI 报价后由目标 AI 自动判断", () => {
  const game = createGame("AIP02");
  const human = addPlayer(game, "真人");
  const proposer = addPlayer(game, "电脑甲", "ai");
  const target = addPlayer(game, "电脑乙", "ai");
  performAction(game, human.id, { type: "set_dice_mode", mode: "choice" });
  performAction(game, human.id, { type: "start" }, () => 0.5);
  finishOpeningOrder(game);
  game.properties[1].ownerId = proposer.id;
  game.properties[3].ownerId = target.id;
  performAction(game, human.id, { type: "roll", dice: [1, 3] });
  performAction(game, human.id, { type: "end_turn" });

  const proposal = chooseAiAction(game, proposer.id);
  assert.equal(proposal.type, "offer_trade");
  assert.equal(proposal.targetId, target.id);
  performAction(game, proposer.id, proposal);

  const response = chooseAiAction(game, target.id);
  assert.equal(response.type, "accept_trade");
  performAction(game, target.id, response);
  assert.equal(game.properties[3].ownerId, proposer.id);
  assert.equal(game.phase, "awaiting_roll");
});

test("AI 不会为不能立即补齐颜色组的普通地产主动交易", () => {
  const game = createGame("AIP03");
  const human = addPlayer(game, "真人");
  const ai = addPlayer(game, "电脑", "ai");
  performAction(game, human.id, { type: "set_dice_mode", mode: "choice" });
  performAction(game, human.id, { type: "start" }, () => 0.5);
  finishOpeningOrder(game);
  game.properties[6].ownerId = ai.id;
  game.properties[8].ownerId = human.id;
  performAction(game, human.id, { type: "roll", dice: [1, 3] });
  performAction(game, human.id, { type: "end_turn" });

  assert.equal(chooseAiAction(game, ai.id).type, "roll");
});

test("AI 主动交易铁路仍沿用原有估值逻辑", () => {
  const game = createGame("AIP04");
  const human = addPlayer(game, "真人");
  const ai = addPlayer(game, "电脑", "ai");
  performAction(game, human.id, { type: "set_dice_mode", mode: "choice" });
  performAction(game, human.id, { type: "start" }, () => 0.5);
  finishOpeningOrder(game);
  game.properties[5].ownerId = ai.id;
  game.properties[15].ownerId = human.id;
  performAction(game, human.id, { type: "roll", dice: [1, 3] });
  performAction(game, human.id, { type: "end_turn" });

  const proposal = chooseAiAction(game, ai.id);
  assert.equal(proposal.type, "offer_trade");
  assert.deepEqual(proposal.request.properties, [15]);
});

test("AI 现金充足时优先赎回完整颜色组的抵押地产", () => {
  const game = createGame("AIM01");
  const human = addPlayer(game, "真人");
  const ai = addPlayer(game, "电脑", "ai");
  performAction(game, human.id, { type: "set_dice_mode", mode: "choice" });
  performAction(game, human.id, { type: "start" }, () => 0.5);
  finishOpeningOrder(game);
  game.properties[1].ownerId = ai.id;
  game.properties[3].ownerId = ai.id;
  game.properties[1].mortgaged = true;
  ai.cash = 900;
  performAction(game, human.id, { type: "roll", dice: [1, 3] });
  performAction(game, human.id, { type: "end_turn" });

  const action = chooseAiAction(game, ai.id);
  assert.equal(action.type, "unmortgage");
  assert.ok([1, 3].includes(action.spaceIndex));
  performAction(game, ai.id, action);
  assert.equal(game.properties[action.spaceIndex].mortgaged, false);
});

test("AI 为补齐关键颜色组融资时先抵押非核心资产", () => {
  const game = createGame("AIM02");
  const human = addPlayer(game, "真人");
  const ai = addPlayer(game, "电脑", "ai");
  performAction(game, human.id, { type: "set_dice_mode", mode: "choice" });
  performAction(game, human.id, { type: "start" }, () => 0.5);
  finishOpeningOrder(game);
  performAction(game, human.id, { type: "roll", dice: [1, 3] });
  performAction(game, human.id, { type: "end_turn" });
  game.properties[16].ownerId = ai.id;
  game.properties[18].ownerId = ai.id;
  game.properties[5].ownerId = ai.id;
  ai.cash = 180;
  game.pendingPurchase = 19;
  game.phase = "awaiting_purchase";

  const action = chooseAiAction(game, ai.id);
  assert.deepEqual(action, { type: "mortgage", spaceIndex: 5 });
  performAction(game, ai.id, action);
  assert.equal(chooseAiAction(game, ai.id).type, "buy");
});

test("AI 欠债时优先抵押散置资产并保护完整颜色组", () => {
  const game = createGame("AIM03");
  const human = addPlayer(game, "真人");
  const ai = addPlayer(game, "电脑", "ai");
  performAction(game, human.id, { type: "set_dice_mode", mode: "choice" });
  performAction(game, human.id, { type: "start" }, () => 0.5);
  finishOpeningOrder(game);
  performAction(game, human.id, { type: "roll", dice: [1, 3] });
  performAction(game, human.id, { type: "end_turn" });
  game.properties[1].ownerId = ai.id;
  game.properties[3].ownerId = ai.id;
  game.properties[5].ownerId = ai.id;
  ai.cash = 0;
  game.phase = "debt";
  game.debt = { payerId: ai.id, creditorId: null, amount: 80, reason: "测试债务" };

  assert.deepEqual(chooseAiAction(game, ai.id), { type: "mortgage", spaceIndex: 5 });
});

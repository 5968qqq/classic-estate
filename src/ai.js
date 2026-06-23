const { BOARD } = require("./board");
const { aiTradeOnCooldown, auctionCurrentPlayerId, bankSupply } = require("./game");

const AI_TRADE_RESERVE = 220;
const AI_MIN_TRADE_GAIN = 12;
const COLOR_GROUP_STRATEGY = Object.freeze({
  brown: { partial: 1.05, complete: 1.25 },
  lightBlue: { partial: 1.15, complete: 1.65 },
  pink: { partial: 1.2, complete: 1.9 },
  orange: { partial: 1.3, complete: 2.25 },
  red: { partial: 1.25, complete: 2.1 },
  yellow: { partial: 1.2, complete: 1.9 },
  green: { partial: 1.1, complete: 1.6 },
  darkBlue: { partial: 1.05, complete: 1.35 },
});

function chooseAiAction(game, playerId) {
  const player = game.players.find((candidate) => candidate.id === playerId);
  if (!player || player.kind !== "ai" || player.bankrupt) return null;

  if (game.phase === "trade") {
    if (game.trade?.targetId !== playerId) return null;
    return { type: aiAcceptsTrade(game, playerId) ? "accept_trade" : "reject_trade" };
  }

  if (game.phase === "auction") {
    if (auctionCurrentPlayerId(game) !== playerId) return null;
    const space = BOARD[game.auction.spaceIndex];
    const ceiling = auctionCeiling(game, player, space);
    const nextBid = Math.max(game.auction.currentBid + 10, Math.ceil((game.auction.currentBid + 1) / 10) * 10);
    if (nextBid <= ceiling && nextBid <= player.cash) return { type: "bid", amount: nextBid };
    return { type: "pass_auction" };
  }

  const current = game.players[game.currentIndex];
  if (!current || current.id !== playerId) return null;

  if (game.phase === "debt") return chooseDebtAction(game, player);

  if (game.phase === "awaiting_purchase") {
    const space = BOARD[game.pendingPurchase];
    if (shouldBuy(game, player, space)) return { type: "buy" };
    const mortgageAction = chooseMortgageForPurchase(game, player, space);
    if (mortgageAction) return mortgageAction;
    return { type: "decline" };
  }

  if (game.phase === "awaiting_roll") {
    const tradeAction = chooseAiTrade(game, player);
    if (tradeAction) return tradeAction;
    const unmortgageAction = chooseUnmortgage(game, player);
    if (unmortgageAction) return unmortgageAction;
    const buildAction = chooseBuild(game, player);
    if (buildAction) return buildAction;
    if (player.inJail && player.jailCards > 0 && player.jailTurns >= 1) return { type: "use_jail_card" };
    if (player.inJail && (player.jailTurns >= 2 || player.cash > 700)) return { type: "pay_bail" };
    return { type: "roll" };
  }

  if (game.phase === "turn_complete") {
    const tradeAction = chooseAiTrade(game, player);
    if (tradeAction) return tradeAction;
    const unmortgageAction = chooseUnmortgage(game, player);
    if (unmortgageAction) return unmortgageAction;
    const buildAction = chooseBuild(game, player);
    return buildAction || { type: "end_turn" };
  }

  return null;
}

function chooseAiTrade(game, proposer) {
  if (game.turn?.aiTradeAttempted) return null;
  const proposerAssets = tradeablePropertyIndexes(game, proposer.id);
  const targets = game.players.filter((player) => player.id !== proposer.id && !player.bankrupt);
  const candidates = [];

  for (const target of targets) {
    const targetAssets = tradeablePropertyIndexes(game, target.id);
    for (const requestIndex of targetAssets) {
      const purchase = aiProposalCandidate(game, proposer, target, [], [requestIndex]);
      if (purchase) candidates.push(purchase);

      for (const offerIndex of proposerAssets) {
        const swap = aiProposalCandidate(game, proposer, target, [offerIndex], [requestIndex]);
        if (swap) candidates.push(swap);
      }
    }
  }

  candidates.sort((a, b) => b.score - a.score || a.offer.cash - b.offer.cash);
  const best = candidates[0];
  return best ? {
    type: "offer_trade",
    targetId: best.targetId,
    offer: best.offer,
    request: best.request,
  } : null;
}

function aiProposalCandidate(game, proposer, target, offerProperties, requestProperties) {
  if (!requestedPropertiesCompleteGroups(game, proposer.id, offerProperties, requestProperties)) return null;
  if (aiTradeOnCooldown(game, proposer.id, target.id, requestProperties)) return null;
  const incomingFee = mortgageFee(game, requestProperties);
  const maximumPayment = Math.min(1_000_000, proposer.cash - incomingFee - AI_TRADE_RESERVE);
  if (maximumPayment < 0) return null;

  const trade = {
    proposerId: proposer.id,
    targetId: target.id,
    offer: { cash: 0, properties: offerProperties },
    request: { cash: 0, properties: requestProperties },
  };
  const offerCash = findLowestAcceptedCash(game, trade, target.id, "offer", maximumPayment);
  if (offerCash === null || (offerCash === 0 && !offerProperties.length)) return null;
  trade.offer.cash = offerCash;
  const evaluation = evaluateAiTrade(game, trade, target.id);
  if (!evaluation.accepts || evaluation.proposerGain < AI_MIN_TRADE_GAIN) return null;
  if (evaluation.proposerCashAfter < AI_TRADE_RESERVE) return null;

  return {
    targetId: target.id,
    offer: { cash: offerCash, properties: [...offerProperties] },
    request: { cash: 0, properties: [...requestProperties] },
    score: evaluation.proposerGain,
  };
}

function requestedPropertiesCompleteGroups(game, proposerId, offerProperties, requestProperties) {
  const requestedColorProperties = requestProperties
    .map((index) => BOARD[index])
    .filter((space) => space?.type === "property");
  if (!requestedColorProperties.length) return true;

  const holdingsAfterTrade = ownedPropertySet(game, proposerId);
  for (const index of offerProperties) holdingsAfterTrade.delete(index);
  for (const index of requestProperties) holdingsAfterTrade.add(index);
  return requestedColorProperties.every((space) => BOARD
    .filter((candidate) => candidate.group === space.group)
    .every((candidate) => holdingsAfterTrade.has(candidate.index)));
}

function tradeablePropertyIndexes(game, playerId) {
  return BOARD.filter((space) => {
    const state = game.properties[space.index];
    if (!state || state.ownerId !== playerId) return false;
    if (space.type !== "property") return true;
    return !BOARD.some(
      (candidate) => candidate.group === space.group && game.properties[candidate.index].houses > 0,
    );
  }).map((space) => space.index);
}

function aiAcceptsTrade(game, playerId) {
  const trade = game.trade;
  return trade ? evaluateAiTrade(game, trade, playerId).accepts : false;
}

function evaluateAiTrade(game, trade, playerId) {
  const target = game.players.find((player) => player.id === playerId);
  const proposer = game.players.find((player) => player.id === trade.proposerId);
  if (!target || !proposer) return { accepts: false };

  const targetBefore = ownedPropertySet(game, target.id);
  const proposerBefore = ownedPropertySet(game, proposer.id);
  const targetAfter = new Set(targetBefore);
  const proposerAfter = new Set(proposerBefore);
  for (const index of trade.request.properties) {
    targetAfter.delete(index);
    proposerAfter.add(index);
  }
  for (const index of trade.offer.properties) {
    proposerAfter.delete(index);
    targetAfter.add(index);
  }

  const targetCashAfter = target.cash - trade.request.cash + trade.offer.cash
    - mortgageFee(game, trade.offer.properties);
  const proposerCashAfter = proposer.cash - trade.offer.cash + trade.request.cash
    - mortgageFee(game, trade.request.properties);
  if (targetCashAfter < 180 || proposerCashAfter < 0) {
    return { accepts: false, targetCashAfter, proposerCashAfter };
  }

  const targetBeforeValue = target.cash + portfolioValue(game, targetBefore);
  const targetAfterValue = targetCashAfter + portfolioValue(game, targetAfter);
  const proposerBeforeValue = proposer.cash + portfolioValue(game, proposerBefore);
  const proposerAfterValue = proposerCashAfter + portfolioValue(game, proposerAfter);
  const targetGain = targetAfterValue - targetBeforeValue;
  const proposerGain = proposerAfterValue - proposerBeforeValue;
  return {
    accepts: targetGain >= Math.max(0, proposerGain * 0.5),
    targetGain,
    proposerGain,
    targetCashAfter,
    proposerCashAfter,
  };
}

function quoteAiTrade(game, proposerId, action) {
  if (game.status !== "playing") throw new Error("游戏尚未开始");
  const proposer = game.players.find((player) => player.id === proposerId && !player.bankrupt);
  const current = game.players[game.currentIndex];
  if (!proposer || current?.id !== proposerId) throw new Error("只有当前玩家可以询价");
  if (!["awaiting_roll", "turn_complete"].includes(game.phase)) throw new Error("当前阶段不能交易");

  const target = game.players.find(
    (player) => player.id === action?.targetId && player.kind === "ai" && !player.bankrupt,
  );
  if (!target || target.id === proposerId) throw new Error("只能向有效的 AI 玩家询价");

  const offerProperties = normalizeQuoteProperties(action?.offerProperties);
  const requestProperties = normalizeQuoteProperties(action?.requestProperties);
  if (!offerProperties.length && !requestProperties.length) throw new Error("请先选择要交易的地产");
  validateQuoteProperties(game, proposer, offerProperties);
  validateQuoteProperties(game, target, requestProperties);

  const trade = {
    proposerId,
    targetId: target.id,
    offer: { cash: 0, properties: offerProperties },
    request: { cash: 0, properties: requestProperties },
  };
  const zeroCashAccepted = evaluateAiTrade(game, trade, target.id).accepts;

  if (zeroCashAccepted && offerProperties.length) {
    const maximumPayout = Math.min(
      1_000_000,
      target.cash - mortgageFee(game, offerProperties) - 180,
    );
    const requestCash = findHighestAcceptedCash(game, trade, target.id, "request", maximumPayout);
    if (requestCash > 0 || requestProperties.length) {
      return { offerCash: 0, requestCash, targetId: target.id };
    }
  }

  if (!requestProperties.length) throw new Error("AI 不愿为当前选择的地产出价");
  const maximumPayment = Math.min(
    1_000_000,
    proposer.cash - mortgageFee(game, requestProperties),
  );
  const offerCash = findLowestAcceptedCash(game, trade, target.id, "offer", maximumPayment);
  if (offerCash === null) throw new Error("你的现金不足，当前地块无法与 AI 成交");
  return { offerCash, requestCash: 0, targetId: target.id };
}

function normalizeQuoteProperties(properties) {
  const indexes = [...new Set((Array.isArray(properties) ? properties : []).map(Number))];
  if (indexes.some((index) => !Number.isInteger(index) || !gameProperty(index))) {
    throw new Error("询价地产无效");
  }
  return indexes;
}

function gameProperty(index) {
  return BOARD[index] && ["property", "railroad", "utility"].includes(BOARD[index].type);
}

function validateQuoteProperties(game, owner, indexes) {
  for (const index of indexes) {
    const space = BOARD[index];
    const state = game.properties[index];
    if (!state || state.ownerId !== owner.id) throw new Error(`${space.name} 已不属于 ${owner.name}`);
    if (space.type === "property") {
      const hasBuildings = BOARD.some(
        (candidate) => candidate.group === space.group && game.properties[candidate.index].houses > 0,
      );
      if (hasBuildings) throw new Error(`${space.name} 所在颜色组有建筑，不能交易`);
    }
  }
}

function findHighestAcceptedCash(game, trade, playerId, side, maximum) {
  let low = 0;
  let high = Math.max(0, Math.floor(maximum));
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    trade[side].cash = middle;
    if (evaluateAiTrade(game, trade, playerId).accepts) low = middle;
    else high = middle - 1;
  }
  trade[side].cash = 0;
  return low;
}

function findLowestAcceptedCash(game, trade, playerId, side, maximum) {
  let low = 0;
  let high = Math.max(0, Math.floor(maximum));
  trade[side].cash = high;
  if (!evaluateAiTrade(game, trade, playerId).accepts) {
    trade[side].cash = 0;
    return null;
  }
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    trade[side].cash = middle;
    if (evaluateAiTrade(game, trade, playerId).accepts) high = middle;
    else low = middle + 1;
  }
  trade[side].cash = 0;
  return low;
}

function ownedPropertySet(game, playerId) {
  return new Set(
    BOARD.filter((space) => game.properties[space.index]?.ownerId === playerId).map((space) => space.index),
  );
}

function portfolioValue(game, indexes) {
  const groupCounts = new Map();
  let railroads = 0;
  let utilities = 0;
  for (const index of indexes) {
    const space = BOARD[index];
    if (space.group) groupCounts.set(space.group, (groupCounts.get(space.group) || 0) + 1);
    if (space.type === "railroad") railroads += 1;
    if (space.type === "utility") utilities += 1;
  }

  let total = 0;
  let railroadBase = 0;
  let utilityBase = 0;
  for (const index of indexes) {
    const space = BOARD[index];
    const state = game.properties[index];
    let value = space.price * (state.mortgaged ? 0.55 : 1);
    if (space.group) {
      const groupSize = BOARD.filter((candidate) => candidate.group === space.group).length;
      const owned = groupCounts.get(space.group) || 0;
      const strategy = colorGroupStrategy(space.group);
      if (owned === groupSize) value *= strategy.complete;
      else if (owned === groupSize - 1) value *= strategy.partial;
      value += state.houses * space.buildCost * 0.7;
    } else if (space.type === "railroad") {
      railroadBase += value;
      continue;
    } else if (space.type === "utility") {
      utilityBase += value;
      continue;
    }
    total += value;
  }
  const railroadTotals = [0, 200, 460, 800, 1400];
  const utilityTotals = [0, 150, 450];
  if (railroads > 0) total += railroadBase * (railroadTotals[railroads] / (railroads * 200));
  if (utilities > 0) total += utilityBase * (utilityTotals[utilities] / (utilities * 150));
  return total;
}

function mortgageFee(game, indexes) {
  return indexes.reduce((sum, index) => {
    const space = BOARD[index];
    return sum + (game.properties[index].mortgaged ? Math.ceil((space.price / 2) * 0.1) : 0);
  }, 0);
}

function shouldBuy(game, player, space) {
  if (!space || player.cash < space.price) return false;
  return auctionCeiling(game, player, space) >= space.price;
}

function completesGroup(game, playerId, group) {
  const spaces = BOARD.filter((space) => space.group === group);
  const missing = spaces.filter((space) => game.properties[space.index].ownerId !== playerId);
  return missing.length === 1;
}

function colorGroupStrategy(group) {
  return COLOR_GROUP_STRATEGY[group] || { partial: 1.15, complete: 1.75 };
}

function auctionCeiling(game, player, space) {
  const ownedOfType = BOARD.filter(
    (candidate) => candidate.type === space.type && game.properties[candidate.index]?.ownerId === player.id,
  ).length;
  let multiplier = 1.15;
  let reserve = 220 + game.players.filter((candidate) => !candidate.bankrupt).length * 25;

  if (space.group) {
    const groupSize = BOARD.filter((candidate) => candidate.group === space.group).length;
    const ownedInGroup = BOARD.filter(
      (candidate) => candidate.group === space.group
        && game.properties[candidate.index]?.ownerId === player.id,
    ).length;
    if (ownedInGroup === groupSize - 1) {
      multiplier = colorGroupStrategy(space.group).complete;
      reserve = 80;
    } else if (ownedInGroup > 0) {
      multiplier = colorGroupStrategy(space.group).partial;
    }
  } else if (space.type === "railroad") {
    multiplier = [1.1, 1.25, 1.45, 1.8][Math.min(ownedOfType, 3)];
    reserve = Math.max(160, reserve - ownedOfType * 35);
  } else if (space.type === "utility") {
    multiplier = ownedOfType > 0 ? 1.5 : 1.1;
    if (ownedOfType > 0) reserve = Math.max(170, reserve - 70);
  }
  return Math.max(0, Math.min(Math.floor(space.price * multiplier), player.cash - reserve));
}

function chooseBuild(game, player) {
  if (player.cash < 420) return null;
  const candidates = [];
  const supply = bankSupply(game);
  const groups = new Set(BOARD.filter((space) => space.group).map((space) => space.group));
  for (const group of groups) {
    const spaces = BOARD.filter((space) => space.group === group);
    if (!spaces.every((space) => game.properties[space.index].ownerId === player.id)) continue;
    if (spaces.some((space) => game.properties[space.index].mortgaged)) continue;
    const minimum = Math.min(...spaces.map((space) => game.properties[space.index].houses));
    for (const space of spaces) {
      const state = game.properties[space.index];
      if (state.houses !== minimum || state.houses >= 5) continue;
      if (player.cash - space.buildCost < 300) continue;
      if (state.houses === 4 && supply.hotels < 1) continue;
      if (state.houses < 4 && supply.houses < 1) continue;
      const gain = space.rents[state.houses + 1] - space.rents[state.houses];
      candidates.push({ type: "build", spaceIndex: space.index, score: gain / space.buildCost });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  if (!candidates[0]) return null;
  return { type: "build", spaceIndex: candidates[0].spaceIndex };
}

function chooseUnmortgage(game, player) {
  const candidates = BOARD.filter((space) => {
    const state = game.properties[space.index];
    return state?.ownerId === player.id && state.mortgaged;
  }).map((space) => {
    const cost = Math.ceil((space.price / 2) * 1.1);
    const tier = assetStrategicTier(game, player.id, space);
    const reserve = tier >= 3 ? 300 : tier >= 2 ? 400 : 650;
    return { space, cost, tier, reserve, score: tier * 1000 + space.price };
  }).filter((candidate) => player.cash - candidate.cost >= candidate.reserve)
    .sort((a, b) => b.score - a.score);
  return candidates[0] ? { type: "unmortgage", spaceIndex: candidates[0].space.index } : null;
}

function chooseMortgageForPurchase(game, player, space) {
  if (!space || player.cash >= space.price || !isStrategicPurchase(game, player.id, space)) return null;
  const shortfall = space.price - player.cash;
  const candidates = mortgageCandidates(game, player.id, space.group);
  const available = candidates.reduce((total, candidate) => total + Math.floor(candidate.price / 2), 0);
  if (available < shortfall) return null;
  return candidates[0] ? { type: "mortgage", spaceIndex: candidates[0].index } : null;
}

function isStrategicPurchase(game, playerId, space) {
  if (space.group) return completesGroup(game, playerId, space.group);
  if (space.type === "railroad") {
    return BOARD.filter(
      (candidate) => candidate.type === "railroad" && game.properties[candidate.index].ownerId === playerId,
    ).length >= 2;
  }
  if (space.type === "utility") {
    return BOARD.some(
      (candidate) => candidate.type === "utility" && game.properties[candidate.index].ownerId === playerId,
    );
  }
  return false;
}

function mortgageCandidates(game, playerId, avoidGroup = null) {
  return BOARD.filter((space) => {
    const state = game.properties[space.index];
    if (!state || state.ownerId !== playerId || state.mortgaged) return false;
    if (space.type !== "property") return true;
    return !BOARD.some(
      (candidate) => candidate.group === space.group && game.properties[candidate.index].houses > 0,
    );
  }).sort((a, b) => {
    const aAvoided = a.group === avoidGroup ? 1 : 0;
    const bAvoided = b.group === avoidGroup ? 1 : 0;
    if (aAvoided !== bAvoided) return aAvoided - bAvoided;
    const tierDifference = assetStrategicTier(game, playerId, a) - assetStrategicTier(game, playerId, b);
    return tierDifference || b.price - a.price;
  });
}

function assetStrategicTier(game, playerId, space) {
  if (space.group) {
    const group = BOARD.filter((candidate) => candidate.group === space.group);
    const owned = group.filter((candidate) => game.properties[candidate.index].ownerId === playerId).length;
    if (owned === group.length) return 4;
    if (owned === group.length - 1) return 2;
    return 1;
  }
  if (space.type === "railroad") {
    const owned = BOARD.filter(
      (candidate) => candidate.type === "railroad" && game.properties[candidate.index].ownerId === playerId,
    ).length;
    return owned >= 3 ? 3 : owned >= 2 ? 2 : 1;
  }
  if (space.type === "utility") {
    const owned = BOARD.filter(
      (candidate) => candidate.type === "utility" && game.properties[candidate.index].ownerId === playerId,
    ).length;
    return owned === 2 ? 3 : 1;
  }
  return 0;
}

function chooseDebtAction(game, player) {
  if (!game.debt || game.debt.payerId !== player.id) return null;
  if (player.cash >= game.debt.amount) return { type: "pay_debt" };

  const supply = bankSupply(game);
  const buildings = BOARD.filter((space) => {
    const state = game.properties[space.index];
    if (space.type !== "property" || state.ownerId !== player.id || state.houses < 1) return false;
    const groupMaximum = Math.max(
      ...BOARD.filter((candidate) => candidate.group === space.group)
        .map((candidate) => game.properties[candidate.index].houses),
    );
    if (state.houses !== groupMaximum) return false;
    return state.houses !== 5 || supply.houses >= 4;
  }).sort((a, b) => game.properties[b.index].houses - game.properties[a.index].houses);
  if (buildings[0]) return { type: "sell_building", spaceIndex: buildings[0].index };

  const mortgageable = mortgageCandidates(game, player.id);
  if (mortgageable[0]) return { type: "mortgage", spaceIndex: mortgageable[0].index };
  return { type: "bankrupt" };
}

module.exports = { aiAcceptsTrade, chooseAiAction, quoteAiTrade };

const { BOARD } = require("./board");
const { aiTradeOnCooldown, auctionCurrentPlayerId, bankSupply } = require("./game");

const AI_TRADE_RESERVE = 220;
const AI_MIN_TRADE_GAIN = 12;
const STRATEGIC_EV_CASH_FACTOR = 3;
const RAILROAD_HARD_CAPS = Object.freeze([0, 240, 450, 750, 1200]);
const STRONG_DEVELOPMENT_GROUPS = new Set(["orange", "red", "yellow", "darkBlue"]);
const MAX_TRADE_CHIPS = 12;
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
const GROUP_STAGE_EV = Object.freeze({
  brown: [0.284, 0.710, 2.130, 6.390, 11.360, 16.560],
  lightBlue: [1.010, 2.525, 7.070, 21.209, 31.561, 42.921],
  pink: [1.783, 4.457, 13.371, 38.983, 54.301, 66.857],
  orange: [2.844, 7.110, 20.033, 54.927, 74.305, 93.683],
  red: [3.572, 8.929, 25.580, 68.481, 85.164, 101.848],
  yellow: [3.960, 9.900, 29.701, 71.357, 86.655, 101.954],
  green: [4.572, 11.704, 35.113, 79.972, 97.133, 112.836],
  darkBlue: [4.581, 10.003, 29.410, 67.020, 80.523, 94.026],
});
const RAILROAD_EV = [0, 0.839, 3.358, 10.073, 26.862];
const UTILITY_EV = [0, 0.948, 4.195];
const BUILDABILITY_WEIGHTS = [0, 0.15, 0.4, 1, 1.1, 1.15];
const BLOCKER_GROUP_WEIGHTS = Object.freeze({
  brown: 0.25,
  lightBlue: 0.75,
  pink: 0.8,
  orange: 1.2,
  red: 1.1,
  yellow: 1,
  green: 0.8,
  darkBlue: 0.95,
});
const DENIAL_WEIGHTS = [0, 0, 1.35, 1, 0.85, 0.7, 0.6];
const LEADER_WEIGHTS = [0, 0, 0.75, 0.65, 0.55, 0.45, 0.4];
const RESERVE_SCHEDULE = Object.freeze({
  acquisition: [0, 0, 180, 220, 220, 260, 260],
  formation: [0, 0, 240, 300, 300, 340, 340],
  development: [0, 0, 320, 380, 380, 440, 440],
  endgame: [0, 0, 420, 500, 500, 580, 580],
});

function chooseAiAction(game, playerId) {
  const player = game.players.find((candidate) => candidate.id === playerId);
  if (!player || player.kind !== "ai" || player.bankrupt) return null;

  if (game.phase === "card_confirmation") {
    if (game.pendingCard?.playerId !== playerId) return null;
    return { type: "confirm_card" };
  }

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
    const jailAction = chooseJailAction(game, player);
    if (jailAction) return jailAction;
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
  const offerBundles = tradeOfferBundles(game, proposer.id, proposerAssets);
  const targets = game.players.filter((player) => player.id !== proposer.id && !player.bankrupt);
  const candidates = [];

  for (const target of targets) {
    const targetAssets = tradeablePropertyIndexes(game, target.id);
    for (const requestIndex of targetAssets) {
      for (const offerProperties of offerBundles) {
        const proposal = aiProposalCandidate(
          game,
          proposer,
          target,
          offerProperties,
          [requestIndex],
        );
        if (proposal) candidates.push(proposal);
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

function tradeOfferBundles(game, proposerId, propertyIndexes) {
  const chips = [...propertyIndexes]
    .sort((left, right) => tradeChipScore(game, proposerId, left) - tradeChipScore(game, proposerId, right))
    .slice(0, MAX_TRADE_CHIPS);
  const bundles = [[]];
  for (const index of chips) bundles.push([index]);
  for (let left = 0; left < chips.length; left += 1) {
    for (let right = left + 1; right < chips.length; right += 1) {
      bundles.push([chips[left], chips[right]]);
    }
  }
  return bundles;
}

function tradeChipScore(game, playerId, index) {
  const space = BOARD[index];
  const typePriority = space.type === "utility" ? 0 : space.type === "railroad" ? 1 : 2;
  return typePriority * 100_000 + assetStrategicTier(game, playerId, space) * 10_000 + space.price;
}

function aiProposalCandidate(game, proposer, target, offerProperties, requestProperties) {
  if (!requestedPropertiesCompleteGroups(game, proposer.id, offerProperties, requestProperties)) return null;
  if (aiTradeOnCooldown(game, proposer.id, target.id, requestProperties)) return null;
  const incomingFee = mortgageFee(game, requestProperties);
  const proposerReserve = Math.max(AI_TRADE_RESERVE, adaptiveReserve(game, proposer));
  const maximumPayment = Math.min(1_000_000, proposer.cash - incomingFee - proposerReserve);
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
  if (evaluation.proposerCashAfter < proposerReserve) return null;

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
  const targetLiquidityFloor = Math.max(180, Math.floor(adaptiveReserve(game, target) * 0.7));
  if (targetCashAfter < targetLiquidityFloor || proposerCashAfter < 0) {
    return { accepts: false, targetCashAfter, proposerCashAfter };
  }

  const beforeHoldings = new Map([
    [target.id, targetBefore],
    [proposer.id, proposerBefore],
  ]);
  const afterHoldings = new Map([
    [target.id, targetAfter],
    [proposer.id, proposerAfter],
  ]);
  const targetBeforeValue = strategicPositionValue(game, target.id, targetBefore, target.cash, beforeHoldings);
  const targetAfterValue = strategicPositionValue(game, target.id, targetAfter, targetCashAfter, afterHoldings);
  const proposerBeforeValue = strategicPositionValue(game, proposer.id, proposerBefore, proposer.cash, beforeHoldings);
  const proposerAfterValue = strategicPositionValue(
    game,
    proposer.id,
    proposerAfter,
    proposerCashAfter,
    afterHoldings,
  );
  const targetGain = targetAfterValue - targetBeforeValue;
  const proposerGain = proposerAfterValue - proposerBeforeValue;
  const activeCount = activePlayerCount(game);
  const leaderId = currentLeaderId(game);
  const proposerIsLeader = proposer.id === leaderId;
  const leaderPremium = proposerIsLeader
    ? (LEADER_WEIGHTS[activeCount] || LEADER_WEIGHTS[6]) * 0.25
    : 0;
  let fairnessShare = (activeCount === 2 ? 0.4 : 0.3) + leaderPremium;
  const createsThreeHouseThreat = tradeCreatesThreeHouseThreat(
    game,
    proposer,
    proposerBefore,
    proposerAfter,
    proposer.cash,
    proposerCashAfter,
  );
  if (createsThreeHouseThreat && activeCount === 2) fairnessShare = Math.max(fairnessShare, 0.9);
  else if (createsThreeHouseThreat && proposerIsLeader) fairnessShare = Math.max(fairnessShare, 0.75);
  return {
    accepts: targetGain >= Math.max(0, proposerGain * fairnessShare),
    targetGain,
    proposerGain,
    targetCashAfter,
    proposerCashAfter,
  };
}

function tradeCreatesThreeHouseThreat(
  game,
  proposer,
  beforeHoldings,
  afterHoldings,
  beforeCash,
  afterCash,
) {
  return [...STRONG_DEVELOPMENT_GROUPS].some((group) => (
    !canBuildGroupToTier(game, proposer, group, beforeHoldings, beforeCash, 3)
      && canBuildGroupToTier(game, proposer, group, afterHoldings, afterCash, 3)
  ));
}

function canBuildGroupToTier(game, player, group, holdings, cash, targetTier) {
  const spaces = BOARD.filter((space) => space.group === group);
  if (!spaces.every((space) => holdings.has(space.index))) return false;
  if (spaces.some((space) => game.properties[space.index].mortgaged)) return false;
  const currentLevels = spaces.map((space) => game.properties[space.index].houses);
  const currentTier = Math.min(...currentLevels);
  if (currentTier >= targetTier) return true;
  const requiredHouses = currentLevels.reduce(
    (total, level) => total + Math.max(0, targetTier - level),
    0,
  );
  if (bankSupply(game).houses < requiredHouses) return false;
  const buildCost = requiredHouses * spaces[0].buildCost;
  const reserve = adaptiveReserve(game, player, { completionGroup: group });
  return cash - buildCost >= reserve;
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
      target.cash - mortgageFee(game, offerProperties)
        - Math.max(180, Math.floor(adaptiveReserve(game, target) * 0.7)),
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
  const railroadTotals = [0, 180, 430, 820, 1500];
  const utilityTotals = [0, 130, 360];
  if (railroads > 0) total += railroadBase * (railroadTotals[railroads] / (railroads * 200));
  if (utilities > 0) total += utilityBase * (utilityTotals[utilities] / (utilities * 150));
  return total;
}

function strategicPositionValue(game, playerId, indexes, cash, holdingsOverrides = new Map()) {
  return cash
    + portfolioValue(game, indexes)
    + developmentValue(game, playerId, indexes, cash)
    + blockerValue(game, playerId, indexes, holdingsOverrides);
}

function developmentValue(game, playerId, indexes, cash) {
  const opponents = Math.max(1, activePlayerCount(game) - 1);
  const player = game.players.find((candidate) => candidate.id === playerId);
  const reserve = player ? adaptiveReserve(game, player) : 300;
  let currentIncomeValue = 0;
  let bestBuildOption = 0;

  for (const group of Object.keys(GROUP_STAGE_EV)) {
    const spaces = BOARD.filter((space) => space.group === group);
    if (!spaces.every((space) => indexes.has(space.index))) continue;
    if (spaces.some((space) => game.properties[space.index].mortgaged)) continue;

    const currentTier = Math.min(...spaces.map((space) => game.properties[space.index].houses));
    const stageValues = GROUP_STAGE_EV[group];
    currentIncomeValue += stageValues[currentTier] * opponents * STRATEGIC_EV_CASH_FACTOR;

    const buildCost = spaces[0].buildCost * spaces.length;
    const reachableTier = Math.min(
      5,
      currentTier + Math.floor(Math.max(0, cash - reserve) / Math.max(1, buildCost)),
    );
    const optionValue = (stageValues[reachableTier] - stageValues[currentTier])
      * opponents
      * STRATEGIC_EV_CASH_FACTOR
      * BUILDABILITY_WEIGHTS[reachableTier]
      * BLOCKER_GROUP_WEIGHTS[group];
    bestBuildOption = Math.max(bestBuildOption, optionValue);
  }

  const railroads = [...indexes].filter((index) => BOARD[index].type === "railroad").length;
  const utilities = [...indexes].filter((index) => BOARD[index].type === "utility").length;
  currentIncomeValue += (
    RAILROAD_EV[railroads] + UTILITY_EV[utilities]
  ) * opponents * STRATEGIC_EV_CASH_FACTOR;
  return currentIncomeValue + bestBuildOption;
}

function blockerValue(game, playerId, indexes, holdingsOverrides) {
  const activeCount = activePlayerCount(game);
  const denialWeight = DENIAL_WEIGHTS[activeCount] || DENIAL_WEIGHTS[6];
  const leaderId = currentLeaderId(game);
  const counted = new Set();
  let value = 0;

  for (const index of indexes) {
    const space = BOARD[index];
    if (!space.group) continue;
    for (const opponent of game.players) {
      if (opponent.bankrupt || opponent.id === playerId) continue;
      const key = `${opponent.id}:${space.group}`;
      if (counted.has(key)) continue;
      const group = BOARD.filter((candidate) => candidate.group === space.group);
      const blocksCompletion = group.every((candidate) => (
        candidate.index === index
          ? indexes.has(candidate.index)
          : hypotheticalOwnerId(game, candidate.index, holdingsOverrides) === opponent.id
      ));
      if (!blocksCompletion) continue;
      counted.add(key);
      const leaderMultiplier = opponent.id === leaderId
        ? 1 + (LEADER_WEIGHTS[activeCount] || LEADER_WEIGHTS[6])
        : 1;
      value += GROUP_STAGE_EV[space.group][3]
        * denialWeight
        * leaderMultiplier
        * STRATEGIC_EV_CASH_FACTOR
        * BLOCKER_GROUP_WEIGHTS[space.group];
    }
  }
  return value;
}

function hypotheticalOwnerId(game, spaceIndex, holdingsOverrides) {
  for (const [playerId, indexes] of holdingsOverrides.entries()) {
    if (indexes.has(spaceIndex)) return playerId;
  }
  const originalOwnerId = game.properties[spaceIndex]?.ownerId || null;
  return holdingsOverrides.has(originalOwnerId) ? null : originalOwnerId;
}

function currentLeaderId(game) {
  const ranked = game.players.filter((player) => !player.bankrupt)
    .map((player) => ({
      id: player.id,
      value: player.cash + portfolioValue(game, ownedPropertySet(game, player.id)),
    }))
    .sort((left, right) => right.value - left.value);
  if (!ranked[0]) return null;
  if (!ranked[1]) return ranked[0].id;
  const meaningfulLead = ranked[0].value >= ranked[1].value + 100
    || ranked[0].value >= ranked[1].value * 1.08;
  return meaningfulLead ? ranked[0].id : null;
}

function activePlayerCount(game) {
  return game.players.filter((player) => !player.bankrupt).length;
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
  let value = space.price * 1.1;
  let completionGroup = null;
  let hardCap = Number.POSITIVE_INFINITY;

  if (space.group) {
    const groupSize = BOARD.filter((candidate) => candidate.group === space.group).length;
    const ownedInGroup = BOARD.filter(
      (candidate) => candidate.group === space.group
        && game.properties[candidate.index]?.ownerId === player.id,
    ).length;
    if (ownedInGroup === groupSize - 1) {
      completionGroup = space.group;
      value = space.price * colorGroupStrategy(space.group).complete;
      const tier = reachableGroupTier(game, player, space.group, player.cash - space.price);
      value += GROUP_STAGE_EV[space.group][tier]
        * BUILDABILITY_WEIGHTS[tier]
        * Math.max(1, activePlayerCount(game) - 1)
        * STRATEGIC_EV_CASH_FACTOR;
    } else if (ownedInGroup > 0) {
      value = space.price * colorGroupStrategy(space.group).partial;
    }
  } else if (space.type === "railroad") {
    const nextCount = Math.min(4, ownedOfType + 1);
    value = space.price + (RAILROAD_EV[nextCount] - RAILROAD_EV[ownedOfType])
      * Math.max(1, activePlayerCount(game) - 1)
      * 18;
    hardCap = nextCount === 4 && hasStrongGroupWaitingToBuild(game, player.id)
      ? 900
      : RAILROAD_HARD_CAPS[nextCount];
  } else if (space.type === "utility") {
    const nextCount = Math.min(2, ownedOfType + 1);
    value = space.price * 0.85 + (UTILITY_EV[nextCount] - UTILITY_EV[ownedOfType])
      * Math.max(1, activePlayerCount(game) - 1)
      * 12;
  }

  value += auctionDenialValue(game, player, space);
  const reserve = adaptiveReserve(game, player, { completionGroup });
  return Math.max(0, Math.min(Math.floor(value), hardCap, player.cash - reserve));
}

function hasStrongGroupWaitingToBuild(game, playerId) {
  return [...STRONG_DEVELOPMENT_GROUPS].some((group) => {
    const spaces = BOARD.filter((space) => space.group === group);
    if (!spaces.every((space) => game.properties[space.index].ownerId === playerId)) return false;
    if (spaces.some((space) => game.properties[space.index].mortgaged)) return false;
    return Math.min(...spaces.map((space) => game.properties[space.index].houses)) < 3;
  });
}

function auctionDenialValue(game, player, space) {
  const activeCount = activePlayerCount(game);
  const denialWeight = DENIAL_WEIGHTS[activeCount] || DENIAL_WEIGHTS[6];
  const leaderId = currentLeaderId(game);
  let best = 0;

  for (const opponent of game.players) {
    if (opponent.bankrupt || opponent.id === player.id) continue;
    let threat = 0;
    if (space.group && completesGroup(game, opponent.id, space.group)) {
      const tier = reachableGroupTier(game, opponent, space.group, opponent.cash - space.price);
      threat = GROUP_STAGE_EV[space.group][Math.max(3, tier)]
        * BUILDABILITY_WEIGHTS[Math.max(1, tier)]
        * STRATEGIC_EV_CASH_FACTOR
        * BLOCKER_GROUP_WEIGHTS[space.group];
    } else if (space.type === "railroad") {
      const owned = BOARD.filter(
        (candidate) => candidate.type === "railroad"
          && game.properties[candidate.index].ownerId === opponent.id,
      ).length;
      if (owned >= 2) threat = (RAILROAD_EV[Math.min(4, owned + 1)] - RAILROAD_EV[owned]) * 12;
    }
    if (opponent.id === leaderId) threat *= 1 + (LEADER_WEIGHTS[activeCount] || LEADER_WEIGHTS[6]);
    best = Math.max(best, threat * denialWeight);
  }
  return best;
}

function adaptiveReserve(game, player, options = {}) {
  const activeCount = Math.max(2, activePlayerCount(game));
  const phase = strategicPhase(game);
  let reserve = RESERVE_SCHEDULE[phase][Math.min(6, activeCount)];
  if (hasHostileDevelopedGroup(game, player.id, 3)) reserve += 150;
  if (hasHostileLuxuryHotel(game, player.id) && liquidationValue(game, player.id) < 500) reserve += 250;
  if (["orange", "red", "yellow", "darkBlue"].includes(options.completionGroup)) {
    reserve -= options.completionGroup === "orange" ? 140 : 100;
  }
  return Math.max(80, reserve);
}

function strategicPhase(game) {
  const unowned = BOARD.filter((space) => game.properties[space.index]?.ownerId === null).length;
  const activeCount = activePlayerCount(game);
  if (unowned >= 8) return "acquisition";
  if (activeCount <= 2 && unowned <= 3) return "endgame";
  if (game.players.some((player) => !player.bankrupt && playerHasDevelopedGroup(game, player.id, 3))) {
    return "development";
  }
  return "formation";
}

function playerHasDevelopedGroup(game, playerId, minimumTier) {
  return Object.keys(GROUP_STAGE_EV).some((group) => {
    const spaces = BOARD.filter((space) => space.group === group);
    return spaces.every((space) => game.properties[space.index].ownerId === playerId)
      && Math.min(...spaces.map((space) => game.properties[space.index].houses)) >= minimumTier;
  });
}

function hasHostileDevelopedGroup(game, playerId, minimumTier) {
  return game.players.some(
    (player) => !player.bankrupt && player.id !== playerId
      && playerHasDevelopedGroup(game, player.id, minimumTier),
  );
}

function hasHostileLuxuryHotel(game, playerId) {
  return game.players.some((player) => {
    if (player.bankrupt || player.id === playerId) return false;
    return ["green", "darkBlue"].some((group) => {
      const spaces = BOARD.filter((space) => space.group === group);
      return spaces.every((space) => game.properties[space.index].ownerId === player.id)
        && spaces.some((space) => game.properties[space.index].houses === 5);
    });
  });
}

function reachableGroupTier(game, player, group, cashAfterAcquisition = player.cash) {
  const spaces = BOARD.filter((space) => space.group === group);
  const currentTier = spaces.every((space) => game.properties[space.index].ownerId === player.id)
    ? Math.min(...spaces.map((space) => game.properties[space.index].houses))
    : 0;
  const reserve = adaptiveReserve(game, player, { completionGroup: group });
  const fullTierCost = spaces.length * spaces[0].buildCost;
  return Math.min(5, currentTier + Math.floor(Math.max(0, cashAfterAcquisition - reserve) / fullTierCost));
}

function chooseBuild(game, player) {
  const candidates = [];
  const supply = bankSupply(game);
  const reserve = adaptiveReserve(game, player);
  const protectHouseShortage = supply.houses <= 8 && opponentHasBuildableGroup(game, player.id);
  const groups = new Set(BOARD.filter((space) => space.group).map((space) => space.group));
  for (const group of groups) {
    const spaces = BOARD.filter((space) => space.group === group);
    if (!spaces.every((space) => game.properties[space.index].ownerId === player.id)) continue;
    if (spaces.some((space) => game.properties[space.index].mortgaged)) continue;
    const minimum = Math.min(...spaces.map((space) => game.properties[space.index].houses));
    if (minimum >= 5) continue;
    const legalSpaces = spaces.filter((space) => game.properties[space.index].houses === minimum);
    const targetTier = minimum + 1;
    const fullTierCost = spaces.length * spaces[0].buildCost;

    const stageValues = GROUP_STAGE_EV[group];
    const stageGain = stageValues[targetTier] - stageValues[minimum];
    const tierMultiplier = targetTier === 3 ? 1.8 : targetTier < 3 ? 1.15 : 0.78;
    const shortageBonus = targetTier < 5 && supply.houses <= 12 ? 1.18 : 1;
    const hotelReleasePenalty = targetTier === 5 && protectHouseShortage ? 0.45 : 1;
    const bundleScore = (stageGain / fullTierCost)
      * tierMultiplier
      * shortageBonus
      * hotelReleasePenalty;

    for (const space of legalSpaces) {
      const canBuySingleBuilding = targetTier === 5 ? supply.hotels >= 1 : supply.houses >= 1;
      if (!canBuySingleBuilding || player.cash - space.buildCost < reserve) continue;
      const state = game.properties[space.index];
      const gain = space.rents[state.houses + 1] - space.rents[state.houses];
      candidates.push({
        type: "build",
        spaceIndex: space.index,
        score: bundleScore * 1000 + gain / space.buildCost,
      });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  if (!candidates[0]) return null;
  return { type: "build", spaceIndex: candidates[0].spaceIndex };
}

function opponentHasBuildableGroup(game, playerId) {
  return game.players.some((opponent) => {
    if (opponent.bankrupt || opponent.id === playerId) return false;
    return Object.keys(GROUP_STAGE_EV).some((group) => {
      const spaces = BOARD.filter((space) => space.group === group);
      if (!spaces.every((space) => game.properties[space.index].ownerId === opponent.id)) return false;
      if (spaces.some((space) => game.properties[space.index].mortgaged)) return false;
      const minimum = Math.min(...spaces.map((space) => game.properties[space.index].houses));
      if (minimum >= 4) return false;
      return opponent.cash - spaces[0].buildCost >= adaptiveReserve(game, opponent);
    });
  });
}

function chooseUnmortgage(game, player) {
  const candidates = BOARD.filter((space) => {
    const state = game.properties[space.index];
    return state?.ownerId === player.id && state.mortgaged;
  }).map((space) => {
    const cost = Math.ceil((space.price / 2) * 1.1);
    const tier = assetStrategicTier(game, player.id, space);
    const baseReserve = adaptiveReserve(game, player);
    const reserve = tier >= 3 ? baseReserve : tier >= 2 ? baseReserve + 100 : baseReserve + 250;
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
    return mortgageLiquidationScore(game, playerId, b) - mortgageLiquidationScore(game, playerId, a);
  });
}

function mortgageLiquidationScore(game, playerId, space) {
  const cashRaised = Math.floor(space.price / 2);
  const opponents = Math.max(1, activePlayerCount(game) - 1);
  let strategicLoss = 1;
  if (space.type === "railroad") {
    const owned = BOARD.filter(
      (candidate) => candidate.type === "railroad"
        && game.properties[candidate.index].ownerId === playerId
        && !game.properties[candidate.index].mortgaged,
    ).length;
    strategicLoss += (RAILROAD_EV[owned] - RAILROAD_EV[Math.max(0, owned - 1)])
      * opponents
      * STRATEGIC_EV_CASH_FACTOR;
  } else if (space.type === "utility") {
    const owned = BOARD.filter(
      (candidate) => candidate.type === "utility"
        && game.properties[candidate.index].ownerId === playerId
        && !game.properties[candidate.index].mortgaged,
    ).length;
    strategicLoss += (UTILITY_EV[owned] - UTILITY_EV[Math.max(0, owned - 1)])
      * opponents
      * STRATEGIC_EV_CASH_FACTOR;
  } else if (space.group) {
    const group = BOARD.filter((candidate) => candidate.group === space.group);
    const owned = group.filter((candidate) => game.properties[candidate.index].ownerId === playerId).length;
    if (owned === group.length) {
      strategicLoss += GROUP_STAGE_EV[space.group][0] * opponents * STRATEGIC_EV_CASH_FACTOR;
      strategicLoss += ["orange", "red", "yellow", "darkBlue"].includes(space.group) ? 45 : 20;
    } else if (owned === group.length - 1) {
      strategicLoss += 12;
    }
  }
  return cashRaised / strategicLoss;
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

function chooseJailAction(game, player) {
  if (!player.inJail) return null;
  if (!shouldLeaveJail(game, player)) return { type: "roll" };
  if (player.jailCards > 0) return { type: "use_jail_card" };
  if (player.cash >= 50) return { type: "pay_bail" };
  return { type: "roll" };
}

function shouldLeaveJail(game, player) {
  const bankOwned = BOARD.filter((space) => game.properties[space.index]?.ownerId === null).length;
  if (bankOwned >= 8) return true;

  const cushion = player.cash + liquidationValue(game, player.id);
  const maximumHit = maxHostileRent(game, player.id);
  if (maximumHit > cushion * 0.6) return false;

  const ownIncome = playerIncomeEv(game, player.id);
  const hostileIncome = game.players.filter((opponent) => !opponent.bankrupt && opponent.id !== player.id)
    .reduce((sum, opponent) => sum + playerIncomeEv(game, opponent.id), 0);
  if (hasHostileDevelopedGroup(game, player.id, 3) && hostileIncome > ownIncome * 1.25) return false;
  return true;
}

function playerIncomeEv(game, playerId) {
  let income = 0;
  for (const group of Object.keys(GROUP_STAGE_EV)) {
    const spaces = BOARD.filter((space) => space.group === group);
    if (!spaces.every((space) => game.properties[space.index].ownerId === playerId)) continue;
    if (spaces.some((space) => game.properties[space.index].mortgaged)) continue;
    const tier = Math.min(...spaces.map((space) => game.properties[space.index].houses));
    income += GROUP_STAGE_EV[group][tier];
  }
  const railroads = BOARD.filter(
    (space) => space.type === "railroad"
      && game.properties[space.index].ownerId === playerId
      && !game.properties[space.index].mortgaged,
  ).length;
  const utilities = BOARD.filter(
    (space) => space.type === "utility"
      && game.properties[space.index].ownerId === playerId
      && !game.properties[space.index].mortgaged,
  ).length;
  return income + RAILROAD_EV[railroads] + UTILITY_EV[utilities];
}

function maxHostileRent(game, playerId) {
  let maximum = 0;
  for (const space of BOARD) {
    const state = game.properties[space.index];
    if (!state?.ownerId || state.ownerId === playerId || state.mortgaged) continue;
    if (space.type === "property") {
      const ownerHasGroup = BOARD.filter((candidate) => candidate.group === space.group)
        .every((candidate) => game.properties[candidate.index].ownerId === state.ownerId);
      const rent = state.houses === 0 && ownerHasGroup ? space.rents[0] * 2 : space.rents[state.houses];
      maximum = Math.max(maximum, rent);
    } else if (space.type === "railroad") {
      const count = BOARD.filter(
        (candidate) => candidate.type === "railroad"
          && game.properties[candidate.index].ownerId === state.ownerId,
      ).length;
      maximum = Math.max(maximum, 25 * 2 ** (count - 1));
    } else if (space.type === "utility") {
      const count = BOARD.filter(
        (candidate) => candidate.type === "utility"
          && game.properties[candidate.index].ownerId === state.ownerId,
      ).length;
      maximum = Math.max(maximum, count === 2 ? 120 : 48);
    }
  }
  return maximum;
}

function liquidationValue(game, playerId) {
  let value = 0;
  for (const space of BOARD) {
    const state = game.properties[space.index];
    if (!state || state.ownerId !== playerId) continue;
    if (!state.mortgaged && state.houses === 0) value += Math.floor(space.price / 2);
    if (space.type === "property" && state.houses > 0) {
      value += Math.floor((space.buildCost * state.houses) / 2);
    }
  }
  return value;
}

function chooseDebtAction(game, player) {
  if (!game.debt || game.debt.payerId !== player.id) return null;
  if (player.cash >= game.debt.amount) return { type: "pay_debt" };

  const supply = bankSupply(game);
  const buildingActions = BOARD.filter((space) => {
    const state = game.properties[space.index];
    if (space.type !== "property" || state.ownerId !== player.id || state.houses < 1) return false;
    const groupMaximum = Math.max(
      ...BOARD.filter((candidate) => candidate.group === space.group)
        .map((candidate) => game.properties[candidate.index].houses),
    );
    if (state.houses !== groupMaximum) return false;
    return state.houses !== 5 || supply.houses >= 4;
  }).map((space) => {
    const level = game.properties[space.index].houses;
    const rentLoss = space.rents[level] - space.rents[level - 1];
    const threeHousePenalty = level === 3 ? 3 : level > 3 ? 1.35 : 1;
    const cashRaised = Math.floor(space.buildCost / 2);
    return {
      action: { type: "sell_building", spaceIndex: space.index },
      score: cashRaised / Math.max(1, rentLoss * threeHousePenalty),
    };
  });

  const mortgageActions = mortgageCandidates(game, player.id).map((space) => ({
    action: { type: "mortgage", spaceIndex: space.index },
    score: mortgageLiquidationScore(game, player.id, space),
  }));
  const best = [...buildingActions, ...mortgageActions].sort((a, b) => b.score - a.score)[0];
  if (best) return best.action;
  return { type: "bankrupt" };
}

module.exports = { aiAcceptsTrade, chooseAiAction, quoteAiTrade };

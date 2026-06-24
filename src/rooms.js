const crypto = require("node:crypto");
const {
  addPlayer,
  completeOpeningOrder,
  createGame,
  performAction,
  publicState,
  removePlayer,
} = require("./game");
const { chooseAiAction, quoteAiTrade } = require("./ai");

const ROOM_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const AI_NAMES = ["阿尔法", "蓝鲸", "红杉", "北斗", "云雀"];
const ROOM_TTL_MS = 6 * 60 * 60 * 1_000;
const MAX_ROOMS = 500;
const MAX_SPECTATORS = 24;

class RoomStore {
  constructor() {
    this.rooms = new Map();
  }

  create(name) {
    this.pruneRooms();
    if (this.rooms.size >= MAX_ROOMS) throw new Error("服务器房间已满，请稍后重试");
    const code = this.createCode();
    const game = createGame(code);
    const player = addPlayer(game, cleanName(name));
    const room = { code, game, sessions: new Map(), timer: null, updatedAt: Date.now() };
    const token = this.createSession(room, { role: "player", playerId: player.id, name: player.name });
    this.rooms.set(code, room);
    return { code, token, playerId: player.id, state: this.stateFor(room, room.sessions.get(token)) };
  }

  join(code, name) {
    const room = this.requireRoom(code);
    if (room.game.status !== "lobby") throw new Error("游戏已经开始，暂不支持中途加入");
    const player = addPlayer(room.game, cleanName(name));
    const token = this.createSession(room, { role: "player", playerId: player.id, name: player.name });
    room.updatedAt = Date.now();
    return { code: room.code, token, playerId: player.id, state: this.stateFor(room, room.sessions.get(token)) };
  }

  watch(code, name) {
    const room = this.requireRoom(code);
    const now = Date.now();
    const spectatorCount = [...room.sessions.values()].filter(
      (session) => session.role === "spectator" && now - session.lastSeen < 60_000,
    ).length;
    if (spectatorCount >= MAX_SPECTATORS) throw new Error("该房间观战人数已满");
    const spectator = { role: "spectator", spectatorId: uid("spectator"), name: cleanName(name) };
    const token = this.createSession(room, spectator);
    room.updatedAt = Date.now();
    return {
      code: room.code,
      token,
      spectatorId: spectator.spectatorId,
      state: this.stateFor(room, room.sessions.get(token)),
    };
  }

  addAi(code, token) {
    const { room, playerId, session } = this.authenticatePlayer(code, token);
    if (playerId !== room.game.hostId) throw new Error("只有房主可以添加 AI");
    const usedNames = new Set(room.game.players.map((player) => player.name));
    const name = AI_NAMES.find((candidate) => !usedNames.has(candidate)) || `AI ${room.game.players.length}`;
    addPlayer(room.game, name, "ai");
    room.updatedAt = Date.now();
    return this.stateFor(room, session);
  }

  removePlayer(code, token, targetId) {
    const { room, playerId, session } = this.authenticatePlayer(code, token);
    removePlayer(room.game, playerId, targetId);
    for (const [sessionToken, session] of room.sessions.entries()) {
      if (session.role === "player" && session.playerId === targetId) room.sessions.delete(sessionToken);
    }
    room.updatedAt = Date.now();
    return this.stateFor(room, session);
  }

  state(code, token) {
    const { room, session } = this.authenticate(code, token);
    session.lastSeen = Date.now();
    room.updatedAt = Date.now();
    return this.stateFor(room, session);
  }

  action(code, token, action) {
    const { room, playerId, session } = this.authenticatePlayer(code, token);
    performAction(room.game, playerId, action);
    room.updatedAt = Date.now();
    this.scheduleAi(room);
    return this.stateFor(room, session);
  }

  tradeQuote(code, token, action) {
    const { room, playerId } = this.authenticatePlayer(code, token);
    return quoteAiTrade(room.game, playerId, action);
  }

  authenticate(code, token) {
    const room = this.requireRoom(code);
    const session = room.sessions.get(String(token || ""));
    if (!session) throw new Error("登录凭证无效，请重新加入房间");
    return { room, playerId: session.playerId, session };
  }

  authenticatePlayer(code, token) {
    const authenticated = this.authenticate(code, token);
    if (authenticated.session.role !== "player") throw new Error("观战者不能执行游戏操作");
    return authenticated;
  }

  scheduleAi(room) {
    if (room.timer) clearTimeout(room.timer);
    if (room.game.phase === "order_countdown") {
      const delay = Math.max(0, room.game.openingOrder.countdownEndsAt - Date.now());
      room.timer = setTimeout(() => {
        room.timer = null;
        if (completeOpeningOrder(room.game)) room.updatedAt = Date.now();
        this.scheduleAi(room);
      }, delay);
      return;
    }
    const action = nextAiAction(room.game);
    if (!action) return;
    room.timer = setTimeout(() => {
      room.timer = null;
      try {
        performAction(room.game, action.playerId, action.action);
        room.updatedAt = Date.now();
      } catch (error) {
        console.error("AI action failed:", error.message);
      }
      this.scheduleAi(room);
    }, 520);
  }

  createSession(room, details) {
    const token = crypto.randomBytes(24).toString("base64url");
    room.sessions.set(token, { ...details, lastSeen: Date.now() });
    return token;
  }

  stateFor(room, session) {
    return publicState(room.game, session.playerId || null, {
      role: session.role,
      name: session.name,
      spectatorId: session.spectatorId || null,
    });
  }

  createCode() {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      let code = "";
      for (let index = 0; index < 5; index += 1) {
        code += ROOM_ALPHABET[crypto.randomInt(ROOM_ALPHABET.length)];
      }
      if (!this.rooms.has(code)) return code;
    }
    throw new Error("暂时无法创建房间，请稍后重试");
  }

  pruneRooms(now = Date.now()) {
    for (const [code, room] of this.rooms.entries()) {
      if (now - room.updatedAt < ROOM_TTL_MS) continue;
      if (room.timer) clearTimeout(room.timer);
      this.rooms.delete(code);
    }
  }

  requireRoom(code) {
    const normalized = String(code || "").trim().toUpperCase();
    const room = this.rooms.get(normalized);
    if (!room) throw new Error("房间不存在或服务器已重启");
    return room;
  }
}

function nextAiAction(game) {
  if (game.status !== "playing") return null;
  if (game.phase === "determining_order") {
    const playerId = game.openingOrder?.pendingIds.find((id) => (
      game.players.find((player) => player.id === id)?.kind === "ai"
    ));
    return playerId ? { playerId, action: { type: "roll_for_order" } } : null;
  }
  let playerId = null;
  if (game.phase === "trade") {
    playerId = game.trade?.targetId || null;
  } else if (game.phase === "auction") {
    const auction = game.auction;
    if (!auction) return null;
    const active = auction.activeIds;
    if (active.length === 1 && auction.bidderId === active[0]) return null;
    for (let offset = 0; offset < active.length; offset += 1) {
      const pos = (auction.turnPos + offset) % active.length;
      if (active[pos] !== auction.bidderId) {
        playerId = active[pos];
        break;
      }
    }
  } else {
    playerId = game.players[game.currentIndex]?.id;
  }
  const player = game.players.find((candidate) => candidate.id === playerId);
  if (!player || player.kind !== "ai") return null;
  const action = chooseAiAction(game, playerId);
  return action ? { playerId, action } : null;
}

function cleanName(name) {
  const cleaned = String(name || "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 12);
  if (cleaned.length < 1) throw new Error("请输入玩家名称");
  return cleaned;
}

function uid(prefix) {
  return `${prefix}_${crypto.randomBytes(6).toString("hex")}`;
}

module.exports = { RoomStore };

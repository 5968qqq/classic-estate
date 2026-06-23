const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const { URL } = require("node:url");
const { RoomStore } = require("./src/rooms");

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const PUBLIC_DIR = path.join(__dirname, "public");
const rooms = new RoomStore();
const rateLimits = new Map();

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const server = http.createServer(async (request, response) => {
  setHeaders(response);
  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }

  try {
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    if (url.pathname.startsWith("/api/")) {
      if (!consumeRateLimit(request, url)) {
        response.setHeader("Retry-After", "60");
        sendJson(response, 429, { error: "请求过于频繁，请稍后重试" });
        return;
      }
      await handleApi(request, response, url);
      return;
    }
    await serveStatic(response, url.pathname);
  } catch (error) {
    const status = error.statusCode || 400;
    sendJson(response, status, { error: error.message || "请求失败" });
  }
});

async function handleApi(request, response, url) {
  if (request.method === "POST" && url.pathname === "/api/rooms") {
    const body = await readJson(request);
    sendJson(response, 201, rooms.create(body.name));
    return;
  }

  const joinMatch = url.pathname.match(/^\/api\/rooms\/([A-Z0-9]+)\/join$/i);
  if (request.method === "POST" && joinMatch) {
    const body = await readJson(request);
    sendJson(response, 200, rooms.join(joinMatch[1], body.name));
    return;
  }

  const stateMatch = url.pathname.match(/^\/api\/rooms\/([A-Z0-9]+)\/state$/i);
  if (request.method === "GET" && stateMatch) {
    sendJson(response, 200, rooms.state(stateMatch[1], url.searchParams.get("token")));
    return;
  }

  const actionMatch = url.pathname.match(/^\/api\/rooms\/([A-Z0-9]+)\/action$/i);
  if (request.method === "POST" && actionMatch) {
    const body = await readJson(request);
    sendJson(response, 200, rooms.action(actionMatch[1], body.token, body.action));
    return;
  }

  const tradeQuoteMatch = url.pathname.match(/^\/api\/rooms\/([A-Z0-9]+)\/trade-quote$/i);
  if (request.method === "POST" && tradeQuoteMatch) {
    const body = await readJson(request);
    sendJson(response, 200, rooms.tradeQuote(tradeQuoteMatch[1], body.token, body));
    return;
  }

  const aiMatch = url.pathname.match(/^\/api\/rooms\/([A-Z0-9]+)\/ai$/i);
  if (request.method === "POST" && aiMatch) {
    const body = await readJson(request);
    sendJson(response, 200, rooms.addAi(aiMatch[1], body.token));
    return;
  }

  const removeMatch = url.pathname.match(/^\/api\/rooms\/([A-Z0-9]+)\/remove$/i);
  if (request.method === "POST" && removeMatch) {
    const body = await readJson(request);
    sendJson(response, 200, rooms.removePlayer(removeMatch[1], body.token, body.playerId));
    return;
  }

  const error = new Error("接口不存在");
  error.statusCode = 404;
  throw error;
}

async function serveStatic(response, pathname) {
  const requested = pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
  const filePath = path.resolve(PUBLIC_DIR, requested);
  if (!filePath.startsWith(`${PUBLIC_DIR}${path.sep}`) && filePath !== path.join(PUBLIC_DIR, "index.html")) {
    const error = new Error("文件不存在");
    error.statusCode = 404;
    throw error;
  }
  try {
    const content = await fs.readFile(filePath);
    response.writeHead(200, { "Content-Type": MIME_TYPES[path.extname(filePath)] || "application/octet-stream" });
    response.end(content);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const fallback = await fs.readFile(path.join(PUBLIC_DIR, "index.html"));
    response.writeHead(200, { "Content-Type": MIME_TYPES[".html"] });
    response.end(fallback);
  }
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 32_768) {
        const error = new Error("请求内容过大");
        error.statusCode = 413;
        reject(error);
        request.destroy();
      }
    });
    request.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("JSON 格式无效"));
      }
    });
    request.on("error", reject);
  });
}

function setHeaders(response) {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "SAMEORIGIN");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'self'; form-action 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'",
  );
  response.setHeader("Cache-Control", "no-store");
}

function consumeRateLimit(request, url) {
  const now = Date.now();
  const isStateRead = request.method === "GET" && /\/state$/.test(url.pathname);
  const isEntry = request.method === "POST"
    && (url.pathname === "/api/rooms" || /\/join$/.test(url.pathname));
  const tier = isStateRead ? "state" : isEntry ? "entry" : "action";
  const limit = tier === "state" ? 150 : tier === "entry" ? 30 : 180;
  const sessionKey = isStateRead ? url.searchParams.get("token") || "anonymous" : "shared";
  const key = `${clientIp(request)}:${tier}:${sessionKey}`;
  const current = rateLimits.get(key);
  if (!current || now - current.startedAt >= 60_000) {
    rateLimits.set(key, { startedAt: now, count: 1 });
  } else {
    current.count += 1;
    if (current.count > limit) return false;
  }
  if (rateLimits.size > 5_000) {
    for (const [bucketKey, bucket] of rateLimits.entries()) {
      if (now - bucket.startedAt >= 60_000) rateLimits.delete(bucketKey);
    }
  }
  return true;
}

function clientIp(request) {
  const direct = request.socket.remoteAddress || "unknown";
  const fromLocalProxy = direct === "127.0.0.1" || direct === "::1" || direct === "::ffff:127.0.0.1";
  if (!fromLocalProxy) return direct;
  return String(request.headers["x-forwarded-for"] || direct).split(",")[0].trim();
}

function sendJson(response, status, payload) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

server.listen(PORT, HOST, () => {
  console.log(`Classic Estate listening on http://${HOST}:${PORT}`);
});

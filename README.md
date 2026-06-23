# Classic Estate

Classic Estate is a browser-based property trading board game with server-authoritative rules, online rooms, AI opponents, auctions, mortgages, trades, and a bilingual Chinese/English interface.

The game focuses on the core tabletop experience: rolling dice, buying properties, collecting rent, building houses and hotels, negotiating trades, handling debt, and playing against human players or AI. It uses a responsive 2D board and does not include 3D dice or character animations.

This project is an independent open-source implementation of familiar property-trading board game mechanics. It is not affiliated with or endorsed by any tabletop game publisher.

## Features

- 40-space classic-style board with start rewards, taxes, chance spaces, and community fund spaces
- 2-6 players with mixed human and AI seats
- Online rooms with room-code joining
- Server-authoritative game state, so browser clients cannot directly edit money or assets
- Property, railroad, and utility ownership with rent calculation
- Auctions when a player declines to buy an unowned asset
- Mortgage, unmortgage, building sale, debt handling, and bankruptcy
- Color groups, even building rules, houses, hotels, and limited bank buildings
- Player-to-player and player-to-AI trades with cash and multiple assets
- AI valuation for auctions, trades, mortgages, and unmortgaging
- Optional manual dice mode for relaxed or sandbox play
- Opening dice roll to determine turn order
- Movement trails, quick movement toggle, map zoom/pan, ownership statistics, and turn summaries
- Chinese and English UI

## Run Locally

Requires Node.js 18 or newer.

```powershell
node server.js
```

The default server address is `0.0.0.0:3000`. Open `http://localhost:3000` in a browser.

To use a different port:

```powershell
$env:PORT=8080
node server.js
```

## Deployment Notes

Upload the project to a server with Node.js 18 or newer, run `node server.js`, and expose the selected TCP port. For public use, prefer a reverse proxy such as Nginx or Caddy in front of `127.0.0.1:3000`, with HTTPS enabled.

Do not commit SSH passwords, private keys, raw server credentials, or private deployment notes. If you want to publish a live demo, use a domain or HTTPS demo URL rather than documenting SSH access or server internals.

Room state is currently stored in memory, so active games disappear after a server restart. A long-running deployment can later add SQLite or Redis persistence.

## Tests

```powershell
node --test
```

The browser end-to-end smoke test is in `scripts/e2e-smoke.js` and requires Playwright with Chromium.

## 中文说明

# 地产风云

一个服务器权威判定的经典地产交易桌游，支持 2-6 名真人与 AI 混合游玩。前端为响应式 2D 棋盘，不包含 3D 骰子或角色 3D 动画；服务端只使用 Node.js 标准库。

## 已实现

- 40 格经典棋盘、起点奖励、税费和公共区域
- 地产、铁路、公共事业购买与租金
- 拒绝购买后的全员拍卖
- 双骰奖励、连续三次双骰、留置所三回合规则
- 机会卡、公益基金卡、免费离所卡
- 完整颜色组、均匀建房、旅馆和银行建筑数量
- 抵押、赎回、出售建筑、债务与破产
- 创建房间、房间码加入、真人与 AI 混合对局
- 房主可选择服务器随机掷骰或真人自选两颗骰子点数
- 玩家可用多块地产和双方现金发起交易，真人或 AI 可接受/拒绝
- 有建筑的颜色组禁止交易，抵押地产转手收取 10% 手续费
- 服务端维护全部状态，浏览器不能直接修改钱或资产

## 本地运行

```powershell
node server.js
```

默认监听 `0.0.0.0:3000`，浏览器访问 `http://localhost:3000`。

自定义端口：

```powershell
$env:PORT=8080
node server.js
```

## 公网部署

把整个目录上传到安装了 Node.js 18 或更高版本的服务器，运行 `node server.js`，再开放对应 TCP 端口。正式使用建议通过 Nginx/Caddy 反向代理到 `127.0.0.1:3000` 并启用 HTTPS。

不要把 SSH 密码、私钥、服务器内部配置或敏感部署信息提交到仓库。如果想放在线试玩地址，建议使用域名或 HTTPS 演示地址，而不是直接写服务器登录方式。

房间状态目前保存在内存中，服务器重启后对局会消失。长期部署可在后续接入 SQLite 或 Redis 持久化。

## 测试

```powershell
node --test
```

浏览器端到端验收脚本位于 `scripts/e2e-smoke.js`，需要本机提供 Playwright 与 Chromium。

## License

MIT

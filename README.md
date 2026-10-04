# stronghold-scout · 卫戍协议公共服务器自动发现

自动发现玩家自建的「卫戍协议：盟约」联机服，校验后**投递到维护者的待审队列**，不直接改线上清单。

```
scout.mjs      采集核（runtime 无关：Cloudflare Worker / Node 22+ 同一份代码）
worker.mjs     CF Worker 入口：cron 定时 + /run 手工触发
run-node.mjs   Node 入口：单次或 --loop 常驻（给远程盒子用）
wrangler.toml  cron 每天 4 轮（`0 */6 * * *`）、R2 绑定、兼容标志
```

## 投递模式（两套，自动上线已启用）

| 模式 | 开关 | 行为 | 需要什么 |
|---|---|---|---|
| 只入队 | `AUTO_SUBMIT=1` | 过指纹的投进 `POST /api/servers/submit` → KV 待审队列 | 无密钥即可（Worker 原生能力） |
| 自动上线 | `AUTO_PUBLISH=1` | submit → `review approve` → 本侧 `canonicalPayload`+Ed25519 签名 → `PUT /api/servers` | Worker secret `SP_SIGN_KEY`（32B hex seed）+ `PUBLISH_KEY`；可选 `SP_PUB_KEY` |

信任根位置：**清单私钥现在同时存在于本机 `~/.sp-sign/` 和 Cloudflare Worker secret**（2026-10-03 由维护者选定）。等价含义：能控制该 CF 账号或 Worker 代码的人，就能签出客户端会接受的伪造清单。APK 侧仍可用内置公钥验签；`keyId` 固定 `sp-2026-10`，将来轮换走多公钥。

误发布保险：`publisher.mjs` 的 `resignAndPublish()` 在写之前先用公钥验**现网那份由 dl-site 侧签的名**。两侧规范化一旦分叉 → 验不过 → 拒绝发布并报错（`/selftest?key=…` 可随时核对两侧 sha256 是否一致）。

## 安全模型（为什么它不会污染清单）

1. 候选必须过上游 `/healthz` **指纹校验**才可能被提交：原版 node 要 `ok:true + version:1 + app:"0.1.0" + 7 个计数字段`；Workers 改造版要 `runtime:"cloudflare" + version + build:<git sha>`。静态托管（GitHub Pages / pages.dev / vercel）没有这个响应，天然被刷掉。
2. 只调用维护者搭好的访客通道 `POST https://dl.jiangjiangze.icu/api/servers/submit` —— 服务端再校验一次、再去重（已在清单/已在队列就 409），然后进 `SERVER_REVIEW` KV 队列，**由维护者在 admin 页 approve/reject**。
3. 脚本对 R2 只写 `scout/state.json`、`scout/last-report.json` 两个键，**不直接改 `site/servers.json`**；上线一律走 Pages Function（服务端校验 + 签名），因此门卫与审计都在维护者那一侧。
4. 出站地址硬校验：仅 http(s)、拒绝 URL 内账号密码、拒绝环回/私有/链路本地/保留地址与无点主机名、重定向不跟随。静态排除表覆盖 github/bilibili/网盘/库文档等 megadomain，避免误探别人家的站点。
5. 配额闸门：每轮最多探 40 个候选、90 秒预算（超了记 `truncated`）、单次请求 6 秒硬超时、失败主机 3 天冷却、每轮最多投 5 条、同一条投过之后 7 天内不重投。

## 发现渠道

| 渠道 | 需要凭据 | 说明 |
|---|---|---|
| GitHub fork 网络 | 否（可选 `GITHUB_TOKEN` 提额度） | `sganggs/Stronghold-Protocol` 的 fork 的 homepage / has_pages；fork 的 README 正文（按 `pushed_at` 缓存，每轮最多 8 个） |
| 上游 Issue/PR | 否 | issue 正文 + 评论里的地址（按 `updated_at` 增量） |
| GitHub 仓库搜索 | 否 | `卫戍协议`、`stronghold protocol arknights` |
| B 站弹幕 | 否 | `comment.bilibili.com/{cid}.xml` 全文抽链接 |
| B 站站内搜索 | 否（WBI 自动签名） | 关键词命中的视频简介 / 专栏摘要 |
| B 站评论区 | **`BILI_COOKIE`** | 不给 cookie 时只有公开可见的少数热帖；给了才翻得动全量（这也是唯一能捞到 `game.starst.site` 这类留言的渠道） |

跟踪的视频在 `scout.mjs` 的 `DEFAULTS.videos`（`aid` + `cid`），有同类新项目就往里加。

## 部署 A：Cloudflare Worker（推荐）

```bash
cd stronghold-scout
# 可选：给评论区渠道配 cookie（一整行 "SESSDATA=...; bili_jct=..."）
printf '%s' "$(cat ~/.bili_cookie)" | wrangler secret put BILI_COOKIE
# 手工触发口令，必填
printf '%s' "$(openssl rand -hex 16 2>/dev/null || head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')" | wrangler secret put SCOUT_TOKEN
wrangler deploy
```

之后每天 4 轮自动跑（UTC 00/06/12/18 = 北京 08/14/20/02）。想改频率就改 `wrangler.toml` 的 `[triggers] crons` 再 `wrangler deploy`。手工触发/查状态（口令用上面设的 `SCOUT_TOKEN`）：

```
GET https://stronghold-scout.<account>.workers.dev/run?key=$SCOUT_TOKEN        # 跑一轮并回报告
GET https://stronghold-scout.<account>.workers.dev/run?dry=1&key=$SCOUT_TOKEN  # 只报告不投递
GET https://stronghold-scout.<account>.workers.dev/state?key=$SCOUT_TOKEN      # 读 state
```

注意：`*.workers.dev` 从国内经常连不通（本仓库维护者的机器上就实测不通）。要能从本地手工触发，给 Worker 绑一个自己域名的路由（`wrangler deployments`/dashboard 里加 route），或者直接用部署在 R2 的 `scout/last-report.json` 看结果。

## 部署 B：远程盒子（无窗口后台）

单次：

```bash
node run-node.mjs            # 真投递
node run-node.mjs --dry-run  # 只报告
```

常驻（内置 30 分钟节拍 + ±60 秒抖动，异常不退出）：

```bash
# Linux：完全无终端
SCOUT_INTERVAL_MIN=30 nohup node run-node.mjs --loop >/tmp/stronghold-scout.log 2>&1 &
# 或 systemd unit（推荐，重启自恢复）：ExecStart=/usr/bin/node .../run-node.mjs --loop
# 节拍默认 360 分钟（每天 4 次），要更密就 SCOUT_INTERVAL_MIN=60 之类覆盖

# Windows：任务计划程序，SYSTEM 身份 = 任何情况下都不弹窗
schtasks /Create /F /TN stronghold-scout /SC MINUTE /MO 30 ^
  /RU SYSTEM /NP /TR "cmd /c cd /d D:\stronghold-scout && node run-node.mjs"
```

`BILI_COOKIE` / `GITHUB_TOKEN` 可用环境变量，也可以放成 `~/.bili_cookie`、`~/.gh_fine_token` 文件由脚本自己读。

## 报告字段

`discovered` 候选数、`verified` 通过指纹校验数、`submitted[]`（含队列 `queueId`）、`rejected[]`（失败原因）、`cooldown` 跳过、`deferred` 提交额度用尽顺延、`truncated` 超预算、`stateSize`。历史报告在 R2 `scout/last-report.json`，去重/缓存在 `scout/state.json`。

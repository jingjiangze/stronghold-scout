import { createHash } from 'node:crypto';

/* ==========================================================================================
   scout.mjs — 卫戍协议公共服务器自动发现（runtime 无关：Cloudflare Worker / Node 22+）

   发现渠道
     1. GitHub：sganggs/Stronghold-Protocol 的 fork 网络（homepage 字段）+ 仓库搜索
     2. B 站弹幕 XML（comment.bilibili.com/{cid}.xml，公开无需登录）
     3. B 站评论区（需 SESSDATA，未配置时退化为公开可见的热评）
   候选必须先通过上游 /healthz 指纹校验才会被提交；提交只走维护者搭好的
   POST /api/servers/submit（服务端再校验一次 + 进 KV 待审队列），本脚本永远不写
   site/servers.json —— 签名清单的发布权保持在维护者手里。
   ========================================================================================== */

export const DEFAULTS = {
  upstream: 'sganggs/Stronghold-Protocol',
  liveList: 'https://weishucdn.jiangjiangze.icu/site/servers.json',
  submitUrl: 'https://dl.jiangjiangze.icu/api/servers/submit',
  reviewUrl: 'https://dl.jiangjiangze.icu/api/servers/review',
  probePaths: ['/healthz', '/api/status', '/health'],   // raiya 这类挂在子路径/改名健康检查的服要靠这个才收得进来
  clientMounts: ['/play', '/game', '/app', '/covenant', '/'],  // 客户端本体的常见挂载点
  videos: [{ aid: '117371003995662', cid: '42396680690', bvid: 'BV1QoaU6gEF2', note: '主视频' }],
  repoQueries: ['卫戍协议', 'stronghold protocol arknights'],
  /* 人工观察名单：现在还没过指纹，但已经在跑别的形态（登录门、状态站…）。
     每轮复探，哪天它开出合法的 /healthz 就会被自动收进清单。 */
  seeds: [{ url: 'https://ark-proto.stardust.matce.cn', note: 'B站 10-04 Stardust_减，登录门改版' },
          { url: 'https://sp.nekotc.cn', note: '妮蔻（已在清单，复探用于容量观察）' }],
  watch: ['https://game.rainya.me'],   // 监听名单：每小时一次采样，见 watchServers
  searchQueries: ['卫戍协议 网页版', '卫戍协议 联机 服务器'],
  autoSubmit: false,          // 默认只报告；确认维护端修好审核队列后再开
  maxSubmitsPerRun: 5,
  commentPages: 12,          // 有 cookie 时按时间序翻到第几页（可用 COMMENT_PAGES 覆盖）
  forkPages: 2,
  readmeScanMax: 15,
  githubIntervalMin: 180,   // fork 枚举/README/仓库搜索的节流间隔（分钟）
  biliCookieIntervalMin: 180, // 带 cookie 的评论区深翻每 3 小时才做一轮（风控按账号计）
  biliBanOffHours: 6,         // 撞到 -412 后退避多久
  expandRelated: true,     // 把二创/教程视频的评论区也纳进来
  maxRelatedVideos: 6,      // 每轮最多额外带几个相关视频
  hotPages: 3,              // 热度序评论浅翻；新服基本只出现在按时间序的前几页
  candidateEagerHours: 6,   // 新地址这几小时内每轮都探（刚开服往往反复重启）
  candidateRetryMin: 120,   // 老候选（出现满一天）的复探间隔，分钟
  maxCandidates: 40,
  fetchTimeoutMs: 6000,
  refailCooldownMs: 3 * 864e5,
  budgetMs: 240e3,
};

/* 上游 shared/constants.js：只有协议号 PROTOCOL_VERSION 参与门禁；APP_VERSION 仅记录（写死会把已升级的好服全刷掉） */
const VERIFY = { version: 1 };
const HEALTH_FIELDS = ['uptimeSec', 'sockets', 'sessions', 'rooms', 'matches', 'humans', 'bots'];

/* 静态托管跑不了 node 服务端；代码/分享/社交平台根域名也开不了同盟房。先本地排除省请求，
   真正的判据仍是 /healthz 指纹。 */
const SKIP_HOST = [/\.github\.io$/i, /\.pages\.dev$/i, /\.vercel\.app$/i, /\.netlify\.(app|site)$/i,
                   /\.gitlab\.io$/i, /^raw\.githubusercontent\.com$/i, /^github\.com$/i, /^gitee\.com$/i,
                   /\.bilibili\.com$/i, /^b23\.tv$/i, /(^|\.)163\.com$/i, /(^|\.)music\.com$/i,
                   /(^|\.)ax1x\.com$/i, /(^|\.)imgchr\.com$/i, /(^|\.)smms\.app$/i,
                   /(^|\.)image\.tm$/i, /(^|\.)staticflickr\.com$/i, /(^|\.)lanzou[a-z]*\.com$/i,
                   /(^|\.)pan\.baidu\.com$/i, /(^|\.)123pan\.cn$/i, /(^|\.)quark\.cn$/i, /(^|\.)docs\.qq\.com$/i,
                   /(^|\.)taptap\.cn$/i, /(^|\.)nga\.cn$/i, /(^|\.)nodejs\.org$/i, /(^|\.)npmmirror\.com$/i,
                   /(^|\.)shields\.io$/i, /(^|\.)example\.com$/i, /(^|\.)hypergryph\.com$/i,
                   /(^|\.)prts\.wiki$/i, /(^|\.)pixijs\.com$/i, /(^|\.)threejs\.org$/i, /(^|\.)preactjs\.com$/i,
                   /(^|\.)esotericsoftware\.com$/i, /(^|\.)wikipedia\.org$/i, /(^|\.)mozilla\.org$/i];
const LINK_RE = /https?:\/\/[^\s"'），、\]()<>`]+/g;

export function isPublicHttpUrl(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.username || u.password) return null;
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!h || h === 'localhost' || /\.(localhost|local|internal|localdomain)$/.test(h)) return null;
  if (!h.includes('.') && !/^[0-9a-f:.]+$/i.test(h)) return null;   // 无点主机名 = 链接被全角字符截断的残片
  if (/^(127\.|10\.|0\.|169\.254\.|192\.168\.)/.test(h)) return null;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return null;
  if (/^(::1|::|f[cd]|fe[89ab])/i.test(h)) return null;
  return u;
}

function originOf(u) { return `${u.protocol}//${u.host}`; }
/** ?room=RWJW 这类深链也是服务器：去掉 ? 与 # 之后的部分，但保留 path（子路径挂载是真的）。 */
function normalizeCandidate(raw) {
  const u = isPublicHttpUrl(raw);
  if (!u) return null;
  if (SKIP_HOST.some(re => re.test(u.hostname))) return null;
  const path = u.pathname.replace(/\/+$/, '');
  return originOf(u) + path;
}
const cleanId = s => String(s || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32);
const cleanNote = s => String(s || '').trim().slice(0, 48);

/** 上游健康指纹：只有回 JSON 且字段对得上的才是「能开同盟房的卫戍服」。 */
export async function probeHealth(fetchImpl, origin, timeoutMs, paths = ['/healthz']) {
  for (let i = 0; i < paths.length; i++) {
    const out = await probeOnce(fetchImpl, origin, paths[i], timeoutMs);
    if (out.ok || i === paths.length - 1) return out;
  }
  return { ok: false, error: 'unreachable' };
}

async function probeOnce(fetchImpl, origin, path, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(origin + path, {
      redirect: 'manual', signal: ctrl.signal,
      headers: { accept: 'application/json', 'user-agent': 'stronghold-scout/1' },
    });
    if (res.status >= 300 && res.status < 400) return { ok: false, error: `重定向 ${res.status}` };
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    if (!((res.headers.get('content-type') || '').includes('json'))) return { ok: false, error: '响应不是 JSON' };
    const text = await res.text();
    if (text.length > 2048) return { ok: false, error: '响应过大' };
    let body; try { body = JSON.parse(text); } catch { return { ok: false, error: 'JSON 解析失败' }; }
    if (body.ok !== true) return { ok: false, error: 'ok 非 true' };
    const workers = body.runtime === 'cloudflare' || typeof body.version === 'string';
    if (!workers && body.version !== VERIFY.version) return { ok: false, error: `version=${body.version}` };
    if (workers) {
      if (typeof body.build !== 'string' || !/^[0-9a-f]{6,40}$/i.test(body.build)) return { ok: false, error: 'workers 版缺 build' };
    } else {
      for (const f of HEALTH_FIELDS) if (typeof body[f] !== 'number') return { ok: false, error: `缺字段 ${f}` };
    }
    return { ok: true, probe: path, variant: workers ? 'workers' : 'node', app: body.app || body.version,
             build: body.build || null, humans: body.humans ?? null, rooms: body.rooms ?? null,
             uptimeSec: body.uptimeSec ?? null };
  } catch (e) {
    return { ok: false, error: String(e && e.name || e).slice(0, 40) };
  } finally { clearTimeout(timer); }
}

async function getJson(fetchImpl, url, headers) {
  try {
    const res = await fetchImpl(url, { headers: { 'user-agent': 'stronghold-scout/1', ...headers } });
    const t = await res.text();
    try { return JSON.parse(t); } catch { return null; }
  } catch { return null; }
}

function linksIn(text, into) {
  for (const m of String(text || '').matchAll(LINK_RE)) into.add(m[0].replace(/[.,;:!?_]+$/, ''));
}

const unesc = s => String(s).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

/* 判断一个 URL 是不是游戏客户端本体（而不是状态页/落地页）：
   上游 index.html 里同时有 viewport-fit=cover、/vendor/ 资源、STRONGHOLD PROTOCOL 标题。 */
const CLIENT_MARKERS = [/viewport-fit=cover/i, /\/vendor\//i, /STRONGHOLD PROTOCOL/i];
export async function looksLikeClient(fetchImpl, url, timeoutMs) {
  try {
    const res = await fetchImpl(url, { headers: { 'user-agent': 'stronghold-scout/1', accept: 'text/html' } });
    if (!res.ok) return false;
    const html = (await res.text()).slice(0, 20000);
    return CLIENT_MARKERS.filter(re => re.test(html)).length >= 2;
  } catch { return false; }
}

/**
 * 把一个候选地址解析成「可入清单的条目」：
 *   健康检查一律在站点根上找（/healthz、/api/status、/health 任选其一命中）；
 *   客户端本体可能挂在 /play 之类子路径（raiya 的根是状态页，/healthz 还被 nginx 403），
 *   所以再找挂载点，找不到就退回站点根。
 * 返回 { probePath, clientUrl } 或 null。
 */
export async function resolveServer(fetchImpl, candidate, timeoutMs, probePaths, clientMounts) {
  const u = isPublicHttpUrl(candidate); if (!u) return null;
  const origin = originOf(u);
  let probePath = null;
  for (const p of probePaths) {
    const v = await probeHealth(fetchImpl, origin, timeoutMs, [p]);
    if (v.ok) { probePath = p; break; }
  }
  if (!probePath) return null;
  for (const mount of (clientMounts || ['/'])) {
    const url = origin + (mount === '/' ? '' : mount);
    if (url === candidate || mount === '/') {
      if (await looksLikeClient(fetchImpl, url || origin + '/', timeoutMs)) return { probePath, clientUrl: url, origin };
      if (mount !== '/') continue;
    } else if (await looksLikeClient(fetchImpl, url, timeoutMs)) return { probePath, clientUrl: url, origin };
  }
  return { probePath, clientUrl: u.pathname.replace(/\/+$/, '') ? origin + u.pathname.replace(/\/+$/, '') : origin, origin };
}

/* ---- 渠道 ---- */

async function fromGithub(ctx) {
  const found = new Map();
  const gh = async (path) => {
    const json = await getJson(ctx.fetch, `https://api.github.com/${path}`,
      { accept: 'application/vnd.github+json', ...(ctx.secrets.githubToken ? { authorization: `Bearer ${ctx.secrets.githubToken}` } : {}) });
    return json && (json.items || json) || null;
  };
  const text = async (path) => {
    try {
      const res = await ctx.fetch(`https://api.github.com/${path}`, {
        headers: { accept: 'application/vnd.github.raw+json', ...(ctx.secrets.githubToken ? { authorization: `Bearer ${ctx.secrets.githubToken}` } : {}) },
      });
      return res.ok ? res.text() : '';
    } catch { return ''; }
  };
  const urls = (blob, source) => { const set = new Set(); linksIn(blob, set); for (const u of set) if (!found.has(u)) found.set(u, source); };

  // fork 枚举 + README + 仓库搜索是最贵的一坨（200 个 fork 列表 + 几十个 README 原文）。
  // 30 分钟一轮不必每轮都做，按 githubIntervalMin 节流；上游 Issue 是增量扫的，每轮都跑。
  const gapMs = (ctx.cfg.githubIntervalMin || 0) * 60000;
  const heavyDue = !(gapMs && ctx.state.githubAt && Date.now() - ctx.state.githubAt < gapMs);
  const forks = [];
  for (let page = 1; heavyDue && page <= ctx.cfg.forkPages; page++) {
    const list = await gh(`repos/${ctx.cfg.upstream}/forks?per_page=100&sort=newest&page=${page}`);
    if (!Array.isArray(list) || !list.length) break;
    forks.push(...list);
    if (list.length < 100) break;
  }
  for (const f of forks) {
    if (f.homepage) found.set(f.homepage, `GitHub fork ${f.full_name}`);
    if (f.has_pages) found.set(`https://${f.owner.login}.github.io/${f.name}`, `GitHub Pages ${f.full_name}`);
  }
  /* README 里常写着「我部署在 http://…」（本轮只扫有变化的、上限 8 个，靠 state.readme 记住已扫） */
  ctx.state.readme = ctx.state.readme || {};
  let scanned = 0;
  for (const f of forks) {
    if (scanned >= ctx.cfg.readmeScanMax) break;
    const stamp = `${f.pushed_at}|${f.default_branch}`;
    if (ctx.state.readme[f.full_name] === stamp) continue;
    const body = await text(`repos/${f.full_name}/readme?ref=${encodeURIComponent(f.default_branch || 'master')}`);
    if (body) { urls(body, `README ${f.full_name}`); ctx.state.readme[f.full_name] = stamp; scanned++; }
  }
  for (const q of (heavyDue ? ctx.cfg.repoQueries : [])) {
    const d = await gh(`search/repositories?q=${encodeURIComponent(q)}&per_page=30&sort=updated`);
    for (const it of (Array.isArray(d) ? d : [])) if (it.homepage) found.set(it.homepage, `GitHub 搜索 ${it.full_name}`);
  }
  /* 上游 Issue/PR 正文也常带地址（只扫新开的） */
  ctx.state.issues = ctx.state.issues || {};
  const issues = await gh(`repos/${ctx.cfg.upstream}/issues?state=all&per_page=30`);
  for (const i of (Array.isArray(issues) ? issues : [])) {
    if (ctx.state.issues[i.number] === i.updated_at) continue;
    urls(i.body || '', `Issue #${i.number}`);
    const comments = await gh(`repos/${ctx.cfg.upstream}/issues/${i.number}/comments?per_page=30`);
    for (const c of (Array.isArray(comments) ? comments : [])) urls(c.body || '', `Issue #${i.number} 评论`);
    ctx.state.issues[i.number] = i.updated_at;
  }
  if (heavyDue) ctx.state.githubAt = Date.now();
  return found;
}


async function fromDanmaku(ctx) {
  const found = new Map();
  for (const v of ctx.cfg.videos) {
    try {
      const res = await ctx.fetch(`https://comment.bilibili.com/${v.cid}.xml`, { headers: { 'user-agent': 'stronghold-scout/1', referer: 'https://www.bilibili.com/' } });
      const xml = await res.text();
      for (const m of xml.matchAll(/<d p="[^"]*">([\s\S]*?)<\/d>/g)) {
        const urls = new Set(); linksIn(unesc(m[1]), urls);
        for (const u of urls) found.set(u, `弹幕 ${v.note}`);
      }
    } catch { /* 单渠道失败不影响整体 */ }
  }
  return found;
}

/* 二创/教程视频的评论区是主视频之外的另一批分享源；一次 API 就能拿到列表，
   结果缓进台账，按 maxRelatedVideos 限流，避免每小时一轮时把请求数翻几倍。 */
async function relatedVideos(ctx) {
  if (!ctx.cfg.expandRelated) return [];
  ctx.state.related = ctx.state.related || { at: 0, list: [] };
  if (Date.now() - ctx.state.related.at < 6 * 3600e3 && ctx.state.related.list.length) return ctx.state.related.list;
  const out = [];
  const headers = biliHeaders(ctx.secrets.biliCookie, true);
  for (const v of ctx.cfg.videos) {
    if (!v.bvid) continue;
    const rel = await getJson(ctx.fetch, 'https://api.bilibili.com/x/web-interface/archive/related?bvid=' + v.bvid, headers);
    for (const it of ((rel && rel.data) || [])) {
      if (out.length >= ctx.cfg.maxRelatedVideos) break;
      out.push({ aid: String(it.aid), cid: String(it.cid), bvid: it.bvid, note: '相关·' + String(it.title).slice(0, 14) });
    }
  }
  if (out.length) ctx.state.related = { at: Date.now(), list: out };
  return ctx.state.related.list;
}

/* 监听：对指定站点做时间序列采样 —— 活没活、几人在、版本/构建有没有变、有没有悄悄重启。
   样本跟着台账一起存进 Worker 的 R2，直读 https://weishucdn.jiangjiangze.icu/scout/state.json
   就能看到 watch[host] 的历史数组和最近 60 条 watchEvents。 */
const WATCH_SAMPLES = 300;
export async function watchServers(ctx, report) {
  const events = [];
  ctx.state.watch = ctx.state.watch || {};
  for (const target of ctx.cfg.watch || []) {
    const origin = normalizeCandidate(typeof target === 'string' ? target : target.url);
    if (!origin) continue;
    const key = new URL(origin).host;
    const hist = ctx.state.watch[key] || [];
    const prev = hist.slice(-1)[0] || null;
    const paths = (typeof target === 'object' && target.probe) ? [target.probe] : (ctx.cfg.probePaths || ['/healthz']);
    let s = { at: Date.now(), ok: false, err: 'unreachable' };
    for (const p of paths) {
      const v = await probeHealth(ctx.fetch, origin, ctx.cfg.fetchTimeoutMs, [p]);
      if (v.ok) { s = { at: s.at, ok: true, probe: p, app: v.app || null, build: v.build || null, humans: v.humans ?? null, rooms: v.rooms ?? null, uptimeSec: v.uptimeSec ?? null }; break; }
      s.err = v.error;
    }
    if (!s.ok) s = { at: s.at, ok: false, err: String(s.err || 'unreachable').slice(0, 44) };
    hist.push(s);
    if (hist.length > WATCH_SAMPLES) hist.splice(0, hist.length - WATCH_SAMPLES);
    ctx.state.watch[key] = hist;

    if (s.ok && (!prev || !prev.ok)) events.push({ host: key, type: 'up', at: s.at, app: s.app, build: s.build });
    if (!s.ok && prev && prev.ok) events.push({ host: key, type: 'down', at: s.at, reason: s.err });
    if (s.ok && prev && prev.ok) {
      if (prev.app !== s.app || prev.build !== s.build) events.push({ host: key, type: 'version', at: s.at, from: prev.app + '/' + (prev.build || '-'), to: s.app + '/' + (s.build || '-') });
      if (Number.isFinite(prev.uptimeSec) && Number.isFinite(s.uptimeSec) && s.uptimeSec < prev.uptimeSec) events.push({ host: key, type: 'restart', at: s.at, uptimeSec: s.uptimeSec });
    }
    (report.watch = report.watch || []).push({ host: key, ok: s.ok, app: s.app || null, humans: s.humans ?? null, rooms: s.rooms ?? null, uptimeSec: s.uptimeSec ?? null, samples: hist.length, err: s.ok ? null : s.err });
  }
  if (events.length) ctx.state.watchEvents = (ctx.state.watchEvents || []).concat(events).slice(-60);
  report.watchEvents = events;
  return events;
}

async function fromBiliComments(ctx) {
  const found = new Map();
  const cookie = ctx.secrets.biliCookie;
  // B 站风控按账号/会话计，不看出口：今天浏览器 + 本机 + 云端连着翻同一个视频的评论区，
  // 三个出口全吃了 -412。所以带 cookie 的深翻页必须自我限流，撞封禁就主动退避几小时，
  // 把「每小时都去敲门」改成「隔几小时一次」；不带 cookie 的公开位渠道不受影响。
  const banUntil = Number(ctx.state.biliBanUntil) || 0;
  const gapMs = (ctx.cfg.biliCookieIntervalMin || 0) * 60000;
  if (cookie && banUntil > Date.now()) { ctx.state.biliSkip = { at: Date.now(), why: '封禁退避中，剩 ' + Math.round((banUntil - Date.now()) / 60000) + ' 分钟' }; return found; }
  if (cookie && gapMs && ctx.state.biliCookieAt && Date.now() - ctx.state.biliCookieAt < gapMs) {
    ctx.state.biliSkip = { at: Date.now(), why: '距上次 cookie 翻页不足 ' + ctx.cfg.biliCookieIntervalMin + ' 分钟' };
    return found;
  }
  if (cookie) ctx.state.biliCookieAt = Date.now();
  const headers = biliHeaders(cookie, true);
  // 时间水位：上一轮已经翻到过的评论时间戳。按时间序翻页时，一旦某页出现比水位更早的
  // 评论就说明已经翻过重复区，直接停 —— 30 分钟一轮靠这个把每轮请求数压到个位数。
  const videos = ctx.cfg.videos.concat(await relatedVideos(ctx));
  const watermark = Number(ctx.state.biliWatermark) || 0;
  let newest = watermark;
  const stamp = (c) => {
    const raw = Number(c && (c.created || c.create_time * 1000)) || 0;
    return raw > 1e12 ? raw : raw * 1000;
  };
  for (const v of videos) {
    for (const sort of [2, 0]) {
      const depth = sort === 2 ? (cookie ? ctx.cfg.commentPages : 1) : (cookie ? ctx.cfg.hotPages : 1);
      let repeat = false;
      for (let pn = 1; pn <= depth && !repeat; pn++) {
        const d = await getJson(ctx.fetch, `https://api.bilibili.com/x/v2/reply?type=1&oid=${v.aid}&sort=${sort}&pn=${pn}&ps=20`, headers);
        if (d && d.code === -412) {
          ctx.state.biliBanUntil = Date.now() + (ctx.cfg.biliBanOffHours || 6) * 3600e3;
          ctx.state.biliSkip = { at: Date.now(), why: '命中 -412，退避 ' + (ctx.cfg.biliBanOffHours || 6) + ' 小时' };
          break;
        }
        const reps = d && d.data && d.data.replies;
        if (!Array.isArray(reps)) break;
        for (const c of reps) {
          const at = stamp(c);
          if (at > newest) newest = at;
          if (sort === 2 && watermark && at && at <= watermark) repeat = true;
          const urls = new Set();
          linksIn(c?.content?.message, urls);
          // 楼中楼里也常有「我这边还有个服」的补充，同一次请求白送
          for (const sub of (c.replies || [])) linksIn(sub?.content?.message, urls);
          for (const u of urls) found.set(u, `评论区 ${(c?.member?.uname || '').slice(0, 12)}`);
        }
        if (!reps.length || (d.data.cursor && d.data.cursor.is_end)) break;
      }
    }
  }
  if (newest > watermark) ctx.state.biliWatermark = newest;
  return found;
}

/* B 站站内搜索（公开，需 WBI 签名）：命中视频的简介里常有部署地址 */
const MIXIN_INDEX = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29,
                     28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 30, 52, 51, 25, 20, 34, 11];

async function fromBiliSearch(ctx) {
  const found = new Map();
  const cookie = ctx.secrets.biliCookie;
  const headers = { referer: 'https://www.bilibili.com/', ...(cookie ? { cookie } : {}) };
  const nav = await getJson(ctx.fetch, 'https://api.bilibili.com/x/web-interface/nav', headers);
  const img = nav?.data?.wbi_img?.img_url?.split('/').pop()?.split('.')[0];
  const sub = nav?.data?.wbi_img?.sub_url?.split('/').pop()?.split('.')[0];
  if (!img || !sub) return found;
  const raw = img + sub;
  let mixin = '';
  for (const i of MIXIN_INDEX) if (raw[i]) mixin += raw[i];
  mixin = mixin.slice(0, 32);
  const md5 = (x) => createHash('md5').update(x).digest('hex');
  for (const keyword of ctx.cfg.searchQueries) {
    for (const type of ['video', 'article']) {
      const params = new URLSearchParams({ search_type: type, keyword, page: '1' });
      params.set('wts', String(Math.floor(Date.now() / 1000)));
      const q = [...params.entries()].sort(([a], [b]) => a < b ? -1 : 1);
      const query = q.map(([k, v]) => `${k}=${encodeURIComponent(v).replace(/!/g, '%21').replace(/'/g, '%27').replace(/\(/g, '%28').replace(/\)/g, '%29').replace(/~/g, '%7E')}`).join('&');
      params.set('w_rid', await md5(query + mixin));
      const d = await getJson(ctx.fetch, 'https://api.bilibili.com/x/web-interface/search/type?' + params.toString(), headers);
      const urls = new Set();
      for (const it of (d?.data?.result || [])) linksIn(`${it.description || ''} ${it.title || ''} ${it.summary || ''}`, urls);
      for (const u of urls) found.set(u, `B 站搜索「${keyword}」`);
    }
  }
  return found;
}

/* ---- 渠道探针：从 Cloudflare 出口实测 B 站各个评论入口的可用性与指纹要求 ---- */
const BILI_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const BILI_BASE = { referer: 'https://www.bilibili.com/', origin: 'https://www.bilibili.com' };

/** browser=true 时补浏览器级指纹（UA / sec-fetch / sec-ch-ua）。Worker 裸 fetch 的 UA 是 Cloudflare-Worker。 */
export function biliHeaders(cookie, browser) {
  if (!browser) return { ...BILI_BASE, ...(cookie ? { cookie } : {}) };
  return { ...BILI_BASE,
    'user-agent': BILI_UA,
    accept: 'application/json, text/plain, */*',
    'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'sec-fetch-mode': 'cors', 'sec-fetch-site': 'same-site', 'sec-fetch-dest': 'empty',
    'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    'sec-ch-ua-mobile': '?0', 'sec-ch-ua-platform': '"Windows"',
    'cache-control': 'no-cache', pragma: 'no-cache',
    ...(cookie ? { cookie } : {}) };
}

async function wbiMixin(fetchImpl, headers) {
  const nav = await getJson(fetchImpl, 'https://api.bilibili.com/x/web-interface/nav', headers);
  const img = nav?.data?.wbi_img?.img_url?.split('/').pop()?.split('.')[0];
  const sub = nav?.data?.wbi_img?.sub_url?.split('/').pop()?.split('.')[0];
  if (!img || !sub) return '';
  const raw = img + sub;
  let mixin = '';
  for (const i of MIXIN_INDEX) if (raw[i]) mixin += raw[i];
  return mixin.slice(0, 32);
}

/** WBI 签名后的完整地址（与搜索渠道同一套编码规则）。 */
async function wbiUrl(fetchImpl, base, params, headers) {
  const mixin = await wbiMixin(fetchImpl, headers);
  if (!mixin) return '';
  const p = new URLSearchParams(params);
  p.set('wts', String(Math.floor(Date.now() / 1000)));
  const q = [...p.entries()].sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${encodeURIComponent(v).replace(/!/g, '%21').replace(/'/g, '%27').replace(/\(/g, '%28').replace(/\)/g, '%29').replace(/~/g, '%7E')}`).join('&');
  p.set('w_rid', createHash('md5').update(q + mixin).digest('hex'));
  return base + '?' + p.toString();
}

export async function biliProbe(fetchImpl, cookie) {
  const { aid, cid, bvid } = DEFAULTS.videos[0];
  const out = [];
  const hit = async (name, url, headers) => {
    if (!url) { out.push({ name, error: '地址为空（WBI 取密钥失败）' }); return; }
    const t0 = Date.now();
    try {
      const res = await fetchImpl(url, { headers });
      const text = await res.text();
      const row = { name, status: res.status, ms: Date.now() - t0, ct: (res.headers.get('content-type') || '').slice(0, 28) };
      let j = null; try { j = JSON.parse(text); } catch { /* xml/html */ }
      if (j) {
        row.code = j.code; row.msg = String(j.message || '').slice(0, 26);
        const reps = (j.data && j.data.replies) || [];
        row.replies = Array.isArray(reps) ? reps.length : 0;
        if (j.data && j.data.page) row.acount = j.data.page.acount;
        if (j.data && j.data.cursor && j.data.cursor.is_end) row.isEnd = true;
        const upper = j.data && j.data.upper && j.data.upper.top && j.data.upper.top.content
          ? j.data.upper.top.content.message : '';
        if (upper) row.upper = String(upper).replace(/\s+/g, ' ').slice(0, 90);
        const tops = ((j.data && j.data.top_replies) || []).map((x) => (x.content && x.content.message) || '').join(' | ');
        if (tops) row.topReplies = tops.replace(/\s+/g, ' ').slice(0, 90);
        const urls = new Set();
        for (const r of Array.isArray(reps) ? reps : []) {
          linksIn(((r.content && r.content.message) || '') + ' ' + ((r.replies || []).map((s) => (s.content && s.content.message) || '').join(' ')), urls);
        }
        row.links = [...urls].slice(0, 6);
        if (Array.isArray(reps) && reps[0]) row.rpid = reps[0].rpid;
      } else row.sample = text.replace(/\s+/g, ' ').slice(0, 90);
      out.push(row);
    } catch (e) { out.push({ name, error: String((e && e.name) || e).slice(0, 40) }); }
  };
  const q = (sort, pn) => `https://api.bilibili.com/x/v2/reply?type=1&oid=${aid}&sort=${sort}&pn=${pn}&ps=20`;
  await hit('1 未登录+裸referer', q(2, 1), biliHeaders(''));
  await hit('2 cookie+裸referer（云端现状）', q(2, 1), biliHeaders(cookie));
  await hit('3 cookie+浏览器指纹', q(2, 1), biliHeaders(cookie, true));
  await hit('4 无cookie+浏览器指纹', q(2, 1), biliHeaders('', true));
  await hit('5 cookie+浏览器 p6', q(2, 6), biliHeaders(cookie, true));
  await hit('6 cookie+浏览器 p30', q(2, 30), biliHeaders(cookie, true));
  await hit('7 cookie+浏览器 热度序', q(0, 1), biliHeaders(cookie, true));
  await hit('8 wbi /reply/wbi/main mode=2', await wbiUrl(fetchImpl, 'https://api.bilibili.com/x/v2/reply/wbi/main', { oid: aid, type: '1', mode: '2', next: '0' }, biliHeaders(cookie, true)), biliHeaders(cookie, true));
  const root = (out.find((r) => r.rpid) || {}).rpid;
  if (root) await hit(`9 楼中楼 /reply/reply root=${root}`, `https://api.bilibili.com/x/v2/reply/reply?type=1&oid=${aid}&root=${root}&pn=1&ps=20`, biliHeaders(cookie, true));
  await hit('10 弹幕 XML', `https://comment.bilibili.com/${cid}.xml`, biliHeaders('', true));
  await hit('11 相关视频列表', `https://api.bilibili.com/x/web-interface/archive/related?bvid=${bvid}`, biliHeaders('', true));
  await hit('12 视频详情(简介/cid/staff)', `https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, biliHeaders('', true));
  const ap = new URLSearchParams({ type: '1', oid: String(aid), pn: '1', ps: '20', sort: '2', appkey: '1d8b6e3d45233436', mobi_app: 'android', build: '7670000', platform: 'android', channel: 'bilibili' });
  const aq = [...ap.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  ap.set('sign', createHash('md5').update(aq + 'c75875c5a694e20bd91e0d327996991d').digest('hex'));
  await hit('13 App 端 /x/v2/reply', 'https://app.bilibili.com/x/v2/reply?' + ap.toString(), { 'user-agent': 'bili_android/7.67.0 os/android model/Pixel 5' });
  return { at: new Date().toISOString(), hasCookie: !!cookie, rows: out };
}

/* B 站「公开位」渠道：不需要登录、也不吃数据中心 IP 风控的四个位置。
   实测（10-04 本机基线）：未登录时 /x/v2/reply 只回 3 条主楼，但 **UP 置顶评论
   `data.upper.top` 照常返回**，`/web-interface/view`（简介）与 `/archive/related`
   （相关视频）也都不要登录。作者把版本说明和地址写在置顶/简介里，正是新服出现的地方。 */
async function fromBiliPublic(ctx) {
  const found = new Map();
  const headers = biliHeaders('', true);
  for (const v of ctx.cfg.videos.concat(await relatedVideos(ctx))) {
    const bag = [];
    const rp = await getJson(ctx.fetch, `https://api.bilibili.com/x/v2/reply?type=1&oid=${v.aid}&sort=2&pn=1&ps=20`, headers);
    const upper = rp?.data?.upper?.top;
    if (upper && upper.content) bag.push(String(upper.content.message || ''));
    for (const s of (upper && upper.replies) || []) bag.push(String((s.content && s.content.message) || ''));
    if (upper && upper.rpid) {
      const sub = await getJson(ctx.fetch, `https://api.bilibili.com/x/v2/reply/reply?type=1&oid=${v.aid}&root=${upper.rpid}&pn=1&ps=20`, headers);
      for (const s of (sub && sub.data && sub.data.replies) || []) bag.push(String((s.content && s.content.message) || ''));
    }
    const view = await getJson(ctx.fetch, `https://api.bilibili.com/x/web-interface/view?bvid=${v.bvid}`, headers);
    if (view && view.data) bag.push(String(view.data.desc || '') + ' ' + String(view.data.title || ''));
    const rel = await getJson(ctx.fetch, `https://api.bilibili.com/x/web-interface/archive/related?bvid=${v.bvid}`, headers);
    for (const it of ((rel && rel.data) || []).slice(0, ctx.cfg.relatedVideos)) {
      bag.push(`${String(it.title || '')} ${String(it.desc || it.description || '')}`);
    }
    for (const t of bag) {
      const urls = new Set();
      linksIn(t, urls);
      for (const u of urls) found.set(u, 'B站公开位（置顶/简介/相关）');
    }
  }
  return found;
}

/* ---- 主流程 ---- */

export async function runScout(options = {}) {
  const cfg = { ...DEFAULTS, ...(options.config || {}) };
  const baseFetch = options.fetch || ((...a) => fetch(...a));
  /* 所有渠道请求都带硬超时：某个上游挂住不能拖垮整轮（否则一轮能跑到两分钟） */
  const fetchImpl = (input, init) => baseFetch(input, { ...(init || {}), signal: (init && init.signal) || AbortSignal.timeout(cfg.fetchTimeoutMs) });
  const log = options.log || (() => {});
  const secrets = options.secrets || {};
  const state = options.state || { seen: {}, submitted: {} };
  const now = Date.now();
  const report = { autoSubmit: !!cfg.autoSubmit, startedAt: new Date(now).toISOString(), discovered: 0, verified: 0, submitted: [], rejected: [], errors: [] };

  const liveDoc = await getJson(fetchImpl, cfg.liveList, { accept: 'application/json' });
  const liveList = (liveDoc && liveDoc.servers) || [];
  const live = new Set(liveList.map(s => s.url));
  /* 同一站点挂不同 path 只算一台：按 host 去重，避免把 raiya 的 /play 与 /?room=… 当成两家 */
  // 「同一台服务器」的判据：同 host 且有一方是根路径（?room= 深链归一后就是根），或者两边子路径相同。
  // 只看 host 会把同一域名下不同子路径的另一台实例误判成重复；完全不看 host 又会让深链变成新条目。
  const splitUrl = (u) => { try { const x = new URL(u); const p = x.pathname.replace(/\/+$/, ''); return { host: x.host, path: p || '/' }; } catch { return null; } };
  const listed = liveList.map((u) => splitUrl(u && u.url)).filter(Boolean);
  const alreadyListed = (u) => { const x = splitUrl(u); if (!x) return false;
    return listed.some((y) => y.host === x.host && (x.path === y.path || x.path === '/' || y.path === '/')); };
  if (!live.size) report.errors.push('线上清单读取失败，本轮不提交以免重复入队');

  const src = { cfg, fetch: fetchImpl, secrets, state };
  const pools = [await fromGithub(src), await fromDanmaku(src), await fromBiliComments(src), await fromBiliPublic(src)];
  if (state.bili !== false) { try { pools.push(await fromBiliSearch(src)); } catch (e) { report.errors.push('B 站搜索渠道失败 ' + String(e).slice(0, 40)); } }
  const candidates = new Map();
  for (const pool of pools) for (const [raw, source] of pool) {
    const origin = normalizeCandidate(raw);
    if (origin && !candidates.has(origin)) candidates.set(origin, source);
  }
  /* 之前收下的候选 + 人工观察名单，每轮复探一次（本轮新发现的优先） */
  for (const [origin, c] of Object.entries(state.candidates || {})) {
    // 收紧 SKIP_HOST 之前存进台账的噪声（图床、直播间、UP 主空间、网盘…）不该继续占每轮配额：
    // 复探注入这条路不过 normalizeCandidate，所以这里补一道同样的过滤并顺手清账。
    let needle = '';
    try { needle = new URL(origin).hostname; } catch { needle = ''; }
    if (!needle || SKIP_HOST.some((re) => re.test(needle))) { delete state.candidates[origin]; continue; }
    if (!candidates.has(origin) && !live.has(origin)) candidates.set(origin, c.source || '候选台账');
  }
  for (const seed of cfg.seeds || []) {
    const o = normalizeCandidate(seed.url);
    if (o && !candidates.has(o)) candidates.set(o, '观察名单' + (seed.note ? ` · ${seed.note}` : ''));
  }
  report.discovered = candidates.size;

  let probed = 0;
  for (const [origin, source] of candidates) {
    if (probed++ >= cfg.maxCandidates || Date.now() - now > (cfg.budgetMs || 90e3)) { report.truncated = true; break; }
    let hostKey = ''; try { hostKey = new URL(origin).host; } catch { /* ignore */ }
    if (alreadyListed(origin)) { state.seen[origin] = { ...(state.seen[origin] || {}), lastSeenLive: now, at: now }; continue; }
    const C = state.candidates = state.candidates || {};
    if (!C[origin]) C[origin] = { firstSeen: now, source, probes: 0 };
    // 30 分钟一轮时，把已经死掉两周的地址每轮重探纯属烧 runner 时间：
    // 出现超过一天的老候选降到 candidateRetryMin 的频率；一天内的新地址照旧每轮探。
    const aged = now - (C[origin].firstSeen || now) >= (cfg.candidateEagerHours || 6) * 3600e3;
    const retryMs = (cfg.candidateRetryMin || 0) * 60000;
    if (aged && retryMs && C[origin].lastProbe && now - C[origin].lastProbe < retryMs) {
      report.throttled = (report.throttled || 0) + 1;
      continue;
    }
    let verdict = null, resolved = null;
    try { resolved = await resolveServer(fetchImpl, origin, cfg.fetchTimeoutMs, cfg.probePaths, cfg.clientMounts); }
    catch (e) { resolved = null; }
    verdict = resolved ? { ok: true, probe: resolved.probePath, variant: 'resolved' } : { ok: false, error: '无合法健康检查' };
    C[origin].lastProbe = now; C[origin].probes++;
    const prev = state.seen[origin] || {};
    if (!verdict.ok) {
      state.seen[origin] = { ...prev, at: now, fail: verdict.error, source };
      C[origin].lastError = verdict.error;
      report.rejected.push({ origin, source, error: verdict.error });
      continue;
    }
    C[origin].lastOk = now; delete C[origin].lastError;
    state.seen[origin] = { ...prev, at: now, ok: true, variant: verdict.variant, humans: verdict.humans, rooms: verdict.rooms, source };
    report.verified++;
    if (state.submitted[origin] && now - state.submitted[origin].at < 7 * 864e5) { report.skippedQueued = (report.skippedQueued || 0) + 1; continue; }
    if (report.submitted.length >= cfg.maxSubmitsPerRun) { report.deferred = (report.deferred || 0) + 1; continue; }
    const id = cleanId(new URL(origin).hostname.split('.')[0]) || `srv-${Object.keys(state.seen).length}`;
    const entryUrl = resolved.clientUrl || origin;
    if (alreadyListed(entryUrl)) { report.alreadyListed = (report.alreadyListed || 0) + 1; continue; }
    const entry = { id, name: `${new URL(origin).hostname}（待核）`, url: entryUrl, probe: resolved.probePath,
                    enabled: true, note: cleanNote(`自动发现 · ${source}`) };
    if (options.dryRun) { report.submitted.push({ ...entry, dryRun: true, verdict }); continue; }
    if (options.deliver) {
      let r; try { r = await options.deliver(entry, verdict); } catch (e) { r = { ok: false, error: String(e && e.message || e).slice(0, 90) }; }
      if (r && r.ok) { state.submitted[origin] = { at: now, mode: r.mode, detail: r.detail }; report.submitted.push({ ...entry, mode: r.mode }); log(`delivered(${r.mode}) ${origin}`); }
      else { state.seen[origin].deliverError = String(r && r.error || 'failed').slice(0, 70); report.errors.push(`${origin} 投递失败: ${r && r.error}`); }
      continue;
    }
    const res = await fetchImpl(cfg.submitUrl, {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ servers: [entry] }), signal: AbortSignal.timeout(cfg.fetchTimeoutMs),
    }).catch(() => null);
    const body = res ? await res.json().catch(() => ({})) : { ok: false, error: 'fetch failed' };
    if (body.ok) { state.submitted[origin] = { at: now, queueId: body.id }; report.submitted.push({ ...entry, queueId: body.id }); log(`submitted ${origin}`); }
    else if (/已在/.test(String(body.error || ''))) { state.submitted[origin] = { at: now, dup: true }; log(`dup ${origin}`); }
    else { state.seen[origin].submitError = String(body.error || '').slice(0, 60); report.errors.push(`${origin}: ${body.error}`); }
  }

  await watchServers(src, report);
  for (const k of Object.keys(state.seen)) if (now - (state.seen[k].at || 0) > 30 * 864e5) delete state.seen[k];
  for (const k of Object.keys(state.submitted)) if (now - (state.submitted[k].at || 0) > 30 * 864e5) delete state.submitted[k];
  /* 候选台账留 90 天：现在没开服的地址，以后可能就成了服 */
  for (const k of Object.keys(state.candidates || {})) {
    if (state.candidates[k].lastOk) { delete state.candidates[k]; continue; }
    if (now - (state.candidates[k].lastProbe || state.candidates[k].firstSeen) > 90 * 864e5) delete state.candidates[k];
    else if (!state.seen[k]) state.seen[k] = { at: now, fail: state.candidates[k].lastError, candidate: true };
  }
  report.candidates = Object.keys(state.candidates || {}).length;
  state.lastRun = new Date(now).toISOString();
  report.finishedAt = new Date().toISOString();
  report.stateSize = { seen: Object.keys(state.seen).length, submitted: Object.keys(state.submitted).length };
  return { report, state };
}

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
  videos: [{ aid: '117371003995662', cid: '42396680690', note: '主视频' }],
  repoQueries: ['卫戍协议', 'stronghold protocol arknights'],
  /* 人工观察名单：现在还没过指纹，但已经在跑别的形态（登录门、状态站…）。
     每轮复探，哪天它开出合法的 /healthz 就会被自动收进清单。 */
  seeds: [{ url: 'https://ark-proto.stardust.matce.cn', note: 'B站 10-04 Stardust_减，登录门改版' },
          { url: 'https://sp.nekotc.cn', note: '妮蔻（已在清单，复探用于容量观察）' }],
  searchQueries: ['卫戍协议 网页版', '卫戍协议 联机 服务器'],
  autoSubmit: false,          // 默认只报告；确认维护端修好审核队列后再开
  maxSubmitsPerRun: 5,
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
                   /^bilibili\.com$/i, /^b23\.tv$/i, /^comment\.bilibili\.com$/i, /^api\.bilibili\.com$/i,
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
function normalizeCandidate(raw) {
  const u = isPublicHttpUrl(raw);
  if (!u) return null;
  if (SKIP_HOST.some(re => re.test(u.hostname))) return null;
  const o = originOf(u);
  return o;
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

  const forks = [];
  for (let page = 1; page <= 2; page++) {
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
    if (scanned >= 15) break;
    const stamp = `${f.pushed_at}|${f.default_branch}`;
    if (ctx.state.readme[f.full_name] === stamp) continue;
    const body = await text(`repos/${f.full_name}/readme?ref=${encodeURIComponent(f.default_branch || 'master')}`);
    if (body) { urls(body, `README ${f.full_name}`); ctx.state.readme[f.full_name] = stamp; scanned++; }
  }
  for (const q of ctx.cfg.repoQueries) {
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

async function fromBiliComments(ctx) {
  const found = new Map();
  const cookie = ctx.secrets.biliCookie;
  const headers = { referer: 'https://www.bilibili.com/', ...(cookie ? { cookie } : {}) };
  for (const v of ctx.cfg.videos) {
    for (const sort of [0, 2]) {
      for (let pn = 1; pn <= (cookie ? 4 : 1); pn++) {
        const d = await getJson(ctx.fetch, `https://api.bilibili.com/x/v2/reply?type=1&oid=${v.aid}&sort=${sort}&pn=${pn}&ps=20`, headers);
        const reps = d && d.data && d.data.replies;
        if (!Array.isArray(reps)) break;
        for (const c of reps) {
          const urls = new Set(); linksIn(c?.content?.message, urls);
          for (const u of urls) found.set(u, `评论区 ${(c?.member?.uname || '').slice(0, 12)}`);
        }
        if (!reps.length || (d.data.cursor && d.data.cursor.is_end)) break;
      }
    }
  }
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
  const live = new Set(((liveDoc && liveDoc.servers) || []).map(s => s.url));
  if (!live.size) report.errors.push('线上清单读取失败，本轮不提交以免重复入队');

  const src = { cfg, fetch: fetchImpl, secrets, state };
  const pools = [await fromGithub(src), await fromDanmaku(src), await fromBiliComments(src)];
  if (state.bili !== false) { try { pools.push(await fromBiliSearch(src)); } catch (e) { report.errors.push('B 站搜索渠道失败 ' + String(e).slice(0, 40)); } }
  const candidates = new Map();
  for (const pool of pools) for (const [raw, source] of pool) {
    const origin = normalizeCandidate(raw);
    if (origin && !candidates.has(origin)) candidates.set(origin, source);
  }
  /* 之前收下的候选 + 人工观察名单，每轮复探一次（本轮新发现的优先） */
  for (const [origin, c] of Object.entries(state.candidates || {})) {
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
    if (live.has(origin)) { state.seen[origin] = { ...(state.seen[origin] || {}), lastSeenLive: now, at: now }; continue; }
    const C = state.candidates = state.candidates || {};
    if (!C[origin]) C[origin] = { firstSeen: now, source, probes: 0 };
    let verdict; try { verdict = await probeHealth(fetchImpl, origin, cfg.fetchTimeoutMs, cfg.probePaths); }
    catch (e) { verdict = { ok: false, error: 'probe 异常 ' + String(e && e.name || e).slice(0, 30) }; }
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
    const entry = { id, name: `${new URL(origin).hostname}（待核）`, url: origin, probe: verdict.probe || '/healthz',
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

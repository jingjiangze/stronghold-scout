/* ==========================================================================================
   worker.mjs — Cloudflare Worker 入口：cron 每 30 分钟自动发现服务器并投递到待审队列。

   Secrets（wrangler secret put）
     GITHUB_TOKEN   可选，提高 GitHub API 额度（匿名也能跑，只是容易 403 限流）
     BILI_COOKIE    可选，形如 "SESSDATA=...; bili_jct=..."，给了才能翻评论区全量
     SCOUT_TOKEN    必填，手工触发 /run 用的口令
   R2 绑定 SCOUT → bucket stronghold-assets，只写 scout/ 前缀（site/servers.json 由维护者签名发布，本脚本不碰）
   ========================================================================================== */
import { runScout, DEFAULTS, biliProbe } from './scout.mjs';
import { createPublisher } from './publisher.mjs';

const STATE_KEY = 'scout/state.json';
const REPORT_KEY = 'scout/last-report.json';

async function loadState(env) {
  try { return JSON.parse(await (await env.SCOUT.get(STATE_KEY)).text()); } catch { return { seen: {}, submitted: {} }; }
}

async function persist(env, state, report) {
  await env.SCOUT.put(STATE_KEY, JSON.stringify(state), { httpMetadata: { contentType: 'application/json' } });
  await env.SCOUT.put(REPORT_KEY, JSON.stringify(report), { httpMetadata: { contentType: 'application/json', cacheControl: 'public, max-age=60' } });
}

/** AUTO_PUBLISH=1 且 Worker 里配了 SP_SIGN_KEY + PUBLISH_KEY 时，发现即上线（含重签发布）。 */
function publisherFor(env) {
  if (String(env.AUTO_PUBLISH || '') !== '1') return undefined;
  if (!env.SP_SIGN_KEY || !env.PUBLISH_KEY) { console.warn('AUTO_PUBLISH=1 但缺 SP_SIGN_KEY/PUBLISH_KEY，退回只入队'); return undefined; }
  return createPublisher({ keys: { signKey: env.SP_SIGN_KEY, pubKey: env.SP_PUB_KEY }, adminKey: env.PUBLISH_KEY, log: (...a) => console.log(...a) }).deliver;
}

async function scan(env, dryRun) {
  const state = await loadState(env);
  let out;
  try {
    out = await runScout({ state, dryRun, deliver: dryRun ? undefined : publisherFor(env), config: { autoSubmit: String(env.AUTO_SUBMIT || '') === '1' || String(env.AUTO_PUBLISH || '') === '1' },
      secrets: { githubToken: env.GITHUB_TOKEN, biliCookie: env.BILI_COOKIE },
      log: (...a) => console.log(...a) });
  } catch (e) {
    // 失败也要落盘：否则 cron 静默炸掉，外部完全看不出来
    out = { report: { startedAt: state.lastRun || null, fatal: String(e && e.stack || e).slice(0, 500), submitted: [], rejected: [], errors: ['fatal'] }, state };
  }
  const { report } = out;
  report.configured = {
    githubToken: !!env.GITHUB_TOKEN, biliCookie: !!env.BILI_COOKIE, videos: DEFAULTS.videos.length,
    autoPublish: String(env.AUTO_PUBLISH || '') === '1' && !!(env.SP_SIGN_KEY && env.PUBLISH_KEY),
  };
  await persist(env, out.state, report);
  return report;
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(scan(env, false).then(r => console.log('cron ok', r.startedAt, r.discovered)).catch(e => console.error('scout failed', e)));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    const key = url.searchParams.get('key') || request.headers.get('x-scout-key') || '';
    if (!env.SCOUT_TOKEN || key !== env.SCOUT_TOKEN) return new Response('forbidden', { status: 403 });
    if (url.pathname === '/selftest') {
      // 只验不动：拿现网清单跑一次交叉验签 + 算 sha，确认 Worker 侧规范化与 dl-site 一致
      try {
        const p = createPublisher({ keys: { signKey: env.SP_SIGN_KEY, pubKey: env.SP_PUB_KEY }, adminKey: env.PUBLISH_KEY || 'none', fetch: (u, i) => fetch(u, { ...i, signal: (i && i.signal) || AbortSignal.timeout(15000) }) });
        const doc = await (await fetch(`https://weishucdn.jiangjiangze.icu/site/servers.json?cb=${Date.now()}`)).json();
        return new Response(JSON.stringify({ autoPublish: String(env.AUTO_PUBLISH || '') === '1', hasSignKey: !!env.SP_SIGN_KEY, hasPublishKey: !!env.PUBLISH_KEY,
          hasGithubTickToken: !!env.GH_TICK_TOKEN,
          liveCount: doc.servers?.length, liveUpdated: doc.updated, crossVerify: p.verifyDoc(doc), canonicalSha: p.canonicalSha(doc) }, null, 2),
          { headers: { 'content-type': 'application/json' } });
      } catch (e) { return new Response(JSON.stringify({ error: String(e && e.stack || e) }), { status: 500, headers: { 'content-type': 'application/json' } }); }
    }
    if (url.pathname === '/probe') {
      // 渠道探针：从 CF 出口实测 B 站各评论入口（结果同时落 R2，本机 workers.dev 被中间盒掐时用域名读）
      try {
        const probe = await biliProbe((u, i) => fetch(u, { ...(i || {}), signal: AbortSignal.timeout(15000) }), env.BILI_COOKIE || '');
        await env.SCOUT.put('scout/probe.json', JSON.stringify(probe, null, 1), { httpMetadata: { contentType: 'application/json', cacheControl: 'public, max-age=30' } });
        return new Response(JSON.stringify(probe, null, 2), { headers: { 'content-type': 'application/json' } });
      } catch (e) { return new Response(JSON.stringify({ error: String((e && e.stack) || e) }), { status: 500, headers: { 'content-type': 'application/json' } }); }
    }
    if (url.pathname === '/tick') {
      // 备用打点入口：盒子或本机只要 curl 这个 URL + 触发口令就能拉一轮 Actions 采集。
      // 现在**故意没配 GH_TICK_TOKEN**（会明确回 503）—— 持续节拍已由独立闹钟仓
      // jingjiangze/stronghold-tick 承担（口令以 GitHub secret 形式密封在那里，不落 CF 也不落盒子）。
      // 这条路径留着当"闹钟仓哪天也哑了"的手动后手。
      const J = (o, s = 200) => new Response(JSON.stringify(o, null, 2), { status: s, headers: { 'content-type': 'application/json' } });
      if (!env.GH_TICK_TOKEN) return J({ ok: false, error: '未配置 GH_TICK_TOKEN（一把只对 jingjiangze/stronghold-scout 有 Actions: write 的 fine-grained PAT）' }, 503);
      const allowed = ['crawl', 'run', 'probe', 'bili'];
      const target = allowed.includes(url.searchParams.get('target')) ? url.searchParams.get('target') : 'crawl';
      const num = (v) => String(v || '').replace(/\D/g, '').slice(0, 3);
      const inputs = { target, dry: url.searchParams.get('dry') === '1',
        pages: num(url.searchParams.get('pages')), forks: num(url.searchParams.get('forks')), tick_min: '' };
      const res = await fetch('https://api.github.com/repos/jingjiangze/stronghold-scout/actions/workflows/scout-schedule.yml/dispatches', {
        method: 'POST', signal: AbortSignal.timeout(20000),
        headers: { authorization: 'Bearer ' + env.GH_TICK_TOKEN, accept: 'application/vnd.github+json',
          'user-agent': 'stronghold-scout-tick', 'content-type': 'application/json' },
        body: JSON.stringify({ ref: 'main', inputs }),
      });
      const rec = { ok: res.status === 204, http: res.status, at: new Date().toISOString(), target,
        note: res.status === 204 ? '' : (await res.text().catch(() => '')).slice(0, 200) };
      // 心跳落 R2：这样"盒子到底有没有在打点"是可查的，不用去翻机上日志
      await env.SCOUT.put('scout/tick.json', JSON.stringify({ ...rec, lastOk: rec.ok ? rec.at : null }, null, 1),
        { httpMetadata: { contentType: 'application/json', cacheControl: 'public, max-age=30' } });
      return J(rec, rec.ok ? 200 : 502);
    }
    if (url.pathname === '/ingest' && request.method === 'POST') {
      // 采集在 GitHub Actions 跑（B 站只拉黑 CF 的 IP 段），签名仍只在这里：
      // Actions 侧一个私钥都不放，口令换来的只是「投递候选」。
      if (!env.SP_SIGN_KEY || !env.PUBLISH_KEY) return new Response(JSON.stringify({ ok: false, error: '缺 SP_SIGN_KEY/PUBLISH_KEY' }), { status: 500, headers: { 'content-type': 'application/json' } });
      const body = await request.json().catch(() => ({}));
      const list = Array.isArray(body.servers) ? body.servers.slice(0, 10) : [];
      const p = createPublisher({ keys: { signKey: env.SP_SIGN_KEY, pubKey: env.SP_PUB_KEY }, adminKey: env.PUBLISH_KEY, log: (...a) => console.log(...a) });
      const results = [];
      for (const e of list) { try { results.push({ url: e.url, ...(await p.deliver(e)) }); } catch (err) { results.push({ url: e.url, ok: false, error: String((err && err.message) || err).slice(0, 120) }); } }
      return new Response(JSON.stringify({ ok: true, results }, null, 2), { headers: { 'content-type': 'application/json' } });
    }
    if (url.pathname === '/ledger') {
      // 台账托管在这里：Actions 侧不落私有状态，采集器读写 R2 的 scout/state.json 即可。
      if (request.method === 'POST') {
        const body = await request.text();
        if (body.length > 900000) return new Response(JSON.stringify({ ok: false, error: 'state 太大' }), { status: 413, headers: { 'content-type': 'application/json' } });
        try { JSON.parse(body); } catch { return new Response(JSON.stringify({ ok: false, error: 'state 不是合法 JSON' }), { status: 400, headers: { 'content-type': 'application/json' } }); }
        await env.SCOUT.put(STATE_KEY, body, { httpMetadata: { contentType: 'application/json' } });
        return new Response(JSON.stringify({ ok: true, bytes: body.length }), { headers: { 'content-type': 'application/json' } });
      }
      const s = await env.SCOUT.get(STATE_KEY);
      return new Response(s ? s.body : '{}', { headers: { 'content-type': 'application/json' } });
    }
    if (url.pathname === '/state') {
      const body = await env.SCOUT.get(STATE_KEY);
      return new Response(body ? body.body : '{}', { headers: { 'content-type': 'application/json' } });
    }
    const report = await scan(env, url.searchParams.get('dry') === '1');
    return new Response(JSON.stringify(report, null, 2), { headers: { 'content-type': 'application/json' } });
  },
};

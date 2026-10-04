/* ==========================================================================================
   worker.mjs — Cloudflare Worker 入口：cron 每 30 分钟自动发现服务器并投递到待审队列。

   Secrets（wrangler secret put）
     GITHUB_TOKEN   可选，提高 GitHub API 额度（匿名也能跑，只是容易 403 限流）
     BILI_COOKIE    可选，形如 "SESSDATA=...; bili_jct=..."，给了才能翻评论区全量
     SCOUT_TOKEN    必填，手工触发 /run 用的口令
   R2 绑定 SCOUT → bucket stronghold-assets，只写 scout/ 前缀（site/servers.json 由维护者签名发布，本脚本不碰）
   ========================================================================================== */
import { runScout, DEFAULTS } from './scout.mjs';
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
          liveCount: doc.servers?.length, liveUpdated: doc.updated, crossVerify: p.verifyDoc(doc), canonicalSha: p.canonicalSha(doc) }, null, 2),
          { headers: { 'content-type': 'application/json' } });
      } catch (e) { return new Response(JSON.stringify({ error: String(e && e.stack || e) }), { status: 500, headers: { 'content-type': 'application/json' } }); }
    }
    if (url.pathname === '/state') {
      const body = await env.SCOUT.get(STATE_KEY);
      return new Response(body ? body.body : '{}', { headers: { 'content-type': 'application/json' } });
    }
    const report = await scan(env, url.searchParams.get('dry') === '1');
    return new Response(JSON.stringify(report, null, 2), { headers: { 'content-type': 'application/json' } });
  },
};

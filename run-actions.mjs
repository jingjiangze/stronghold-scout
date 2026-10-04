#!/usr/bin/env node
/* ==========================================================================================
   run-actions.mjs — GitHub Actions 版入口（采集在 Actions 跑，签名留在 Worker）

   为什么分工在这：B 站按 IP 段拉黑 —— Cloudflare 出口对评论接口一律 412（`/probe` 实测），
   而 Actions 出口 200 / code 0。签名私钥则一个都不放到 GitHub：投递候选走 Worker 的
   `/ingest`，那边只做 submit → approve → 补签 → PUT。台账托管在 Worker 的 R2（`/ledger`）。

   需要的环境变量：
     SCOUT_WORKER   Worker 根地址，默认 https://stronghold-scout.yuehuibu5561.workers.dev
     SCOUT_TOKEN    口令（同时用于 /ingest 与 /ledger）
     BILI_COOKIE    评论区翻页用的登录票据；没有就退化成「未登录只看 3 条主楼」
     DRY=1          只发现不投递
   ========================================================================================== */
import fs from 'node:fs';
import { runScout, biliHeaders, watchServers, DEFAULTS } from './scout.mjs';

const WORKER = (process.env.SCOUT_WORKER || 'https://stronghold-scout.yuehuibu5561.workers.dev').replace(/\/+$/, '');
const KEY = process.env.SCOUT_TOKEN || '';
const DRY = process.env.DRY === '1';
if (!KEY) { console.error('缺 SCOUT_TOKEN'); process.exit(2); }

const hdr = { 'x-scout-key': KEY, 'content-type': 'application/json', accept: 'application/json' };
const timed = (init) => ({ ...init, signal: (init && init.signal) || AbortSignal.timeout(90000) });

async function loadLedger() {
  try {
    const res = await fetch(`${WORKER}/ledger`, { headers: hdr, signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const s = await res.json();
    if (!s || typeof s !== 'object') throw new Error('空');
    return { seen: {}, submitted: {}, candidates: {}, ...s };
  } catch (e) { console.log('[actions] 台账读不到，按空台账起跑：', String(e.message).slice(0, 60)); return { seen: {}, submitted: {}, candidates: {} }; }
}

async function saveLedger(state) {
  const body = JSON.stringify(state);
  const res = await fetch(`${WORKER}/ledger`, { ...timed({ method: 'POST', headers: hdr, body }) }).catch(() => null);
  const j = res ? await res.json().catch(() => ({})) : {};
  console.log(`[actions] 台账回写 ${res && res.status} ${body.length}B ${j.ok ? '' : JSON.stringify(j).slice(0, 80)}`);
}

/** 投给 runScout 的 deliver：把单条候选交给 Worker 的 /ingest（那边完成 approve + 补签 + PUT）。 */
function ingestDeliver() {
  return async function deliver(entry) {
    const res = await fetch(`${WORKER}/ingest`, { ...timed({ method: 'POST', headers: hdr, body: JSON.stringify({ servers: [entry] }) }) }).catch((e) => null);
    if (!res) return { ok: false, error: 'ingest fetch failed' };
    const j = await res.json().catch(() => ({}));
    const r = (j.results || [])[0];
    if (!r) return { ok: false, error: `ingest ${res.status} ${JSON.stringify(j).slice(0, 90)}` };
    return r;
  };
}

const baseFetch = (u, i) => fetch(u, i);
const state = await loadLedger();

/* 守门：30 分钟一轮里绝大多数轮次其实什么都没变，但一次 GitHub Actions 作业要 3.5 分钟
   （开机 + checkout + 扫描），48 轮/天 ≈ 5000 分钟/月，私密仓免费只有 2000，月中就会被
   静默停掉。所以先用 1 个请求问评论总数有没有动，再看法克/复探窗口到没到期；
   都没动静就直接收工（一轮 ~40 秒），只在真有可能新东西时才做完整采集。
   FORCE_CRAWL=1 可绕过。 */
/* 私密仓免费只有 2000 分钟/月，超了 GitHub 是「静默停掉 schedule」——正是今天查了一天的
   那类失效。所以自己记账：预算用满就只留最便宜的空转，绝不冒停摆的险。 */
const BUDGET_MIN = Number(process.env.ACTIONS_MINUTE_BUDGET || 1400);
const monthKey = (d = new Date()) => d.toISOString().slice(0, 7);

async function deltaDue(state) {
  const now = Date.now();
  state.meter = state.meter && state.meter.month === monthKey() ? state.meter : { month: monthKey(), minutes: 0 };
  if (state.meter.minutes >= BUDGET_MIN) return { due: false, why: `本月 Actions 分钟预算已用完（${state.meter.minutes.toFixed(0)}/${BUDGET_MIN}）` };
  const aid = (process.env.BILI_OID || '117371003995662');
  let count = null;
  try {
    const r = await fetch(`https://api.bilibili.com/x/v2/reply/count?type=1&oid=${aid}`, {
      headers: { ...biliHeaders(process.env.BILI_COOKIE || '', true), cookie: process.env.BILI_COOKIE || '' },
      signal: AbortSignal.timeout(12000),
    });
    const j = await r.json();
    count = j && j.data && (j.data.count ?? j.data.total);
  } catch (e) { console.log('[actions] 评论数取不到，按有声静处理：', String(e.message).slice(0, 40)); }
  const prev = Number(state.biliCount) || 0;
  if (count != null) state.biliCount = Number(count);   // 无论跑不跑都记水位
  if (process.env.FORCE_CRAWL === '1') return { due: true, why: `FORCE_CRAWL（评论数 ${prev} → ${count ?? '?'} 已记入台账）` };
  if (count == null) return { due: true, why: '评论数不可用' };
  if (!prev || Number(count) !== prev) return { due: true, why: `评论数 ${prev} → ${count}` };
  const ghGap = (process.env.GITHUB_INTERVAL_MIN || 180) * 60000;
  if (!state.githubAt || now - state.githubAt >= ghGap) return { due: true, why: 'fork 扫描到期' };
  const retry = (process.env.CANDIDATE_RETRY_MIN || 120) * 60000;
  const C = state.candidates || {};
  const dueC = Object.values(C).filter((c) => (now - (c.firstSeen || now) < (Number(process.env.CANDIDATE_EAGER_HOURS) || 6) * 3600e3) || !c.lastProbe || now - c.lastProbe >= retry).length;
  if (dueC > 0) return { due: true, why: `${dueC} 个候选到复探时间` };
  return { due: false, why: `评论数未变（${count}）且各窗口未到` };
}

const gate = await deltaDue(state);
console.log(`[actions] 守门：${gate.due ? '真跑' : '跳过'} —— ${gate.why}`);
fs.writeFileSync('scout-gate.json', JSON.stringify(gate, null, 1));

const t0 = Date.now();
let report;
if (gate.due) {
  report = (await runScout({
  state, dryRun: DRY,
  config: {
    autoSubmit: true,
    commentPages: Number(process.env.COMMENT_PAGES || 12),
    forkPages: Number(process.env.FORK_PAGES || 2),
    readmeScanMax: Number(process.env.README_SCAN_MAX || 15),
    // 跨洋 + 撞上 WAF 时 6 秒不够：超时太紧会让评论渠道静默退化成「未登录 3 条」，
    // 台账里连时间水位都留不下。宁可单轮慢一点。
    fetchTimeoutMs: Number(process.env.FETCH_TIMEOUT_MS || 12000),
  },
  deliver: DRY ? undefined : ingestDeliver(),
  secrets: { biliCookie: process.env.BILI_COOKIE || '', githubToken: process.env.GITHUB_TOKEN || '' },
  log: (...a) => console.log('[actions]', ...a),
})).report;
} else {
  report = { skipped: true, reason: gate.why, discovered: 0, verified: 0, submitted: [], rejected: [], errors: [] };
  // 跳过的是重活，不是监听：历史留空洞就看不出「掉了几小时」，所以照样打个点。
  try {
    await watchServers({ cfg: DEFAULTS, state, fetch: (u, i) => baseFetch(u, { ...(i || {}), signal: AbortSignal.timeout(12000) }) }, report);
  } catch (e) { console.log('[actions] 监听采样失败：', String(e.message).slice(0, 50)); }
}
report.durationMs = Date.now() - t0;
report.dryRun = DRY;
report.deliverMode = 'worker /ingest';
// 计一次账：脚本墙钟 + 开机/checkout 的固定开销（约 40 秒）
report.meteredMinutes = Math.round(((report.durationMs || 0) / 60000 + 0.7) * 100) / 100;
state.meter.minutes = Math.round((state.meter.minutes + report.meteredMinutes) * 100) / 100;
state.meter.month = monthKey();
console.log(`[actions] 本月已计 ${state.meter.minutes} / ${BUDGET_MIN} 分钟`);
await saveLedger(state);
fs.writeFileSync('scout-report.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));

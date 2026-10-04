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
import { runScout } from './scout.mjs';

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

const state = await loadLedger();
const t0 = Date.now();
const { report } = await runScout({
  state, dryRun: DRY,
  config: { autoSubmit: true, commentPages: Number(process.env.COMMENT_PAGES || 12) },
  deliver: DRY ? undefined : ingestDeliver(),
  secrets: { biliCookie: process.env.BILI_COOKIE || '', githubToken: process.env.GITHUB_TOKEN || '' },
  log: (...a) => console.log('[actions]', ...a),
});
report.durationMs = Date.now() - t0;
report.dryRun = DRY;
report.deliverMode = 'worker /ingest';
await saveLedger(state);
fs.writeFileSync('scout-report.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));

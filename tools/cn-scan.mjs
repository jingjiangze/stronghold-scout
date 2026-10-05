/* 本机（国内出口）复探 scout 候选池：海外判「无合法健康检查」的地址，很多其实是
   裸 IP 上架的国内云 —— 183.66.27.19 就是这么捞回来的。只读，不投递。
   node tools/cn-scan.mjs            探候选池
   node tools/cn-scan.mjs --live     顺便复探清单里已经判死的条目 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const LEDGER = 'https://weishucdn.jiangjiangze.icu/scout/state.json';
const LIST = 'https://weishucdn.jiangjiangze.icu/site/servers.json';
const VERIFIED = 'https://weishucdn.jiangjiangze.icu/site/verified.json';
const PROBE_PATHS = ['/healthz', '/api/status', '/health'];
const TIMEOUT_MS = 9000;

const get = async (u) => {
  const r = await fetch(u + (u.includes('?') ? '&' : '?') + 'cb=' + Date.now() + Math.random().toString(36).slice(2),
    { signal: AbortSignal.timeout(30000), headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error(u + ' → HTTP ' + r.status);
  return r.json();
};

const hostAlive = async (origin, probePath) => {
  const url = origin + probePath;
  const t0 = Date.now();
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: 'application/json' } });
    const ct = r.headers.get('content-type') || '';
    if (!r.ok) return { url, http: r.status, note: 'HTTP ' + r.status, ms: Date.now() - t0 };
    if (!ct.includes('json')) return { url, http: r.status, note: '非 JSON(' + (ct.split(';')[0] || '?') + ')', ms: Date.now() - t0 };
    const j = await r.json();
    return { url, http: r.status, ms: Date.now() - t0, proto: j.version ?? null, app: j.app || null,
      build: j.build ? String(j.build).slice(0, 14) : null, rooms: j.rooms ?? null, humans: j.humans ?? null,
      runtime: j.runtime || null, okField: j.ok === true, uptimeSec: j.uptimeSec ?? null };
  } catch (e) { return { url, note: String((e && (e.name || e.message)) || e).slice(0, 30), ms: Date.now() - t0 }; }
};

// 一个地址要试的候选：origin 根 + 原路径 + 常见客户端挂载点
const variants = (raw) => {
  let u;
  try { u = new URL(raw.startsWith('http') ? raw : 'http://' + raw); } catch { return []; }
  const out = new Set([u.origin + '/healthz', u.origin + '/api/status']);
  const p = u.pathname.replace(/\/+$/, '');
  if (p && p !== '/') { out.add(u.origin + p + '/healthz'); }
  return [...out];
};

const state = await get(LEDGER);
const list = await get(LIST);
console.log('台账 lastRun ' + state.lastRun + ' | 候选 ' + Object.keys(state.candidates || {}).length
  + ' | 清单 ' + list.servers.length + ' 条 | 本机判活阈值：PROTOCOL_VERSION=1');

const listed = new Set(list.servers.map((s) => { try { return new URL(s.url).host; } catch { return s.url; } }));

const rows = [];
const cands = Object.entries(state.candidates || {});
for (const [url, meta] of cands) {
  let host = '';
  try { host = new URL(url).host; } catch { /* 留着 */ }
  const onList = listed.has(host);
  const t0 = Date.now();
  let hit = null;
  for (const v of variants(url)) {
    const r = await hostAlive(v.replace(/\/(healthz|api\/status|health)$/, ''), '/' + v.match(/\/(healthz|api\/status|health)$/)[1]);
    if (r.proto === 1 || r.okField === true) { hit = r; break; }
    if (!hit && r.http) hit = r; // 留个最接近的记录
  }
  rows.push({ url, onList, src: (meta.source || '').slice(0, 26), lastErr: (meta.lastError || '').slice(0, 24),
    alive: !!(hit && (hit.proto === 1 || hit.okField === true)), hit, ms: Date.now() - t0 });
}

const alive = rows.filter((r) => r.alive);
console.log('\n候选池里国内出口能打通、且协议版本=1 的：' + alive.length + ' 台');
for (const r of alive) {
  console.log('  ★ ' + r.url + (r.onList ? ' [已在清单]' : ' [不在清单]') + ' 源=' + r.src);
  console.log('     ' + r.hit.url + ' proto=' + r.hit.proto + ' app=' + (r.hit.app || '-') + ' build=' + (r.hit.build || '-')
    + ' rooms=' + (r.hit.rooms ?? '-') + ' humans=' + (r.hit.humans ?? '-') + ' uptime=' + (r.hit.uptimeSec ?? '-') + 's');
}
console.log('\n其余候选（海外+国内都探不到健康端点）：');
for (const r of rows.filter((x) => !x.alive)) {
  console.log('  · ' + r.url + ' [' + r.lastErr + '] 源=' + r.src + ' 最近返回=' + (r.hit ? (r.hit.note || ('HTTP ' + r.hit.http)) : '无响应'));
}

if (process.argv.includes('--live')) {
  const ver = await get(VERIFIED);
  const dead = (ver.invalid || []).map((x) => x.id);
  console.log('\n清单里当前判死的 ' + dead.length + ' 台，用国内出口复探：');
  for (const id of dead) {
    const s = list.servers.find((x) => x.id === id);
    if (!s) continue;
    let origin = '';
    try { origin = new URL(s.url).origin; } catch { continue; }
    for (const p of PROBE_PATHS) {
      const r = await hostAlive(origin, p);
      if (r.proto === 1 || r.okField === true) {
        console.log('  ★ ' + id + ' ' + s.name + ' 现在可达：' + r.url + ' proto=' + r.proto + ' app=' + (r.app || '-')
          + ' rooms=' + (r.rooms ?? '-') + ' humans=' + (r.humans ?? '-') + ' ' + r.ms + 'ms（站点判死原因见 verified.json）');
        break;
      }
      if (p === PROBE_PATHS[PROBE_PATHS.length - 1]) {
        console.log('  · ' + id + ' ' + s.name + ' 国内也不通：' + (r.note || ('HTTP ' + r.http)) + ' ' + r.ms + 'ms');
      }
    }
  }
}

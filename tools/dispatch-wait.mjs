/* 等 B 站 cookie 翻页节流解除后打一轮加深翻页的云端采集，跑完回报台账与队列。
   node tools/dispatch-wait.mjs            正常等+投
   node tools/dispatch-wait.mjs --now      不等节流，立刻投（本轮评论渠道会自己跳过） */
import fs from 'node:fs';

const TOKEN = fs.readFileSync(process.env.USERPROFILE + '/.gh_fine_token', 'utf8').trim();
const REPO = 'jingjiangze/stronghold-scout';
const WF = 'scout-schedule.yml';
const H = { authorization: 'Bearer ' + TOKEN, accept: 'application/vnd.github+json', 'user-agent': 'scout-ops', 'content-type': 'application/json' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = async (u) => (await fetch(u, { headers: H, signal: AbortSignal.timeout(40000) })).json();
const led = async () => (await (await fetch('https://weishucdn.jiangjiangze.icu/scout/state.json?cb=' + Date.now(),
  { signal: AbortSignal.timeout(30000) })).json());

const st = await led();
const due = Number(st.biliCookieAt || 0) + 180 * 60000;
const wait = process.argv.includes('--now') ? 0 : Math.max(0, due - Date.now());
console.log(`上次 cookie 翻页 ${st.biliCookieAt ? new Date(Number(st.biliCookieAt)).toISOString() : '-'}，`
  + `节流解除于 ${new Date(due).toISOString()}，等待 ${Math.round(wait / 1000)}s`);
await sleep(wait);

const t0 = new Date().toISOString();
const res = await fetch(`https://api.github.com/repos/${REPO}/actions/workflows/${WF}/dispatches`, {
  method: 'POST', headers: H,
  body: JSON.stringify({ ref: 'main', inputs: { target: 'crawl', dry: false, pages: '18', forks: '20' } }),
});
console.log(`dispatch http=${res.status} at ${t0}`);
if (res.status !== 204) { console.log((await res.text()).slice(0, 300)); process.exit(1); }

const stamp = t0.slice(0, 19); // GitHub created_at 形如 2026-10-05T03:51:30Z，字典序可比较
for (let i = 0; i < 24; i++) {
  await sleep(60000);
  const runs = await get(`https://api.github.com/repos/${REPO}/actions/runs?event=workflow_dispatch&per_page=3`);
  const run = (runs.workflow_runs || []).filter((x) => x.created_at >= stamp)[0];
  if (!run) { console.log('  还没看到本轮 run'); continue; }
  console.log(`  run ${run.id} ${run.status}/${run.conclusion || '-'}`);
  if (run.status === 'completed') {
    console.log(`结论 ${run.conclusion} | 用时 ${(new Date(run.updated_at) - new Date(run.created_at)) / 1000}s`);
    break;
  }
}

const d = await led();
console.log('lastRun:', d.lastRun, '| biliCount:', d.biliCount, '| 月度分钟:', JSON.stringify(d.meter));
console.log('biliSkip:', JSON.stringify(d.biliSkip || null), '| banUntil:', d.biliBanUntil ? new Date(Number(d.biliBanUntil)).toISOString() : '-');
console.log('submitted:', JSON.stringify(d.submitted || {}));
const fresh = Object.entries(d.candidates || {}).filter(([, v]) => Number(v.lastProbe) > Date.parse(t0));
console.log('本轮探过的候选:', fresh.length);
fresh.forEach(([k, v]) => console.log('  -', k, '|', String(v.lastError || '').slice(0, 34), '| src', String(v.source || '').slice(0, 26)));
const list = await (await fetch('https://weishucdn.jiangjiangze.icu/site/servers.json?cb=' + Date.now())).json();
console.log('现网清单:', list.servers.length, '条 | updated', list.updated, '| 队列:', JSON.stringify((await led()).submitted || {}));

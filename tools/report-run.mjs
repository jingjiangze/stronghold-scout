/* 等一轮 Actions 采集跑完，把它摘要里那几行原样打出来（候选/验活/投递/异常/监听）。
   node tools/report-run.mjs --event schedule            等下一轮定时的
   node tools/report-run.mjs --event schedule --since 2026-10-05T04:10:00Z
   默认只认 created_at 晚于 --since（缺省=启动时刻）的那一轮，避免读到上一轮的旧结果。 */
import fs from 'node:fs';

const TOKEN = fs.readFileSync(process.env.USERPROFILE + '/.gh_fine_token', 'utf8').trim();
const REPO = 'jingjiangze/stronghold-scout';
const H = { authorization: 'Bearer ' + TOKEN, accept: 'application/vnd.github+json', 'user-agent': 'scout-ops' };
const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : ''; };
const event = arg('event') || 'schedule';
const since = arg('since') || new Date().toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = async (u, raw) => {
  const r = await fetch(u, { headers: H, signal: AbortSignal.timeout(60000) });
  return raw ? r.text() : r.json();
};

const stamp = since.slice(0, 19); // GitHub 的 created_at 形如 2026-10-05T04:13:22Z，比到秒即可
let run = null;
for (let i = 0; i < 30; i++) {
  const list = await get(`https://api.github.com/repos/${REPO}/actions/runs?event=${event}&per_page=5`);
  run = (list.workflow_runs || []).filter((x) => x.created_at >= stamp)[0];
  if (run) break;
  console.log(`  还没看到 ${event} 触发的、晚于 ${stamp} 的新 run，继续等`);
  await sleep(60000);
}
if (!run) { console.log(`超时没等到 ${event} 的新 run`); process.exit(1); }

for (let i = 0; i < 15; i++) {
  if (run.status === 'completed') break;
  await sleep(30000);
  run = await get(`https://api.github.com/repos/${REPO}/actions/runs/${run.id}`);
  console.log(`  run ${run.id} ${run.status}/${run.conclusion || '-'}`);
}
console.log(`run ${run.id} | ${run.event} | ${run.created_at} → ${run.updated_at} | ${run.status}/${run.conclusion}`);

const jobs = await get(`https://api.github.com/repos/${REPO}/actions/runs/${run.id}/jobs`);
for (const job of (jobs.jobs || []).filter((j) => j.conclusion === 'success' || j.conclusion === 'failure')) {
  const log = await get(`https://api.github.com/repos/${REPO}/actions/jobs/${job.id}/logs`, true);
  const lines = log.split('\n').map((l) => l.replace(/^[\d-]+T[\d:.]+Z /, ''))
    .filter((l) => /^- |^gate |候选 |监听 |异常|投递|验活|上线/.test(l));
  console.log(`### ${job.name} (job ${job.id} ${job.conclusion})`);
  console.log(lines.slice(0, 14).join('\n') || '  （摘要里没有匹配行）');
}

const st = await (await fetch('https://weishucdn.jiangjiangze.icu/scout/state.json?cb=' + Date.now())).json();
console.log('台账 lastRun:', st.lastRun, '| biliCount:', st.biliCount, '| submitted:', JSON.stringify(st.submitted || {}).slice(0, 200));
const list = await (await fetch('https://weishucdn.jiangjiangze.icu/site/servers.json?cb=' + Date.now())).json();
console.log('现网清单:', list.servers.length, '条 | updated', list.updated);

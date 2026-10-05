/* 等 stronghold-tick 的下一格真·定时（cron 7 * * * *），报告它有没有命中、以及它把 scout 拉起来没有。
   node tools/watch-tick.mjs                  等到下一格并回报
   用法上适合后台跑：闹钟能不能自带节拍，全看这一格。 */
import fs from 'node:fs';
const TOK = fs.readFileSync(process.env.USERPROFILE + '/.gh_fine_token', 'utf8').trim();
const H = { authorization: 'Bearer ' + TOK, accept: 'application/vnd.github+json', 'user-agent': 'tick-watch' };
const get = async (u) => (await fetch(u, { headers: H, signal: AbortSignal.timeout(40000) })).json();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = process.env.TICK_WAIT_MIN ? Number(process.env.TICK_WAIT_MIN) : 75;   // 要跨过下一个 :07 槽位，12 分钟会过早下结论
const t0 = Date.now();
console.log(`开始等 tick 仓的 schedule 轮（最多 ${until} 分钟），现在 ${new Date().toISOString()}`);
while (Date.now() - t0 < until * 60000) {
  const r = await get('https://api.github.com/repos/jingjiangze/stronghold-tick/actions/runs?event=schedule&per_page=1');
  const run = (r.workflow_runs || [])[0];
  if (run && Date.parse(run.created_at) > t0 - 60000) {
    console.log(`命中：run ${run.id} ${run.created_at} → ${run.updated_at} ${run.status}/${run.conclusion}`);
    const jobs = await get(`https://api.github.com/repos/jingjiangze/stronghold-tick/actions/runs/${run.id}/jobs`);
    const job = jobs.jobs[0];
    if (job) {
      const log = await (await fetch(job.logs_url, { headers: H })).text();
      log.split('\n').map((l) => l.replace(/^[\d-]+T[\d:.]+Z /, '')).filter((l) => /^(OK|FAIL|静默窗|距上一轮|近 24)/.test(l)).forEach((l) => console.log('  >', l));
    }
    const s = await get('https://api.github.com/repos/jingjiangze/stronghold-scout/actions/runs?per_page=3');
    (s.workflow_runs || []).forEach((x) => console.log('   scout:', x.id, x.event, x.created_at, x.status, x.conclusion));
    process.exit(0);
  }
  await sleep(45000);
}
console.log(`超时：等了 ${until} 分钟仍没有 event=schedule 的新 run（这一格没打；注意先确认等待窗口真的跨过了 :07）`);

#!/usr/bin/env node
/* ==========================================================================================
   run-node.mjs — Node 版入口（远程盒子/本机常驻，或按计划任务单次跑）

     node run-node.mjs --dry-run          只发现和校验，不投递
     node run-node.mjs                     正常一轮（投递到 /api/servers/submit 待审队列）
     node run-node.mjs --auto-publish      提交 + approve + 本机补签发布（一条龙上线）
     node run-node.mjs --loop              常驻，每 SCOUT_INTERVAL_MIN 分钟一轮（默认 360 = 每天 4 次，带抖动）

   凭据（都可选，缺失就降级）：
     GITHUB_TOKEN   环境变量，或文件 ~/.gh_fine_token
     BILI_COOKIE    环境变量，或文件 ~/.bili_cookie（一行 "SESSDATA=...; bili_jct=..."）
   状态文件：同目录 scout-state.json
   ========================================================================================== */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runScout } from './scout.mjs';
import { createPublisher } from './publisher.mjs';

/** 只有本机/盒子这种「握着私钥的执行者」才走得到这里；Worker 侧同名逻辑读 env secret。 */
function nodeCreds() {
  const read = (f) => { try { return fs.readFileSync(f, 'utf8').trim(); } catch { return ''; } };
  const signKey = process.env.SP_SIGN_KEY || read(path.join(os.homedir(), '.sp-sign', 'ed25519.key'));
  const pubKey = process.env.SP_PUB_KEY || read(path.join(os.homedir(), '.sp-sign', 'ed25519.pub'));
  let adminKey = process.env.PUBLISH_KEY || read(path.join(os.homedir(), '.sp_publish_key'));
  if (!adminKey) adminKey = read(path.resolve(HERE, '..', 'stronghold-download-audit', 'recon', 'publish_key.txt'));
  return { signKey, pubKey, adminKey };
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATE = path.join(HERE, 'scout-state.json');
const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run') || (!argv.includes('--submit') && !argv.includes('--auto-publish'));
const autoSubmit = argv.includes('--submit');
const autoPublish = argv.includes('--auto-publish');   // 需要本机私钥：只在这台机器/远程盒子上有意义
const loop = argv.includes('--loop');
const verbose = argv.includes('-v') || argv.includes('--verbose');

function readSecret(envName, fileName) {
  if (process.env[envName]) return process.env[envName].trim();
  try { return fs.readFileSync(path.join(os.homedir(), fileName), 'utf8').trim(); } catch { return ''; }
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return { seen: {}, submitted: {} }; }
}

/* 单次运行也要兜住未处理拒绝：一个上游挂掉不该把整轮报告吞掉 */
process.on('unhandledRejection', (e) => console.error('[scout] 未处理拒绝：', e && e.message || e));
process.on('uncaughtException', (e) => console.error('[scout] 未捕获异常：', e && e.message || e));

function nodePublisher() {
  const c = nodeCreds();
  if (!c.signKey || !c.adminKey) throw new Error('--auto-publish 需要 SP_SIGN_KEY（~/.sp-sign/ed25519.key）与发布口令（PUBLISH_KEY 或 recon/publish_key.txt）');
  return createPublisher({ keys: { signKey: c.signKey, pubKey: c.pubKey }, adminKey: c.adminKey, log: (...a) => console.log('[scout]', ...a) }).deliver;
}

async function once() {
  const state = loadState();
  const t0 = Date.now();
  const { report } = await runScout({
    state, dryRun, config: { autoSubmit: autoSubmit || autoPublish },
    deliver: autoPublish && !dryRun ? nodePublisher() : undefined,
    secrets: { githubToken: readSecret('GITHUB_TOKEN', '.gh_fine_token'), biliCookie: readSecret('BILI_COOKIE', '.bili_cookie') },
    log: (...a) => console.log('[scout]', ...a),
  });
  fs.writeFileSync(STATE, JSON.stringify(state, null, 1));
  report.durationMs = Date.now() - t0;
  report.dryRun = dryRun;
  if (autoPublish && !dryRun && report.submitted?.some(x => x.mode === 'published')) {
    const c = nodeCreds();
    report.reSignature = await createPublisher({ keys: { signKey: c.signKey, pubKey: c.pubKey }, adminKey: c.adminKey }).resignAndPublish({ reason: 'sweep-final', force: true }).catch(e => ({ error: e.message }));
  }
  console.log(JSON.stringify(report, null, 2));
  return report;
}

const jitter = () => Math.round((Math.random() * 2 - 1) * 60e3);

if (loop) {
  const every = (Number(process.env.SCOUT_INTERVAL_MIN) || 360) * 60e3;
  process.on('SIGTERM', () => process.exit(0));
  process.on('uncaughtException', e => console.error('[scout] 未捕获异常，继续下一轮', e));
  process.on('unhandledRejection', e => console.error('[scout] 未处理拒绝', e));
  (async () => {
    for (;;) {
      try { await once(); } catch (e) { console.error('[scout] 本轮失败', e); }
      const wait = Math.max(60e3, every + jitter());
      if (verbose) console.log(`[scout] 下一轮 ${(wait / 1000 / 60).toFixed(1)} 分钟后`);
      await new Promise(r => setTimeout(r, wait));
    }
  })();
} else {
  once().then(r => process.exit(r.errors && r.errors.length && verbose ? 1 : 0)).catch(e => { console.error(e); process.exit(1); });
}

/* ==========================================================================================
   publisher.mjs — 「提交 → approve → 补签发布」的纯逻辑（runtime 无关：Worker / Node 共用一份）

   一条地址的旅程：
     POST /api/servers/submit   服务端自己再跑一遍指纹校验，不过就 400 —— 门卫在这里，不在本侧
     POST /api/servers/review   approve：再 fresh 校验一次，把条目并进清单并作废签名（标 unsigned）
     本侧 canonicalPayload + Ed25519 签名 → PUT /api/servers（带 sig 的请求服务端逐字节存）

   安全闸门：resignAndPublish() 动手之前先用公钥验一遍**现网那份由 dl-site 侧签的名**。
   两侧规范化一旦分叉就验不过、直接拒绝发布 —— 宁可停手，也不签出一份客户端会拒收的清单。
   （approve 之后清单必然无签名，所以那条路径显式 force。）
   ========================================================================================== */
import crypto from 'node:crypto';
import { canonicalPayload } from './canonical.mjs';

export const DEFAULTS = {
  liveUrl: 'https://weishucdn.jiangjiangze.icu/site/servers.json',
  putUrl: 'https://dl.jiangjiangze.icu/api/servers',
  submitUrl: 'https://dl.jiangjiangze.icu/api/servers/submit',
  reviewUrl: 'https://dl.jiangjiangze.icu/api/servers/review',
  keyId: 'sp-2026-10',
  timeoutMs: 20000,
};

const PKCS8 = Buffer.from('302e020100300506032b657004220420', 'hex');   // Ed25519 PKCS8 前缀
const SPKI = Buffer.from('302a300506032b6570032100', 'hex');             // Ed25519 SPKI 前缀
const hex32 = (s, what) => {
  const t = String(s || '').trim();
  if (!/^[0-9a-fA-F]{64}$/.test(t)) throw new Error(`${what} 应为 64 位 hex（32 字节裸密钥）`);
  return Buffer.from(t, 'hex');
};
const sha256hex = (s) => crypto.createHash('sha256').update(s).digest('hex');

export function keyPairFrom({ signKey, pubKey } = {}) {
  const priv = crypto.createPrivateKey({ key: Buffer.concat([PKCS8, hex32(signKey, 'SP_SIGN_KEY')]), format: 'der', type: 'pkcs8' });
  const pub = pubKey ? crypto.createPublicKey({ key: Buffer.concat([SPKI, hex32(pubKey, 'SP_PUB_KEY')]), format: 'der', type: 'spki' })
                     : crypto.createPublicKey(priv);
  return { priv, pub };
}

/** 公钥复核一份清单的签名；同时也就是两侧规范化的一致性检查。 */
export function verifyDoc(doc, pub) {
  if (!doc || typeof doc.sig !== 'string' || !doc.sig) return { ok: false, error: '清单没有 sig 字段' };
  const payload = canonicalPayload(doc);
  let ok = false;
  try { ok = crypto.verify(null, Buffer.from(payload, 'utf8'), pub, Buffer.from(doc.sig, 'base64')); } catch { ok = false; }
  return { ok, sha256: sha256hex(payload) };
}

export function createPublisher(options = {}) {
  const cfg = { ...DEFAULTS, ...(options.config || {}) };
  const fetchImpl = options.fetch || fetch;
  const log = options.log || (() => {});
  if (!options.adminKey) throw new Error('createPublisher 需要 adminKey（PUBLISH_KEY）');
  const { priv, pub } = keyPairFrom(options.keys);

  const timed = (init) => ({ ...init, signal: (init && init.signal) || AbortSignal.timeout(cfg.timeoutMs) });
  const json = async (p) => {
    try { const res = await p; const body = await res.json().catch(() => ({})); return { status: res.status, body }; }
    catch (e) { return { status: 0, body: { ok: false, error: e && e.name || String(e) } }; }
  };

  async function getDoc(bust) {
    const { status, body } = await json(fetchImpl(`${cfg.liveUrl}?cb=${bust}${Date.now()}`, timed({ headers: { accept: 'application/json' } })));
    if (!body || !Array.isArray(body.servers)) throw new Error(`读现网清单失败 HTTP ${status}`);
    return body;
  }

  async function putDoc(doc) {
    const { status, body } = await json(fetchImpl(cfg.putUrl, timed({
      method: 'PUT', headers: { 'content-type': 'application/json', accept: 'application/json', 'x-admin-key': options.adminKey },
      body: JSON.stringify(doc, null, 2) + '\n' })));
    if (!body.ok) throw new Error(`发布失败 HTTP ${status} ${JSON.stringify(body)}`);
    return body;
  }

  /** 只盖章不改内容（换 updated + sig）。默认必须先过交叉验签闸门。 */
  async function resignAndPublish({ reason = 'auto', force = false } = {}) {
    const doc = await getDoc(reason);
    const gate = verifyDoc(doc, pub);
    if (!force && !doc.sig) throw new Error('现网清单当前无签名（多半刚被 approve 改过）；确需盖章请显式 force');
    if (!force && doc.sig && !gate.ok) {
      throw new Error(`交叉验签闸门未过：本侧算出的载荷 sha256 ${gate.sha256} 与现网签名不符 —— 两侧规范化分叉或密钥不对，拒绝发布`);
    }
    const next = { ...doc };
    delete next.sig; delete next.unsigned;
    next.updated = new Date().toISOString();
    if (!next.keyId) next.keyId = cfg.keyId;
    if (typeof next.v !== 'number') next.v = 1;
    const payload = canonicalPayload(next);
    next.sig = crypto.sign(null, Buffer.from(payload, 'utf8'), priv).toString('base64');
    if (!verifyDoc(next, pub).ok) throw new Error('自校验失败：签名与载荷不匹配，放弃发布');
    const out = await putDoc(next);
    const gateName = doc.sig ? (gate.ok ? 'valid' : 'mismatch') : 'unsigned';
    log(`resigned ${out.count} 条 sha256 ${sha256hex(payload)}（闸门 ${gateName}${force ? '+force' : ''}）`);
    return { count: out.count, updated: next.updated, sha256: sha256hex(payload), gate: gateName };
  }

  /** 交给 runScout 的 deliver(entry, verdict)。 */
  async function deliver(entry) {
    // 投递一律带管理口令：站点侧把「出示口令的提交者」当成一条独立的验活通道 ——
    // 我们只在别的出口跑过 /healthz 指纹之后才投，CF 边缘 403/超时不再是否决理由，
    // 由服务端自己补 direct_cn（2026-10-05 政策：边缘挡一律不管，可信出口验活即入清单）。
    const sub = await json(fetchImpl(cfg.submitUrl, timed({
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', 'x-admin-key': options.adminKey },
      body: JSON.stringify({ servers: [entry] }),
    })));
    if (!sub.body.ok) return /已在/.test(String(sub.body.error || '')) ? { ok: true, mode: 'already-listed' } : { ok: false, error: `submit(${sub.status}): ${sub.body.error}` };
    const rev = await json(fetchImpl(cfg.reviewUrl, timed({ method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', 'x-admin-key': options.adminKey }, body: JSON.stringify({ id: sub.body.id, action: 'approve' }) })));
    if (!rev.body.ok) return { ok: false, error: `approve(${rev.status}): ${rev.body.error}` };
    try {
      const done = await resignAndPublish({ reason: entry.id, force: true });
      return { ok: true, mode: 'published', detail: { ...done, added: entry.url } };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  return { deliver, resignAndPublish, verifyDoc: (doc) => verifyDoc(doc, pub), canonicalSha: (doc) => sha256hex(canonicalPayload(doc)) };
}

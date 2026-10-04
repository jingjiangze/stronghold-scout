/* ==========================================================================================
   canonical.mjs — 清单规范化：必须与 dl-site 的 functions/api/_verify.js 完全一致

   真正的权威是那边（Pages Function 与 tools/sign-servers.mjs 都用它）。这里之所以复制一份，
   是因为 wrangler 不能跨项目目录 import。跑偏了不会静默：publish.mjs 的 resignAndPublish()
   在改清单前会先验一次**由那边签好的现网签名**，规则一分叉就拒绝发布。
   ========================================================================================== */

const DROP = ['sig', 'unsigned'];

function sortDeep(v) {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortDeep(v[k])]));
  return v;
}

export function canonicalPayload(doc) {
  const copy = { ...(doc || {}) };
  for (const k of DROP) delete copy[k];
  return JSON.stringify(sortDeep(copy));
}

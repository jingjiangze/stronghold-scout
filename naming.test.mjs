// 命名规则测试：锁住「名称不能直接是域名」这条口径（2026-10-20 用户要求）。
// 只测纯函数与 fetch stub，不碰网络、不碰任何线上状态。
import test from 'node:test';
import assert from 'node:assert/strict';
import { titleFromHtml, looksLikeClient, resolveServer } from './scout.mjs';

/* ---- titleFromHtml：页面自称 ---- */

test('titleFromHtml: og:site_name 优先于 <title>', () => {
  const html = `<html><head><meta property="og:site_name" content="临夏服"><title>别的名字</title></head></html>`;
  assert.equal(titleFromHtml(html), '临夏服');
});

test('titleFromHtml: <title> 取主段并剥掉产品名/版本噪声', () => {
  assert.equal(titleFromHtml('<title>妮蔻 · 卫戍协议联机</title>'), '妮蔻');
  assert.equal(titleFromHtml('<title>星空之下服 v1.2.3 - Stronghold Protocol</title>'), '星空之下服 v1.2.3');
  assert.equal(titleFromHtml('<title>Stronghold Protocol Lobby</title>'), '');
});

test('titleFromHtml: 空/无标题安全返回空串', () => {
  assert.equal(titleFromHtml(''), '');
  assert.equal(titleFromHtml('<html><head></head></html>'), '');
  assert.equal(titleFromHtml(undefined), '');
});

test('titleFromHtml: 没写标题的页面不当名字（端到端验证抓到过顶着 "x" 进清单）', () => {
  assert.equal(titleFromHtml('<title>x</title>'), '');
  assert.equal(titleFromHtml('<title>123</title>'), '');
  assert.equal(titleFromHtml('<title>Loading</title>'), '');
  assert.equal(titleFromHtml('<title>首页</title>'), '');
  assert.equal(titleFromHtml('<title>untitled</title>'), '');
});

/* ---- looksLikeClient：契约是 {client, name}（2026-10-20 前是布尔） ---- */

test('looksLikeClient: 返回对象带 client 与 name，不再只是布尔', async () => {
  const html = `<html><head><meta property="og:site_name" content="镜花殇服"></head>
    <body class="x">viewport-fit=cover /vendor/ STRONGHOLD PROTOCOL</body></html>`;
  const fake = async () => ({ ok: true, text: async () => html });
  const r = await looksLikeClient(fake, 'https://example.com/', 1000);
  assert.equal(r.client, true);
  assert.equal(r.name, '镜花殇服');
});

test('looksLikeClient: 不是客户端页时 client=false 且 name 为空', async () => {
  const fake = async () => ({ ok: true, text: async () => '<html><body>nothing here</body></html>' });
  const r = await looksLikeClient(fake, 'https://example.com/', 1000);
  assert.equal(r.client, false);
  assert.equal(r.name, '');
});

test('looksLikeClient: 网络异常不抛，降级成「不是客户端页」', async () => {
  const fake = async () => { throw new Error('ECONNRESET'); };
  const r = await looksLikeClient(fake, 'https://example.com/', 1000);
  assert.equal(r.client, false);
  assert.equal(r.name, '');
});

/* ---- resolveServer：把页面自称透传给调用方 ---- */

test('resolveServer: 探到健康检查 + 客户端页时带回 title', async () => {
  const client = `<html><head><meta property="og:site_name" content="樱空服"></head>
    <body>viewport-fit=cover /vendor/ STRONGHOLD PROTOCOL</body></html>`;
  const jsonHeaders = new Map([['content-type', 'application/json']]);
  const fake = async (url) => {
    const u = String(url);
    if (u.includes('/healthz')) return { ok: true, status: 200, headers: jsonHeaders, text: async () => JSON.stringify({ ok: true, version: 1, uptimeSec: 60, sockets: 3, sessions: 1, rooms: 2, matches: 0, humans: 4, bots: 2 }) };
    return { ok: true, status: 200, text: async () => client };
  };
  const r = await resolveServer(fake, 'https://ark.sakusky.com', 1000, ['/healthz'], ['/']);
  assert.equal(r.probePath, '/healthz');
  assert.equal(r.clientVerified, true);
  assert.equal(r.title, '樱空服');
});

test('resolveServer: 没有健康检查直接返回 null（不进清单）', async () => {
  const fake = async () => ({ ok: false });
  assert.equal(await resolveServer(fake, 'https://dead.example.com', 1000, ['/healthz'], ['/']), null);
});

test('resolveServer: 健康检查过但不是客户端页 → title 为空串', async () => {
  const jsonHeaders = new Map([['content-type', 'application/json']]);
  const fake = async (url) => {
    const u = String(url);
    if (u.includes('/healthz')) return { ok: true, status: 200, headers: jsonHeaders, text: async () => JSON.stringify({ ok: true, version: 1, uptimeSec: 60, sockets: 0, sessions: 0, rooms: 0, matches: 0, humans: 0, bots: 0 }) };
    return { ok: true, status: 200, text: async () => '<html><body>just a status page</body></html>' };
  };
  const r = await resolveServer(fake, 'https://status.example.com', 1000, ['/healthz'], ['/']);
  assert.equal(r.clientVerified, false);
  assert.equal(r.title, '');
});

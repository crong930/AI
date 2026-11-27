'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createServer, makeHttp, resumeOnBoot } = require('../server');
const nodeHttp = require('http');
const { checkPost } = require('../lib/guard');

function fakes() {
  const calls = [];
  const jobs = {
    start(ctx, mode) { calls.push({ ctx, mode }); return { jobId: 'jabc123', existing: false }; },
    get(id) { return id === 'jabc123' ? { id, status: 'running' } : null; },
    cancel(id) { return id === 'jabc123'; },
    resumeAll: async () => {},
  };
  const store = {
    list: (s) => [{ id: 'r1', symbol: s || 'X' }],
    get: (id) => (id === 'r1' ? { id: 'r1' } : null),
  };
  return { calls, jobs, store };
}

async function boot(over = {}) {
  const f = fakes();
  const cfg = { demo: true, aiDemo: true, refreshSeconds: 5, ai: { claude: null, openai: 'k', gemini: null }, port: 0, secrets: () => [] };
  const server = createServer({ cfg, jobs: f.jobs, store: f.store, ...over });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const url = (p) => 'http://127.0.0.1:' + port + p;
  const post = (p, body, headers = {}) => fetch(url(p), {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:' + port, ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { server, port, url, post, f, close: () => new Promise((r) => { server.close(r); server.closeAllConnections(); }) };
}

test('analyze without Origin -> 403', async () => {
  const t = await boot();
  const res = await fetch(t.url('/api/analyze'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"symbol":"005930","mode":"quick"}' });
  assert.strictEqual(res.status, 403);
  await t.close();
});

test('analyze from evil origin -> 403', async () => {
  const t = await boot();
  const res = await t.post('/api/analyze', { symbol: '005930', mode: 'quick' }, { Origin: 'http://evil.com' });
  assert.strictEqual(res.status, 403);
  await t.close();
});

test('wrong content-type -> 415', async () => {
  const t = await boot();
  const res = await t.post('/api/analyze', '{}', { 'Content-Type': 'text/plain' });
  assert.strictEqual(res.status, 415);
  await t.close();
});

test('body > 10KB -> 413', async () => {
  const t = await boot();
  const res = await t.post('/api/analyze', JSON.stringify({ symbol: '005930', mode: 'quick', pad: 'x'.repeat(11000) }));
  assert.strictEqual(res.status, 413);
  await t.close();
});

test('bad symbol / bad mode -> 400', async () => {
  const t = await boot();
  assert.strictEqual((await t.post('/api/analyze', { symbol: '../x', mode: 'quick' })).status, 400);
  assert.strictEqual((await t.post('/api/analyze', { symbol: '005930', mode: 'turbo' })).status, 400);
  assert.strictEqual((await t.post('/api/analyze', 'not json')).status, 400);
  assert.strictEqual(t.f.calls.length, 0);
  await t.close();
});

test('valid analyze -> 200 {jobId}; demo context has no position data', async () => {
  const t = await boot();
  const res = await t.post('/api/analyze', { symbol: '005930', mode: 'quick' });
  assert.strictEqual(res.status, 200);
  const j = await res.json();
  assert.strictEqual(j.jobId, 'jabc123');
  const { ctx, mode } = t.f.calls[0];
  assert.strictEqual(mode, 'quick');
  assert.strictEqual(ctx.symbol, '005930');
  assert.strictEqual(ctx.avgPrice, undefined);
  assert.match(ctx.today, /^\d{4}-\d{2}-\d{2}$/);
  await t.close();
});

test('real mode: unheld symbol -> 404, held includes position', async () => {
  const snap = { positions: [{ symbol: 'NVDA', name: 'N', market: 'US', currency: 'USD', lastPrice: 1, avgPrice: 2, returnRate: 0.1, dailyRate: 0, valueKrw: 100, quantity: 5 }] };
  const t = await boot({ cfg: { demo: false, aiDemo: true, ai: {}, secrets: () => [] }, snapshot: async () => snap });
  const miss = await t.post('/api/analyze', { symbol: '005930', mode: 'quick' });
  assert.strictEqual(miss.status, 404);
  assert.match((await miss.json()).error, /보유하지 않은 종목이에요/);
  assert.strictEqual((await t.post('/api/analyze', { symbol: 'NVDA', mode: 'deep' })).status, 200);
  assert.strictEqual(t.f.calls[0].ctx.avgPrice, 2);
  assert.strictEqual(t.f.calls[0].ctx.quantity, undefined);
  await t.close();
});

test('existing GET routes still work in demo', async () => {
  const t = await boot();
  const snap = await (await fetch(t.url('/api/snapshot'))).json();
  assert.strictEqual(snap.demo, true);
  assert.strictEqual((await fetch(t.url('/api/config'))).status, 200);
  assert.strictEqual((await fetch(t.url('/'))).status, 200);
  assert.strictEqual((await fetch(t.url('/nope'))).status, 404);
  await t.close();
});

test('PUT -> 405', async () => {
  const t = await boot();
  assert.strictEqual((await fetch(t.url('/api/snapshot'), { method: 'PUT' })).status, 405);
  assert.strictEqual((await fetch(t.url('/api/analyze'), { method: 'DELETE' })).status, 405);
  await t.close();
});

test('ai status, jobs, cancel, reports', async () => {
  const t = await boot();
  const st = await (await fetch(t.url('/api/ai/status'))).json();
  assert.deepStrictEqual(st, { aiDemo: true, tossDemo: true, providers: { claude: false, openai: true, gemini: false } });
  assert.strictEqual((await (await fetch(t.url('/api/jobs/jabc123'))).json()).status, 'running');
  assert.strictEqual((await fetch(t.url('/api/jobs/nope'))).status, 404);
  assert.strictEqual((await fetch(t.url('/api/jobs/..%2Fx'))).status, 404);
  assert.deepStrictEqual(await (await t.post('/api/jobs/jabc123/cancel', {})).json(), { ok: true });
  assert.strictEqual((await t.post('/api/jobs/jabc123/cancel', {}, { Origin: 'http://evil.com' })).status, 403);
  assert.strictEqual((await t.post('/api/jobs/zzz/cancel', {})).status, 404);
  assert.strictEqual((await (await fetch(t.url('/api/reports?symbol=NVDA'))).json())[0].symbol, 'NVDA');
  assert.strictEqual((await fetch(t.url('/api/reports/r1'))).status, 200);
  assert.strictEqual((await fetch(t.url('/api/reports/nope'))).status, 404);
  await t.close();
});

test('checkPost accepts 127.0.0.1 origin and rejects other ports', () => {
  const req = (o) => ({ headers: { origin: o, 'content-type': 'application/json; charset=utf-8' } });
  assert.strictEqual(checkPost(req('http://127.0.0.1:8787'), '{}', 8787), null);
  assert.strictEqual(checkPost(req('http://localhost:9999'), '{}', 8787).status, 403);
});

test('bound http scrubs secret keys from errors', async () => {
  const http = makeHttp({ secrets: () => ['sk-SECRET-123'] });
  await assert.rejects(
    http({ url: 'https://x', transport: async () => { throw new Error('boom sk-SECRET-123'); } }),
    (e) => !e.message.includes('sk-SECRET-123') && e.message.includes('***'));
});

function getWithHost(port, p, host) {
  return new Promise((resolve, reject) => {
    const req = nodeHttp.request({ host: '127.0.0.1', port, path: p, method: 'GET', headers: { Host: host } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject); req.end();
  });
}

test('DNS rebinding: foreign Host header -> 403, localhost/127.0.0.1 -> 200', async () => {
  const t = await boot();
  try {
  assert.strictEqual(await getWithHost(t.port, '/api/snapshot', 'evil.com:' + t.port), 403);
  assert.strictEqual(await getWithHost(t.port, '/api/snapshot', 'evil.com'), 403);
  assert.strictEqual(await getWithHost(t.port, '/api/snapshot', 'localhost:' + (t.port + 1)), 403);
  assert.strictEqual(await getWithHost(t.port, '/api/snapshot', 'localhost:' + t.port), 200);
  assert.strictEqual(await getWithHost(t.port, '/api/snapshot', '127.0.0.1:' + t.port), 200);
  assert.strictEqual((await fetch(t.url('/api/snapshot'))).status, 200);
  } finally { await t.close(); }
});

test('resume runs whenever AI keys exist, even in Toss demo mode', async () => {
  let n = 0;
  const jobs = { resumeAll: async () => { n++; } };
  const store = { loadJobs: () => ({ j1: {} }) };
  await resumeOnBoot({ cfg: { demo: true, aiDemo: false }, jobs, store, log: () => {} });
  assert.strictEqual(n, 1);
  await resumeOnBoot({ cfg: { demo: false, aiDemo: true }, jobs, store, log: () => {} });
  assert.strictEqual(n, 1);
});

test('serves the app icon as svg and ico', async () => {
  const t = await boot();
  const svg = await fetch(t.url('/icon.svg'));
  assert.strictEqual(svg.status, 200); assert.match(svg.headers.get('content-type'), /svg/);
  const ico = await fetch(t.url('/favicon.ico'));
  assert.strictEqual(ico.status, 200);
  const buf = Buffer.from(await ico.arrayBuffer());
  assert.deepStrictEqual([...buf.subarray(0, 4)], [0, 0, 1, 0]);
  await t.close();
});

test('launcher scripts are UTF-16LE with BOM so Korean text works in Windows Script Host', () => {
  const fs = require('fs'); const path = require('path');
  for (const f of ['start-hidden.vbs', 'stop-hidden.vbs', 'make-shortcuts.vbs']) {
    const b = fs.readFileSync(path.join(__dirname, '..', f));
    assert.deepStrictEqual([b[0], b[1]], [0xff, 0xfe], f);
    const t = b.subarray(2).toString('utf16le');
    assert.ok(t.includes('Option Explicit'), f);
  }
  const start = fs.readFileSync(path.join(__dirname, '..', 'start-hidden.vbs')).subarray(2).toString('utf16le');
  assert.match(start, /--no-open/);
});

test('POST /api/explain validates and returns the explanation', async () => {
  const seen = [];
  const t = await boot({ explain: async (o) => { seen.push(o); return { provider: 'claude', answer: '쉬운 설명' }; } });
  let r = await t.post('/api/explain', { reportId: 'r1', text: 'PCE 물가' });
  assert.strictEqual(r.status, 200); assert.deepStrictEqual(await r.json(), { provider: 'claude', answer: '쉬운 설명' });
  assert.strictEqual(seen[0].selection, 'PCE 물가'); assert.deepStrictEqual(seen[0].report, { id: 'r1' });
  r = await t.post('/api/explain', { reportId: 'nope', text: 'x' }); assert.strictEqual(r.status, 404);
  r = await t.post('/api/explain', { reportId: 'r1', text: '' }); assert.strictEqual(r.status, 400);
  r = await t.post('/api/explain', { reportId: 'r1', text: 'x'.repeat(1001) }); assert.strictEqual(r.status, 400);
  r = await fetch(t.url('/api/explain'), { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: '{"reportId":"r1","text":"x"}' });
  assert.strictEqual(r.status, 403);
  await t.close();
});

test('POST /api/explain returns 502 with the error text when explaining fails', async () => {
  const t = await boot({ explain: async () => { throw new Error('Claude 크레딧(충전 금액)이 없어요.'); } });
  const r = await t.post('/api/explain', { reportId: 'r1', text: 'x' });
  assert.strictEqual(r.status, 502); assert.match((await r.json()).error, /크레딧/);
  await t.close();
});

test('makeHttp reports each response to the usage tracker', async () => {
  const seen = [];
  const http = makeHttp({ secrets: () => [] }, async () => ({ status: 200, json: { id: 'm' } }), { observe: (u, j) => seen.push([u, j.id]) });
  await http({ url: 'https://api.anthropic.com/v1/messages' });
  assert.deepStrictEqual(seen, [['https://api.anthropic.com/v1/messages', 'm']]);
});

test('usage page and API', async () => {
  const calls = [];
  const usage = { summary: () => ({ fx: 1400, providers: {} }), setBalance: (p, v) => { if (p === 'evil') throw new Error('알 수 없는 AI예요.'); calls.push([p, v]); } };
  const t = await boot({ usage });
  let r = await fetch(t.url('/usage')); assert.strictEqual(r.status, 200); assert.match(await r.text(), /AI 잔액/);
  r = await fetch(t.url('/api/usage')); const j = await r.json();
  assert.strictEqual(j.fx, 1400); assert.deepStrictEqual(j.keys, { claude: false, openai: true, gemini: false });
  r = await t.post('/api/usage/balance', { provider: 'claude', usd: 12.5 }); assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(calls, [['claude', 12.5]]);
  r = await t.post('/api/usage/balance', { provider: 'evil', usd: 1 }); assert.strictEqual(r.status, 400);
  r = await fetch(t.url('/api/usage/balance'), { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: '{"provider":"claude","usd":1}' });
  assert.strictEqual(r.status, 403);
  await t.close();
});

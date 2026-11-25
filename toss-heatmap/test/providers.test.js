'use strict';
const test = require('node:test');
const assert = require('node:assert');
const claude = require('../lib/providers/claude');
const openai = require('../lib/providers/openai');
const gemini = require('../lib/providers/gemini');
const { researchPrompt } = require('../lib/prompts');
const { requestJson, HttpError } = require('../lib/http');

const LIMITS = { enabled: true, claudeMaxSearches: 30, openaiMaxToolCalls: 40, timeoutMinutes: 30 };
function fakeHttp(responses) {
  const calls = [];
  const fn = async (opts) => {
    calls.push(opts);
    const r = typeof responses === 'function' ? responses(opts, calls.length) : responses.shift();
    if (!r) throw new Error('no scripted response for ' + opts.method + ' ' + opts.url);
    return { status: 200, json: r };
  };
  fn.calls = calls;
  return fn;
}
const textMsg = (text, extra = {}) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text }], ...extra });

test('claude builds deep request with limits', async () => {
  const http = fakeHttp([textMsg('보고서')]);
  const r = await claude.run({ key: 'ak', model: 'claude-opus-5-5', mode: 'deep', prompt: 'p', limits: LIMITS, http });
  const { body, headers } = http.calls[0];
  assert.strictEqual(headers['x-api-key'], 'ak');
  assert.strictEqual(body.output_config.effort, 'high');
  assert.strictEqual(body.tools.find((t) => t.name === 'web_search').max_uses, 30);
  assert.strictEqual(r.status, 'done');
  assert.strictEqual(r.text, '보고서');
});

test('claude continues pause_turn', async () => {
  const paused = { stop_reason: 'pause_turn', content: [{ type: 'server_tool_use', id: 's1', name: 'web_search', input: {} }] };
  const http = fakeHttp([paused, textMsg('끝')]);
  const r = await claude.run({ key: 'ak', model: 'm', mode: 'quick', prompt: 'p', limits: LIMITS, http });
  assert.strictEqual(http.calls.length, 2);
  assert.strictEqual(http.calls[1].body.messages.length, 2);
  assert.strictEqual(r.text, '끝');
});

test('claude collects sources and limitHit on max_uses_exceeded', async () => {
  const resp = { stop_reason: 'end_turn', content: [
    { type: 'web_search_tool_result', content: [{ type: 'web_search_result', title: 'A', url: 'https://a' }, { type: 'web_search_result', title: 'A', url: 'https://a' }] },
    { type: 'web_search_tool_result', content: { type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' } },
    { type: 'text', text: 't' }] };
  const r = await claude.run({ key: 'ak', model: 'm', mode: 'deep', prompt: 'p', limits: LIMITS, http: fakeHttp([resp]) });
  assert.strictEqual(r.limitHit, true);
  assert.deepStrictEqual(r.sources, [{ title: 'A', url: 'https://a' }]);
});

test('claude refusal → failed', async () => {
  const r = await claude.run({ key: 'ak', model: 'm', mode: 'quick', prompt: 'p', limits: LIMITS, http: fakeHttp([{ stop_reason: 'refusal', content: [] }]) });
  assert.strictEqual(r.status, 'failed');
});

const oaDone = { id: 'r1', status: 'completed', output: [
  { type: 'web_search_call', status: 'completed' },
  { type: 'message', content: [{ type: 'output_text', text: '오픈AI 보고서', annotations: [{ type: 'url_citation', title: 'B', url: 'https://b' }] }] }] };

test('openai deep polls and reports handle', async () => {
  const http = fakeHttp([{ id: 'r1', status: 'queued' }, { id: 'r1', status: 'in_progress' }, oaDone]);
  let handle;
  const r = await openai.run({ key: 'ok', model: 'o3-deep-research', mode: 'deep', prompt: 'p', limits: LIMITS, http, pollMs: 1, onHandle: (h) => { handle = h; } });
  assert.strictEqual(handle, 'r1');
  assert.strictEqual(http.calls[0].body.background, true);
  assert.strictEqual(http.calls[0].body.max_tool_calls, 40);
  assert.strictEqual(http.calls[0].headers.Authorization, 'Bearer ok');
  assert.strictEqual(r.text, '오픈AI 보고서');
  assert.deepStrictEqual(r.sources, [{ title: 'B', url: 'https://b' }]);
});

test('openai resume skips creation', async () => {
  const http = fakeHttp([oaDone]);
  const r = await openai.run({ key: 'ok', model: 'm', mode: 'deep', prompt: 'p', limits: LIMITS, http, pollMs: 1, resume: 'r1' });
  assert.ok(http.calls.every((c) => c.method === 'GET'));
  assert.strictEqual(r.status, 'done');
});

test('cancel via signal (openai deep)', async () => {
  const ac = new AbortController();
  const http = fakeHttp((opts, n) => {
    if (opts.method === 'POST' && opts.url.endsWith('/cancel')) return { id: 'r1', status: 'cancelled' };
    if (n === 1) return { id: 'r1', status: 'queued' };
    if (n === 2) ac.abort();
    return { id: 'r1', status: 'in_progress' };
  });
  const r = await openai.run({ key: 'ok', model: 'm', mode: 'deep', prompt: 'p', limits: LIMITS, http, pollMs: 1, signal: ac.signal });
  assert.ok(http.calls.some((c) => c.method === 'POST' && c.url.endsWith('/v1/responses/r1/cancel')));
  assert.strictEqual(r.status, 'cancelled');
});

test('gemini deep polls', async () => {
  const http = fakeHttp([{ id: 'g1', status: 'in_progress' }, { id: 'g1', status: 'completed', output_text: '제미나이 보고서' }]);
  let handle;
  const r = await gemini.run({ key: 'gk', model: 'deep-research-preview-04-2026', mode: 'deep', prompt: 'p', limits: LIMITS, http, pollMs: 1, onHandle: (h) => { handle = h; } });
  assert.strictEqual(http.calls[0].body.agent, 'deep-research-preview-04-2026');
  assert.strictEqual(http.calls[0].headers['x-goog-api-key'], 'gk');
  assert.strictEqual(handle, 'g1');
  assert.strictEqual(r.text, '제미나이 보고서');
});

test('timeout returns limitHit and cancels', async () => {
  const http = fakeHttp((opts, n) => (n === 1 ? { id: 'g1', status: 'in_progress' } : { id: 'g1', status: 'in_progress' }));
  const r = await gemini.run({ key: 'gk', model: 'x', mode: 'deep', prompt: 'p', limits: { ...LIMITS, timeoutMinutes: 0.00001 }, http, pollMs: 2 });
  assert.strictEqual(r.limitHit, true);
  assert.strictEqual(r.status, 'failed');
  assert.ok(http.calls.some((c) => c.url.endsWith('/interactions/g1/cancel')));
});

test('prompt carries no amounts', () => {
  const p = researchPrompt({ symbol: '005930', name: '삼성전자', market: 'KR', currency: 'KRW', lastPrice: 96500, avgPrice: 58000, returnRate: 0.66, dailyRate: 0.01, weightPct: 31.2, today: '2026-11-25', quantity: 7, valueKrw: 123456 }, 'deep');
  assert.ok(!p.includes('123456'));
  assert.ok(!p.includes('수량'));
  assert.ok(p.includes('58000') || p.includes('58,000'));
  assert.ok(p.includes('내 상황에서 보면'));
  const g = researchPrompt({ symbol: '005930', name: '삼성전자', market: 'KR', currency: 'KRW', today: '2026-11-25' }, 'quick');
  assert.ok(!g.includes('내 상황에서 보면'));
});

test('scrub removes keys from errors', async () => {
  const transport = async () => ({ status: 401, text: '{"error":"bad key sk-test-123"}' });
  await assert.rejects(
    requestJson({ method: 'GET', url: 'https://x', headers: {}, transport, secrets: ['sk-test-123'] }),
    (e) => e instanceof HttpError && e.status === 401 && !e.message.includes('sk-test-123'),
  );
});

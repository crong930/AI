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

test('claude deep stops at timeout with limitHit and partial text', async () => {
  const paused = { stop_reason: 'pause_turn', content: [{ type: 'text', text: '부분 보고서' }] };
  const seen = [];
  const http = async (opts) => {
    seen.push(opts);
    if (seen.length === 1) return { status: 200, json: paused };
    return new Promise((resolve, reject) => {
      if (!opts.signal) return; // would hang forever without a deadline signal
      opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
    });
  };
  const r = await Promise.race([
    claude.run({ key: 'ak', model: 'm', mode: 'deep', prompt: 'p', limits: { ...LIMITS, timeoutMinutes: 0.0005 }, http }),
    new Promise((resolve) => setTimeout(() => resolve({ hung: true }), 2000)),
  ]);
  assert.ok(!r.hung, 'claude run hung past the time limit');
  assert.strictEqual(r.status, 'done');
  assert.strictEqual(r.limitHit, true);
  assert.strictEqual(r.text, '부분 보고서');
  assert.ok(typeof seen[1].timeoutMs === 'number' && seen[1].timeoutMs <= 30 * 60000 * 0.001 + 1000);
});

test('claude deep timeout with no text fails with limitHit', async () => {
  const http = (opts) => new Promise((resolve, reject) => {
    opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
  });
  const r = await claude.run({ key: 'ak', model: 'm', mode: 'deep', prompt: 'p', limits: { ...LIMITS, timeoutMinutes: 0.0005 }, http });
  assert.strictEqual(r.status, 'failed');
  assert.strictEqual(r.limitHit, true);
});

test('claude user abort still cancels', async () => {
  const ac = new AbortController();
  const http = (opts) => new Promise((resolve, reject) => {
    opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
    setTimeout(() => ac.abort(), 5);
  });
  const r = await claude.run({ key: 'ak', model: 'm', mode: 'deep', prompt: 'p', limits: LIMITS, http, signal: ac.signal });
  assert.strictEqual(r.status, 'cancelled');
});

test('transient poll error is retried', async () => {
  let polls = 0;
  const h = async (opts) => {
    if (opts.method === 'POST') return { status: 200, json: { id: 'g1', status: 'in_progress' } };
    polls++;
    if (polls === 1) throw new HttpError(503, 'HTTP 503');
    return { status: 200, json: { id: 'g1', status: 'completed', output_text: '복구됨' } };
  };
  const r = await gemini.run({ key: 'gk', model: 'x', mode: 'deep', prompt: 'p', limits: LIMITS, http: h, pollMs: 1 });
  assert.strictEqual(r.status, 'done');
  assert.strictEqual(r.text, '복구됨');
});

test('repeated poll errors cancel the job before failing', async () => {
  const calls = [];
  const h = async (opts) => {
    calls.push(opts);
    if (opts.method === 'POST' && opts.url.endsWith('/cancel')) return { status: 200, json: {} };
    if (opts.method === 'POST') return { status: 200, json: { id: 'r1', status: 'queued' } };
    throw new HttpError(500, 'HTTP 500');
  };
  const r = await openai.run({ key: 'ok', model: 'm', mode: 'deep', prompt: 'p', limits: LIMITS, http: h, pollMs: 1 });
  assert.strictEqual(r.status, 'failed');
  assert.ok(calls.some((c) => c.method === 'POST' && c.url.endsWith('/v1/responses/r1/cancel')));
  assert.strictEqual(calls.filter((c) => c.method === 'GET').length, 5);
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

test('claude multiple pause_turn keeps one assistant turn with all segments', async () => {
  const seg1 = [{ type: 'text', text: '첫째 ' }, { type: 'server_tool_use', id: 's1', name: 'web_search', input: {} }];
  const seg2 = [{ type: 'web_search_tool_result', tool_use_id: 's1', content: [] }, { type: 'text', text: '둘째 ' }];
  const http = fakeHttp([{ stop_reason: 'pause_turn', content: seg1 }, { stop_reason: 'pause_turn', content: seg2 }, textMsg('셋째')]);
  const r = await claude.run({ key: 'ak', model: 'm', mode: 'quick', prompt: 'p', limits: LIMITS, http });
  assert.strictEqual(http.calls.length, 3);
  const msgs = http.calls[2].body.messages;
  assert.strictEqual(msgs.length, 2);
  assert.strictEqual(msgs[1].role, 'assistant');
  assert.deepStrictEqual(msgs[1].content, [...seg1, ...seg2]);
  assert.strictEqual(r.text, '첫째 둘째 셋째');
});

test('claude deep web_fetch caps content tokens', async () => {
  const http = fakeHttp([textMsg('보고서')]);
  await claude.run({ key: 'ak', model: 'm', mode: 'deep', prompt: 'p', limits: LIMITS, http });
  assert.strictEqual(http.calls[0].body.tools.find((t) => t.name === 'web_fetch').max_content_tokens, 10000);
});

test('claude complete uses 32000 max_tokens and throws on max_tokens stop', async () => {
  const http = fakeHttp([{ stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"conclusion":' }] }]);
  await assert.rejects(claude.complete({ key: 'ak', model: 'm', prompt: 'p', http }));
  assert.strictEqual(http.calls[0].body.max_tokens, 32000);
});

for (const [name, prov, id, cancelSuffix] of [['openai', openai, 'r9', '/v1/responses/r9/cancel'], ['gemini', gemini, 'g9', '/interactions/g9/cancel']]) {
  test(name + ' abort during start → no signal on create, cancel called with returned id', async () => {
    const ac = new AbortController();
    const calls = [];
    const h = async (opts) => {
      calls.push(opts);
      if (opts.url.endsWith('/cancel')) return { status: 200, json: {} };
      if (opts.method === 'POST') {
        assert.strictEqual(opts.signal, undefined, 'create request must not carry the abort signal');
        ac.abort();
        return { status: 200, json: { id, status: 'queued' } };
      }
      return { status: 200, json: { id, status: 'in_progress' } };
    };
    let handle;
    const r = await prov.run({ key: 'k', model: 'm', mode: 'deep', prompt: 'p', limits: LIMITS, http: h, pollMs: 1, signal: ac.signal, onHandle: (x) => { handle = x; } });
    assert.strictEqual(r.status, 'cancelled');
    assert.ok(calls.some((c) => c.method === 'POST' && c.url.endsWith(cancelSuffix)));
    assert.ok(!calls.some((c) => c.method === 'GET'));
    assert.strictEqual(handle, undefined);
  });
}

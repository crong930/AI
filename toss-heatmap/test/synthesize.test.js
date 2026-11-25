'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { synthesize } = require('../lib/synthesize');

const ctx = { symbol: '005930', name: '삼성전자', market: 'KR', currency: 'KRW', today: '2026-11-25' };
const good = JSON.stringify({ conclusion: ['a', 'b', 'c'], why: 'w', outlook: { up: 'u', down: 'd', events: 'e' }, risks: 'r',
  views: [{ provider: 'claude', stance: '긍정', reason: 'x' }], disagreements: '없음', myPosition: null, summaries: { claude: ['1', '2', '3'] } });
const done = (provider, sources = []) => ({ provider, status: 'done', text: provider + ' 보고서', sources, limitHit: false });
const writer = (id, fn) => ({ provider: { id, complete: fn }, key: 'k', model: 'm' });

test('claude writes when available', async () => {
  const calls = [];
  const r = await synthesize({ ctx, results: [done('claude'), done('openai')], writers: [
    writer('claude', async () => { calls.push('claude'); return good; }), writer('openai', async () => { calls.push('openai'); return good; })] });
  assert.deepStrictEqual(calls, ['claude']);
  assert.strictEqual(r.writer, 'claude');
  assert.strictEqual(r.crossChecked, true);
  assert.deepStrictEqual(r.conclusion, ['a', 'b', 'c']);
});

test('falls back to openai when claude throws', async () => {
  const r = await synthesize({ ctx, results: [done('claude'), done('openai')], writers: [
    writer('claude', async () => { throw new Error('down'); }), writer('openai', async () => good)] });
  assert.strictEqual(r.writer, 'openai');
});

test('single result → crossChecked false; sources deduped union', async () => {
  const r = await synthesize({ ctx, results: [done('gemini', [{ title: 'A', url: 'https://a' }, { title: 'A2', url: 'https://a' }]), { provider: 'openai', status: 'failed', sources: [] }],
    writers: [writer('gemini', async () => good)] });
  assert.strictEqual(r.crossChecked, false);
  assert.deepStrictEqual(r.sources, [{ title: 'A', url: 'https://a' }]);
});

test('malformed JSON wrapped in prose still parses', async () => {
  const r = await synthesize({ ctx, results: [done('claude')], writers: [writer('claude', async () => '여기 있어요:\n```json\n' + good + '\n```\n끝')] });
  assert.strictEqual(r.why, 'w');
  assert.strictEqual(r.raw, undefined);
});

test('all writers garbage → raw set', async () => {
  const r = await synthesize({ ctx, results: [done('claude'), done('openai')], writers: [writer('claude', async () => 'nope'), writer('openai', async () => '그냥 글')] });
  assert.strictEqual(r.raw, '그냥 글');
  assert.deepStrictEqual(r.conclusion, []);
});

test('no writers available → raw is joined provider texts', async () => {
  const r = await synthesize({ ctx, results: [done('claude')], writers: [writer('claude', async () => { throw new Error('x'); })] });
  assert.ok(r.raw.includes('claude 보고서'));
  assert.strictEqual(r.writer, null);
});

test('no done results → throws', async () => {
  await assert.rejects(synthesize({ ctx, results: [{ provider: 'claude', status: 'failed', sources: [] }], writers: [] }), /모든 AI가 실패했어요/);
});

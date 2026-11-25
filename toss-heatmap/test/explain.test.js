'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { explain, explainPrompt } = require('../lib/explain');

const report = { name: 'TQQQ', symbol: 'TQQQ', createdAt: '2026-11-25T10:00:00Z', conclusion: ['a', 'b', 'c'], why: '원인은 ==나스닥 하락==', risks: 'r', providerTexts: { claude: 'x'.repeat(50000) } };
const prov = (id, fn) => ({ id, complete: fn });
const cfg = (ai) => ({ ai, aiDemo: !ai.claude && !ai.openai && !ai.gemini, models: { claudeExplain: 'ce', openaiExplain: 'oe', geminiExplain: 'ge' } });

test('prompt contains the selection and report, not raw provider texts, no ==marks==', () => {
  const p = explainPrompt(report, '레버리지 ETF');
  assert.match(p, /레버리지 ETF/); assert.match(p, /나스닥 하락/);
  assert.doesNotMatch(p, /==/); assert.ok(p.length < 20000);
});

test('uses claude light call first', async () => {
  const calls = [];
  const out = await explain({ report, selection: 'PCE', config: cfg({ claude: 'k1', openai: 'k2', gemini: null }), http: {},
    providers: [prov('claude', async (o) => { calls.push(o); return '설명'; }), prov('openai', async () => 'no')] });
  assert.deepStrictEqual(out, { provider: 'claude', answer: '설명' });
  assert.strictEqual(calls[0].model, 'ce'); assert.strictEqual(calls[0].light, true); assert.strictEqual(calls[0].key, 'k1');
});

test('falls back to the next AI with a friendly error if all fail', async () => {
  const out = await explain({ report, selection: 'x', config: cfg({ claude: 'k1', openai: 'k2', gemini: null }), http: {},
    providers: [prov('claude', async () => { throw new Error('HTTP 529: Overloaded'); }), prov('openai', async () => '대신 설명')] });
  assert.deepStrictEqual(out, { provider: 'openai', answer: '대신 설명' });
  await assert.rejects(explain({ report, selection: 'x', config: cfg({ claude: 'k1', openai: null, gemini: null }), http: {},
    providers: [prov('claude', async () => { throw new Error('HTTP 400: Your credit balance is too low'); })] }), /크레딧/);
});

test('demo mode answers without calling anything', async () => {
  const out = await explain({ report, selection: 'x', config: cfg({ claude: null, openai: null, gemini: null }), http: {},
    providers: [prov('claude', async () => { throw new Error('should not call'); })] });
  assert.strictEqual(out.provider, 'demo'); assert.match(out.answer, /예시/);
});

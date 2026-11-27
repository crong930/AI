'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { createUsage, extractUsage } = require('../lib/usage');

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'usage-')), '.usage.json');
const A = 'https://api.anthropic.com/v1/messages', O = 'https://api.openai.com/v1/responses', G = 'https://generativelanguage.googleapis.com/v1beta/interactions';

test('extract claude usage including cache tokens and web searches', () => {
  const u = extractUsage(A, { id: 'msg_1', model: 'claude-opus-5-5', usage: { input_tokens: 1000, cache_read_input_tokens: 500, output_tokens: 200, server_tool_use: { web_search_requests: 3 } } });
  assert.deepStrictEqual(u, { provider: 'claude', id: 'msg_1', model: 'claude-opus-5-5', input: 1500, output: 200, searches: 3 });
});

test('openai counts only finished responses, with web_search_call items', () => {
  assert.strictEqual(extractUsage(O + '/resp_1', { id: 'resp_1', status: 'in_progress' }), null);
  const u = extractUsage(O + '/resp_1', { id: 'resp_1', status: 'completed', model: 'gpt-5', usage: { input_tokens: 10, output_tokens: 20 }, output: [{ type: 'web_search_call' }, { type: 'message' }] });
  assert.deepStrictEqual(u, { provider: 'openai', id: 'resp_1', model: 'gpt-5', input: 10, output: 20, searches: 1 });
});

test('gemini usage in either shape; unfinished ignored', () => {
  assert.strictEqual(extractUsage(G + '/x', { id: 'x', status: 'in_progress' }), null);
  const u = extractUsage(G, { id: 'g1', status: 'completed', model: 'gemini-3.1-pro-preview', usage: { total_input_tokens: 7, total_output_tokens: 8 } });
  assert.strictEqual(u.input, 7); assert.strictEqual(u.output, 8); assert.strictEqual(u.provider, 'gemini');
  const u2 = extractUsage(G, { name: 'g2', agent: 'deep-research-preview-04-2026', status: 'completed' });
  assert.strictEqual(u2.model, 'deep-research-preview-04-2026'); assert.strictEqual(u2.input, 0);
});

test('unknown urls are ignored', () => { assert.strictEqual(extractUsage('https://openapi.tossinvest.com/x', { usage: {} }), null); });

test('records cost, dedupes by id, persists, and estimates balance', () => {
  const file = tmp();
  const u = createUsage(file, { fx: 1400, now: () => new Date('2026-11-27T00:00:00Z') });
  u.setBalance('claude', 10);
  u.observe(A, { id: 'm1', model: 'claude-opus-5-5', usage: { input_tokens: 1000000, output_tokens: 0 } });
  u.observe(A, { id: 'm1', model: 'claude-opus-5-5', usage: { input_tokens: 1000000, output_tokens: 0 } });
  const s = createUsage(file, { fx: 1400 }).summary();
  const c = s.providers.claude;
  assert.strictEqual(c.balanceUsd, 10);
  assert.strictEqual(c.spentUsd, 5);
  assert.strictEqual(c.estimatedUsd, 5);
  assert.strictEqual(s.fx, 1400);
  assert.strictEqual(c.recent.length, 1);
  assert.strictEqual(s.providers.openai.balanceUsd, null);
});

test('setting a new balance resets spending since then; flat fee for gemini deep without usage', () => {
  const file = tmp();
  const u = createUsage(file, {});
  u.setBalance('gemini', 20);
  u.observe(G, { id: 'd1', agent: 'deep-research-preview-04-2026', status: 'completed' });
  assert.ok(u.summary().providers.gemini.spentUsd > 0);
  u.setBalance('gemini', 15);
  assert.strictEqual(u.summary().providers.gemini.spentUsd, 0);
  assert.throws(() => u.setBalance('gemini', -1)); assert.throws(() => u.setBalance('evil', 1));
});

test('observe never throws, even on a broken file', () => {
  const file = tmp(); fs.writeFileSync(file, '{broken');
  const u = createUsage(file, {});
  u.observe(A, { id: 'm', model: 'x', usage: { input_tokens: 100000, output_tokens: 1000 } });
  assert.ok(u.summary().providers.claude.spentUsd > 0);
});

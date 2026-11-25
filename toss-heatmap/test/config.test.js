'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadConfig } = require('../lib/config');

function withFile(obj) {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-')), 'config.json');
  fs.writeFileSync(p, JSON.stringify(obj));
  return p;
}
const load = (obj, env = {}, argv = []) => loadConfig({ path: withFile(obj), env, argv });

test('placeholder keys count as missing', () => {
  const c = load({ anthropicApiKey: '여기에 Claude API 키 붙여넣기' });
  assert.strictEqual(c.ai.claude, null);
  assert.strictEqual(c.ai.openai, null);
  assert.strictEqual(c.ai.gemini, null);
  assert.strictEqual(c.aiDemo, true);
});

test('defaults', () => {
  const c = load({});
  assert.strictEqual(c.models.claudeQuick, 'claude-opus-5-5');
  assert.strictEqual(c.models.claudeDeep, 'claude-opus-5-5');
  assert.strictEqual(c.models.openaiQuick, 'gpt-5');
  assert.strictEqual(c.models.openaiDeep, 'o3-deep-research');
  assert.strictEqual(c.models.geminiQuick, 'gemini-3.1-pro-preview');
  assert.strictEqual(c.models.geminiDeep, 'deep-research-preview-04-2026');
  assert.deepStrictEqual(c.deepResearchLimit, { enabled: true, claudeMaxSearches: 30, openaiMaxToolCalls: 40, timeoutMinutes: 30 });
});

test('user overrides merge', () => {
  const c = load({ models: { openaiQuick: 'x' }, deepResearchLimit: { enabled: false } });
  assert.strictEqual(c.models.openaiQuick, 'x');
  assert.strictEqual(c.models.openaiDeep, 'o3-deep-research');
  assert.strictEqual(c.deepResearchLimit.enabled, false);
  assert.strictEqual(c.deepResearchLimit.claudeMaxSearches, 30);
});

test('toss demo independent of ai', () => {
  const c = load({ openaiApiKey: 'sk-abc' });
  assert.strictEqual(c.demo, true);
  assert.strictEqual(c.aiDemo, false);
  assert.strictEqual(c.ai.openai, 'sk-abc');
});

test('secrets() returns exactly the non-null keys', () => {
  const c = load({ clientId: 'cid', clientSecret: 'csec', geminiApiKey: 'g1', anthropicApiKey: '  ' });
  assert.deepStrictEqual(c.secrets().sort(), ['cid', 'csec', 'g1']);
});

test('missing file gives demo defaults', () => {
  const c = loadConfig({ path: '/nonexistent/config.json', env: {}, argv: [] });
  assert.strictEqual(c.demo, true);
  assert.strictEqual(c.port, 8787);
});

test('config.json with UTF-8 BOM parses', () => {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-')), 'config.json');
  fs.writeFileSync(p, '\uFEFF' + JSON.stringify({ anthropicApiKey: 'sk-ant-x' }));
  const c = loadConfig({ path: p, env: {}, argv: [] });
  assert.strictEqual(c.ai.claude, 'sk-ant-x');
});

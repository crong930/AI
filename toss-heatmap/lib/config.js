'use strict';
// config.json 읽기. 키는 여기서만 읽고, 다른 곳에는 secrets()로만 넘겨요.
const fs = require('fs');

const PLACEHOLDER = /여기에|붙여넣/;
const DEFAULT_MODELS = {
  claudeQuick: 'claude-opus-5-5',
  claudeExplain: 'claude-haiku-5-5',
  openaiExplain: 'gpt-5-mini',
  geminiExplain: 'gemini-3.1-pro-preview',
  claudeDeep: 'claude-opus-5-5',
  openaiQuick: 'gpt-5',
  openaiDeep: 'o3-deep-research',
  geminiQuick: 'gemini-3.1-pro-preview',
  geminiDeep: 'deep-research-preview-04-2026',
};
const DEFAULT_LIMIT = { enabled: true, claudeMaxSearches: 30, openaiMaxToolCalls: 40, timeoutMinutes: 30 };

function cleanKey(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return !s || PLACEHOLDER.test(s) ? null : s;
}

// 형식이 잘못된 config.json이면 Error를 던져요 (server.js가 안내 후 종료).
function loadConfig({ path, env = {}, argv = [] }) {
  let cfg = {};
  // Windows 메모장은 파일 앞에 BOM(\uFEFF)을 붙일 수 있어서 떼어내요.
  if (path && fs.existsSync(path)) cfg = JSON.parse(fs.readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
  const out = { ...cfg };
  out.clientId = cleanKey(env.TOSS_CLIENT_ID) || cleanKey(cfg.clientId) || '';
  out.clientSecret = cleanKey(env.TOSS_CLIENT_SECRET) || cleanKey(cfg.clientSecret) || '';
  out.port = Number(cfg.port) || 8787;
  out.refreshSeconds = Math.max(2, Number(cfg.refreshSeconds) || 5);
  out.sectorOverrides = cfg.sectorOverrides || {};
  out.demo = argv.includes('--demo') || !out.clientId || !out.clientSecret;
  out.ai = {
    claude: cleanKey(cfg.anthropicApiKey),
    openai: cleanKey(cfg.openaiApiKey),
    gemini: cleanKey(cfg.geminiApiKey),
  };
  delete out.anthropicApiKey; delete out.openaiApiKey; delete out.geminiApiKey;
  out.aiDemo = !out.ai.claude && !out.ai.openai && !out.ai.gemini;
  out.models = { ...DEFAULT_MODELS, ...(cfg.models || {}) };
  out.deepResearchLimit = { ...DEFAULT_LIMIT, ...(cfg.deepResearchLimit || {}) };
  const secrets = [out.clientId, out.clientSecret, out.ai.claude, out.ai.openai, out.ai.gemini].filter(Boolean);
  Object.defineProperty(out, 'secrets', { value: () => secrets.slice(), enumerable: false });
  return out;
}

module.exports = { loadConfig, DEFAULT_MODELS, DEFAULT_LIMIT };

'use strict';
// AI를 부를 때마다 쓴 토큰을 기록해서 "예상 잔액"을 계산해요.
// 회사들이 일반 API 키로는 잔액을 알려주지 않아서, 사용자가 넣은 잔액에서 쓴 금액을 빼는 추정치예요.
const fs = require('fs');
const path = require('path');

// 100만 토큰당 달러, 검색 1번당 달러. config.json의 "prices"로 바꿀 수 있어요.
const DEFAULT_PRICES = {
  'claude-opus': { in: 5, out: 25 }, 'claude-sonnet': { in: 3, out: 15 }, 'claude-haiku': { in: 1, out: 5 },
  'gpt-5-mini': { in: 0.25, out: 2 }, 'gpt-5': { in: 1.25, out: 10 }, 'o3-deep-research': { in: 10, out: 40 },
  'gemini-3.1-pro': { in: 2, out: 12 }, 'gemini': { in: 2, out: 12 }, 'deep-research': { in: 2, out: 12, flat: 2 },
  search: { claude: 0.01, openai: 0.01, gemini: 0.014 },
  default: { in: 5, out: 25 },
};
const PROVIDERS = ['claude', 'openai', 'gemini'];

function which(url) {
  if (typeof url !== 'string') return null;
  if (url.startsWith('https://api.anthropic.com/')) return 'claude';
  if (url.startsWith('https://api.openai.com/')) return 'openai';
  if (url.startsWith('https://generativelanguage.googleapis.com/')) return 'gemini';
  return null;
}
const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

function extractUsage(url, json) {
  const provider = which(url);
  if (!provider || !json || typeof json !== 'object') return null;
  const u = json.usage || json.usageMetadata || {};
  if (provider === 'claude') {
    if (!json.usage) return null;
    return { provider, id: json.id || null, model: String(json.model || ''),
      input: n(u.input_tokens) + n(u.cache_read_input_tokens) + n(u.cache_creation_input_tokens), output: n(u.output_tokens),
      searches: n(u.server_tool_use && u.server_tool_use.web_search_requests) };
  }
  // 백그라운드 작업은 끝났을 때 한 번만 세요.
  if (json.status && !['completed', 'incomplete', 'failed', 'cancelled'].includes(json.status)) return null;
  if (provider === 'openai') {
    if (!json.usage) return null;
    return { provider, id: json.id || null, model: String(json.model || ''), input: n(u.input_tokens), output: n(u.output_tokens),
      searches: (json.output || []).filter((x) => x && x.type === 'web_search_call').length };
  }
  return { provider, id: json.id || json.name || null, model: String(json.model || json.agent || ''),
    input: n(u.total_input_tokens || u.input_tokens || u.promptTokenCount),
    output: n(u.total_output_tokens || u.output_tokens || u.candidatesTokenCount) + n(u.total_thought_tokens || u.thoughtsTokenCount),
    searches: 0, noUsage: !json.usage && !json.usageMetadata };
}

function priceFor(prices, model) {
  const keys = Object.keys(prices).filter((k) => k !== 'search' && k !== 'default' && model.includes(k)).sort((a, b) => b.length - a.length);
  return prices[keys[0]] || prices.default;
}

function costUsd(prices, x) {
  const p = priceFor(prices, x.model);
  let c = (x.input * n(p.in) + x.output * n(p.out)) / 1e6 + x.searches * n((prices.search || {})[x.provider]);
  if (x.noUsage && p.flat) c = Math.max(c, n(p.flat));
  return Math.round(c * 10000) / 10000;
}

function createUsage(file, { prices = {}, fx = 1400, now = () => new Date() } = {}) {
  const P = { ...DEFAULT_PRICES, ...prices, search: { ...DEFAULT_PRICES.search, ...(prices.search || {}) } };
  const blank = () => ({ balances: {}, log: [], seen: [] });
  let db;
  try { db = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { db = null; }
  if (!db || typeof db !== 'object' || !Array.isArray(db.log)) db = blank();
  db.balances = db.balances || {}; db.seen = Array.isArray(db.seen) ? db.seen : []; db.seq = n(db.seq);

  function save() {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(db));
      try { fs.renameSync(tmp, file); } catch (_) { fs.writeFileSync(file, JSON.stringify(db)); }
    } catch (_) { /* 기록 실패는 분석을 막지 않아요 */ }
  }

  function observe(url, json) {
    try {
      const x = extractUsage(url, json);
      if (!x) return;
      if (x.id) { if (db.seen.includes(x.provider + ':' + x.id)) return; db.seen.push(x.provider + ':' + x.id); db.seen = db.seen.slice(-2000); }
      db.seq += 1;
      db.log.push({ seq: db.seq, at: now().toISOString(), provider: x.provider, model: x.model, input: x.input, output: x.output, searches: x.searches, usd: costUsd(P, x) });
      db.log = db.log.slice(-5000);
      save();
    } catch (_) { /* 절대 분석을 멈추지 않아요 */ }
  }

  function setBalance(provider, usd) {
    if (!PROVIDERS.includes(provider)) throw new Error('알 수 없는 AI예요.');
    const v = Number(usd);
    if (!Number.isFinite(v) || v < 0 || v > 100000) throw new Error('잔액은 0 이상의 숫자로 넣어 주세요.');
    db.balances[provider] = { usd: v, at: now().toISOString(), seq: db.seq };
    save();
  }

  function summary() {
    const out = { fx, providers: {} };
    const month = now().toISOString().slice(0, 7);
    for (const p of PROVIDERS) {
      const b = db.balances[p];
      const rows = db.log.filter((r) => r.provider === p);
      // 잔액을 넣은 뒤에 쓴 것만 빼요.
      const since = b ? rows.filter((r) => n(r.seq) > n(b.seq)) : rows;
      const spent = Math.round(since.reduce((s, r) => s + n(r.usd), 0) * 10000) / 10000;
      out.providers[p] = {
        balanceUsd: b ? b.usd : null, balanceAt: b ? b.at : null, spentUsd: spent,
        estimatedUsd: b ? Math.round((b.usd - spent) * 100) / 100 : null,
        monthUsd: Math.round(rows.filter((r) => r.at.slice(0, 7) === month).reduce((s, r) => s + n(r.usd), 0) * 100) / 100,
        recent: rows.slice(-8).reverse(),
      };
    }
    return out;
  }

  return { observe, setBalance, summary };
}

module.exports = { createUsage, extractUsage, DEFAULT_PRICES };

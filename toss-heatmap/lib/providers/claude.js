'use strict';
// Claude: 웹 검색 도구로 조사해요. Anthropic API에는 별도 딥리서치 모델이 없어서,
// 딥 모드는 검색 횟수와 생각 깊이(effort)를 늘린 방식이에요.
const { dedupeSources, failed, cancelled } = require('./common');

const URL = 'https://api.anthropic.com/v1/messages';
const MAX_CONTINUATIONS = 5;

function headers(key) { return { 'x-api-key': key, 'anthropic-version': '2023-06-01' }; }

async function call(http, key, body, signal) {
  const { json } = await http({ method: 'POST', url: URL, headers: headers(key), body, signal });
  return json;
}

async function run({ key, model, mode, prompt, limits, signal, http }) {
  const deep = mode === 'deep';
  const tools = [{ type: 'web_search_20260209', name: 'web_search', max_uses: deep ? (limits.enabled ? limits.claudeMaxSearches : 60) : 5 }];
  if (deep) tools.push({ type: 'web_fetch_20260209', name: 'web_fetch', max_uses: limits.enabled ? 20 : 40 });
  const base = { model, max_tokens: 32000, thinking: { type: 'adaptive' }, output_config: { effort: deep ? 'high' : 'medium' }, tools };
  const messages = [{ role: 'user', content: prompt }];
  const sources = []; let limitHit = false; let resp;
  try {
    for (let i = 0; i <= MAX_CONTINUATIONS; i++) {
      if (signal && signal.aborted) return cancelled('claude');
      resp = await call(http, key, { ...base, messages }, signal);
      for (const b of resp.content || []) {
        if (b.type !== 'web_search_tool_result') continue;
        if (Array.isArray(b.content)) for (const r of b.content) sources.push({ title: r.title, url: r.url });
        else if (b.content && b.content.error_code === 'max_uses_exceeded') limitHit = true;
      }
      if (resp.stop_reason !== 'pause_turn') break;
      messages.splice(1, messages.length - 1, { role: 'assistant', content: resp.content });
    }
  } catch (e) {
    if (signal && signal.aborted) return cancelled('claude');
    return failed('claude', e.message);
  }
  if (resp.stop_reason === 'refusal') return failed('claude', 'Claude가 이 요청에 답하지 않았어요');
  if (resp.stop_reason === 'max_tokens') limitHit = true;
  const text = (resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  if (!text) return failed('claude', '빈 응답이 왔어요');
  return { provider: 'claude', status: 'done', text, sources: dedupeSources(sources), limitHit };
}

async function complete({ key, model, prompt, http, signal }) {
  const resp = await call(http, key, { model, max_tokens: 16000, thinking: { type: 'adaptive' }, output_config: { effort: 'high' }, messages: [{ role: 'user', content: prompt }] }, signal);
  return (resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
}

module.exports = { id: 'claude', label: 'Claude', run, complete };

'use strict';
// Claude: 웹 검색 도구로 조사해요. Anthropic API에는 별도 딥리서치 모델이 없어서,
// 딥 모드는 검색 횟수와 생각 깊이(effort)를 늘린 방식이에요.
const { dedupeSources, failed, cancelled } = require('./common');

const URL = 'https://api.anthropic.com/v1/messages';
const MAX_CONTINUATIONS = 5;

function headers(key) { return { 'x-api-key': key, 'anthropic-version': '2023-06-01' }; }

async function call(http, key, body, signal, timeoutMs) {
  const opts = { method: 'POST', url: URL, headers: headers(key), body, signal };
  if (timeoutMs !== undefined) opts.timeoutMs = timeoutMs;
  const { json } = await http(opts);
  return json;
}

async function run({ key, model, mode, prompt, limits, signal, http }) {
  const deep = mode === 'deep';
  const tools = [{ type: 'web_search_20260209', name: 'web_search', max_uses: deep ? (limits.enabled ? limits.claudeMaxSearches : 60) : 5 }];
  if (deep) tools.push({ type: 'web_fetch_20260209', name: 'web_fetch', max_uses: limits.enabled ? 20 : 40, max_content_tokens: 10000 });
  const base = { model, max_tokens: 32000, thinking: { type: 'adaptive' }, output_config: { effort: deep ? 'high' : 'medium' }, tools };
  const messages = [{ role: 'user', content: prompt }];
  const sources = []; let limitHit = false; let resp;
  // pause_turn이 여러 번 와도 assistant 턴은 하나로 이어 붙여요.
  const acc = [];
  const t0 = Date.now();
  const deadline = limits.enabled ? t0 + limits.timeoutMinutes * 60000 : Infinity;
  const textOf = (blocks) => blocks.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  const timedOut = () => {
    const text = textOf(acc);
    if (text) return { provider: 'claude', status: 'done', text, sources: dedupeSources(sources), limitHit: true };
    return failed('claude', '시간 한도(' + limits.timeoutMinutes + '분)에 닿아 멈췄어요', { limitHit: true });
  };
  try {
    for (let i = 0; i <= MAX_CONTINUATIONS; i++) {
      if (signal && signal.aborted) return cancelled('claude');
      const remaining = deadline - Date.now();
      if (remaining <= 0) return timedOut();
      // 남은 시간만큼만 기다리도록 요청마다 타이머를 걸어요.
      const ac = new AbortController();
      const onAbort = () => ac.abort();
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      let timer = null; let hitDeadline = false;
      if (remaining !== Infinity) timer = setTimeout(() => { hitDeadline = true; ac.abort(); }, remaining);
      let r;
      try {
        r = await call(http, key, { ...base, messages }, ac.signal, remaining === Infinity ? undefined : Math.max(1, remaining));
      } catch (e) {
        if (hitDeadline && !(signal && signal.aborted)) return timedOut();
        throw e;
      } finally {
        if (timer) clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
      }
      resp = r;
      acc.push(...(resp.content || []));
      for (const b of resp.content || []) {
        if (b.type !== 'web_search_tool_result') continue;
        if (Array.isArray(b.content)) for (const r of b.content) sources.push({ title: r.title, url: r.url });
        else if (b.content && b.content.error_code === 'max_uses_exceeded') limitHit = true;
      }
      if (resp.stop_reason !== 'pause_turn') break;
      messages.splice(1, messages.length - 1, { role: 'assistant', content: acc.slice() });
    }
  } catch (e) {
    if (signal && signal.aborted) return cancelled('claude');
    return failed('claude', e.message);
  }
  if (resp.stop_reason === 'refusal') return failed('claude', 'Claude가 이 요청에 답하지 않았어요');
  if (resp.stop_reason === 'max_tokens') limitHit = true;
  const text = textOf(acc);
  if (!text) return failed('claude', '빈 응답이 왔어요');
  return { provider: 'claude', status: 'done', text, sources: dedupeSources(sources), limitHit };
}

async function complete({ key, model, prompt, http, signal, light = false }) {
  // light: 드래그 설명처럼 짧고 빠른 답. 생각 시간 없이 짧게 써요.
  const body = light
    ? { model, max_tokens: 1500, messages: [{ role: 'user', content: prompt }] }
    : { model, max_tokens: 32000, thinking: { type: 'adaptive' }, output_config: { effort: 'high' }, messages: [{ role: 'user', content: prompt }] };
  const resp = await call(http, key, body, signal);
  // 잘린 JSON은 쓸 수 없으니 오류로 돌려서 다음 AI가 쓰게 해요.
  if (resp && resp.stop_reason === 'max_tokens') throw new Error('Claude 응답이 길이 한도에서 잘렸어요');
  return (resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
}

module.exports = { id: 'claude', label: 'Claude', run, complete };

'use strict';
// Gemini(Interactions API). 빠른 분석은 Google 검색 그라운딩, 딥은 공식 Deep Research 에이전트예요.
const { runBackground, dedupeSources, failed, cancelled } = require('./common');

const BASE = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const hdr = (key) => ({ 'x-goog-api-key': key, 'Api-Revision': '2026-05-20' });

// 응답 모양이 바뀌어도 텍스트와 출처를 최대한 찾아내요.
function extract(resp) {
  let text = resp.output_text || '';
  if (!text) {
    const parts = [];
    for (const step of resp.steps || resp.outputs || []) {
      if (step.type && step.type !== 'model_output' && step.type !== 'text') continue;
      for (const c of step.content || [step]) if (typeof c.text === 'string') parts.push(c.text);
    }
    text = parts.join('');
  }
  const sources = [];
  (function walk(o, depth) {
    if (!o || typeof o !== 'object' || depth > 8) return;
    if (Array.isArray(o)) return o.forEach((x) => walk(x, depth + 1));
    if (typeof o.url === 'string' && /^https?:/.test(o.url)) sources.push({ title: o.title, url: o.url });
    if (typeof o.uri === 'string' && /^https?:/.test(o.uri)) sources.push({ title: o.title, url: o.uri });
    for (const k of Object.keys(o)) if (k !== 'text') walk(o[k], depth + 1);
  })(resp, 0);
  return { text: text.trim(), sources };
}

async function run({ key, model, mode, prompt, limits, signal, http, resume, onHandle, pollMs }) {
  try {
    if (mode !== 'deep') {
      const { json } = await http({ method: 'POST', url: BASE, headers: hdr(key), body: { model, input: prompt, tools: [{ type: 'google_search' }] }, signal });
      const x = extract(json);
      if (!x.text) return failed('gemini', '빈 응답이 왔어요');
      return { provider: 'gemini', status: 'done', text: x.text, sources: dedupeSources(x.sources), limitHit: false };
    }
    return await runBackground({
      provider: 'gemini', resume, onHandle, signal, limits, pollMs,
      start: async () => (await http({ method: 'POST', url: BASE, headers: hdr(key), body: {
        agent: model, input: prompt, background: true, store: true,
        agent_config: { type: 'deep-research', thinking_summaries: 'none', visualization: 'off', collaborative_planning: false },
      } })).json.id,
      poll: async (id) => {
        const { json } = await http({ method: 'GET', url: BASE + '/' + encodeURIComponent(id), headers: hdr(key) });
        const x = extract(json);
        if (json.status === 'completed') return { finished: true, ok: !!x.text, text: x.text, sources: x.sources, error: '빈 응답이 왔어요' };
        if (json.status === 'failed' || json.status === 'cancelled') return { finished: true, ok: false, error: 'Gemini 작업 상태: ' + json.status };
        return { finished: false, text: x.text, sources: x.sources };
      },
      cancel: (id) => http({ method: 'POST', url: BASE + '/' + encodeURIComponent(id) + '/cancel', headers: hdr(key) }).catch((e) => { if (e.status !== 404) throw e; }),
    });
  } catch (e) {
    if (signal && signal.aborted) return cancelled('gemini');
    return failed('gemini', e.message);
  }
}

async function complete({ key, model, prompt, http, signal }) {
  const { json } = await http({ method: 'POST', url: BASE, headers: hdr(key), body: { model, input: prompt }, signal });
  return extract(json).text;
}

module.exports = { id: 'gemini', label: 'Gemini', run, complete };

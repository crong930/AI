'use strict';
// ChatGPT(OpenAI Responses API). 빠른 분석은 웹 검색, 딥은 딥리서치 모델을 백그라운드로 돌려요.
const { runBackground, dedupeSources, failed, cancelled } = require('./common');

const BASE = 'https://api.openai.com/v1/responses';
const hdr = (key) => ({ Authorization: 'Bearer ' + key });

function extract(resp) {
  let text = ''; const sources = []; let searches = 0;
  for (const item of resp.output || []) {
    if (item.type === 'web_search_call') searches++;
    if (item.type !== 'message') continue;
    for (const c of item.content || []) {
      if (c.text) text += c.text;
      for (const a of c.annotations || []) if (a.url) sources.push({ title: a.title, url: a.url });
    }
  }
  if (!text && resp.output_text) text = resp.output_text;
  return { text: text.trim(), sources, searches };
}

async function run({ key, model, mode, prompt, limits, signal, http, resume, onHandle, pollMs }) {
  try {
    if (mode !== 'deep') {
      const { json } = await http({ method: 'POST', url: BASE, headers: hdr(key), body: { model, input: prompt, tools: [{ type: 'web_search' }], max_tool_calls: 8 }, signal });
      const x = extract(json);
      if (!x.text) return failed('openai', '빈 응답이 왔어요');
      return { provider: 'openai', status: 'done', text: x.text, sources: dedupeSources(x.sources), limitHit: x.searches >= 8 };
    }
    const maxCalls = limits.enabled ? limits.openaiMaxToolCalls : undefined;
    return await runBackground({
      provider: 'openai', resume, onHandle, signal, limits, pollMs,
      start: async () => {
        const body = { model, input: prompt, background: true, tools: [{ type: 'web_search_preview' }] };
        if (maxCalls) body.max_tool_calls = maxCalls;
        return (await http({ method: 'POST', url: BASE, headers: hdr(key), body })).json.id;
      },
      poll: async (id) => {
        const { json } = await http({ method: 'GET', url: BASE + '/' + encodeURIComponent(id), headers: hdr(key) });
        const x = extract(json);
        if (json.status === 'queued' || json.status === 'in_progress') return { finished: false, text: x.text, sources: x.sources };
        if (json.status === 'completed' || json.status === 'incomplete') {
          return { finished: true, ok: !!x.text, text: x.text, sources: x.sources, error: '빈 응답이 왔어요',
            limitHit: json.status === 'incomplete' || (maxCalls && x.searches >= maxCalls) };
        }
        return { finished: true, ok: false, error: 'ChatGPT 작업 상태: ' + json.status + (json.error && json.error.message ? ' (' + json.error.message + ')' : '') };
      },
      cancel: (id) => http({ method: 'POST', url: BASE + '/' + encodeURIComponent(id) + '/cancel', headers: hdr(key) }),
    });
  } catch (e) {
    if (signal && signal.aborted) return cancelled('openai');
    return failed('openai', e.message);
  }
}

async function complete({ key, model, prompt, http, signal }) {
  const { json } = await http({ method: 'POST', url: BASE, headers: hdr(key), body: { model, input: prompt }, signal });
  return extract(json).text;
}

module.exports = { id: 'openai', label: 'ChatGPT', run, complete };

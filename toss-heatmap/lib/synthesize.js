'use strict';
// 성공한 AI 보고서들을 한 AI가 교차 검증해서 최종 보고서(JSON)로 만들어요.
// 쓰는 순서: Claude → ChatGPT → Gemini (키가 있는 것만).
const { synthesisPrompt, LABEL } = require('./prompts');
const { dedupeSources } = require('./providers/common');

function parseLenient(text) {
  if (typeof text !== 'string') return null;
  const a = text.indexOf('{'); const b = text.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try {
    const o = JSON.parse(text.slice(a, b + 1));
    return o && typeof o === 'object' && Array.isArray(o.conclusion) ? o : null;
  } catch (_) { return null; }
}

const STANCES = ['긍정', '중립', '부정'];
function normalize(o) {
  const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));
  const outlook = o.outlook || {};
  return {
    conclusion: o.conclusion.slice(0, 3).map(str),
    why: str(o.why),
    outlook: { up: str(outlook.up), down: str(outlook.down), events: str(outlook.events) },
    risks: str(o.risks),
    views: (Array.isArray(o.views) ? o.views : []).map((v) => ({ provider: str(v.provider), stance: STANCES.includes(v.stance) ? v.stance : '중립', reason: str(v.reason) })),
    disagreements: str(o.disagreements),
    myPosition: o.myPosition ? str(o.myPosition) : null,
    summaries: Object.fromEntries(Object.entries(o.summaries || {}).map(([k, v]) => [k, (Array.isArray(v) ? v : [v]).slice(0, 3).map(str)])),
  };
}

const empty = () => ({ conclusion: [], why: '', outlook: { up: '', down: '', events: '' }, risks: '', views: [], disagreements: '', myPosition: null, summaries: {} });

async function synthesize({ ctx, results, writers, http, signal }) {
  const done = results.filter((r) => r.status === 'done' && r.text);
  if (!done.length) {
    const reasons = results.map((r) => (LABEL[r.provider] || r.provider) + ': ' + (r.error || r.status || '알 수 없는 이유'));
    throw new Error('모든 AI가 실패했어요' + (reasons.length ? ' (' + reasons.join(', ') + ')' : ''));
  }
  const base = { crossChecked: done.length >= 2, sources: dedupeSources(done.flatMap((r) => r.sources || [])) };
  const prompt = synthesisPrompt(ctx, done);
  const errors = [];
  for (const w of writers) {
    if (signal && signal.aborted) break;
    try {
      const text = await w.provider.complete({ key: w.key, model: w.model, prompt, http, signal });
      const parsed = parseLenient(text);
      if (parsed) return { writer: w.provider.id, ...base, ...normalize(parsed) };
      errors.push((LABEL[w.provider.id] || w.provider.id) + ': 결과 형식을 읽을 수 없어요');
    } catch (e) { errors.push((LABEL[w.provider.id] || w.provider.id) + ': ' + e.message); }
  }
  // 최종 보고서를 만들지 못하면 각 AI 보고서를 그대로라도 보여줘요 (깨진 JSON은 보여주지 않아요).
  const raw = done.map((r) => `## ${LABEL[r.provider] || r.provider} 보고서\n\n${r.text}`).join('\n\n');
  return { writer: null, ...base, ...empty(), raw, synthesisErrors: errors };
}

module.exports = { synthesize, parseLenient };

'use strict';
// 저장용 마크다운. 메모장으로 열어도 읽기 쉽게 만들어요.
const { LABEL } = require('./prompts');
const MODE = { quick: '빠른 분석', deep: '딥 리서치' };

function toMarkdown(r) {
  const L = [];
  const date = (r.createdAt || '').slice(0, 10);
  L.push(`# ${r.name} (${r.symbol}) 분석 보고서`, '', `${date} · ${MODE[r.mode] || r.mode}`, '');
  const notes = [];
  const provs = r.providers || {};
  if (Object.values(provs).some((p) => p && p.limitHit)) notes.push('⚠ 조사 한도에 닿았음 (일부 AI는 정해진 한도에서 조사를 멈췄어요)');
  if (r.crossChecked === false) notes.push('⚠ 교차 검증 못 함 (보고서를 쓴 AI가 하나뿐이에요)');
  for (const [id, p] of Object.entries(provs)) if (p && p.status !== 'done') notes.push(`- ${LABEL[id] || id}: ${p.status === 'skipped' ? '키 없음' : p.status === 'failed' ? '실패 (' + (p.error || '') + ')' : p.status}`);
  if (notes.length) L.push(...notes, '');
  if (r.raw) {
    L.push('## 보고서', '', r.raw, '');
  } else {
    if ((r.keyPoints || []).length) L.push('## 🔑 꼭 볼 점', '', ...r.keyPoints.map((k) => `- ${k}`), '');
    L.push('## 최종 3줄 결론', '', ...(r.conclusion || []).map((c, i) => `${i + 1}. ${c}`), '');
    L.push('## ① 왜 올랐나/내렸나', '', r.why || '', '');
    const o = r.outlook || {};
    L.push('## ② 앞으로의 전망', '', `**좋아질 이유**: ${o.up || ''}`, '', `**나빠질 이유**: ${o.down || ''}`, '', `**다가오는 일정**: ${o.events || ''}`, '');
    L.push('## ③ 위험 요소', '', r.risks || '', '');
    L.push('## ④ 세 AI의 시각', '', ...(r.views || []).map((v) => `- **${LABEL[v.provider] || v.provider}**: ${v.stance} · ${v.reason}`), '');
    L.push('## ⑤ AI끼리 다른 의견', '', r.disagreements || '', '');
    if (r.myPosition) L.push('## 내 상황에서 보면', '', r.myPosition, '');
    const sums = r.summaries || {};
    for (const id of Object.keys(sums)) L.push(`### ${LABEL[id] || id} 3줄 요약`, '', ...(sums[id] || []).map((s, i) => `${i + 1}. ${s}`), '');
  }
  if ((r.sources || []).length) L.push('## 출처', '', ...r.sources.map((s) => `- [${s.title}](${s.url})`), '');
  L.push('---', '투자 판단의 책임은 본인에게 있어요. 이 보고서는 참고 자료예요.', '');
  // AI가 ==이렇게== 표시한 핵심 구절은 굵게 보여줘요.
  return L.join('\n').replace(/==([^=\n]{1,120})==/g, '**$1**');
}

module.exports = { toMarkdown };

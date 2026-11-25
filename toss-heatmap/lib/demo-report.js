'use strict';
// 키가 하나도 없을 때 보여주는 예시 보고서예요. 실제 분석이 아니에요.
function demoReport(ctx, mode) {
  const n = ctx.name || ctx.symbol;
  const deep = mode === 'deep';
  const sum = (who) => [`[예시] ${who}가 ${n}의 최근 흐름을 정리한 가짜 요약이에요.`, '[예시] 실제 데이터가 아니라 화면을 보여주기 위한 문장이에요.', '[예시] AI 키를 넣으면 진짜 분석이 나와요.'];
  return {
    writer: null,
    crossChecked: true,
    sources: [{ title: '[예시] 출처 자리예요', url: 'https://example.com/' }],
    conclusion: [
      `[예시] ${n}은(는) 지금 예시 화면이라 실제 의견이 없어요.`,
      `[예시] ${deep ? '딥 리서치' : '빠른 분석'} 결과가 이렇게 3줄로 보여요.`,
      '[예시] config.json에 AI 키를 넣으면 진짜 분석을 받을 수 있어요.',
    ],
    why: '[예시] 이 칸에는 왜 그렇게 판단했는지가 들어가요. 지금은 예시 문장이에요.',
    outlook: { up: '[예시] 오를 수 있는 시나리오가 들어가요.', down: '[예시] 내릴 수 있는 시나리오가 들어가요.', events: '[예시] 앞으로 챙겨볼 일정이 들어가요.' },
    risks: '[예시] 주의할 위험 요소가 들어가요.',
    views: [
      { provider: 'claude', stance: '중립', reason: '[예시] Claude의 의견 자리예요.' },
      { provider: 'openai', stance: '긍정', reason: '[예시] ChatGPT의 의견 자리예요.' },
      { provider: 'gemini', stance: '부정', reason: '[예시] Gemini의 의견 자리예요.' },
    ],
    disagreements: '[예시] AI끼리 의견이 갈린 부분이 들어가요.',
    myPosition: null,
    summaries: { claude: sum('Claude'), openai: sum('ChatGPT'), gemini: sum('Gemini') },
  };
}

module.exports = { demoReport };

'use strict';
// AI 회사가 돌려준 영어 오류를 쉬운 한국어 안내로 바꿔요. 모르는 오류는 그대로 둬요.
const INFO = {
  claude: { name: 'Claude', field: 'anthropicApiKey', billing: 'https://console.anthropic.com/settings/billing' },
  openai: { name: 'ChatGPT', field: 'openaiApiKey', billing: 'https://platform.openai.com/settings/organization/billing' },
  gemini: { name: 'Gemini', field: 'geminiApiKey', billing: 'https://aistudio.google.com/apikey' },
};

function friendlyError(provider, message) {
  if (typeof message !== 'string') return message;
  const i = INFO[provider] || { name: provider, field: 'API 키', billing: '' };
  if (/^연결 실패/.test(message)) return '인터넷 연결이나 ' + i.name + ' 서버에 닿지 못했어요. 잠시 뒤 다시 해 주세요.';
  // "상태 확인이 3번 연속 실패했어요: HTTP 401: …"처럼 감싼 글 안의 오류도 찾아요.
  const m = /HTTP (\d+):\s*([\s\S]*)$/.exec(message);
  const status = m ? Number(m[1]) : 0; const text = m ? m[2] : message;
  if (status === 401 || /api key not valid|invalid x-api-key|incorrect api key|invalid api key|api_key_invalid/i.test(text)) {
    return 'API 키가 맞지 않아요. config.json의 ' + i.field + ' 값을 다시 확인해 주세요.';
  }
  if (/free[ _]?tier/i.test(text)) {
    if (/limit:\s*0\b/i.test(text)) return '무료 키로는 이 모델을 쓸 수 없어요. ' + i.billing + ' 에서 결제(Billing)를 등록한 키를 써 주세요.';
    return i.name + ' 무료 사용량 한도에 잠시 닿았어요. 몇 분 뒤 다시 하거나 결제를 등록해 주세요.';
  }
  if (provider !== 'gemini' && /credit balance|no credits|insufficient_quota|exceeded your current quota|purchase credits/i.test(text)) {
    return i.name + ' 크레딧(충전 금액)이 없어요. ' + i.billing + ' 에서 충전한 뒤 다시 해 주세요.';
  }
  if (status === 429) return i.name + ' 요청이 잠시 막혔어요(너무 많은 요청). 몇 분 뒤 다시 해 주세요.';
  if (status >= 500) return i.name + ' 서버가 지금 바빠요. 잠시 뒤 다시 해 주세요.';
  return message;
}

module.exports = { friendlyError };

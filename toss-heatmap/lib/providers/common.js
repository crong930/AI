'use strict';
// 공급자들이 함께 쓰는 도우미: 출처 중복 제거, 중단 가능한 대기, 백그라운드 작업 폴링.
function dedupeSources(list) {
  const seen = new Set(); const out = [];
  for (const s of list) {
    if (!s || !s.url || seen.has(s.url)) continue;
    seen.add(s.url); out.push({ title: s.title || s.url, url: s.url });
  }
  return out;
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal && signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    if (signal) signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });
}

const failed = (provider, error, extra = {}) => ({ provider, status: 'failed', sources: [], limitHit: false, error, ...extra });
const cancelled = (provider) => ({ provider, status: 'cancelled', sources: [], limitHit: false });

const MAX_POLL_ERRORS = 5;

// start(): 핸들 생성 → poll(handle): {finished, ok, text, sources, limitHit, error} → cancel(handle)
async function runBackground({ provider, start, poll, cancel, resume, onHandle, signal, limits, pollMs = 10000 }) {
  const t0 = Date.now();
  let handle = resume;
  if (!handle) {
    handle = await start();
    if (onHandle) onHandle(handle);
  }
  const deadline = limits && limits.enabled ? t0 + limits.timeoutMinutes * 60000 : Infinity;
  let last = { finished: false };
  let errors = 0;
  for (;;) {
    if (signal && signal.aborted) { await cancel(handle).catch(() => {}); return cancelled(provider); }
    let cur = null;
    try {
      cur = await poll(handle);
      errors = 0;
    } catch (e) {
      // 일시적인 폴링 오류는 간격을 늘려가며 다시 시도하고, 계속 실패하면 작업을 취소한 뒤 실패로 돌려줘요.
      errors++;
      if (errors >= MAX_POLL_ERRORS) {
        await Promise.resolve().then(() => cancel(handle)).catch(() => {});
        return failed(provider, '상태 확인이 ' + errors + '번 연속 실패했어요: ' + (e && e.message));
      }
    }
    if (cur) last = cur;
    if (cur && last.finished) {
      if (!last.ok) return failed(provider, last.error || '분석에 실패했어요');
      return { provider, status: 'done', text: last.text, sources: dedupeSources(last.sources || []), limitHit: !!last.limitHit };
    }
    if (Date.now() > deadline) {
      await cancel(handle).catch(() => {});
      if (last.text) return { provider, status: 'done', text: last.text, sources: dedupeSources(last.sources || []), limitHit: true };
      return failed(provider, '시간 한도(' + limits.timeoutMinutes + '분)에 닿아 멈췄어요', { limitHit: true });
    }
    await sleep(errors ? pollMs * 2 ** (errors - 1) : pollMs, signal);
  }
}

module.exports = { dedupeSources, sleep, failed, cancelled, runBackground };

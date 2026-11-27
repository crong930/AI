'use strict';
// 미국 주식의 환차익·환차손을 계산해요.
// 토스 보유 조회에는 "산 때 환율"이 없어서, 거래내역(매수 기록의 환율)으로 종목별 평균 매입 환율을 구해요.
// 방식: 이동평균법. 팔 때는 같은 비율로 원가를 줄이고(평균 환율은 그대로), 살 때만 평균 환율이 바뀌어요.
const n = (v) => (v == null || v === '' ? null : Number(v));
const when = (t) => t.transactionTime || t.settlementDate || '';

function fxBasis(transactions, fxNow) {
  const rows = (transactions || []).filter((t) => t && t.marketCountry === 'US' && t.currency === 'USD' && t.symbol)
    .slice().sort((a, b) => (when(a) < when(b) ? -1 : when(a) > when(b) ? 1 : 0));
  const st = {};
  for (const t of rows) {
    const s = st[t.symbol] || (st[t.symbol] = { qty: 0, usd: 0, krw: 0, partial: false });
    const q = n(t.quantity) || 0;
    if (t.transactionType === 'BUY') {
      const usd = n(t.amount) != null ? n(t.amount) : (n(t.filledPrice) != null ? n(t.filledPrice) * q : null);
      if (usd == null) { s.partial = true; s.qty += q; continue; }
      let rate = n(t.exchangeRate);
      if (!rate) { rate = fxNow; s.partial = true; } // 아직 결제 전이면 환율이 없어서 지금 환율로 셈해요
      if (!rate) { s.partial = true; s.qty += q; continue; }
      s.qty += q; s.usd += usd; s.krw += usd * rate;
    } else if (t.transactionType === 'SELL' || t.transactionType === 'SECURITIES_TRANSFER_OUT') {
      if (s.qty > 0) { const f = Math.min(1, q / s.qty); s.usd *= 1 - f; s.krw *= 1 - f; s.qty = Math.max(0, s.qty - q); }
    } else if (t.transactionType === 'SECURITIES_TRANSFER_IN') {
      s.qty += q; s.partial = true; // 다른 곳에서 옮겨온 주식은 산 때 환율을 몰라요
    }
  }
  const out = {};
  for (const [sym, s] of Object.entries(st)) if (s.usd > 1e-9) out[sym] = { avgFx: Math.round((s.krw / s.usd) * 100) / 100, partial: s.partial };
  return out;
}

// state: { ready, error } — 거래내역을 아직 불러오는 중인지, 실패했는지
function applyFx(snap, basis, state = {}) {
  const fxNow = snap.usdKrw;
  const usd = (snap.positions || []).filter((p) => p.currency === 'USD');
  const T = snap.totals || (snap.totals = {});
  T.fxGainKrw = null; T.fxBuyAvg = null; T.fxMissing = []; T.fxError = null;
  if (!usd.length) { T.fxStatus = 'none'; return snap; }
  if (!basis || !fxNow) {
    T.fxStatus = state.error ? 'error' : 'loading'; T.fxError = state.error || null;
    for (const p of usd) { p.fxBuy = null; p.fxGainKrw = null; }
    return snap;
  }
  let gain = 0, costUsd = 0, costKrw = 0, any = false;
  for (const p of usd) {
    const b = basis[p.symbol];
    if (!b || p.cost == null || p.value == null) { p.fxBuy = null; p.fxGainKrw = null; T.fxMissing.push(p.symbol); continue; }
    p.fxBuy = b.avgFx; p.fxPartial = b.partial;
    p.fxGainKrw = Math.round(p.cost * (fxNow - b.avgFx));
    p.stockGainKrw = Math.round((p.value - p.cost) * fxNow);
    gain += p.fxGainKrw; costUsd += p.cost; costKrw += p.cost * b.avgFx; any = true;
  }
  T.fxStatus = any ? 'ok' : 'error';
  if (!any) T.fxError = '거래내역에서 미국 주식 매수 기록을 찾지 못했어요';
  T.fxGainKrw = any ? gain : null;
  T.fxBuyAvg = costUsd > 0 ? Math.round((costKrw / costUsd) * 100) / 100 : null;
  return snap;
}

module.exports = { fxBasis, applyFx };

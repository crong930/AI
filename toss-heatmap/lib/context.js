'use strict';
// AI에게 보낼 종목 정보만 골라내요. 수량·금액·현금은 여기서 걸러져서 밖으로 나가지 않아요.
const ALLOWED_KEYS = ['symbol', 'name', 'market', 'currency', 'lastPrice', 'avgPrice', 'returnRate', 'dailyRate', 'weightPct', 'today'];

function buildContext(snapshot, symbol, { includePosition, today }) {
  const positions = (snapshot && snapshot.positions) || [];
  const p = positions.find((x) => x.symbol === symbol);
  if (!p) return null;
  const base = { symbol: p.symbol, name: p.name, market: p.market, currency: p.currency, today };
  if (!includePosition) return base;
  const total = positions.reduce((a, x) => a + (Number(x.valueKrw) || 0), 0);
  const weightPct = total > 0 && p.valueKrw != null ? Math.round((p.valueKrw / total) * 1000) / 10 : null;
  return { ...base, lastPrice: p.lastPrice, avgPrice: p.avgPrice, returnRate: p.returnRate, dailyRate: p.dailyRate, weightPct };
}

module.exports = { buildContext, ALLOWED_KEYS };

'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { fxBasis, applyFx } = require('../lib/fx');

const tx = (o) => ({ marketCountry: 'US', currency: 'USD', settled: true, commission: '0', tax: '0', ...o });

test('weighted average purchase rate over buys; sells keep the average (moving average)', () => {
  const b = fxBasis([
    tx({ transactionType: 'BUY', symbol: 'NVDA', quantity: '10', amount: '1000', exchangeRate: '1300', transactionTime: '2026-01-02T10:00:00+09:00' }),
    tx({ transactionType: 'SELL', symbol: 'NVDA', quantity: '5', amount: '700', exchangeRate: '1350', transactionTime: '2026-02-02T10:00:00+09:00' }),
    tx({ transactionType: 'BUY', symbol: 'NVDA', quantity: '5', amount: '500', exchangeRate: '1400', transactionTime: '2026-03-02T10:00:00+09:00' }),
  ], 1450);
  // 남은 1000USD 중 500은 1300원, 500은 1400원 → 평균 1350원
  assert.strictEqual(b.NVDA.avgFx, 1350);
  assert.strictEqual(b.NVDA.partial, false);
});

test('order of records does not matter (newest-first API order is sorted)', () => {
  const recs = [
    tx({ transactionType: 'BUY', symbol: 'A', quantity: '1', amount: '100', exchangeRate: '1400', transactionTime: '2026-03-01T00:00:00+09:00' }),
    tx({ transactionType: 'SELL', symbol: 'A', quantity: '1', amount: '120', exchangeRate: '1380', transactionTime: '2026-02-01T00:00:00+09:00' }),
    tx({ transactionType: 'BUY', symbol: 'A', quantity: '1', amount: '100', exchangeRate: '1200', transactionTime: '2026-01-01T00:00:00+09:00' }),
  ];
  assert.strictEqual(fxBasis(recs, 1450).A.avgFx, 1400);
});

test('unsettled buys use the current rate and mark partial; KR records ignored', () => {
  const b = fxBasis([
    tx({ transactionType: 'BUY', symbol: 'T', quantity: '1', amount: '100', exchangeRate: '1300', transactionTime: '2026-01-01T00:00:00+09:00' }),
    tx({ transactionType: 'BUY', symbol: 'T', quantity: '1', amount: '100', exchangeRate: null, settled: false, transactionTime: null, settlementDate: '2026-11-28' }),
    { transactionType: 'BUY', symbol: '005930', marketCountry: 'KR', currency: 'KRW', quantity: '1', amount: '50000', settled: true },
  ], 1500);
  assert.strictEqual(b.T.avgFx, 1400);
  assert.strictEqual(b.T.partial, true);
  assert.strictEqual(b['005930'], undefined);
});

test('transfer in without cost marks partial', () => {
  const b = fxBasis([
    tx({ transactionType: 'SECURITIES_TRANSFER_IN', symbol: 'X', quantity: '3', amount: null, exchangeRate: null }),
    tx({ transactionType: 'BUY', symbol: 'X', quantity: '1', amount: '10', exchangeRate: '1300' }),
  ], 1400);
  assert.strictEqual(b.X.avgFx, 1300); assert.strictEqual(b.X.partial, true);
});

test('applyFx splits KRW P/L into stock part and FX part', () => {
  const snap = { usdKrw: 1450, totals: { pnlKrw: 0 }, positions: [
    { symbol: 'NVDA', currency: 'USD', value: 1200, cost: 1000, pnlKrw: 290000 },
    { symbol: 'TSLA', currency: 'USD', value: 500, cost: 400 },
    { symbol: '005930', currency: 'KRW', value: 100000, cost: 90000 },
  ] };
  applyFx(snap, { NVDA: { avgFx: 1350, partial: false } }, { ready: true });
  const n = snap.positions[0];
  assert.strictEqual(n.fxBuy, 1350);
  assert.strictEqual(n.fxGainKrw, 100000);          // 1000 USD × (1450 − 1350)
  assert.strictEqual(n.stockGainKrw, 290000);       // 200 USD × 1450
  assert.strictEqual(snap.positions[1].fxGainKrw, null); // 기록 없음
  assert.strictEqual(snap.positions[2].fxGainKrw, undefined);
  assert.strictEqual(snap.totals.fxGainKrw, 100000);
  assert.strictEqual(snap.totals.fxBuyAvg, 1350);
  assert.deepStrictEqual(snap.totals.fxMissing, ['TSLA']);
  assert.strictEqual(snap.totals.fxStatus, 'ok');
});

test('applyFx without basis reports loading / error and no numbers', () => {
  const snap = { usdKrw: 1450, totals: {}, positions: [{ symbol: 'NVDA', currency: 'USD', value: 1, cost: 1 }] };
  applyFx(snap, null, { ready: false, error: null });
  assert.strictEqual(snap.totals.fxStatus, 'loading'); assert.strictEqual(snap.totals.fxGainKrw, null);
  applyFx(snap, null, { ready: false, error: '권한 없음' });
  assert.strictEqual(snap.totals.fxStatus, 'error'); assert.strictEqual(snap.totals.fxError, '권한 없음');
  const krOnly = { usdKrw: 1450, totals: {}, positions: [{ symbol: 'A', currency: 'KRW' }] };
  applyFx(krOnly, {}, { ready: true });
  assert.strictEqual(krOnly.totals.fxStatus, 'none');
});

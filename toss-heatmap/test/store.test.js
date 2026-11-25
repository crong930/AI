'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildContext, ALLOWED_KEYS } = require('../lib/context');
const { createStore } = require('../lib/report-store');
const { toMarkdown } = require('../lib/report-md');

const snap = { positions: [
  { symbol: '005930', name: '삼성전자', market: 'KR', currency: 'KRW', quantity: 3, lastPrice: 100, avgPrice: 80, returnRate: 0.25, dailyRate: 0.01, valueKrw: 300, costKrw: 240, pnlKrw: 60 },
  { symbol: 'NVDA', name: '엔비디아', market: 'US', currency: 'USD', quantity: 1, lastPrice: 10, avgPrice: 9, returnRate: 0.1, dailyRate: 0, valueKrw: 100 },
] };

test('weightPct and allowed keys only', () => {
  const c = buildContext(snap, '005930', { includePosition: true, today: '2026-11-25' });
  assert.strictEqual(c.weightPct, 75);
  for (const k of Object.keys(c)) assert.ok(ALLOWED_KEYS.includes(k), 'unexpected key ' + k);
  assert.strictEqual(c.avgPrice, 80);
});

test('not held → null; includePosition:false → no avgPrice', () => {
  assert.strictEqual(buildContext(snap, 'TSLA', { includePosition: true, today: 'x' }), null);
  const c = buildContext(snap, 'NVDA', { includePosition: false, today: 'x' });
  assert.deepStrictEqual(Object.keys(c).sort(), ['currency', 'market', 'name', 'symbol', 'today']);
});

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rep-'));
const report = (over = {}) => ({ symbol: '005930', name: '삼성전자', mode: 'quick', createdAt: '2026-11-25T12:34:56.000Z',
  conclusion: ['a', 'b', 'c'], why: 'w', outlook: { up: 'u', down: 'd', events: 'e' }, risks: 'r',
  views: [{ provider: 'claude', stance: '긍정', reason: 'x' }], disagreements: '없음', myPosition: null,
  summaries: { claude: ['1', '2', '3'] }, sources: [{ title: 'S', url: 'https://s' }], crossChecked: true,
  providers: { claude: { status: 'done', limitHit: false } }, ...over });

test('save/list/get roundtrip', () => {
  const dir = tmp(); const s = createStore(dir);
  const id = s.save(report());
  assert.match(id, /^\d{8}-\d{6}_005930_quick$/);
  s.save(report({ symbol: 'NVDA', name: '엔비디아', createdAt: '2026-11-25T13:00:00.000Z' }));
  const l = s.list('005930');
  assert.strictEqual(l.length, 1);
  assert.strictEqual(l[0].id, id);
  assert.strictEqual(s.list().length, 2);
  assert.strictEqual(s.list()[0].symbol, 'NVDA');
  assert.strictEqual(s.get(id).why, 'w');
  assert.ok(fs.existsSync(path.join(dir, id + '.md')));
});

test('same second does not overwrite', () => {
  const s = createStore(tmp());
  const a = s.save(report()); const b = s.save(report());
  assert.notStrictEqual(a, b);
  assert.strictEqual(s.list().length, 2);
});

test('get rejects traversal', () => {
  const s = createStore(tmp());
  assert.strictEqual(s.get('../config'), null);
  assert.strictEqual(s.get('20261125-123456_..%2F_quick'), null);
});

test('jobs file roundtrip', () => {
  const s = createStore(tmp());
  assert.deepStrictEqual(s.loadJobs(), {});
  s.saveJobs({ j1: { symbol: 'X' } });
  assert.deepStrictEqual(s.loadJobs(), { j1: { symbol: 'X' } });
});

test('markdown has sections', () => {
  const md = toMarkdown(report({ providers: { claude: { status: 'done', limitHit: true } }, crossChecked: false }));
  for (const s of ['최종 3줄 결론', '왜 올랐나/내렸나', '앞으로의 전망', '위험 요소', 'AI끼리 다른 의견', '투자 판단의 책임은 본인에게 있어요', '조사 한도에 닿았음', '교차 검증 못 함', 'https://s'])
    assert.ok(md.includes(s), 'missing ' + s);
});

test('writeAtomic retries rename on EPERM/EBUSY (Windows lock)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rep-'));
  const store = createStore(dir);
  const orig = fs.renameSync; let n = 0;
  fs.renameSync = (a, b) => { n++; if (n <= 2) throw Object.assign(new Error('locked'), { code: n === 1 ? 'EPERM' : 'EBUSY' }); return orig(a, b); };
  try { store.saveJobs({ j1: { jobId: 'j1' } }); } finally { fs.renameSync = orig; }
  assert.strictEqual(n, 3);
  assert.deepStrictEqual(store.loadJobs(), { j1: { jobId: 'j1' } });
});

test('writeAtomic falls back to direct write when rename keeps failing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rep-'));
  const store = createStore(dir);
  const orig = fs.renameSync; let n = 0;
  fs.renameSync = () => { n++; throw Object.assign(new Error('locked'), { code: 'EACCES' }); };
  try { store.saveJobs({ j2: { jobId: 'j2' } }); } finally { fs.renameSync = orig; }
  assert.ok(n >= 3 && n <= 10);
  assert.deepStrictEqual(store.loadJobs(), { j2: { jobId: 'j2' } });
  assert.ok(!fs.existsSync(path.join(dir, '.jobs.json.tmp')));
});

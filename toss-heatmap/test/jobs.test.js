'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createJobManager } = require('../lib/jobs');

const ctx = { symbol: '005930', name: '삼성전자', market: 'KR', currency: 'KRW', today: '2026-11-25' };
const KEYS = { claude: 'sk-ant-SECRET', openai: 'sk-oai-SECRET', gemini: 'gem-SECRET' };
const tick = () => new Promise((r) => setImmediate(r));

function makeConfig(ai = KEYS, aiDemo = false) {
  const secrets = Object.values(ai).filter(Boolean);
  const cfg = { ai, aiDemo, models: { claudeQuick: 'cq', claudeDeep: 'cd', openaiQuick: 'oq', openaiDeep: 'od', geminiQuick: 'gq', geminiDeep: 'gd' }, deepResearchLimit: { enabled: true } };
  Object.defineProperty(cfg, 'secrets', { value: () => secrets, enumerable: false });
  return cfg;
}

// 직접 resolve/reject 할 수 있는 가짜 provider
function fakeProvider(id) {
  const p = { id, label: id, calls: [], pending: [] };
  p.run = (opts) => new Promise((resolve, reject) => {
    p.calls.push(opts);
    p.pending.push({ resolve, reject });
    opts.signal.addEventListener('abort', () => resolve({ provider: id, status: 'cancelled', sources: [], limitHit: false }));
  });
  p.complete = async () => '';
  p.finish = (i = 0, extra = {}) => p.pending[i].resolve({ provider: id, status: 'done', text: id + ' 보고서', sources: [], limitHit: false, ...extra });
  return p;
}

function memStore() {
  const s = { saved: [], jobs: {} };
  s.save = (r) => { s.saved.push(r); return 'rep-' + s.saved.length; };
  s.list = () => []; s.get = () => null;
  s.loadJobs = () => JSON.parse(JSON.stringify(s.jobs));
  s.saveJobs = (o) => { s.jobs = JSON.parse(JSON.stringify(o)); };
  return s;
}

const fakeSynth = async ({ results }) => {
  const done = results.filter((r) => r.status === 'done');
  if (!done.length) throw new Error('모든 AI가 실패했어요');
  return { writer: done[0].provider, crossChecked: done.length > 1, sources: [], conclusion: ['a', 'b', 'c'], why: '', outlook: {}, risks: '', views: [], disagreements: '', myPosition: null, summaries: {} };
};

function setup({ ai, aiDemo, synth = fakeSynth } = {}) {
  const fakes = { claude: fakeProvider('claude'), openai: fakeProvider('openai'), gemini: fakeProvider('gemini') };
  const store = memStore();
  const config = makeConfig(ai, aiDemo);
  const httpCalls = [];
  const http = async (o) => { httpCalls.push(o); throw new Error('network'); };
  const mgr = createJobManager({ config, providers: Object.values(fakes), synthesize: synth, store, http, now: () => new Date('2026-11-25T01:02:03Z'), demoDelayMs: 5 });
  return { fakes, store, config, mgr, httpCalls };
}

async function waitFor(fn, n = 50) { for (let i = 0; i < n; i++) { if (fn()) return; await tick(); } throw new Error('timeout'); }

test('runs three in parallel', async () => {
  const { fakes, mgr } = setup();
  const { jobId, existing } = mgr.start(ctx, 'quick');
  assert.strictEqual(existing, false);
  await tick();
  assert.ok(fakes.claude.calls.length && fakes.openai.calls.length && fakes.gemini.calls.length);
  const v = mgr.get(jobId);
  assert.strictEqual(v.status, 'running');
  for (const id of ['claude', 'openai', 'gemini']) assert.strictEqual(v.providers[id].status, 'running');
  assert.strictEqual(fakes.openai.calls[0].model, 'oq');
  assert.strictEqual(fakes.openai.calls[0].key, KEYS.openai);
});

test('deep mode uses deep models', async () => {
  const { fakes, mgr } = setup();
  mgr.start(ctx, 'deep');
  await tick();
  assert.strictEqual(fakes.gemini.calls[0].model, 'gd');
  assert.strictEqual(fakes.claude.calls[0].mode, 'deep');
});

test('one fails others continue', async () => {
  const { fakes, store, mgr } = setup();
  const { jobId } = mgr.start(ctx, 'quick');
  await tick();
  fakes.openai.pending[0].reject(new Error('boom'));
  fakes.claude.finish(); fakes.gemini.finish();
  await waitFor(() => mgr.get(jobId).status === 'done');
  const v = mgr.get(jobId);
  assert.strictEqual(v.providers.openai.status, 'failed');
  assert.strictEqual(v.providers.claude.status, 'done');
  assert.strictEqual(v.reportId, 'rep-1');
  assert.strictEqual(store.saved.length, 1);
  assert.strictEqual(store.saved[0].providers.openai.status, 'failed');
  assert.strictEqual(store.saved[0].providerTexts.claude, 'claude 보고서');
  assert.strictEqual(store.saved[0].symbol, '005930');
  assert.strictEqual(store.saved[0].createdAt, '2026-11-25T01:02:03.000Z');
  assert.deepStrictEqual(store.jobs, {});
});

test('missing key → skipped', async () => {
  const { fakes, mgr } = setup({ ai: { claude: 'k', openai: null, gemini: null } });
  const { jobId } = mgr.start(ctx, 'quick');
  await tick();
  assert.strictEqual(fakes.openai.calls.length, 0);
  const v = mgr.get(jobId);
  assert.strictEqual(v.providers.openai.status, 'skipped');
  assert.strictEqual(v.providers.openai.error, '키 없음');
  assert.strictEqual(v.providers.claude.status, 'running');
});

test('all providers failing makes the job failed', async () => {
  const { fakes, store, mgr } = setup({ ai: { claude: 'k', openai: null, gemini: null } });
  const { jobId } = mgr.start(ctx, 'quick');
  await tick();
  fakes.claude.pending[0].resolve({ provider: 'claude', status: 'failed', error: 'x', sources: [], limitHit: false });
  await waitFor(() => mgr.get(jobId).status === 'failed');
  assert.match(mgr.get(jobId).error, /모든 AI/);
  assert.strictEqual(store.saved.length, 0);
  assert.deepStrictEqual(store.jobs, {});
});

test('dedupe', async () => {
  const { fakes, mgr } = setup();
  const a = mgr.start(ctx, 'quick');
  const b = mgr.start(ctx, 'quick');
  assert.strictEqual(b.jobId, a.jobId);
  assert.strictEqual(b.existing, true);
  await tick();
  fakes.claude.finish(); fakes.openai.finish(); fakes.gemini.finish();
  await waitFor(() => mgr.get(a.jobId).status === 'done');
  const c = mgr.start(ctx, 'quick');
  assert.notStrictEqual(c.jobId, a.jobId);
  assert.strictEqual(c.existing, false);
});

test('cancel', async () => {
  const { fakes, store, mgr } = setup();
  const { jobId } = mgr.start(ctx, 'quick');
  await tick();
  assert.strictEqual(mgr.cancel(jobId), true);
  assert.ok(fakes.claude.calls[0].signal.aborted && fakes.openai.calls[0].signal.aborted);
  await waitFor(() => mgr.get(jobId).status === 'cancelled');
  assert.strictEqual(store.saved.length, 0);
  assert.deepStrictEqual(store.jobs, {});
  assert.strictEqual(mgr.cancel(jobId), false);
  assert.strictEqual(mgr.cancel('nope'), false);
});

test('handles are persisted via onHandle and removed at the end', async () => {
  const { fakes, store, mgr } = setup();
  const { jobId } = mgr.start(ctx, 'deep');
  await tick();
  assert.deepStrictEqual(store.jobs[jobId].handles, {});
  assert.strictEqual(store.jobs[jobId].symbol, '005930');
  fakes.openai.calls[0].onHandle('resp_1');
  assert.deepStrictEqual(store.jobs[jobId].handles, { openai: 'resp_1' });
  assert.ok(!JSON.stringify(store.jobs).includes('SECRET'));
  fakes.claude.finish(); fakes.openai.finish(); fakes.gemini.finish();
  await waitFor(() => mgr.get(jobId).status === 'done');
  assert.deepStrictEqual(store.jobs, {});
});

test('resume', async () => {
  const { fakes, store, mgr } = setup();
  store.jobs = { j1: { jobId: 'j1', symbol: '005930', mode: 'deep', ctx, handles: { openai: 'r1' } } };
  await mgr.resumeAll();
  await tick();
  assert.strictEqual(fakes.openai.calls[0].resume, 'r1');
  assert.strictEqual(fakes.gemini.calls[0].resume, undefined);
  assert.strictEqual(fakes.claude.calls.length, 1);
  const again = mgr.start(ctx, 'deep');
  assert.strictEqual(again.existing, true);
  assert.strictEqual(again.jobId, 'j1');
  assert.strictEqual(mgr.get('j1').status, 'running');
});

test('aiDemo makes no provider calls', async () => {
  const { fakes, store, mgr, httpCalls } = setup({ ai: { claude: null, openai: null, gemini: null }, aiDemo: true });
  const { jobId } = mgr.start(ctx, 'quick');
  await waitFor(() => mgr.get(jobId).status === 'done', 200).catch(() => {});
  await new Promise((r) => setTimeout(r, 30));
  assert.strictEqual(mgr.get(jobId).status, 'done');
  assert.ok(Object.values(fakes).every((f) => f.calls.length === 0));
  assert.strictEqual(httpCalls.length, 0);
  assert.strictEqual(store.saved.length, 1);
  assert.strictEqual(store.saved[0].conclusion.length, 3);
  assert.ok(store.saved[0].conclusion.every((l) => l.startsWith('[예시]')));
});

test('job view has no secrets', async () => {
  const { fakes, config, mgr } = setup();
  const { jobId } = mgr.start(ctx, 'quick');
  await tick();
  fakes.claude.finish(); fakes.openai.finish(); fakes.gemini.finish();
  await waitFor(() => mgr.get(jobId).status === 'done');
  const s = JSON.stringify(mgr.get(jobId));
  for (const k of config.secrets()) assert.ok(!s.includes(k));
  assert.strictEqual(mgr.get('unknown'), null);
});

function captureWarn() {
  const lines = []; const orig = console.warn;
  console.warn = (...a) => { lines.push(a.map(String).join(' ')); };
  return { lines, restore: () => { console.warn = orig; } };
}
function captureUncaught() {
  const errs = [];
  const h = (e) => errs.push(e);
  process.on('uncaughtException', h); process.on('unhandledRejection', h);
  return { errs, restore: () => { process.off('uncaughtException', h); process.off('unhandledRejection', h); } };
}

test('provider failure is logged with keys scrubbed', async () => {
  const w = captureWarn();
  try {
    const { fakes, mgr } = setup();
    const { jobId } = mgr.start(ctx, 'quick');
    await tick();
    fakes.openai.pending[0].reject(new Error('bad key ' + KEYS.openai));
    fakes.claude.pending[0].resolve({ provider: 'claude', status: 'failed', error: 'HTTP 401 ' + KEYS.claude, sources: [], limitHit: false });
    fakes.gemini.finish();
    await waitFor(() => mgr.get(jobId).status === 'done');
    const all = w.lines.join('\n');
    assert.ok(w.lines.some((l) => l.includes('ChatGPT') && l.includes('bad key ***')), all);
    assert.ok(w.lines.some((l) => l.includes('Claude') && l.includes('HTTP 401')), all);
    for (const k of Object.values(KEYS)) assert.ok(!all.includes(k));
  } finally { w.restore(); }
});

test('saveJobs throwing never breaks the job', async () => {
  const w = captureWarn(); const u = captureUncaught();
  try {
    const { fakes, store, mgr } = setup();
    store.saveJobs = () => { throw Object.assign(new Error('EPERM rename'), { code: 'EPERM' }); };
    const { jobId } = mgr.start(ctx, 'deep');
    await tick();
    assert.doesNotThrow(() => fakes.openai.calls[0].onHandle('resp_1'));
    fakes.claude.finish(); fakes.openai.finish(); fakes.gemini.finish();
    await waitFor(() => mgr.get(jobId).status === 'done');
    assert.strictEqual(store.saved.length, 1);
    await new Promise((r) => setTimeout(r, 10));
    assert.deepStrictEqual(u.errs, []);
  } finally { w.restore(); u.restore(); }
});

test('store.save throwing in demo mode → job failed, no uncaught exception', async () => {
  const w = captureWarn(); const u = captureUncaught();
  try {
    const { store, mgr } = setup({ ai: { claude: null, openai: null, gemini: null }, aiDemo: true });
    store.save = () => { throw new Error('disk full'); };
    const { jobId } = mgr.start(ctx, 'quick');
    await new Promise((r) => setTimeout(r, 40));
    assert.strictEqual(mgr.get(jobId).status, 'failed');
    assert.deepStrictEqual(u.errs, []);
  } finally { w.restore(); u.restore(); }
});

test('billing errors become friendly Korean in the job view and for synthesis', async () => {
  let seen = null;
  const synth = async (o) => { seen = o.results; throw new Error('모든 AI가 실패했어요'); };
  const { fakes, mgr } = setup({ synth });
  const { jobId } = mgr.start(ctx, 'quick');
  await tick();
  const warn = console.warn; console.warn = () => {};
  try {
    fakes.claude.pending[0].resolve({ provider: 'claude', status: 'failed', sources: [], limitHit: false, error: 'HTTP 400: Your credit balance is too low to access the Anthropic API.' });
    fakes.openai.pending[0].resolve({ provider: 'openai', status: 'failed', sources: [], limitHit: false, error: 'HTTP 429: You have no credits remaining.' });
    fakes.gemini.pending[0].resolve({ provider: 'gemini', status: 'failed', sources: [], limitHit: false, error: 'HTTP 429: Rate limit exceeded (limit: 0 input tokens per minute on Free Tier).' });
    await waitFor(() => mgr.get(jobId).status === 'failed');
  } finally { console.warn = warn; }
  const v = mgr.get(jobId);
  assert.match(v.providers.claude.error, /크레딧/);
  assert.match(v.providers.openai.error, /크레딧/);
  assert.match(v.providers.gemini.error, /무료 키/);
  assert.match(seen.find((r) => r.provider === 'claude').error, /크레딧/);
});

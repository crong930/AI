'use strict';
// 분석 작업 관리: 세 AI를 동시에 돌리고, 같은 종목 중복을 막고, 취소/재시작 후 이어받기를 해요.
const crypto = require('crypto');
const { demoReport } = require('./demo-report');
const { researchPrompt, LABEL } = require('./prompts');
const { friendlyError } = require('./friendly-error');

const ORDER = ['claude', 'openai', 'gemini'];
const cap = (s) => s[0].toUpperCase() + s.slice(1);

function createJobManager({ config, providers, synthesize, store, http, now = () => new Date(), demoDelayMs = 3000 }) {
  const list = Array.isArray(providers) ? providers : Object.values(providers);
  const byId = Object.fromEntries(list.map((p) => [p.id, p]));
  const ids = ORDER.filter((id) => byId[id]);
  const jobs = new Map();      // id → job (끝난 것도 get()용으로 보관)
  const active = new Map();    // symbol → job (실행 중인 것만)

  const scrub = (msg) => config.secrets().reduce((m, s) => (s ? m.split(s).join('***') : m), String(msg));
  const keyOf = (id) => config.ai[id] || null;
  const modelOf = (id, mode) => config.models[id + cap(mode === 'deep' ? 'deep' : 'quick')];

  function persist() {
    const out = {};
    for (const j of active.values()) out[j.id] = { jobId: j.id, symbol: j.symbol, mode: j.mode, ctx: j.ctx, handles: { ...j.handles } };
    // 저장이 실패해도(Windows 파일 잠금 등) 분석은 계속해요. 이어받기만 안 될 뿐이에요.
    try { store.saveJobs(out); } catch (e) { console.warn('[분석] 진행 상태 저장 실패: ' + scrub(e && e.message)); }
  }

  function finish(job, status, extra = {}) {
    job.status = status;
    Object.assign(job, extra);
    if (active.get(job.symbol) === job) active.delete(job.symbol);
    persist();
  }

  function newJob(id, ctx, mode, handles) {
    const job = {
      id, ctx, symbol: ctx.symbol, name: ctx.name, mode, status: 'running', startedAt: now().toISOString(),
      handles: { ...handles }, providers: {}, controller: new AbortController(), timers: [],
    };
    for (const id2 of ids) job.providers[id2] = keyOf(id2) || config.aiDemo ? { status: 'waiting' } : { status: 'skipped', error: '키 없음' };
    jobs.set(id, job);
    active.set(job.symbol, job);
    persist();
    (config.aiDemo ? runDemo : runReal)(job).catch((e) => {
      try {
        if (job.status === 'running' || job.status === 'synthesizing') finish(job, 'failed', { error: scrub(e && e.message) });
      } catch (e2) { console.warn('[분석] 작업 마무리 실패: ' + scrub(e2 && e2.message)); }
    });
    return job;
  }

  function buildReport(job, final, results) {
    const provs = {}; const texts = {};
    for (const [id, p] of Object.entries(job.providers)) {
      provs[id] = { status: p.status, limitHit: !!p.limitHit };
      if (p.error) provs[id].error = p.error;
    }
    for (const r of results) if (r.status === 'done' && r.text) texts[r.provider] = r.text;
    return { ...final, symbol: job.symbol, name: job.name, mode: job.mode, createdAt: job.startedAt, providers: provs, providerTexts: texts };
  }

  async function runReal(job) {
    const { signal } = job.controller;
    const running = ids.filter((id) => keyOf(id));
    for (const id of running) job.providers[id] = { status: 'running' };
    const results = await Promise.all(running.map(async (id) => {
      let r;
      try {
        r = await byId[id].run({
          key: keyOf(id), model: modelOf(id, job.mode), mode: job.mode, prompt: researchPrompt(job.ctx, job.mode),
          limits: config.deepResearchLimit, signal, http, resume: job.handles[id],
          onHandle: (h) => { job.handles[id] = h; persist(); },
        });
      } catch (e) {
        r = { provider: id, status: signal.aborted ? 'cancelled' : 'failed', error: scrub(e.message), sources: [], limitHit: false };
      }
      if (job.status === 'cancelled') return r;
      const p = { status: r.status, limitHit: !!r.limitHit };
      // 로그에는 원문(키 지움)을, 화면과 보고서에는 쉬운 안내를 남겨요.
      const raw = r.error ? scrub(r.error) : null;
      if (r.status === 'failed') console.warn('[분석] ' + (LABEL[id] || id) + ' 실패: ' + (raw || '이유 없음'));
      if (raw) { p.error = friendlyError(id, raw); r = { ...r, error: p.error }; }
      job.providers[id] = p;
      return r;
    }));
    if (job.status === 'cancelled') return;
    job.status = 'synthesizing';
    const writers = running.map((id) => ({ provider: byId[id], key: keyOf(id), model: modelOf(id, 'quick') }));
    let final;
    try {
      final = await synthesize({ ctx: job.ctx, results, writers, http, signal });
    } catch (e) {
      if (job.status !== 'cancelled') finish(job, 'failed', { error: scrub(e.message) });
      return;
    }
    if (job.status === 'cancelled') return;
    finish(job, 'done', { reportId: store.save(buildReport(job, final, results)) });
  }

  function runDemo(job) {
    return new Promise((resolve) => {
      for (const id of ids) job.providers[id] = { status: 'running' };
      const half = setTimeout(() => {
        for (const id of ids) job.providers[id] = { status: 'done', limitHit: false };
        job.status = 'synthesizing';
      }, demoDelayMs / 2);
      const end = setTimeout(() => {
        try {
          const final = demoReport(job.ctx, job.mode);
          finish(job, 'done', { reportId: store.save(buildReport(job, final, [])) });
        } catch (e) {
          try { finish(job, 'failed', { error: '보고서를 저장하지 못했어요: ' + scrub(e && e.message) }); } catch (_) {}
        }
        resolve();
      }, demoDelayMs);
      job.timers.push(half, end);
      job.resolveDemo = resolve;
    });
  }

  return {
    start(ctx, mode) {
      const cur = active.get(ctx.symbol);
      if (cur) return { jobId: cur.id, existing: true };
      return { jobId: newJob('j' + crypto.randomBytes(6).toString('hex'), ctx, mode, {}).id, existing: false };
    },
    get(id) {
      const j = jobs.get(id);
      if (!j) return null;
      const v = { id: j.id, symbol: j.symbol, name: j.name, mode: j.mode, status: j.status, startedAt: j.startedAt, providers: JSON.parse(JSON.stringify(j.providers)) };
      if (j.reportId) v.reportId = j.reportId;
      if (j.error) v.error = j.error;
      return v;
    },
    cancel(id) {
      const j = jobs.get(id);
      if (!j || (j.status !== 'running' && j.status !== 'synthesizing')) return false;
      j.timers.forEach(clearTimeout);
      for (const p of Object.values(j.providers)) if (p.status === 'waiting' || p.status === 'running') p.status = 'cancelled';
      finish(j, 'cancelled');
      j.controller.abort();
      if (j.resolveDemo) j.resolveDemo();
      return true;
    },
    async resumeAll() {
      const saved = store.loadJobs();
      for (const e of Object.values(saved)) {
        if (!e || !e.ctx || !e.ctx.symbol || active.has(e.ctx.symbol) || jobs.has(e.jobId)) continue;
        newJob(e.jobId, e.ctx, e.mode === 'deep' ? 'deep' : 'quick', e.handles || {});
      }
    },
  };
}

module.exports = { createJobManager };

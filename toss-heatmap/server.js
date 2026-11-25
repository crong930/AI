// 토스증권 보유 종목 히트맵 - 내 컴퓨터에서만 도는 조회 전용 서버
// 주문/정정/취소 API는 일부러 하나도 호출하지 않습니다. (조회 전용)
// 필요: Node.js 18 이상. 외부 패키지 없음.

'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { requestJson } = require('./lib/http');
const { createStore } = require('./lib/report-store');
const { buildContext } = require('./lib/context');
const { createJobManager } = require('./lib/jobs');
const { synthesize } = require('./lib/synthesize');
const { checkPost, MAX_BODY } = require('./lib/guard');

const ROOT = __dirname;
const API = 'https://openapi.tossinvest.com';
const CONFIG_PATH = path.join(ROOT, 'config.json');
const SECTOR_CACHE = path.join(ROOT, '.sector-cache.json');

// ---------- 설정 ----------
const { loadConfig } = require('./lib/config');
let cfg;
try { cfg = loadConfig({ path: CONFIG_PATH, env: process.env, argv: process.argv }); }
catch (e) { console.error('[오류] config.json 형식이 잘못됐어요: ' + e.message); process.exit(1); }

// ---------- 토스 API 호출 ----------
let token = null; // {value, expiresAt}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getToken() {
  if (token && Date.now() < token.expiresAt - 5 * 60 * 1000) return token.value;
  const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: cfg.clientId, client_secret: cfg.clientSecret });
  const res = await fetch(API + '/oauth2/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    const why = data.error_description || data.error || ('HTTP ' + res.status);
    throw new ApiErr('토큰 발급 실패: ' + why + (res.status === 403 ? ' (이 컴퓨터의 IP가 토스증권 Open API 허용 IP에 등록돼 있는지 확인해 주세요)' : ''), res.status);
  }
  token = { value: data.access_token, expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000 };
  return token.value;
}

class ApiErr extends Error { constructor(msg, status, code) { super(msg); this.status = status; this.code = code; } }

async function call(pathAndQuery, { account, retry = 2 } = {}) {
  const headers = { Authorization: 'Bearer ' + (await getToken()), Accept: 'application/json' };
  if (account != null) headers['X-Tossinvest-Account'] = String(account);
  const res = await fetch(API + pathAndQuery, { headers });
  if (res.status === 429 && retry > 0) {
    const wait = Number(res.headers.get('retry-after')) || 1;
    await sleep(wait * 1000);
    return call(pathAndQuery, { account, retry: retry - 1 });
  }
  if (res.status === 401 && retry > 0) { token = null; return call(pathAndQuery, { account, retry: retry - 1 }); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = data.error || {};
    let msg = (e.message || e.code || ('HTTP ' + res.status)) + ' [' + pathAndQuery.split('?')[0] + ']';
    if (res.status === 403) msg += ' (허용 IP 등록 여부를 확인해 주세요)';
    throw new ApiErr(msg, res.status, e.code);
  }
  return data.result;
}

// ---------- 계좌/섹터 캐시 ----------
let accountSeq = null;
async function getAccount() {
  if (accountSeq != null) return accountSeq;
  if (cfg.accountSeq) return (accountSeq = cfg.accountSeq);
  const list = await call('/api/v1/accounts');
  const acc = (list || []).find((a) => a.accountType === 'BROKERAGE') || (list || [])[0];
  if (!acc) throw new ApiErr('조회 가능한 계좌가 없어요.', 404);
  accountSeq = acc.accountSeq;
  return accountSeq;
}

let sectorMap = null; // symbol -> sector name
let sectorBuilding = null;
function loadSectorCache() {
  try {
    const c = JSON.parse(fs.readFileSync(SECTOR_CACHE, 'utf8'));
    if (Date.now() - c.at < 24 * 3600 * 1000) return c.map;
  } catch (_) {}
  return null;
}
async function buildSectorMap() {
  const res = await call('/api/v1/sectors');
  const top = (res.sectors || []).filter((s) => s.depth === 0);
  const map = {};
  for (const s of top) {
    for (const mc of ['KR', 'US']) {
      try {
        const r = await call('/api/v1/sectors/' + encodeURIComponent(s.sectorId) + '/stocks?marketCountry=' + mc);
        for (const st of r.stocks || []) if (!map[st.symbol]) map[st.symbol] = s.name;
      } catch (e) { if (e.status !== 404) console.warn('[섹터] ' + s.name + ' ' + mc + ': ' + e.message); }
      await sleep(400);
    }
  }
  fs.writeFileSync(SECTOR_CACHE, JSON.stringify({ at: Date.now(), map }));
  return map;
}
function ensureSectors() {
  if (sectorMap) return;
  sectorMap = loadSectorCache();
  if (sectorMap || sectorBuilding) return;
  console.log('[섹터] 토스증권 섹터 분류를 처음 불러오는 중이에요 (1~2분, 하루 한 번)...');
  sectorBuilding = buildSectorMap()
    .then((m) => { sectorMap = m; console.log('[섹터] 완료: ' + Object.keys(m).length + '개 종목 분류'); })
    .catch((e) => console.warn('[섹터] 불러오지 못했어요. 국내/미국으로만 묶을게요: ' + e.message))
    .finally(() => { sectorBuilding = null; });
}

let typeCache = {}; // symbol -> securityType
async function ensureTypes(symbols) {
  const missing = symbols.filter((s) => !(s in typeCache));
  if (!missing.length) return;
  try {
    const r = await call('/api/v1/stocks?symbols=' + encodeURIComponent(missing.join(',')));
    for (const s of r || []) typeCache[s.symbol] = s.securityType;
  } catch (_) {}
  for (const s of missing) if (!(s in typeCache)) typeCache[s] = null;
}

function sectorOf(item) {
  if (cfg.sectorOverrides[item.symbol]) return cfg.sectorOverrides[item.symbol];
  if (sectorMap && sectorMap[item.symbol]) return sectorMap[item.symbol];
  const t = typeCache[item.symbol];
  if (t && /ETF|ETN/.test(t)) return item.marketCountry === 'US' ? '미국 ETF' : '국내 ETF';
  return item.marketCountry === 'US' ? '미국 기타' : '국내 기타';
}

// ---------- 스냅샷 ----------
const num = (v) => (v == null || v === '' ? null : Number(v));
let usdRateCache = { at: 0, rate: null };

async function snapshot() {
  const acc = await getAccount();
  ensureSectors();
  const [h, krw, usd] = await Promise.all([
    call('/api/v1/holdings', { account: acc }),
    call('/api/v1/buying-power?currency=KRW', { account: acc }).catch(() => null),
    call('/api/v1/buying-power?currency=USD', { account: acc }).catch(() => null),
  ]);
  if (Date.now() - usdRateCache.at > 60 * 1000) {
    try {
      const fx = await call('/api/v1/exchange-rate?baseCurrency=USD&quoteCurrency=KRW');
      usdRateCache = { at: Date.now(), rate: num(fx.midRate) || num(fx.rate) };
    } catch (_) {}
  }
  const fx = usdRateCache.rate;
  const items = h.items || [];
  await ensureTypes(items.map((i) => i.symbol));
  const toKrw = (v, cur) => (v == null ? null : cur === 'USD' ? (fx ? v * fx : null) : v);

  const positions = items.map((i) => {
    const cur = i.currency;
    const value = num(i.marketValue && i.marketValue.amount);
    const cost = num(i.marketValue && i.marketValue.purchaseAmount);
    const pnl = num(i.profitLoss && i.profitLoss.amount);
    const dpl = num(i.dailyProfitLoss && i.dailyProfitLoss.amount);
    return {
      symbol: i.symbol, name: i.name, market: i.marketCountry, currency: cur, sector: sectorOf(i),
      quantity: num(i.quantity), lastPrice: num(i.lastPrice), avgPrice: num(i.averagePurchasePrice),
      value, cost, pnl, valueKrw: toKrw(value, cur), costKrw: toKrw(cost, cur), pnlKrw: toKrw(pnl, cur),
      returnRate: num(i.profitLoss && i.profitLoss.rate), dailyRate: num(i.dailyProfitLoss && i.dailyProfitLoss.rate), dailyPnlKrw: toKrw(dpl, cur),
    };
  });

  const sum = (o) => (o ? (num(o.krw) || 0) + (num(o.usd) && fx ? num(o.usd) * fx : 0) : null);
  const cashKrw = krw ? num(krw.cashBuyingPower) : null;
  const cashUsd = usd ? num(usd.cashBuyingPower) : null;
  const stockKrw = sum(h.marketValue && h.marketValue.amount);
  return {
    at: new Date().toISOString(), demo: false, usdKrw: fx,
    totals: {
      valueKrw: stockKrw, costKrw: sum(h.totalPurchaseAmount), pnlKrw: sum(h.profitLoss && h.profitLoss.amount),
      returnRate: num(h.profitLoss && h.profitLoss.rate), dailyPnlKrw: sum(h.dailyProfitLoss && h.dailyProfitLoss.amount),
      dailyRate: num(h.dailyProfitLoss && h.dailyProfitLoss.rate),
      cashKrw, cashUsd, cashTotalKrw: (cashKrw || 0) + (cashUsd && fx ? cashUsd * fx : 0),
    },
    positions,
  };
}

async function candles(q) {
  const symbol = String(q.get('symbol') || '');
  if (!/^[A-Za-z0-9.\-]{1,15}$/.test(symbol)) throw new ApiErr('종목 심볼이 올바르지 않아요.', 400);
  const interval = q.get('interval') === '1m' ? '1m' : '1d';
  const count = Math.min(200, Math.max(10, Number(q.get('count')) || (interval === '1d' ? 120 : 200)));
  const r = await call('/api/v1/candles?symbol=' + encodeURIComponent(symbol) + '&interval=' + interval + '&count=' + count + '&adjusted=true');
  return (r.candles || []).map((c) => ({ t: c.timestamp, o: num(c.openPrice), h: num(c.highPrice), l: num(c.lowPrice), c: num(c.closePrice), v: num(c.volume) }))
    .sort((a, b) => (a.t < b.t ? -1 : 1));
}

// ---------- 데모 데이터 (config.json 없을 때) ----------
const DEMO = [
  ['005930', '삼성전자', 'KR', 'KRW', 'IT 하드웨어', 120, 58000, 96500], ['000660', 'SK하이닉스', 'KR', 'KRW', 'IT 하드웨어', 15, 128000, 478000],
  ['NVDA', '엔비디아', 'US', 'USD', 'IT 하드웨어', 25, 82, 181], ['035420', 'NAVER', 'KR', 'KRW', '소프트웨어', 20, 215000, 238000],
  ['035720', '카카오', 'KR', 'KRW', '소프트웨어', 60, 61000, 52800], ['GOOGL', '알파벳 A', 'US', 'USD', '소프트웨어', 12, 158, 289],
  ['373220', 'LG에너지솔루션', 'KR', 'KRW', '2차전지', 8, 420000, 362000], ['TSLA', '테슬라', 'US', 'USD', '자동차', 5, 350, 402],
  ['005380', '현대차', 'KR', 'KRW', '자동차', 15, 205000, 246000], ['105560', 'KB금융', 'KR', 'KRW', '금융', 30, 72000, 118000],
  ['068270', '셀트리온', 'KR', 'KRW', '헬스케어', 12, 185000, 171000],
];
const demoDrift = {};
function demoSnapshot() {
  const fx = 1460;
  const positions = DEMO.map(([symbol, name, market, currency, sector, q, avg, base]) => {
    demoDrift[symbol] = (demoDrift[symbol] || 0) + (Math.random() - 0.5) * 0.004;
    const last = +(base * (1 + demoDrift[symbol])).toFixed(currency === 'USD' ? 2 : 0);
    const k = currency === 'USD' ? fx : 1;
    const value = q * last, cost = q * avg, daily = demoDrift[symbol] + 0.01 * Math.sin(symbol.length);
    return { symbol, name, market, currency, sector, quantity: q, lastPrice: last, avgPrice: avg, value, cost, pnl: value - cost,
      valueKrw: value * k, costKrw: cost * k, pnlKrw: (value - cost) * k, returnRate: last / avg - 1, dailyRate: daily, dailyPnlKrw: value * k * daily / (1 + daily) };
  });
  const s = (f) => positions.reduce((a, p) => a + p[f], 0);
  return { at: new Date().toISOString(), demo: true, usdKrw: fx,
    totals: { valueKrw: s('valueKrw'), costKrw: s('costKrw'), pnlKrw: s('pnlKrw'), returnRate: s('valueKrw') / s('costKrw') - 1,
      dailyPnlKrw: s('dailyPnlKrw'), dailyRate: s('dailyPnlKrw') / (s('valueKrw') - s('dailyPnlKrw')), cashKrw: 3250000, cashUsd: 412.5, cashTotalKrw: 3250000 + 412.5 * fx },
    positions };
}
function demoCandles(q) {
  const p = DEMO.find((d) => d[0] === q.get('symbol')) || DEMO[0];
  const intraday = q.get('interval') === '1m', n = intraday ? 200 : 120, out = [];
  let c = p[7] * 0.8;
  for (let i = n - 1; i >= 0; i--) {
    const o = c; c = o * (1 + (Math.random() - 0.47) * (intraday ? 0.003 : 0.025));
    out.push({ t: new Date(Date.now() - i * (intraday ? 60e3 : 86400e3)).toISOString(), o, h: Math.max(o, c) * 1.005, l: Math.min(o, c) * 0.995, c, v: Math.round(Math.random() * 1e6) });
  }
  return out;
}

// ---------- 웹 서버 (127.0.0.1 전용) ----------
const send = (res, status, body, type = 'application/json; charset=utf-8') => {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};
const SYMBOL_RE = /^[A-Za-z0-9.\-]{1,15}$/;
const JOB_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const localDate = (d = new Date()) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');

// AI 공급자가 쓰는 http: 모든 키를 오류 메시지에서 지워줘요.
function makeHttp(c, request = requestJson) { return (o) => request({ ...o, secrets: c.secrets() }); }

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size <= MAX_BODY) chunks.push(c); });
    req.on('end', () => resolve(size > MAX_BODY ? 'x'.repeat(MAX_BODY + 1) : Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function createServer(deps = {}) {
  const c = deps.cfg || cfg;
  const jobs = deps.jobs, store = deps.store;
  const snap = deps.snapshot || snapshot;
  const demoSnap = deps.demoSnapshot || demoSnapshot;
  const srv = http.createServer(async (req, res) => {
    // DNS 리바인딩 막기: 이 PC 주소(localhost/127.0.0.1 + 실제 포트)로 들어온 요청만 받아요.
    const port = srv.address().port;
    const host = String(req.headers.host || '').toLowerCase();
    if (host !== 'localhost:' + port && host !== '127.0.0.1:' + port) return send(res, 403, { error: '이 컴퓨터의 주소(localhost)로만 열 수 있어요.' });
    const url = new URL(req.url, 'http://localhost');
    try {
      if (req.method === 'POST' && (url.pathname === '/api/analyze' || /^\/api\/jobs\/[^/]+\/cancel$/.test(url.pathname))) {
        const bodyText = await readBody(req);
        const bad = checkPost(req, bodyText, srv.address().port);
        if (bad) return send(res, bad.status, { error: bad.error });
        if (url.pathname === '/api/analyze') {
          let b;
          try { b = JSON.parse(bodyText); } catch (_) { b = null; }
          const symbol = b && typeof b.symbol === 'string' ? b.symbol : '';
          if (!SYMBOL_RE.test(symbol)) return send(res, 400, { error: '종목 심볼이 올바르지 않아요.' });
          if (b.mode !== 'quick' && b.mode !== 'deep') return send(res, 400, { error: '분석 방식이 올바르지 않아요.' });
          const ctx = buildContext(c.demo ? demoSnap() : await snap(), symbol, { includePosition: !c.demo, today: localDate() });
          if (!ctx) return send(res, 404, { error: '보유하지 않은 종목이에요' });
          return send(res, 200, jobs.start(ctx, b.mode));
        }
        const id = url.pathname.split('/')[3];
        if (!JOB_ID_RE.test(id) || !jobs.cancel(id)) return send(res, 404, { error: '진행 중인 분석을 찾을 수 없어요.' });
        return send(res, 200, { ok: true });
      }
      if (req.method !== 'GET') return send(res, 405, { error: '지원하지 않는 요청이에요.' });
      if (url.pathname === '/' || url.pathname === '/index.html') return send(res, 200, fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8'), 'text/html; charset=utf-8');
      if (url.pathname === '/icon.svg') return send(res, 200, fs.readFileSync(path.join(ROOT, 'icon.svg'), 'utf8'), 'image/svg+xml');
      if (url.pathname === '/favicon.ico') return send(res, 200, fs.readFileSync(path.join(ROOT, 'icon.ico')), 'image/x-icon');
      if (url.pathname === '/d3.min.js') return send(res, 200, fs.readFileSync(path.join(ROOT, 'd3.min.js'), 'utf8'), 'text/javascript; charset=utf-8');
      if (url.pathname === '/api/config') return send(res, 200, { refreshSeconds: c.refreshSeconds, demo: c.demo });
      if (url.pathname === '/api/snapshot') return send(res, 200, c.demo ? demoSnap() : await snap());
      if (url.pathname === '/api/candles') return send(res, 200, c.demo ? demoCandles(url.searchParams) : await candles(url.searchParams));
      if (url.pathname === '/api/ai/status') return send(res, 200, { aiDemo: !!c.aiDemo, tossDemo: !!c.demo, providers: { claude: !!c.ai.claude, openai: !!c.ai.openai, gemini: !!c.ai.gemini } });
      if (url.pathname === '/api/reports') {
        const s = url.searchParams.get('symbol');
        return send(res, 200, store.list(s && SYMBOL_RE.test(s) ? s : undefined));
      }
      let m = url.pathname.match(/^\/api\/jobs\/([^/]+)$/);
      if (m) { const v = JOB_ID_RE.test(m[1]) ? jobs.get(m[1]) : null; return v ? send(res, 200, v) : send(res, 404, { error: '분석을 찾을 수 없어요.' }); }
      m = url.pathname.match(/^\/api\/reports\/([^/]+)$/);
      if (m) { const r = store.get(m[1]); return r ? send(res, 200, r) : send(res, 404, { error: '보고서를 찾을 수 없어요.' }); }
      send(res, 404, { error: 'not found' });
    } catch (e) {
      console.error('[오류] ' + e.message);
      send(res, e.status && e.status < 600 ? (e.status >= 500 ? 502 : e.status) : 500, { error: e.message });
    }
  });
  return srv;
}

// AI 키가 있으면(토스가 데모 모드여도) 멈췄던 분석을 이어받아요.
function resumeOnBoot({ cfg: c, jobs, store, log = console.log }) {
  if (c.aiDemo) return Promise.resolve();
  const n = Object.keys(store.loadJobs()).length;
  return jobs.resumeAll().then(() => { if (n) log('  이어받은 분석 ' + n + '개'); }).catch((e) => console.warn('[이어받기] ' + e.message));
}

module.exports = { createServer, makeHttp, resumeOnBoot };

if (require.main === module) {
  const store = createStore(path.join(ROOT, 'reports'));
  const jobs = createJobManager({
    config: cfg, store, synthesize, http: makeHttp(cfg),
    providers: [require('./lib/providers/claude'), require('./lib/providers/openai'), require('./lib/providers/gemini')],
  });
  const server = createServer({ cfg, jobs, store });
  server.listen(cfg.port, '127.0.0.1', () => {
    const u = 'http://localhost:' + cfg.port;
    console.log('');
    console.log(cfg.demo ? '  [데모 모드] config.json에 키가 없어서 예시 데이터로 띄웠어요.' : '  토스증권 계좌에 연결했어요. (조회 전용)');
    console.log(cfg.aiDemo ? '  [AI 데모] AI 키가 없어서 예시 분석 보고서로 보여드려요.' : '  AI 분석을 쓸 수 있어요.');
    console.log('  브라우저에서 열기: ' + u);
    console.log('  끄려면 이 창에서 Ctrl+C');
    console.log('');
    resumeOnBoot({ cfg, jobs, store });
    // 숨겨서 켰을 때 stop-hidden.vbs가 이 프로그램만 끌 수 있게 번호(PID)를 남겨요.
    const pidFile = path.join(ROOT, '.server.pid');
    try { fs.writeFileSync(pidFile, String(process.pid)); } catch (_) {}
    const clean = () => { try { if (fs.readFileSync(pidFile, 'utf8') === String(process.pid)) fs.unlinkSync(pidFile); } catch (_) {} };
    process.on('exit', clean);
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(sig, () => process.exit(0));
    if (!process.argv.includes('--no-open')) {
      const { exec } = require('child_process');
      const cmd = process.platform === 'win32' ? 'start "" "' + u + '"' : process.platform === 'darwin' ? 'open ' + u : 'xdg-open ' + u;
      exec(cmd, () => {});
    }
  });
  server.on('error', (e) => { console.error('[오류] 서버를 열 수 없어요: ' + e.message + (e.code === 'EADDRINUSE' ? ' (이미 켜져 있거나 포트 ' + cfg.port + '을 다른 프로그램이 쓰는 중)' : '')); process.exit(1); });
}

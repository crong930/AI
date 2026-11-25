# AI 주식 포트폴리오 (토스 히트맵 + 종목 AI 분석) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-stock "⚡빠른 분석 / 🔬딥 리서치" to the existing local Toss heatmap. Three AIs (Claude, ChatGPT, Gemini) analyze the stock, one AI cross-checks them into a final report, and the result is saved on the PC.

**Architecture:** Keep the no-dependency Node server. New logic lives in small modules under `toss-heatmap/lib/`, which `server.js` wires to new HTTP routes. Each AI provider exposes one `run()` function with an injectable HTTP layer so tests never touch the network. A `JobManager` runs the providers in parallel, persists provider job ids for resume, and calls the synthesizer, then the report store.

**Tech Stack:** Node 18+ built-ins only (`node:https`, `node:fs`, `node:test`), vanilla JS + d3 in `index.html`. Raw HTTPS to the Anthropic, OpenAI and Gemini REST APIs. No SDKs, because the approved design forbids external packages (the beginner runs `start-windows.bat` with no `npm install`).

**Spec:** `docs/superpowers/specs/2026-11-25-ai-stock-portfolio-design.md`

## Global Constraints

- Node 18+, **no external packages**, no `npm install` step. Tests run with `node --test toss-heatmap/test/`.
- Read-only toward Toss: never call order, amend or cancel endpoints.
- Server listens on `127.0.0.1` only. Every POST requires `Origin` ∈ {`http://localhost:<port>`, `http://127.0.0.1:<port>`} and `Content-Type: application/json`, with a body ≤ 10 KB. Otherwise return 403/415/413.
- Data sent to AIs: symbol, name, market, currency, lastPrice, avgPrice, returnRate, dailyRate, weightPct. **Never** quantity, value/cost/pnl amounts, cash, account, or keys.
- Keys come only from `config.json` (`anthropicApiKey`, `openaiApiKey`, `geminiApiKey`). They must never appear in reports, `.jobs.json`, HTTP responses, or console logs.
- User-facing text is Korean, matching the existing tone ("~해요").
- Deep research: confirm dialog with "약 1만~2만 5천 원, 최대 약 3만 원" before starting. Hard limits come from `config.deepResearchLimit`.
- At most one running job per symbol. A second start returns the existing job (HTTP 200 `{jobId, existing:true}`).
- Never overwrite the user's `config.json`, `.sector-cache.json`, or `reports/` on the PC.

## Review Focus

1. **One provider fails or has no key:** the job still finishes with the others, the failure is shown per AI, and the final report says "교차 검증 못 함" when only one succeeded. Covered by tests in Task 5.
2. **Final writer is unavailable:** if Claude is missing or fails, ChatGPT and then Gemini synthesize, and the synthesizer's JSON may be malformed. Covered by tests in Task 4 (lenient parse → markdown fallback) and Task 5 (fallback order).
3. **Server restart mid-deep-research:** `.jobs.json` holds OpenAI/Gemini handles. On restart they are polled again, not restarted, and the duplicate guard still holds. Covered by a test in Task 5.
4. **Malicious or odd POST:** a cross-origin page, an oversized body, or a bad symbol like `../x` must not start a job or touch the filesystem. Covered by tests in Task 6 (guard) and Task 3 (report id/symbol sanitising).
5. **Key leakage:** a provider error body echoing the request must not put the key into job state or logs. Covered by a test in Task 2 (error messages are scrubbed of every configured key).

---

### Task 1: Bring v1 into the repo + config module

**Files:**
- Create: `toss-heatmap/` (copy of `/mnt/user-data/uploads/toss-heatmap/*`: server.js, index.html, d3.min.js, d3-LICENSE.txt, README.md, config.example.json, start-windows.bat, start-mac.command)
- Create: `toss-heatmap/.gitignore` (`config.json`, `.sector-cache.json`, `reports/`)
- Create: `toss-heatmap/lib/config.js`
- Modify: `toss-heatmap/server.js` (replace inline `loadConfig` with the module)
- Modify: `toss-heatmap/config.example.json`
- Test: `toss-heatmap/test/config.test.js`

**Interfaces:**
- Produces: `loadConfig({ path, env, argv }) -> Config`, where `Config` = existing fields plus `ai: { claude: string|null, openai: string|null, gemini: string|null }`, `models: {claudeQuick, claudeDeep, openaiQuick, openaiDeep, geminiQuick, geminiDeep}`, `deepResearchLimit: { enabled: bool, claudeMaxSearches: number, openaiMaxToolCalls: number, timeoutMinutes: number }`, `aiDemo: bool` (true when all three keys are null), and `secrets(): string[]` (all non-empty keys, used for scrubbing).

- [ ] **Step 1:** Copy the v1 files into `toss-heatmap/` and commit them as-is (`chore: import toss-heatmap v1`), so later diffs show only the new work.
- [ ] **Step 2: Write the failing tests** in `test/config.test.js`:
  - `placeholder keys count as missing`: an AI key value containing "여기에" gives `ai.claude === null`, and with all three missing, `aiDemo === true`.
  - `defaults`: `models.claudeQuick === 'claude-opus-5-5'`, `models.claudeDeep === 'claude-opus-5-5'`, `models.openaiQuick === 'gpt-5'`, `models.openaiDeep === 'o3-deep-research'`, `models.geminiQuick === 'gemini-3.1-pro-preview'`, `models.geminiDeep === 'deep-research-preview-04-2026'`, and `deepResearchLimit` deep-equals `{enabled:true, claudeMaxSearches:30, openaiMaxToolCalls:40, timeoutMinutes:30}`.
  - `user overrides merge`: `{"models":{"openaiQuick":"x"}}` changes only that field.
  - `toss demo independent of ai`: Toss keys missing but `openaiApiKey` set gives `demo === true`, `aiDemo === false`.
  - `secrets()` returns exactly the non-null Toss and AI keys.
- [ ] **Step 3:** Run `node --test toss-heatmap/test/config.test.js`. Expected: FAIL (module missing).
- [ ] **Step 4:** Implement `lib/config.js`. Keep the existing env overrides (`TOSS_CLIENT_ID`/`TOSS_CLIENT_SECRET`) and the `/여기에|붙여넣/` placeholder rule. Make `server.js` call `loadConfig({path: CONFIG_PATH, env: process.env, argv: process.argv})`, keeping its existing exit-on-bad-JSON behaviour. Add the three key fields (placeholder text "여기에 … API 키 붙여넣기") to `config.example.json`, plus `"deepResearchLimit": {"enabled": true}`.
- [ ] **Step 5:** Run the tests. Expected: PASS. Also run `node toss-heatmap/server.js --demo --no-open`, `curl -s localhost:8787/api/snapshot`, and check it returns JSON with `demo:true`.
- [ ] **Step 6:** Commit `feat: config module with AI keys and limits`.

### Task 2: HTTPS helper + three providers

**Files:**
- Create: `toss-heatmap/lib/http.js`
- Create: `toss-heatmap/lib/providers/claude.js`, `openai.js`, `gemini.js`
- Create: `toss-heatmap/lib/prompts.js`
- Test: `toss-heatmap/test/providers.test.js`

**Interfaces:**
- Produces `http.js`: `requestJson({ method, url, headers, body, signal, timeoutMs }) -> Promise<{ status, json }>`. It uses `node:https` with no header timeout, so long Claude calls survive. Only `timeoutMs` (default 35 min) aborts. It throws `HttpError(status, message)` with the message passed through `scrub(text, secrets)`.
- Produces `scrub(text: string, secrets: string[]) -> string`, which replaces each secret with `***`.
- Produces `prompts.js`: `researchPrompt(ctx: AnalysisContext, mode: 'quick'|'deep') -> string` and `synthesisPrompt(ctx, results: ProviderResult[]) -> string`. `AnalysisContext` = `{symbol, name, market, currency, lastPrice?, avgPrice?, returnRate?, dailyRate?, weightPct?, today: 'YYYY-MM-DD'}`. The research prompt is in Korean and asks for the spec §3 sections ①②③, a stance (긍정/중립/부정 + 근거), "내 상황에서 보면" only when `avgPrice` is present, cited source URLs, and no 매수/매도 directive. The synthesis prompt asks for **JSON only** matching `FinalReport` (Task 4).
- Produces each provider as `{ id: 'claude'|'openai'|'gemini', label: 'Claude'|'ChatGPT'|'Gemini', run(opts) -> Promise<ProviderResult>, complete(opts) -> Promise<string> }`.
  - `run(opts)` takes `{ key, model, mode, prompt, limits, signal, http, resume?: string, onHandle?: (h: string) => void }`.
  - `ProviderResult` = `{ provider, status: 'done'|'failed'|'cancelled'|'skipped', text?, sources: {title,url}[], limitHit: bool, error? }`.
  - `complete({key, model, prompt, http, signal})` is a plain no-tools call used for synthesis and returns text.
- Provider request shapes (the implementer must check field names against current official docs before finalising, and adjust only what differs):
  - **claude**: `POST https://api.anthropic.com/v1/messages` with headers `x-api-key`, `anthropic-version: 2023-06-01`. Body: `{model, max_tokens: 32000, thinking:{type:'adaptive'}, output_config:{effort: quick?'medium':'high'}, tools:[{type:'web_search_20260209',name:'web_search',max_uses: quick?5:limits.claudeMaxSearches}, …deep adds {type:'web_fetch_20260209',name:'web_fetch',max_uses:20}], messages:[{role:'user',content:prompt}]}`. Loop on `stop_reason==='pause_turn'` by re-sending `[user, {role:'assistant',content:resp.content}]`, max 5 continuations. Text = joined `text` blocks. Sources come from `web_search_tool_result` list items `{title,url}`, deduped. `limitHit` is true if any tool result content is an object with `error_code==='max_uses_exceeded'`, or `stop_reason==='max_tokens'`. `stop_reason==='refusal'` → `failed`. No resume handle (a restart re-runs Claude).
  - **openai**: `POST https://api.openai.com/v1/responses` with header `Authorization: Bearer`. Quick: `{model, input: prompt, tools:[{type:'web_search'}], max_tool_calls: 8}` (synchronous). Deep: `{model, input: prompt, background:true, tools:[{type:'web_search_preview'}], max_tool_calls: limits.enabled?limits.openaiMaxToolCalls:undefined}` → `onHandle(id)`, then poll `GET /v1/responses/{id}` every 10 s until `status` ∉ {`queued`,`in_progress`}. Text comes from `output[]` items of `type==='message'` → `content[].text`. Sources come from `annotations[]` `{title,url}`. `limitHit` is true when the count of `web_search_call` items ≥ `max_tool_calls` or `status==='incomplete'`. Cancel: `POST /v1/responses/{id}/cancel`. With `resume`, skip creation and poll.
  - **gemini**: `POST https://generativelanguage.googleapis.com/v1beta/interactions` with headers `x-goog-api-key` and `Api-Revision: 2026-05-20`. Quick: `{model, input: prompt, tools:[{type:'google_search'}]}` (synchronous). Deep: `{agent: model, input: prompt, background:true, store:true, agent_config:{type:'deep-research', thinking_summaries:'none', visualization:'off', collaborative_planning:false}}` → `onHandle(id)`, then poll `GET …/interactions/{id}` every 10 s until `completed`/`failed`. Text = `output_text` if present, otherwise the joined text of `model_output` steps. Sources come from any `citations`/`url` fields found, deduped. Cancel: `POST …/interactions/{id}/cancel`, best effort (ignore 404).
  - All providers: when `limits.enabled` and elapsed > `limits.timeoutMinutes`, call cancel and return `{status:'done', limitHit:true, text: <partial if any>}`, or `failed` if there is no text. Abort via `signal` → cancel → `cancelled`.

- [ ] **Step 1: Write failing tests** with a fake `http` that records calls and returns scripted responses:
  - `claude builds deep request with limits`: asserts the recorded body has `web_search` `max_uses === 30`, `output_config.effort === 'high'`, and that the `x-api-key` header equals the key.
  - `claude continues pause_turn`: two scripted responses (`pause_turn`, then `end_turn`) → two calls, the second has 2 messages, and the result text comes from the final one.
  - `claude limitHit on max_uses_exceeded` → `limitHit === true`.
  - `openai deep polls and resumes`: create returns `{id:'r1',status:'queued'}` and polls return `in_progress` then `completed` with a message and an annotation → `onHandle` called with `'r1'`, text and sources extracted. A second test with `resume:'r1'` makes no POST to `/v1/responses`.
  - `gemini deep polls`: same shape as OpenAI, with `agent === 'deep-research-preview-04-2026'` in the body.
  - `cancel via signal` (openai deep): aborting mid-poll sends `POST …/r1/cancel`, and status is `'cancelled'`.
  - `prompt carries no amounts`: `researchPrompt` built from a ctx object that also has `quantity:7, valueKrw:123456` (extra fields) contains neither `123456` nor `수량`. It contains `avgPrice` when given and omits "내 상황에서 보면" when `avgPrice` is absent.
  - `scrub removes keys`: `requestJson` with a fake transport returning 401 and a body echoing `sk-test-123` throws an `HttpError` whose message lacks `sk-test-123`.
- [ ] **Step 2:** Run `node --test toss-heatmap/test/providers.test.js`. Expected: FAIL.
- [ ] **Step 3:** Implement `http.js`, `prompts.js`, and the three providers per the Interfaces above. `requestJson` accepts an optional `transport` for the scrub test. Poll interval comes from `opts.pollMs ?? 10000`, so tests pass `pollMs: 1`.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5:** Commit `feat: Claude/OpenAI/Gemini research providers`.

### Task 3: Analysis context + report store

**Files:**
- Create: `toss-heatmap/lib/context.js`, `toss-heatmap/lib/report-store.js`, `toss-heatmap/lib/report-md.js`
- Test: `toss-heatmap/test/store.test.js`

**Interfaces:**
- Consumes: the snapshot shape from `server.js` (`positions[]` with `symbol,name,market,currency,lastPrice,avgPrice,returnRate,dailyRate,valueKrw`).
- Produces: `buildContext(snapshot|null, symbol, { includePosition: bool, today }) -> AnalysisContext | null`. `weightPct` = `valueKrw / Σ valueKrw * 100`, rounded to 1 decimal. It returns `null` if the symbol is not held. With `includePosition:false` (Toss demo), it returns only `{symbol,name,market,currency,today}`.
- Produces: `createStore(dir) -> { save(report: SavedReport) -> id, list(symbol?) -> {id, symbol, name, mode, createdAt}[] (newest first), get(id) -> SavedReport|null, loadJobs() -> object, saveJobs(obj) }`. The id format is `YYYYMMDD-HHmmss_<symbol>_<quick|deep>`. `get` rejects ids not matching `/^\d{8}-\d{6}_[A-Za-z0-9.\-]{1,15}_(quick|deep)$/`. Writes go to `<id>.json` and `<id>.md` (via `toMarkdown`) plus `.jobs.json`, using write-temp-then-rename.
- Produces: `toMarkdown(report: SavedReport) -> string`, following the spec §3 order and the closing line "투자 판단의 책임은 본인에게 있어요. 이 보고서는 참고 자료예요."

- [ ] **Step 1: Write failing tests:**
  - `weightPct`: two positions at valueKrw 300/100 → 75.0 for the first. Output keys ⊆ the allowed list in Global Constraints.
  - `not held` → `null`. `includePosition:false` → no `avgPrice`.
  - `save/list/get roundtrip` in a temp dir. `list('005930')` filters by symbol, and `.md` exists.
  - `get rejects traversal`: `get('../config')` → `null`, with no fs read outside the dir (assert via a spy or just the return value).
  - `markdown has sections`: contains `최종 3줄 결론`, `왜 올랐나/내렸나`, `위험 요소`, `AI끼리 다른 의견`, the disclaimer, and `조사 한도에 닿았음` when any provider `limitHit`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement the three modules.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat: analysis context and report store`.

### Task 4: Synthesis (final report)

**Files:**
- Create: `toss-heatmap/lib/synthesize.js`
- Test: `toss-heatmap/test/synthesize.test.js`

**Interfaces:**
- Consumes: provider `complete()` from Task 2, and `synthesisPrompt` from Task 2.
- Produces: `synthesize({ ctx, results: ProviderResult[], writers: Array<{provider, key, model}>, http, signal }) -> Promise<FinalReport>`.
  - `writers` is in fallback order (Claude → ChatGPT → Gemini, only those with keys).
  - It tries each writer until one returns parseable JSON.
  - `FinalReport` = `{ writer: 'claude'|'openai'|'gemini'|null, crossChecked: bool, conclusion: string[3], why: string, outlook: {up: string, down: string, events: string}, risks: string, views: {provider, stance:'긍정'|'중립'|'부정', reason}[], disagreements: string, myPosition: string|null, summaries: {[provider]: string[3]}, sources: {title,url}[], raw?: string }`.
  - `crossChecked` = (count of `done` results ≥ 2).
  - `sources` is the deduped union of the provider sources.
  - Lenient parse: take the substring from the first `{` to the last `}`. If every writer returns unparseable text, return a report with `raw` set to the last text and the other fields empty.
  - If no `done` results exist, throw `Error('모든 AI가 실패했어요')`.

- [ ] **Step 1: Write failing tests:**
  - `claude writes when available`.
  - `falls back to openai when claude throws`.
  - `single result → crossChecked false`.
  - `malformed JSON wrapped in prose still parses`.
  - `all writers garbage → raw set`.
  - `no done results → throws`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat: cross-checked final report synthesis`.

### Task 5: Job manager (parallel run, dedupe, cancel, resume, demo)

**Files:**
- Create: `toss-heatmap/lib/jobs.js`, `toss-heatmap/lib/demo-report.js`
- Test: `toss-heatmap/test/jobs.test.js`

**Interfaces:**
- Consumes: providers (Task 2), `synthesize` (Task 4), `createStore` (Task 3).
- Produces: `createJobManager({ config, providers, synthesize, store, http, now }) -> { start(ctx, mode) -> {jobId, existing}, get(jobId) -> JobView|null, cancel(jobId) -> bool, resumeAll() -> Promise<void> }`.
  - `JobView` = `{ id, symbol, name, mode, status: 'running'|'synthesizing'|'done'|'failed'|'cancelled', startedAt, providers: {[id]: {status: 'waiting'|'running'|'done'|'failed'|'skipped'|'cancelled', error?, limitHit?}}, reportId?, error? }`. It never includes keys.
  - A provider without a key → `skipped` ("키 없음").
  - On provider handles via `onHandle`, persist `{jobId, symbol, mode, ctx, handles:{openai?, gemini?}}` to `.jobs.json`. Remove the entry when the job ends.
  - `resumeAll()` re-creates the running jobs from `.jobs.json`, passing `resume` handles. Claude is re-run.
  - When `config.aiDemo`, `start` produces `demoReport(ctx, mode)` after ~3 s (scripted progress), with no network calls.
  - After synthesis, call `store.save({ ...finalReport, symbol, name, mode, createdAt, providers: results-without-text-free-of-keys, providerTexts: {[id]: text} })`. `reportId` is set on the job.

- [ ] **Step 1: Write failing tests** with fake providers (promises you resolve manually) and an in-memory store:
  - `runs three in parallel`: all three are `running` before any resolves.
  - `one fails others continue`: openai rejects → its status is `failed`, the job ends `done`, and the report is saved.
  - `missing key → skipped`.
  - `dedupe`: a second `start` for the same symbol while running returns the same `jobId` with `existing:true`. After it finishes, a new start makes a new id.
  - `cancel`: aborts the signals passed to providers, and the job is `cancelled` with no report saved.
  - `resume`: seed `.jobs.json` with `{handles:{openai:'r1'}}`, call `resumeAll()`, and the openai fake is called with `resume:'r1'`. A `start` for that symbol returns `existing:true`.
  - `aiDemo makes no provider calls` and saves a report whose `conclusion` has 3 lines.
  - `job view has no secrets`: `JSON.stringify(get(id))` lacks each `config.secrets()` value.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat: analysis job manager with resume and cancel`.

### Task 6: Server routes + POST guard

**Files:**
- Create: `toss-heatmap/lib/guard.js`
- Modify: `toss-heatmap/server.js` (routing; export a `createServer(deps)` and only listen when `require.main === module`)
- Test: `toss-heatmap/test/server.test.js`

**Interfaces:**
- Produces: `checkPost(req, bodyText, port) -> null | {status, error}` with the rules in Global Constraints.
- Routes:
  - `GET /api/ai/status` → `{ aiDemo, tossDemo, providers: {claude: bool, openai: bool, gemini: bool} }`.
  - `POST /api/analyze` `{symbol, mode}` → `{jobId, existing}`. Returns 400 for a bad symbol or mode, and 404 `보유하지 않은 종목이에요` when real Toss mode and not held.
  - `GET /api/jobs/<id>` → `JobView`.
  - `POST /api/jobs/<id>/cancel` → `{ok}`.
  - `GET /api/reports?symbol=` → list.
  - `GET /api/reports/<id>` → `SavedReport`.
  - Existing GET routes are unchanged. The old blanket "GET only" 405 now applies to everything except these two POST paths.
- On startup (not demo), call `jobs.resumeAll()` and log the count `이어받은 분석 n개`.

- [ ] **Step 1: Write failing tests** that start `createServer` on port 0 with fake jobs/store:
  - `analyze without Origin → 403`.
  - `analyze from evil origin → 403`.
  - `body > 10KB → 413`.
  - `bad symbol "../x" → 400`.
  - `valid analyze → 200 {jobId}`.
  - `GET existing snapshot route still works in demo`.
  - `PUT → 405`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS. Then run the full suite: `node --test toss-heatmap/test/`.
- [ ] **Step 5:** Commit `feat: analysis API routes with origin guard`.

### Task 7: UI — buttons, confirm, progress, report view, past reports

**Files:**
- Modify: `toss-heatmap/index.html`

**Interfaces:**
- Consumes: the Task 6 routes.
- UI behaviour:
  - Under the chart, when a stock is selected, show two buttons: `⚡ 빠른 분석 (1~2분, 수백 원)` and `🔬 딥 리서치 (5~20분, 약 1만~2만 5천 원)`. When `aiDemo`, a small note reads "AI 키가 없어서 예시 보고서로 보여드려요".
  - Deep → a `confirm()`-free inline confirm panel (avoid native dialogs): "딥 리서치는 약 1만~2만 5천 원(최대 약 3만 원)이 들어요. 진행할까요? [진행] [취소]".
  - While running, show a per-AI status row (대기/진행 중/완료/실패/키 없음), elapsed time, and a `분석 취소` button. Poll `GET /api/jobs/<id>` every 3 s. Remember the jobId per symbol in `sessionStorage`, wrapped in try/catch, so a page reload reattaches.
  - The report view follows spec §3 order. Each stance gets a badge colour: 긍정 green, 중립 gray, 부정 red (reuse the existing palette vars). Sources are a link list (`target=_blank rel=noopener`). Show a "조사 한도에 닿았음" chip, plus "교차 검증 못 함" when `crossChecked` is false. When `raw` is set, render it as preformatted text.
  - "지난 보고서" list for the selected symbol (`GET /api/reports?symbol=`). Clicking one opens it with no cost.
  - All report text is inserted via `textContent`, never `innerHTML`, because AI output is untrusted.

- [ ] **Step 1:** Implement the UI.
- [ ] **Step 2:** Verify in the browser. Run `node toss-heatmap/server.js --demo --no-open`, then use a Playwright script (scratchpad, not committed) that clicks a tile → `빠른 분석` → waits for the report → asserts `최종 3줄 결론` is visible. Then it clicks `딥 리서치` → asserts the confirm panel → `취소` → asserts no job started. Take a screenshot at 1280×900 and at 390 px wide, and check there is no horizontal overflow.
- [ ] **Step 3:** Commit `feat: analysis UI`.

### Task 8: Docs, install on PC, verify

**Files:**
- Modify: `toss-heatmap/README.md`

- [ ] **Step 1:** README: a section "AI 분석 켜기" with where to get each key (console.anthropic.com, platform.openai.com, aistudio.google.com: use a paid/billing-enabled key), where to paste them in `config.json`, what is sent to the AIs and what is not, costs, the limit settings, where reports are saved, and that keys must never be pasted in chat.
- [ ] **Step 2:** Run the full suite `node --test toss-heatmap/test/`. Expected: all pass. Run a demo-server smoke test via curl on `/api/ai/status`.
- [ ] **Step 3:** Commit, push the branch, and open a draft PR.
- [ ] **Step 4:** Copy to the PC folder `C:\Users\munmi\Documents\toss-heatmap` via `device_commit_files`: server.js, index.html, lib/**, README.md, config.example.json, start scripts. **Not** config.json, .sector-cache.json, or reports/. Re-list the folder to confirm.

'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { friendlyError } = require('../lib/friendly-error');

test('Anthropic low credit -> charge guide', () => {
  const m = friendlyError('claude', 'HTTP 400: Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.');
  assert.match(m, /크레딧/); assert.match(m, /console\.anthropic\.com/);
});
test('OpenAI no credits -> charge guide', () => {
  const m = friendlyError('openai', 'HTTP 429: You have no credits remaining. Add credits to continue using the API at https://platform.openai.com/settings/organization/billing/.');
  assert.match(m, /크레딧/); assert.match(m, /platform\.openai\.com/);
});
test('OpenAI insufficient_quota wording', () => {
  assert.match(friendlyError('openai', 'HTTP 429: You exceeded your current quota, please check your plan and billing details.'), /크레딧/);
});
test('Gemini free tier limit 0 -> billing guide', () => {
  const m = friendlyError('gemini', 'HTTP 429: Rate limit exceeded for model gemini-3.1-pro (limit: 0 input tokens per minute on Free Tier). Please upgrade your tier at https://ai.dev/rate-limit.');
  assert.match(m, /무료 키/); assert.match(m, /aistudio\.google\.com/);
});
test('401 -> wrong key with config field', () => {
  assert.match(friendlyError('claude', 'HTTP 401: invalid x-api-key'), /anthropicApiKey/);
  assert.match(friendlyError('openai', 'HTTP 401: Incorrect API key provided'), /openaiApiKey/);
  assert.match(friendlyError('gemini', 'HTTP 400: API key not valid. Please pass a valid API key.'), /geminiApiKey/);
});
test('plain 429 -> wait', () => {
  assert.match(friendlyError('claude', 'HTTP 429: rate_limit_error'), /잠시/);
});
test('5xx / overloaded -> server busy', () => {
  assert.match(friendlyError('claude', 'HTTP 529: Overloaded'), /서버/);
  assert.match(friendlyError('openai', 'HTTP 503: unavailable'), /서버/);
});
test('connection failure', () => {
  assert.match(friendlyError('gemini', '연결 실패: getaddrinfo ENOTFOUND'), /인터넷/);
});
test('unknown messages pass through unchanged', () => {
  assert.strictEqual(friendlyError('claude', '빈 응답이 왔어요'), '빈 응답이 왔어요');
  assert.strictEqual(friendlyError('claude', 'HTTP 400: some odd thing'), 'HTTP 400: some odd thing');
  assert.strictEqual(friendlyError('claude', undefined), undefined);
});
test('Gemini free_tier metric wording', () => {
  const base = 'HTTP 429: You exceeded your current quota, please check your plan and billing details. Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, ';
  assert.match(friendlyError('gemini', base + 'limit: 0, model: gemini-3.1-pro'), /무료 키로는/);
  const m = friendlyError('gemini', base + 'limit: 5, model: gemini-3.1-pro');
  assert.match(m, /몇 분 뒤/); assert.doesNotMatch(m, /크레딧/);
});
test('403 that is not a key problem passes through', () => {
  const t = 'HTTP 403: Country, region, or territory not supported';
  assert.strictEqual(friendlyError('openai', t), t);
});
test('wrapped errors are mapped too', () => {
  assert.match(friendlyError('openai', '상태 확인이 5번 연속 실패했어요: HTTP 401: Incorrect API key provided'), /openaiApiKey/);
  assert.match(friendlyError('openai', 'ChatGPT 작업 상태: failed (You exceeded your current quota)'), /크레딧/);
});

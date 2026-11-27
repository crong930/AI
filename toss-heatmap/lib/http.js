'use strict';
// 외부 패키지 없이 HTTPS JSON 요청. 긴 딥 리서치 요청도 끊기지 않게 헤더 타임아웃을 두지 않아요.
const https = require('https');

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function scrub(text, secrets = []) {
  let s = String(text == null ? '' : text);
  for (const k of secrets) if (k) s = s.split(k).join('***');
  return s;
}

function nodeTransport({ method, url, headers, body, signal, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method, headers, signal }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('응답 시간이 너무 오래 걸려요 (' + Math.round(timeoutMs / 60000) + '분 초과)')));
    req.on('error', reject);
    if (body != null) req.write(body);
    req.end();
  });
}

async function requestJson({ method = 'GET', url, headers = {}, body, signal, timeoutMs = 35 * 60 * 1000, secrets = [], transport = nodeTransport }) {
  const h = { Accept: 'application/json', ...headers };
  let payload;
  if (body !== undefined) { payload = JSON.stringify(body); h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(payload); }
  let res;
  try {
    res = await transport({ method, url, headers: h, body: payload, signal, timeoutMs });
  } catch (e) {
    if (e && e.name === 'AbortError') throw e;
    throw new HttpError(0, scrub('연결 실패: ' + (e && e.message), secrets));
  }
  let json = null;
  try { json = res.text ? JSON.parse(res.text) : null; } catch (_) {}
  if (res.status >= 400) {
    const err = json && (json.error && (json.error.message || json.error.status || json.error)) || res.text || '';
    throw new HttpError(res.status, scrub('HTTP ' + res.status + ': ' + (typeof err === 'string' ? err : JSON.stringify(err)).slice(0, 500), secrets));
  }
  return { status: res.status, json };
}

module.exports = { requestJson, HttpError, scrub };

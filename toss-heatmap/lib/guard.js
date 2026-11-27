'use strict';
// POST 보호: 내 브라우저의 같은 주소에서 온 요청만 받아요. (다른 웹사이트가 몰래 호출하는 것 방지)
const MAX_BODY = 10 * 1024;

function checkPost(req, bodyText, port) {
  const h = req.headers || {};
  const ok = ['http://localhost:' + port, 'http://127.0.0.1:' + port];
  if (!h.origin || !ok.includes(h.origin)) return { status: 403, error: '허용되지 않은 요청이에요.' };
  if (!/^application\/json\s*(;|$)/i.test(String(h['content-type'] || ''))) return { status: 415, error: 'JSON 형식으로 보내 주세요.' };
  if (Buffer.byteLength(bodyText || '') > MAX_BODY) return { status: 413, error: '요청이 너무 커요.' };
  return null;
}

module.exports = { checkPost, MAX_BODY };

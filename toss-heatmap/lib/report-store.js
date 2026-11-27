'use strict';
// 보고서를 PC의 reports/ 폴더에 날짜별로 저장해요. 다시 볼 때는 비용이 들지 않아요.
const fs = require('fs');
const path = require('path');
const { toMarkdown } = require('./report-md');

const ID_RE = /^\d{8}-\d{6}_[A-Za-z0-9.\-]{1,15}_(quick|deep)(-\d{1,3})?$/;
const pad = (n) => String(n).padStart(2, '0');

function stamp(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

const RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const pauseMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Windows에서는 백신·검색 색인이 파일을 잠깐 잡고 있어 이름 바꾸기가 실패할 수 있어요.
// 몇 번 기다렸다 다시 해 보고, 그래도 안 되면 파일에 바로 써요.
function writeAtomic(file, text) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text);
  for (let i = 0; i < 5; i++) {
    try { fs.renameSync(tmp, file); return; } catch (e) {
      if (!RETRY_CODES.has(e && e.code)) throw e;
      pauseMs(50);
    }
  }
  fs.writeFileSync(file, text);
  try { fs.unlinkSync(tmp); } catch (_) {}
}

function createStore(dir) {
  const ensure = () => fs.mkdirSync(dir, { recursive: true });
  const jobsFile = path.join(dir, '.jobs.json');
  return {
    save(report) {
      ensure();
      const base = `${stamp(report.createdAt)}_${report.symbol}_${report.mode}`;
      let id = base;
      for (let n = 2; fs.existsSync(path.join(dir, id + '.json')); n++) id = base + '-' + n;
      if (!ID_RE.test(id)) throw new Error('보고서 이름을 만들 수 없어요: ' + id);
      const full = { ...report, id };
      writeAtomic(path.join(dir, id + '.json'), JSON.stringify(full, null, 2));
      writeAtomic(path.join(dir, id + '.md'), toMarkdown(full));
      return id;
    },
    list(symbol) {
      if (!fs.existsSync(dir)) return [];
      const out = [];
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.json') || f.startsWith('.')) continue;
        const id = f.slice(0, -5);
        if (!ID_RE.test(id)) continue;
        try {
          const r = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
          if (symbol && r.symbol !== symbol) continue;
          out.push({ id, symbol: r.symbol, name: r.name, mode: r.mode, createdAt: r.createdAt });
        } catch (_) {}
      }
      return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.id < b.id ? 1 : -1));
    },
    get(id) {
      if (typeof id !== 'string' || !ID_RE.test(id)) return null;
      try { return JSON.parse(fs.readFileSync(path.join(dir, id + '.json'), 'utf8')); } catch (_) { return null; }
    },
    loadJobs() {
      try { return JSON.parse(fs.readFileSync(jobsFile, 'utf8')) || {}; } catch (_) { return {}; }
    },
    saveJobs(obj) { ensure(); writeAtomic(jobsFile, JSON.stringify(obj, null, 2)); },
  };
}

module.exports = { createStore, ID_RE };

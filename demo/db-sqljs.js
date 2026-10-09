'use strict';
// 브라우저 데모용: sql.js(SQLite를 자바스크립트로 옮긴 것)를 서버와 같은 db API로 감싼다.
const { wrap } = require('../server/db/wrap');

function openSqlJsDb(SQL, bytes) {
  const raw = new SQL.Database(bytes || undefined);
  raw.exec('PRAGMA foreign_keys = ON;');
  const cache = new Map();
  const prep = (sql) => {
    let s = cache.get(sql);
    if (!s) {
      s = raw.prepare(sql);
      cache.set(sql, s);
    }
    return s;
  };
  const lastId = () => {
    const r = raw.exec('SELECT last_insert_rowid()');
    return r.length ? Number(r[0].values[0][0]) : 0;
  };
  const db = wrap({
    get(sql, params) {
      const s = prep(sql);
      try {
        s.bind(params);
        return s.step() ? s.getAsObject() : undefined;
      } finally {
        s.reset();
      }
    },
    all(sql, params) {
      const s = prep(sql);
      const rows = [];
      try {
        s.bind(params);
        while (s.step()) rows.push(s.getAsObject());
      } finally {
        s.reset();
      }
      return rows;
    },
    run(sql, params) {
      const s = prep(sql);
      try {
        s.bind(params);
        s.step();
      } finally {
        s.reset();
      }
      return { changes: raw.getRowsModified(), lastInsertRowid: lastId() };
    },
    exec(sql) {
      raw.exec(sql);
    },
    close() {
      raw.close();
    },
  });
  // export()는 준비된 문장을 모두 닫고 DB를 다시 연다(sql.js 동작). 캐시도 비운다.
  db.exportBytes = () => {
    for (const s of cache.values()) {
      try {
        s.free();
      } catch {
        /* 이미 해제 */
      }
    }
    cache.clear();
    const bytes = raw.export();
    raw.exec('PRAGMA foreign_keys = ON;');
    return bytes;
  };
  return db;
}

module.exports = { openSqlJsDb };

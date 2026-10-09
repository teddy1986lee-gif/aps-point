'use strict';

// SQLite 드라이버(node:sqlite 또는 브라우저의 sql.js)를 같은 모양의 API로 감싼다.
//   db.get(sql, ...params) / db.all(...) / db.run(...) / db.exec(sql) / db.tx(fn)
// tx 안의 콜백은 동기 함수여야 한다. 외부 API 호출 같은 비동기 작업은 트랜잭션 밖에서 한다.
function normParams(params) {
  return params.map((p) => (p === undefined ? null : typeof p === 'boolean' ? (p ? 1 : 0) : p));
}

function wrap(driver) {
  let depth = 0;

  function tx(fn) {
    const sp = `sp${depth}`;
    driver.exec(depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${sp}`);
    depth++;
    let out;
    try {
      out = fn();
      if (out && typeof out.then === 'function') throw new Error('db.tx 콜백은 동기 함수여야 합니다.');
    } catch (err) {
      depth--;
      try {
        if (depth === 0) driver.exec('ROLLBACK');
        else driver.exec(`ROLLBACK TO ${sp}; RELEASE ${sp}`);
      } catch (_) {
        /* 이미 롤백된 경우 */
      }
      throw err;
    }
    depth--;
    driver.exec(depth === 0 ? 'COMMIT' : `RELEASE ${sp}`);
    return out;
  }

  return {
    get: (sql, ...p) => driver.get(sql, normParams(p)),
    all: (sql, ...p) => driver.all(sql, normParams(p)),
    run: (sql, ...p) => driver.run(sql, normParams(p)),
    exec: (sql) => driver.exec(sql),
    tx,
    inTx: () => depth > 0,
    close: () => driver.close(),
    driver,
  };
}

module.exports = { wrap };

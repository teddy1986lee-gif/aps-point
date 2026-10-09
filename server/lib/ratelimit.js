'use strict';

// 프로세스 메모리 기반 슬라이딩 윈도 제한기. 관리자 로그인 시도처럼 DB에 남기지 않는 값에 쓴다.
// 여러 서버 프로세스를 띄우면 프로세스마다 따로 센다(README의 확장 안내 참고).
function createLimiter() {
  const hits = new Map();

  function hit(key, limit, windowMs, now) {
    const since = now - windowMs;
    const arr = (hits.get(key) || []).filter((t) => t > since);
    if (arr.length >= limit) {
      hits.set(key, arr);
      return { ok: false, retryAfter: Math.ceil((arr[0] + windowMs - now) / 1000) };
    }
    arr.push(now);
    hits.set(key, arr);
    if (hits.size > 5000) {
      for (const [k, v] of hits) if (!v.length || v[v.length - 1] <= since) hits.delete(k);
    }
    return { ok: true };
  }

  return { hit, reset: (key) => hits.delete(key) };
}

module.exports = { createLimiter };

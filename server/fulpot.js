'use strict';
/*
 * 풀팟 연동 — 계정 조회, 티켓 지급, 지급 기록 조회
 *   mock : 개발·데모용 모의 풀팟. MOCK_ACCOUNTS에 있는 ID만 '있는 계정'이고 실제 티켓은 나가지 않는다.
 *   http : 운영용. README 4장의 API 세 개를 부른다. 실제 풀팟 API가 다르면 createHttpFulpot만 고치면 된다.
 *
 * 어느 방식이든 결과는 아래 모양으로 돌려주고 예외는 던지지 않는다.
 *   lookupAccount(fulpotId)  → { status: 'found', uid, fulpotId, nickname } | { status: 'not_found' } | { status: 'unknown', message }
 *   issueTicket({ requestKey, uid, ticketCode, quantity })
 *                            → { status: 'issued', issueId, duplicate } | { status: 'rejected', reason } | { status: 'unknown', message }
 *   queryIssue(requestKey)   → { status: 'issued', issueId, issuedAt } | { status: 'not_found' } | { status: 'unknown', message }
 *
 * 'unknown'은 결과를 모르는 경우(시간 초과, 통신 오류, 5xx)다. 지급 요청이 'unknown'이면 실제로는 지급됐을 수도 있으므로
 * 부르는 쪽은 포인트를 돌려주지 않고 '확인 필요'로 둔 뒤 지급 기록을 조회한다.
 * 풀팟은 같은 requestKey(신청번호)로 여러 번 요청해도 한 번만 지급해야 한다. 다시 요청해도 두 번 지급되지 않는 근거다.
 */

const ISSUE_ID = /^[A-Za-z0-9_.:#/-]{2,80}$/;

// 모의 풀팟에 '있는' 계정. 키는 소문자 풀팟 ID.
const MOCK_ACCOUNTS = {
  teddy123: { uid: 'FP100231', fulpotId: 'teddy123', nickname: '테디베어' },
  minjun_k: { uid: 'FP100244', fulpotId: 'minjun_k', nickname: '올인민준' },
  seoyeon_p: { uid: 'FP100257', fulpotId: 'seoyeon_p', nickname: '서연포커' },
  yujin_h: { uid: 'FP100263', fulpotId: 'yujin_h', nickname: '유진' },
  seyoung5: { uid: 'FP100278', fulpotId: 'seyoung5', nickname: '세영', restricted: true },
  taeho_y: { uid: 'FP100281', fulpotId: 'taeho_y', nickname: '리버킹태호' },
  'jimin.s': { uid: 'FP100295', fulpotId: 'jimin.s', nickname: '지민' },
  doyoon_k: { uid: 'FP100302', fulpotId: 'doyoon_k', nickname: '도윤K' },
  dana_j: { uid: 'FP100316', fulpotId: 'dana_j', nickname: '다나' },
  sky_lim: { uid: 'FP100327', fulpotId: 'sky_lim', nickname: '하늘' },
  haeun_s: { uid: 'FP100339', fulpotId: 'haeun_s', nickname: '하은' },
  fulpot_demo: { uid: 'FP100400', fulpotId: 'fulpot_demo', nickname: '풀팟체험' },
};

const RESTRICTED_REASON = '풀팟 계정이 이용 제한 상태라 티켓을 지급할 수 없습니다. 풀팟홀덤 고객센터에 계정 상태를 문의해 주세요.';

/*
 * 모의 풀팟
 *   behavior.issue : 'ok'     지급함
 *                    'lost'   지급은 했지만 응답이 오지 않음(시간 초과처럼 보임)
 *                    'down'   요청이 풀팟에 닿지 않음(지급 안 함)
 *                    'reject' 지급 거절
 *                    'hang'   응답이 영영 오지 않음(시간 제한 시험용)
 *   behavior.lookup, behavior.query : 'ok' | 'down'
 *   latencyMs : 응답 지연(데모에서 '지급 중' 상태가 잠깐 보이도록)
 * 지급 번호는 신청번호에서 만든다(EX261009-0001 → FPX-261009-0001). 서버를 다시 켜도 번호가 겹치지 않는다.
 */
function createMockFulpot(opts = {}) {
  const accounts = new Map(Object.entries(MOCK_ACCOUNTS));
  for (const [k, a] of Object.entries(opts.accounts || {})) accounts.set(k.toLowerCase(), { fulpotId: k, ...a });
  const behavior = { issue: 'ok', lookup: 'ok', query: 'ok', ...(opts.behavior || {}) };
  const issued = new Map(); // requestKey → { issueId, uid, ticketCode, quantity, issuedAt }
  const calls = []; // 지급 요청 기록(시험용)
  let latencyMs = Number(opts.latencyMs) || 0;
  const now = opts.now || (() => Date.now());
  const wait = () => (latencyMs > 0 ? new Promise((r) => setTimeout(r, latencyMs)) : Promise.resolve());
  const down = (what) => ({ status: 'unknown', message: `풀팟 ${what} 응답 없음(시간 초과)` });

  return {
    behavior,
    issued,
    calls,
    accounts,
    setLatency(ms) {
      latencyMs = Number(ms) || 0;
    },
    latency: () => latencyMs,
    async lookupAccount(fulpotId) {
      await wait();
      if (behavior.lookup === 'down') return down('계정 조회');
      const a = accounts.get(String(fulpotId).toLowerCase());
      return a ? { status: 'found', uid: a.uid, fulpotId: a.fulpotId, nickname: a.nickname } : { status: 'not_found' };
    },
    async issueTicket({ requestKey, uid, ticketCode, quantity }) {
      calls.push({ requestKey, uid, ticketCode, quantity, mode: behavior.issue });
      await wait();
      const mode = behavior.issue;
      if (mode === 'hang') return new Promise(() => {});
      if (mode === 'down') return down('지급');
      const prev = issued.get(requestKey);
      if (prev) return { status: 'issued', issueId: prev.issueId, duplicate: true };
      const account = [...accounts.values()].find((a) => a.uid === uid);
      if (mode === 'reject') return { status: 'rejected', reason: '모의 풀팟: 지급할 수 없는 요청입니다.' };
      if (!account) return { status: 'rejected', reason: '풀팟에서 지급받을 계정을 찾을 수 없습니다.' };
      if (account.restricted) return { status: 'rejected', reason: RESTRICTED_REASON };
      const rec = { issueId: 'FPX-' + String(requestKey).replace(/^EX/, ''), uid, ticketCode, quantity, issuedAt: now() };
      issued.set(requestKey, rec);
      if (mode === 'lost') return down('지급');
      return { status: 'issued', issueId: rec.issueId, duplicate: false };
    },
    async queryIssue(requestKey) {
      await wait();
      if (behavior.query === 'down') return down('지급 기록 조회');
      const rec = issued.get(requestKey);
      return rec ? { status: 'issued', issueId: rec.issueId, issuedAt: rec.issuedAt } : { status: 'not_found' };
    },
    // 브라우저 데모가 새로고침해도 모의 풀팟 기록이 남도록 저장·복원
    exportState: () => ({ issued: [...issued.entries()], behavior: { ...behavior } }),
    importState(state) {
      if (!state) return;
      issued.clear();
      for (const [k, v] of state.issued || []) issued.set(k, v);
      if (state.behavior) Object.assign(behavior, state.behavior);
    },
  };
}

/*
 * 풀팟 API (FULPOT_MODE=http)
 *   GET  {base}/accounts/{fulpotId}           200 { uid, fulpotId, nickname } · 404 없음
 *   POST {base}/tickets/issues                 Idempotency-Key: {requestKey}
 *        { requestKey, uid, ticketCode, quantity }
 *        200/201 { issueId } 지급 · 409 { issueId } 같은 requestKey로 이미 지급 · 400/404/422 { reason } 거절
 *   GET  {base}/tickets/issues/{requestKey}    200 { issueId, issuedAt } · 404 기록 없음
 *   모든 요청에 Authorization: Bearer {token}. 그 밖의 응답과 시간 초과는 '결과 모름'.
 */
function createHttpFulpot({ baseUrl, token, timeoutMs = 8000 }) {
  if (!baseUrl) throw new Error('FULPOT_API_URL이 필요합니다.');
  const base = String(baseUrl).replace(/\/+$/, '');

  async function call(method, path, { body, headers } = {}) {
    let res;
    try {
      res = await fetch(base + path, {
        method,
        headers: {
          accept: 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(body ? { 'content-type': 'application/json' } : {}),
          ...(headers || {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const timedOut = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
      return { status: 0, data: null, error: timedOut ? `${timeoutMs / 1000}초 안에 응답 없음` : `통신 오류(${(e && e.message) || e})` };
    }
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    return { status: res.status, data };
  }
  const unknown = (r, what) => ({ status: 'unknown', message: r.error || `풀팟 ${what} 응답 ${r.status}` });
  const reasonOf = (r) => (r.data && (r.data.reason || r.data.message)) || `풀팟이 지급을 거절했습니다(응답 ${r.status}).`;

  return {
    async lookupAccount(fulpotId) {
      const r = await call('GET', `/accounts/${encodeURIComponent(fulpotId)}`);
      if (r.status === 200 && r.data && r.data.uid) {
        return { status: 'found', uid: String(r.data.uid), fulpotId: r.data.fulpotId ? String(r.data.fulpotId) : fulpotId, nickname: r.data.nickname ? String(r.data.nickname) : '' };
      }
      if (r.status === 404) return { status: 'not_found' };
      return unknown(r, '계정 조회');
    },
    async issueTicket({ requestKey, uid, ticketCode, quantity }) {
      const r = await call('POST', '/tickets/issues', { body: { requestKey, uid, ticketCode, quantity }, headers: { 'idempotency-key': requestKey } });
      if ((r.status === 200 || r.status === 201 || r.status === 409) && r.data && r.data.issueId) {
        return { status: 'issued', issueId: String(r.data.issueId), duplicate: r.status === 409 };
      }
      if (r.status === 400 || r.status === 404 || r.status === 422) return { status: 'rejected', reason: reasonOf(r) };
      return unknown(r, '지급');
    },
    async queryIssue(requestKey) {
      const r = await call('GET', `/tickets/issues/${encodeURIComponent(requestKey)}`);
      if (r.status === 200 && r.data && r.data.issueId) {
        const at = r.data.issuedAt ? Date.parse(r.data.issuedAt) : NaN;
        return { status: 'issued', issueId: String(r.data.issueId), issuedAt: Number.isNaN(at) ? null : at };
      }
      if (r.status === 404) return { status: 'not_found' };
      return unknown(r, '지급 기록 조회');
    },
  };
}

// 어떤 구현이든 예외·시간 초과·이상한 응답을 '결과 모름'으로 바꿔 부르는 쪽이 한 가지 모양만 다루게 한다.
function guard(fn, timeoutMs, what) {
  return (...args) => {
    let timer;
    const limit = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ status: 'unknown', message: `풀팟 ${what} 응답이 ${Math.round(timeoutMs / 100) / 10}초 안에 오지 않았습니다.` }), timeoutMs);
    });
    return Promise.race([Promise.resolve().then(() => fn(...args)), limit])
      .catch((e) => ({ status: 'unknown', message: `풀팟 ${what} 오류: ${(e && e.message) || e}` }))
      .finally(() => clearTimeout(timer));
  };
}

function checkIssued(r) {
  if (r && r.status === 'issued' && !ISSUE_ID.test(String(r.issueId || ''))) {
    return { status: 'unknown', message: '풀팟 응답에 올바른 지급 번호가 없습니다.' };
  }
  return r && r.status ? r : { status: 'unknown', message: '풀팟 응답을 해석할 수 없습니다.' };
}

const LABEL = { mock: '모의 풀팟(개발·데모용, 실제 티켓 지급 없음)', http: '풀팟 API' };

function createFulpot(cfg = {}) {
  const mode = cfg.mode || 'mock';
  const timeoutMs = Number(cfg.timeoutMs) || 8000;
  let impl;
  if (mode === 'mock') impl = createMockFulpot(cfg);
  else if (mode === 'http') impl = createHttpFulpot({ baseUrl: cfg.baseUrl, token: cfg.token, timeoutMs });
  else throw new Error(`알 수 없는 FULPOT_MODE: ${mode} (mock 또는 http)`);
  const lookup = guard(impl.lookupAccount, timeoutMs, '계정 조회');
  const issue = guard(impl.issueTicket, timeoutMs, '지급');
  const query = guard(impl.queryIssue, timeoutMs, '지급 기록 조회');
  return {
    mode,
    label: LABEL[mode],
    baseUrl: mode === 'http' ? String(cfg.baseUrl) : null,
    timeoutMs,
    mock: mode === 'mock' ? impl : null,
    lookupAccount: async (id) => {
      const r = await lookup(id);
      return r && r.status ? r : { status: 'unknown', message: '풀팟 응답을 해석할 수 없습니다.' };
    },
    issueTicket: async (req) => checkIssued(await issue(req)),
    queryIssue: async (key) => checkIssued(await query(key)),
  };
}

module.exports = { createFulpot, createMockFulpot, createHttpFulpot, MOCK_ACCOUNTS };

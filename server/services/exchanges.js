'use strict';
const { E, isUniqueViolation } = require('../lib/errors');
const v = require('../lib/validate');
const { kstDateKey, formatPhone, likeEscape, cleanText } = require('../lib/format');

/*
 * 티켓 교환 — 신청하면 그 자리에서 풀팟에 지급을 요청한다(운영자 승인·대기 없음).
 *
 *   신청 → 지급 중(issuing) ─풀팟 지급함→ 지급 완료(completed)  원장에서 포인트 차감
 *                         ─풀팟 거절──→ 지급 실패(failed)     포인트 그대로
 *                         ─응답 없음──→ 확인 필요(check)      포인트는 사용 대기로 둔다(돌려주지 않음)
 *
 *   확인 필요는 지급 기록 조회로 정리한다. 서버가 1분마다 조회해 지급된 건은 자동으로 완료하고,
 *   관리자는 [풀팟에서 확인] [다시 요청] [지급 번호로 완료] [지급 실패 처리]를 할 수 있다.
 *
 * 신청번호(exchange_no)를 풀팟 요청 키로 쓴다. 풀팟은 같은 요청 키로는 한 번만 지급하므로,
 * 응답을 못 받은 신청을 다시 요청해도 두 번 지급되지 않는다.
 * db.tx는 동기 함수만 받으므로 풀팟 호출은 반드시 트랜잭션 밖에서 하고, 결과는 다시 트랜잭션 안에서
 * '지금 상태'를 확인한 뒤 반영한다.
 */
const STATUS = { issuing: '지급 중', completed: '지급 완료', failed: '지급 실패', check: '확인 필요' };
const MEMBER_STATUS = { issuing: '지급 중', completed: '지급 완료', failed: '지급 실패', check: '지급 확인 중' };
const PENDING = ['issuing', 'check'];
const STALE_MS = 60 * 1000; // 요청을 보낸 뒤 1분 넘게 지급 중이면 확인 필요로 옮긴다(서버가 요청 도중 멈춘 경우)
const RECHECK_MS = 24 * 3600 * 1000; // 관리자가 실패 처리한 건은 하루 동안 늦은 지급이 없는지 계속 조회한다
const PAYOUT_REF = /^[A-Za-z0-9가-힣_.:#/-]{2,80}$/;
const AUTO = '자동';
const TABS = {
  check: "e.status IN ('check', 'issuing')",
  completed: "e.status = 'completed'",
  failed: "e.status = 'failed'",
  all: '1 = 1',
};

module.exports = function (s) {
  const { db } = s;
  const now = () => s.clock.now();
  const get = (id) => db.get('SELECT * FROM exchanges WHERE id = ?', id);
  const getByNo = (no) => db.get('SELECT * FROM exchanges WHERE exchange_no = ?', String(no || ''));
  let checking = false;

  function nextNo(at) {
    const prefix = 'EX' + kstDateKey(at).replace(/-/g, '').slice(2) + '-';
    const row = db.get('SELECT exchange_no FROM exchanges WHERE exchange_no LIKE ? ORDER BY length(exchange_no) DESC, exchange_no DESC LIMIT 1', prefix + '%');
    const seq = row ? parseInt(row.exchange_no.slice(prefix.length), 10) + 1 : 1;
    return prefix + String(seq).padStart(4, '0');
  }

  function memberView(ex) {
    return {
      no: ex.exchange_no,
      status: ex.status,
      statusLabel: MEMBER_STATUS[ex.status],
      ticketName: ex.ticket_name,
      quantity: ex.quantity,
      unitPoints: ex.unit_points,
      totalPoints: ex.total_points,
      fulpotId: ex.fulpot_id,
      issueId: ex.status === 'completed' ? ex.payout_ref : null,
      reason: ex.status === 'failed' ? ex.reason : null,
      createdAt: ex.created_at,
      completedAt: ex.completed_at,
      closedAt: ex.closed_at,
    };
  }

  // ───────── 풀팟 결과 반영 (모두 트랜잭션 안에서 부른다) ─────────

  function stateChanged(cur) {
    return E.conflict('STATE_CHANGED', `다른 곳에서 먼저 처리되어 지금은 '${STATUS[cur.status]}' 상태입니다. 목록을 새로고침해 주세요.`, { status: cur.status });
  }

  // 지급이 확인됨: 지급 완료로 바꾸고 원장에서 차감한다. 실패 처리된 건이면 바로잡는다(장부가 실제 지급과 어긋나지 않게).
  function markIssued(ex, issueId, by, { manual = false } = {}) {
    if (ex.status === 'completed') return { outcome: 'already' };
    const at = now();
    const ref = cleanText(issueId, 80);
    const corrected = ex.status === 'failed';
    const note = corrected ? '실패 처리 뒤 풀팟 지급이 확인되어 지급 완료로 바로잡음' : manual ? '관리자가 풀팟 지급 번호를 확인해 완료' : ex.note;
    let r;
    try {
      r = db.run(
        `UPDATE exchanges SET status = 'completed', payout_ref = ?, completed_at = ?, updated_at = ?, handled_by = ?, note = ?, recheck_until = NULL
         WHERE id = ? AND status = ?`,
        ref,
        at,
        at,
        by,
        note,
        ex.id,
        ex.status
      );
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      if (manual) throw E.conflict('PAYOUT_REF_DUP', '이미 다른 신청에 등록된 지급 번호입니다. 풀팟 지급 내역을 다시 확인해 주세요.');
      // 풀팟이 다른 신청의 지급 번호를 돌려줬다: 자동으로 완료하지 않고 사람이 보게 둔다.
      if (PENDING.includes(ex.status)) {
        db.run("UPDATE exchanges SET status = 'check', note = ?, updated_at = ? WHERE id = ?", `풀팟이 돌려준 지급 번호 ${ref}가 다른 신청에 이미 있습니다. 풀팟 관리 도구에서 확인해 주세요.`, at, ex.id);
      }
      return { outcome: 'conflict' };
    }
    if (r.changes !== 1) throw stateChanged(get(ex.id));
    s.points.add({
      memberId: ex.member_id,
      kind: 'use',
      amount: -ex.total_points,
      memo: `${ex.ticket_name} ${ex.quantity}장`,
      dedupeKey: `use:${ex.id}`,
      exchangeId: ex.id,
      occurredAt: at,
      by,
    });
    return { outcome: corrected ? 'corrected' : 'completed', issueId: ref };
  }

  // 지급 요청의 응답
  function applyIssue(id, r, by) {
    const ex = get(id);
    const at = now();
    if (r.status === 'issued') return markIssued(ex, r.issueId, by);
    if (r.status === 'rejected') {
      if (!PENDING.includes(ex.status)) return { outcome: 'ignored' };
      const reason = cleanText(r.reason, 200) || '풀팟에서 지급을 거절했습니다.';
      db.run(
        "UPDATE exchanges SET status = 'failed', reason = ?, note = ?, closed_at = ?, updated_at = ?, handled_by = ? WHERE id = ? AND status = ?",
        reason,
        '풀팟이 지급을 거절함',
        at,
        at,
        by,
        ex.id,
        ex.status
      );
      return { outcome: 'failed', reason };
    }
    // 결과를 모름: 지급됐을 수도 있으므로 포인트는 사용 대기로 둔 채 확인 필요로
    if (ex.status !== 'issuing') return { outcome: 'ignored' };
    db.run("UPDATE exchanges SET status = 'check', note = ?, updated_at = ? WHERE id = ? AND status = 'issuing'", `풀팟 응답을 받지 못함: ${cleanText(r.message, 150)}`, at, ex.id);
    return { outcome: 'check', message: r.message };
  }

  // 지급 기록 조회 결과
  function applyQuery(id, r, by) {
    const ex = get(id);
    if (r.status === 'issued') return markIssued(ex, r.issueId, by);
    const at = now();
    if (ex.status === 'check') {
      const note = r.status === 'not_found' ? '풀팟에 지급 기록 없음' : `지급 기록 조회 실패: ${cleanText(r.message, 150)}`;
      db.run('UPDATE exchanges SET checked_at = ?, note = ? WHERE id = ?', at, note, ex.id);
    } else if (ex.status === 'failed') {
      db.run('UPDATE exchanges SET checked_at = ? WHERE id = ?', at, ex.id);
    }
    return { outcome: r.status, message: r.message };
  }

  async function requestIssue(ex, by) {
    const r = await s.fulpot.issueTicket({ requestKey: ex.exchange_no, uid: ex.fulpot_uid, ticketCode: ex.ticket_code, quantity: ex.quantity });
    return db.tx(() => applyIssue(ex.id, r, by));
  }

  // ───────── 회원 ─────────

  async function create(member, input) {
    const key = v.str(input.requestKey, { label: '요청 키', field: 'requestKey', min: 8, max: 64, pattern: /^[A-Za-z0-9_-]+$/ });
    const qty = v.int(input.quantity, { label: '수량', field: 'quantity', min: 1, max: 1000 });
    const at = now();
    const prep = db.tx(() => {
      // 같은 요청 키(연속 클릭·재전송)는 처음 만든 신청을 그대로 돌려준다. 풀팟 요청도 다시 보내지 않는다.
      const existing = db.get('SELECT * FROM exchanges WHERE member_id = ? AND request_key = ?', member.id, key);
      if (existing) {
        if (existing.quantity !== qty) throw E.conflict('REQUEST_MISMATCH', '이미 처리된 요청과 내용이 다릅니다. 화면을 새로고침해 주세요.');
        return { existing };
      }
      const t = s.settings.ticket();
      if (!t.open) throw E.conflict('EXCHANGE_CLOSED', '지금은 교환 신청을 받지 않습니다.');
      if (input.expectedUnitPoints != null && Number(input.expectedUnitPoints) !== t.unitPoints) {
        throw E.conflict('TERMS_CHANGED', `티켓 1장당 포인트가 ${t.unitPoints}P로 바뀌었습니다. 바뀐 내용을 확인한 뒤 다시 신청해 주세요.`, { unitPoints: t.unitPoints });
      }
      if (t.maxPerExchange && qty > t.maxPerExchange) throw E.bad(`한 번에 ${t.maxPerExchange}장까지 신청할 수 있습니다.`, { field: 'quantity' });
      const link = s.links.activeOf(member.id);
      if (!link) throw E.conflict('LINK_REQUIRED', '티켓을 받을 풀팟 계정을 먼저 연결해 주세요.');
      const total = t.unitPoints * qty;
      const bal = s.points.balance(member.id);
      if (bal.available < total) {
        throw E.conflict('INSUFFICIENT_POINTS', `포인트가 ${total - bal.available}P 부족합니다. 사용 가능 포인트는 ${bal.available}P입니다.`, { available: bal.available });
      }
      let id;
      try {
        id = db.run(
          `INSERT INTO exchanges (exchange_no, member_id, request_key, ticket_name, ticket_code, unit_points, quantity, total_points,
             fulpot_id, fulpot_uid, status, created_at, updated_at, requested_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'issuing', ?, ?, ?)`,
          nextNo(at),
          member.id,
          key,
          t.name,
          s.settings.get('ticket_code') || null,
          t.unitPoints,
          qty,
          total,
          link.fulpot_id,
          link.fulpot_uid,
          at,
          at,
          at
        ).lastInsertRowid;
      } catch (e) {
        if (isUniqueViolation(e)) throw E.conflict('RETRY', '동시에 들어온 요청이 있어 처리하지 못했습니다. 다시 시도해 주세요.');
        throw e;
      }
      return { ex: get(id) };
    });
    if (prep.existing) return { exchange: memberView(prep.existing), replayed: true };
    await requestIssue(prep.ex, AUTO);
    return { exchange: memberView(get(prep.ex.id)), replayed: false };
  }

  function getForMember(member, no) {
    const ex = getByNo(no);
    // 다른 회원의 신청번호는 있는지조차 알리지 않는다.
    if (!ex || ex.member_id !== member.id) throw E.notFound('신청을 찾을 수 없습니다.');
    return memberView(ex);
  }

  function listForMember(memberId, limit = 200) {
    return db.all('SELECT * FROM exchanges WHERE member_id = ? ORDER BY id DESC LIMIT ?', memberId, limit).map(memberView);
  }

  function activeForMember(memberId) {
    return db.all("SELECT * FROM exchanges WHERE member_id = ? AND status IN ('issuing', 'check') ORDER BY id DESC", memberId).map(memberView);
  }

  // ───────── 관리자 ─────────

  function adminRow(r) {
    return {
      id: r.id,
      no: r.exchange_no,
      status: r.status,
      statusLabel: STATUS[r.status],
      ticketName: r.ticket_name,
      ticketCode: r.ticket_code,
      quantity: r.quantity,
      unitPoints: r.unit_points,
      totalPoints: r.total_points,
      fulpotId: r.fulpot_id,
      fulpotUid: r.fulpot_uid,
      payoutRef: r.payout_ref,
      reason: r.reason,
      note: r.note,
      attempts: r.attempts,
      createdAt: r.created_at,
      requestedAt: r.requested_at,
      checkedAt: r.checked_at,
      completedAt: r.completed_at,
      closedAt: r.closed_at,
      handledBy: r.handled_by,
      member: r.member_no ? { id: r.member_id, memberNo: r.member_no, name: r.name, phone: formatPhone(r.phone) } : undefined,
    };
  }
  const ADMIN_SELECT = 'SELECT e.*, m.member_no, m.name, m.phone FROM exchanges e JOIN members m ON m.id = e.member_id';
  const adminById = (id) => adminRow(db.get(`${ADMIN_SELECT} WHERE e.id = ?`, id));

  function listAdmin({ tab = 'check', q, page = 1 } = {}) {
    const cond = TABS[tab] || TABS.check;
    const params = [];
    let w = `WHERE ${cond}`;
    const text = cleanText(q, 60);
    if (text) {
      const like = `%${likeEscape(text)}%`;
      w += " AND (m.name LIKE ? ESCAPE '\\' OR m.member_no LIKE ? ESCAPE '\\' OR e.exchange_no LIKE ? ESCAPE '\\' OR e.fulpot_id LIKE ? ESCAPE '\\' OR e.payout_ref LIKE ? ESCAPE '\\')";
      params.push(like, like.toUpperCase(), like.toUpperCase(), like, like);
    }
    const p = Math.max(1, Number(page) || 1);
    const size = 50;
    const from = 'FROM exchanges e JOIN members m ON m.id = e.member_id';
    const total = db.get(`SELECT COUNT(*) AS c ${from} ${w}`, ...params).c;
    const order = tab === 'check' ? 'e.id ASC' : 'e.id DESC';
    const rows = db.all(`${ADMIN_SELECT} ${w} ORDER BY ${order} LIMIT ? OFFSET ?`, ...params, size, (p - 1) * size).map(adminRow);
    const c = db.get(
      `SELECT SUM(status IN ('check', 'issuing')) AS checks, SUM(status = 'completed') AS completed, SUM(status = 'failed') AS failed, COUNT(*) AS all_count FROM exchanges`
    );
    return {
      total,
      page: p,
      pageSize: size,
      rows,
      counts: { check: c.checks || 0, completed: c.completed || 0, failed: c.failed || 0, all: c.all_count || 0 },
    };
  }

  const checkCount = () => db.get("SELECT COUNT(*) AS c FROM exchanges WHERE status = 'check'").c;

  function listForMemberAdmin(memberId) {
    return db.all(`${ADMIN_SELECT} WHERE e.member_id = ? ORDER BY e.id DESC LIMIT 200`, memberId).map(adminRow);
  }

  // 관리자 처리. 화면에서 본 상태(expected)와 지금 상태가 다르면 막는다.
  async function act(id, action, input = {}, by) {
    const ex = get(id);
    if (!ex) throw E.notFound('신청을 찾을 수 없습니다.');
    if (input.expected && input.expected !== ex.status) throw stateChanged(ex);
    if (!['query', 'retry', 'complete', 'fail'].includes(action)) throw E.bad('알 수 없는 처리입니다.');
    if (ex.status === 'issuing') throw E.conflict('IN_FLIGHT', '풀팟에 지급 요청이 나가 있습니다. 결과가 나올 때까지 잠시 기다린 뒤 다시 확인해 주세요.');
    if (ex.status !== 'check') throw E.conflict('INVALID_STATE', `'${STATUS[ex.status]}' 상태에서는 할 수 없는 작업입니다.`);

    if (action === 'query') {
      const r = await s.fulpot.queryIssue(ex.exchange_no);
      const res = db.tx(() => applyQuery(id, r, by));
      return { exchange: adminById(id), result: res.outcome, message: res.message || null };
    }

    if (action === 'retry') {
      const at = now();
      const r1 = db.run(
        "UPDATE exchanges SET status = 'issuing', attempts = attempts + 1, requested_at = ?, updated_at = ?, handled_by = ?, note = ? WHERE id = ? AND status = 'check'",
        at,
        at,
        by,
        '관리자가 같은 신청번호로 다시 요청',
        id
      );
      if (r1.changes !== 1) throw stateChanged(get(id));
      const res = await requestIssue(get(id), by);
      return { exchange: adminById(id), result: res.outcome, message: res.reason || res.message || null };
    }

    if (action === 'complete') {
      const payoutRef = v.str(input.payoutRef, {
        label: '지급 번호',
        field: 'payoutRef',
        min: 2,
        max: 80,
        pattern: PAYOUT_REF,
        patternMessage: '지급 번호에는 문자, 숫자와 _ . : # / - 만 쓸 수 있습니다.',
      });
      db.tx(() => {
        const cur = get(id);
        if (cur.status !== 'check') throw stateChanged(cur);
        markIssued(cur, payoutRef, by, { manual: true });
      });
      return { exchange: adminById(id), result: 'completed' };
    }

    // fail: 처리 직전에 풀팟 지급 기록을 다시 본다. 지급돼 있으면 실패 대신 완료.
    const reason = v.str(input.reason, { label: '실패 사유', field: 'reason', min: 2, max: 200 });
    const skipCheck = v.bool(input.skipCheck);
    if (!skipCheck) {
      const r = await s.fulpot.queryIssue(ex.exchange_no);
      if (r.status === 'issued') {
        const res = db.tx(() => applyQuery(id, r, by));
        return { exchange: adminById(id), result: res.outcome === 'conflict' ? 'conflict' : 'issued' };
      }
      if (r.status !== 'not_found') {
        db.tx(() => applyQuery(id, r, by));
        throw E.conflict(
          'FULPOT_UNREACHABLE',
          '풀팟 지급 기록을 확인하지 못해 실패 처리하지 않았습니다. 잠시 뒤 다시 시도하거나, 풀팟 관리 도구에서 지급되지 않은 것을 직접 확인했다면 기록 확인 없이 실패 처리해 주세요.'
        );
      }
    }
    const at = now();
    const r2 = db.run(
      `UPDATE exchanges SET status = 'failed', reason = ?, note = ?, closed_at = ?, updated_at = ?, handled_by = ?, recheck_until = ?
       WHERE id = ? AND status = 'check'`,
      reason,
      skipCheck ? '풀팟 기록 확인 없이 관리자가 실패 처리' : '풀팟에 지급 기록이 없음을 확인하고 실패 처리',
      at,
      at,
      by,
      at + RECHECK_MS,
      id
    );
    if (r2.changes !== 1) throw stateChanged(get(id));
    return { exchange: adminById(id), result: 'failed' };
  }

  // ───────── 1분마다: 멈춘 요청 정리와 지급 기록 조회 ─────────
  async function checkIssues({ limit = 30 } = {}) {
    if (checking) return { skipped: true };
    checking = true;
    const out = { moved: 0, checked: 0, completed: 0, corrected: 0 };
    try {
      const at = now();
      out.moved = db.run(
        "UPDATE exchanges SET status = 'check', note = ?, updated_at = ? WHERE status = 'issuing' AND requested_at < ?",
        '지급 요청 뒤 1분이 지나도록 결과가 없어 확인 대상으로 옮김',
        at,
        at - STALE_MS
      ).changes;
      const rows = db.all(
        "SELECT id, exchange_no FROM exchanges WHERE status = 'check' OR (status = 'failed' AND recheck_until > ?) ORDER BY COALESCE(checked_at, 0), id LIMIT ?",
        at,
        limit
      );
      for (const row of rows) {
        const r = await s.fulpot.queryIssue(row.exchange_no);
        out.checked++;
        let res;
        try {
          res = db.tx(() => applyQuery(row.id, r, AUTO));
        } catch (e) {
          if (e && e.code === 'STATE_CHANGED') continue;
          throw e;
        }
        if (res.outcome === 'completed') out.completed++;
        if (res.outcome === 'corrected') out.corrected++;
      }
      return out;
    } finally {
      checking = false;
    }
  }

  return {
    STATUS,
    PENDING,
    create,
    getForMember,
    listForMember,
    activeForMember,
    listAdmin,
    listForMemberAdmin,
    checkCount,
    act,
    checkIssues,
    memberView,
  };
};

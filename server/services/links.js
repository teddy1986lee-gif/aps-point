'use strict';
const { AppError, E, isUniqueViolation } = require('../lib/errors');
const v = require('../lib/validate');
const { formatPhone, likeEscape, cleanText } = require('../lib/format');
const { createLimiter } = require('../lib/ratelimit');

/*
 * 풀팟 계정 연결 — 운영자 승인 없이, 풀팟에 있는 계정이면 바로 연결한다.
 *   1) 회원이 풀팟 ID를 넣으면 풀팟에서 계정을 찾아 닉네임을 보여 준다(lookup).
 *   2) 회원이 [이 계정으로 연결]을 누르면 서버가 풀팟에서 한 번 더 확인하고 그 자리에서 연결한다(link).
 * 한 회원에 계정 하나, 한 풀팟 계정(ID와 풀팟 내부 번호 모두)에 회원 한 명만 연결된다(DB 고유 제약).
 * 다른 계정으로 바꾸면 이전 연결은 '해제'로 남는다. 관리자는 잘못된 연결을 사유와 함께 해제할 수 있다.
 * 이미 신청한 교환은 신청할 때의 계정으로 처리한다(교환에 풀팟 내부 번호를 따로 저장).
 */
const FULPOT_ID = /^[A-Za-z0-9가-힣._-]{2,30}$/;
const STATUS = { active: '연결됨', released: '해제됨' };
const KIND = { changed: '회원이 변경', admin: '관리자 해제' };
const LOOKUPS_PER_HOUR = 30;

module.exports = function (s) {
  const { db } = s;
  const now = () => s.clock.now();
  const keyOf = (id) => String(id).toLowerCase();
  const limiter = createLimiter();

  const get = (id) => db.get('SELECT * FROM links WHERE id = ?', id);
  const activeOf = (memberId) => db.get("SELECT * FROM links WHERE member_id = ? AND status = 'active'", memberId);

  function memberView(memberId) {
    const a = activeOf(memberId);
    // 운영팀이 해제한 경우에만 이유를 보여 준다(회원이 직접 바꾼 기록은 알릴 필요가 없다).
    const last = a ? null : db.get("SELECT * FROM links WHERE member_id = ? AND status = 'released' ORDER BY released_at DESC, id DESC LIMIT 1", memberId);
    return {
      active: a ? { fulpotId: a.fulpot_id, nickname: a.nickname || '', since: a.linked_at } : null,
      released: last && last.release_kind === 'admin' ? { fulpotId: last.fulpot_id, reason: last.release_reason, at: last.released_at } : null,
    };
  }

  function readId(raw) {
    return v.str(raw, {
      label: '풀팟 ID',
      field: 'fulpotId',
      min: 2,
      max: 30,
      pattern: FULPOT_ID,
      patternMessage: '풀팟 ID는 영문, 숫자, 한글과 . _ - 만 쓸 수 있습니다.',
    });
  }

  function precheck(member, key, uid) {
    const mine = activeOf(member.id);
    if (mine && (mine.fulpot_key === key || (uid && mine.fulpot_uid === uid))) throw E.conflict('LINK_SAME', '이미 연결된 계정입니다.');
    const other = uid
      ? db.get("SELECT id FROM links WHERE status = 'active' AND member_id <> ? AND (fulpot_key = ? OR fulpot_uid = ?)", member.id, key, uid)
      : db.get("SELECT id FROM links WHERE status = 'active' AND member_id <> ? AND fulpot_key = ?", member.id, key);
    if (other) throw E.conflict('ALREADY_LINKED', '이미 다른 APS 회원에게 연결된 풀팟 계정입니다. 본인 계정이 맞다면 운영팀에 문의해 주세요.');
  }

  function throttle(member) {
    const r = limiter.hit(`link:${member.id}`, LOOKUPS_PER_HOUR, 3600e3, now());
    if (!r.ok) throw E.rate('풀팟 계정 확인을 너무 여러 번 했습니다. 잠시 후 다시 시도해 주세요.', r.retryAfter);
  }

  async function findAccount(fulpotId) {
    const r = await s.fulpot.lookupAccount(fulpotId);
    if (r.status === 'found') return { uid: String(r.uid), fulpotId: cleanText(r.fulpotId, 30) || fulpotId, nickname: cleanText(r.nickname, 40) };
    if (r.status === 'not_found') {
      throw new AppError(422, 'FULPOT_NOT_FOUND', '풀팟에서 이 ID를 찾지 못했습니다. 풀팟홀덤 앱의 내 정보에 있는 ID인지 철자를 확인해 주세요.');
    }
    throw new AppError(503, 'FULPOT_UNAVAILABLE', '지금은 풀팟 계정을 확인할 수 없어 연결하지 않았습니다. 잠시 후 다시 시도해 주세요.');
  }

  // 1) 계정 확인: 연결하지 않고 풀팟에서 찾은 계정(닉네임)만 돌려준다.
  async function lookup(member, rawId) {
    const fulpotId = readId(rawId);
    precheck(member, keyOf(fulpotId));
    throttle(member);
    const acc = await findAccount(fulpotId);
    precheck(member, keyOf(acc.fulpotId), acc.uid);
    return { fulpotId: acc.fulpotId, nickname: acc.nickname };
  }

  // 2) 연결: 서버가 풀팟에서 다시 확인한 뒤 바로 연결한다(화면에서 보낸 값은 믿지 않는다).
  async function link(member, rawId) {
    const fulpotId = readId(rawId);
    precheck(member, keyOf(fulpotId));
    throttle(member);
    const acc = await findAccount(fulpotId);
    return db.tx(() => {
      const key = keyOf(acc.fulpotId);
      precheck(member, key, acc.uid);
      const at = now();
      db.run(
        "UPDATE links SET status = 'released', released_at = ?, release_kind = 'changed', release_reason = ?, released_by = ? WHERE member_id = ? AND status = 'active'",
        at,
        `${acc.fulpotId} 계정으로 변경`,
        '회원',
        member.id
      );
      try {
        db.run(
          "INSERT INTO links (member_id, fulpot_id, fulpot_key, fulpot_uid, nickname, status, linked_at) VALUES (?, ?, ?, ?, ?, 'active', ?)",
          member.id,
          acc.fulpotId,
          key,
          acc.uid,
          acc.nickname || null,
          at
        );
      } catch (e) {
        if (isUniqueViolation(e)) throw E.conflict('ALREADY_LINKED', '이미 다른 APS 회원에게 연결된 풀팟 계정입니다. 본인 계정이 맞다면 운영팀에 문의해 주세요.');
        throw e;
      }
      return memberView(member.id);
    });
  }

  // ───────── 관리자 ─────────
  function adminRow(r) {
    return {
      id: r.id,
      status: r.status,
      statusLabel: STATUS[r.status],
      fulpotId: r.fulpot_id,
      fulpotUid: r.fulpot_uid,
      nickname: r.nickname || '',
      linkedAt: r.linked_at,
      releasedAt: r.released_at,
      releaseKind: r.release_kind,
      releaseKindLabel: r.release_kind ? KIND[r.release_kind] : null,
      releaseReason: r.release_reason,
      releasedBy: r.released_by,
      member: r.member_no ? { id: r.member_id, memberNo: r.member_no, name: r.name, phone: formatPhone(r.phone), status: r.member_status } : undefined,
    };
  }
  const ADMIN_SELECT = 'SELECT k.*, m.member_no, m.name, m.phone, m.status AS member_status FROM links k JOIN members m ON m.id = k.member_id';

  function listAdmin({ tab = 'active', q } = {}) {
    const params = [];
    let w = tab === 'released' ? "WHERE k.status = 'released'" : "WHERE k.status = 'active'";
    const text = cleanText(q, 60);
    if (text) {
      const like = `%${likeEscape(text)}%`;
      w += " AND (m.name LIKE ? ESCAPE '\\' OR m.member_no LIKE ? ESCAPE '\\' OR k.fulpot_key LIKE ? ESCAPE '\\' OR k.nickname LIKE ? ESCAPE '\\')";
      params.push(like, like, like.toLowerCase(), like);
    }
    const order = tab === 'released' ? 'k.released_at DESC, k.id DESC' : 'k.linked_at DESC, k.id DESC';
    const rows = db.all(`${ADMIN_SELECT} ${w} ORDER BY ${order} LIMIT 300`, ...params).map(adminRow);
    const c = db.get("SELECT SUM(status = 'active') AS active, SUM(status = 'released') AS released FROM links");
    return { rows, counts: { active: c.active || 0, released: c.released || 0 } };
  }

  function release(id, input, by) {
    const reason = v.str(input.reason, { label: '해제 사유', field: 'reason', min: 2, max: 200 });
    const r = db.run(
      "UPDATE links SET status = 'released', released_at = ?, release_kind = 'admin', release_reason = ?, released_by = ? WHERE id = ? AND status = 'active'",
      now(),
      reason,
      by,
      id
    );
    if (!r.changes) {
      if (!get(id)) throw E.notFound('연결 기록을 찾을 수 없습니다.');
      throw E.conflict('INVALID_STATE', '이미 해제된 연결입니다. 목록을 새로고침해 주세요.');
    }
    return adminRow(db.get(`${ADMIN_SELECT} WHERE k.id = ?`, id));
  }

  function historyOf(memberId) {
    return db.all(`${ADMIN_SELECT} WHERE k.member_id = ? ORDER BY k.id DESC`, memberId).map(adminRow);
  }

  return { FULPOT_ID, STATUS, activeOf, memberView, lookup, link, listAdmin, release, historyOf };
};

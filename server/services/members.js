'use strict';
const { E, isUniqueViolation } = require('../lib/errors');
const v = require('../lib/validate');
const { normalizePhone, formatPhone, maskPhone, nameKey, cleanText, likeEscape } = require('../lib/format');

const MEMBER_NO = /^[A-Za-z0-9][A-Za-z0-9_-]{0,29}$/;
const WEB_PREFIX = 'WEB-'; // 관리자가 직접 등록한 회원의 내부 번호. APS 공식 번호와 섞이지 않게 따로 쓴다.
const PAGE = 50;
const MAX_POINTS = 1000000;

module.exports = function (s) {
  const { db } = s;
  const now = () => s.clock.now();

  const get = (id) => db.get('SELECT * FROM members WHERE id = ?', id);
  const byNo = (no) => db.get('SELECT * FROM members WHERE member_no = ?', String(no || '').trim().toUpperCase());
  const byPhone = (phone) => db.all('SELECT * FROM members WHERE phone = ? ORDER BY id', phone);
  const isWebNo = (no) => String(no || '').toUpperCase().startsWith(WEB_PREFIX);

  function normalizeNo(raw) {
    const no = String(raw ?? '').normalize('NFC').trim().toUpperCase();
    return MEMBER_NO.test(no) ? no : null;
  }

  // 업로드·직접 등록·시드에서 쓴다. 검사는 호출하는 쪽에서 끝낸 값이 들어온다.
  function insert({ memberNo, name, phone }, at = now()) {
    try {
      return db.run(
        'INSERT INTO members (member_no, name, name_key, phone, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        memberNo,
        name,
        nameKey(name),
        phone,
        'active',
        at,
        at
      ).lastInsertRowid;
    } catch (e) {
      if (isUniqueViolation(e)) throw E.conflict('MEMBER_NO_DUP', `이미 있는 회원번호입니다: ${memberNo}`, { field: 'memberNo' });
      throw e;
    }
  }

  function nextWebNo() {
    const row = db.get("SELECT member_no FROM members WHERE member_no LIKE 'WEB-%' ORDER BY length(member_no) DESC, member_no DESC LIMIT 1");
    const last = row ? parseInt(row.member_no.slice(WEB_PREFIX.length), 10) : 0;
    return WEB_PREFIX + String((Number.isFinite(last) ? last : 0) + 1).padStart(5, '0');
  }

  const SELECT_WITH_POINTS = `
    SELECT m.*,
      COALESCE((SELECT SUM(l.amount) FROM ledger l WHERE l.member_id = m.id), 0) AS total,
      COALESCE((SELECT SUM(e.total_points) FROM exchanges e WHERE e.member_id = m.id AND e.status IN ('issuing', 'check')), 0) AS pending,
      (SELECT k.fulpot_id FROM links k WHERE k.member_id = m.id AND k.status = 'active') AS fulpot_id,
      (SELECT k.nickname FROM links k WHERE k.member_id = m.id AND k.status = 'active') AS fulpot_nickname,
      (SELECT COUNT(*) FROM exchanges e WHERE e.member_id = m.id AND e.status = 'check') AS checks,
      EXISTS (SELECT 1 FROM registrations r WHERE r.member_id = m.id AND r.kind = 'created') AS direct
    FROM members m`;

  function listView(r) {
    return {
      id: r.id,
      memberNo: r.member_no,
      name: r.name,
      phone: formatPhone(r.phone),
      status: r.status,
      fulpotId: r.fulpot_id || null,
      fulpotNickname: r.fulpot_nickname || '',
      checks: r.checks || 0,
      direct: !!r.direct,
      points: { total: r.total, pending: r.pending, available: r.total - r.pending },
    };
  }

  function search({ q, page = 1 } = {}) {
    const where = [];
    const params = [];
    const text = cleanText(q, 60);
    if (text) {
      const like = `%${likeEscape(text)}%`;
      const digits = text.replace(/\D/g, '');
      const parts = ["m.name LIKE ? ESCAPE '\\'", "m.member_no LIKE ? ESCAPE '\\'", "EXISTS (SELECT 1 FROM links k WHERE k.member_id = m.id AND k.fulpot_key LIKE ? ESCAPE '\\')"];
      params.push(like, like.toUpperCase(), like.toLowerCase());
      if (digits.length >= 3) {
        parts.push('m.phone LIKE ?');
        params.push(`%${digits}%`);
      }
      where.push(`(${parts.join(' OR ')})`);
    }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = db.get(`SELECT COUNT(*) AS c FROM members m ${w}`, ...params).c;
    const p = Math.max(1, Number(page) || 1);
    const rows = db.all(`${SELECT_WITH_POINTS} ${w} ORDER BY m.member_no LIMIT ? OFFSET ?`, ...params, PAGE, (p - 1) * PAGE);
    return { total, page: p, pageSize: PAGE, rows: rows.map(listView) };
  }

  function detail(id) {
    const r = db.get(`${SELECT_WITH_POINTS} WHERE m.id = ?`, id);
    if (!r) throw E.notFound('회원을 찾을 수 없습니다.');
    const sameRecord = db
      .all('SELECT member_no FROM members WHERE phone = ? AND name_key = ? AND id <> ? ORDER BY member_no', r.phone, r.name_key, r.id)
      .map((x) => x.member_no);
    return {
      member: { ...listView(r), memo: r.memo || '', createdAt: r.created_at, lastLoginAt: r.last_login_at, duplicates: sameRecord },
      ledger: s.points.ledgerOf(id, 200),
      exchanges: s.exchanges.listForMemberAdmin(id),
      links: s.links.historyOf(id),
    };
  }

  function readMemberNo(raw) {
    const no = normalizeNo(raw);
    if (!no) throw E.bad('회원번호는 영문·숫자와 - _ 로 30자까지 쓸 수 있습니다. 예) APS-10041', { field: 'memberNo' });
    return no;
  }

  function update(id, input, by) {
    const m = get(id);
    if (!m) throw E.notFound('회원을 찾을 수 없습니다.');
    let memberNo = m.member_no;
    if (input.memberNo != null && String(input.memberNo).trim() !== '') {
      const no = readMemberNo(input.memberNo);
      if (no !== m.member_no) {
        if (isWebNo(no)) throw E.bad('WEB-로 시작하는 번호는 직접 등록할 때 자동으로만 붙습니다. APS 회원번호를 입력해 주세요.', { field: 'memberNo' });
        const taken = byNo(no);
        if (taken) throw E.conflict('MEMBER_NO_DUP', `이미 다른 회원(${taken.name})이 쓰는 회원번호입니다: ${no}`, { field: 'memberNo' });
        memberNo = no;
      }
    }
    const name = input.name != null ? v.str(input.name, { label: '이름', field: 'name', max: 40 }) : m.name;
    let phone = m.phone;
    if (input.phone != null) {
      phone = normalizePhone(input.phone);
      if (!phone) throw E.bad('휴대폰 번호를 확인해 주세요. 예) 010-1234-5678', { field: 'phone' });
    }
    const status = input.status != null ? v.oneOf(input.status, ['active', 'stopped'], { label: '회원 상태', field: 'status' }) : m.status;
    const memo = input.memo != null ? cleanText(input.memo, 300) || null : m.memo;
    try {
      db.run(
        'UPDATE members SET member_no = ?, name = ?, name_key = ?, phone = ?, status = ?, memo = ?, updated_at = ? WHERE id = ?',
        memberNo,
        name,
        nameKey(name),
        phone,
        status,
        memo,
        now(),
        id
      );
    } catch (e) {
      if (isUniqueViolation(e)) throw E.conflict('MEMBER_NO_DUP', `이미 있는 회원번호입니다: ${memberNo}`, { field: 'memberNo' });
      throw e;
    }
    // 번호가 바뀌거나 이용이 중지되면 기존 로그인은 끝낸다.
    if (phone !== m.phone || (status === 'stopped' && m.status !== 'stopped')) s.auth.revokeMemberSessions(id);
    return detail(id);
  }

  function memberView(m) {
    return { name: m.name, memberNo: m.member_no, phone: maskPhone(m.phone) };
  }

  function summary(m) {
    return { id: m.id, memberNo: m.member_no, name: m.name, phone: formatPhone(m.phone), status: m.status, points: s.points.balance(m.id) };
  }

  // ───────── 관리자 직접 등록 ─────────
  // 현장·전화로 받은 이름과 휴대폰 번호로 회원을 등록하고, 넣은 포인트를 바로 지급한다.
  //  - 같은 이름·휴대폰의 회원이 있으면 새로 만들지 않고 'exists'로 알려 준다(화면에서 그 회원에게 지급 여부를 고른다).
  //  - memberId를 주면 그 기존 회원에게 포인트만 지급한다.
  //  - 같은 요청 키는 한 번만 처리한다(버튼 연속 클릭·재전송).
  function register(input, by) {
    const key = v.str(input.requestKey, { label: '요청 키', field: 'requestKey', min: 8, max: 64, pattern: /^[A-Za-z0-9_-]+$/ });
    const points = input.points == null || String(input.points).trim() === '' ? 0 : v.int(input.points, { label: '지급 포인트', field: 'points', min: 1, max: MAX_POINTS });
    const reason = cleanText(input.reason, 101);
    if (reason.length > 100) throw E.bad('지급 사유는 100자 이하로 입력해 주세요.', { field: 'reason' });
    const grantTo = input.memberId != null && input.memberId !== '' ? v.int(input.memberId, { label: '회원', field: 'memberId', min: 1 }) : null;

    return db.tx(() => {
      const done = db.get('SELECT * FROM registrations WHERE request_key = ?', key);
      if (done) return { result: done.kind, member: summary(get(done.member_id)), points: done.points, replayed: true, warnings: [] };
      const at = now();
      const record = (kind, memberId) =>
        db.run('INSERT INTO registrations (request_key, kind, member_id, points, reason, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)', key, kind, memberId, points, reason || null, at, by ?? null);
      const grant = (memberId) => {
        if (!points) return;
        s.points.add({ memberId, kind: 'earn', amount: points, memo: reason || '포인트 지급', sourceRef: '직접 등록', dedupeKey: `reg:${key}`, occurredAt: at, by });
      };

      if (grantTo) {
        const m = get(grantTo);
        if (!m) throw E.notFound('회원을 찾을 수 없습니다.');
        if (!points) throw E.bad('지급할 포인트를 입력해 주세요.', { field: 'points' });
        record('granted', m.id);
        grant(m.id);
        return { result: 'granted', member: summary(get(m.id)), points, replayed: false, warnings: [] };
      }

      const name = v.str(input.name, { label: '이름', field: 'name', max: 40 });
      const phone = normalizePhone(input.phone);
      if (!phone) throw E.bad('휴대폰 번호를 확인해 주세요. 예) 010-1234-5678', { field: 'phone' });
      const same = byPhone(phone).filter((m) => m.name_key === nameKey(name));
      if (same.length) {
        return { result: 'exists', member: summary(same[0]), duplicates: same.slice(1).map((m) => m.member_no), points, replayed: false, warnings: [] };
      }
      let memberNo;
      if (input.memberNo != null && String(input.memberNo).trim() !== '') {
        memberNo = readMemberNo(input.memberNo);
        if (isWebNo(memberNo)) throw E.bad('WEB-로 시작하는 번호는 자동으로 붙는 내부 번호입니다. APS 회원번호가 없으면 칸을 비워 두세요.', { field: 'memberNo' });
        const taken = byNo(memberNo);
        if (taken) throw E.conflict('MEMBER_NO_DUP', `이미 다른 회원(${taken.name})이 쓰는 회원번호입니다: ${memberNo}`, { field: 'memberNo' });
      } else {
        memberNo = nextWebNo();
      }
      const others = byPhone(phone);
      const id = insert({ memberNo, name, phone }, at);
      record('created', id);
      grant(id);
      const warnings = others.map((m) => `같은 휴대폰 번호로 이름이 다른 회원(${m.member_no} ${m.name})이 있습니다. 같은 사람이면 한쪽 기록을 정리해 주세요.`);
      return { result: 'created', member: summary(get(id)), points, replayed: false, warnings };
    });
  }

  function registrations(limit = 50) {
    return db
      .all(
        `SELECT r.*, m.member_no, m.name, m.phone FROM registrations r JOIN members m ON m.id = r.member_id ORDER BY r.id DESC LIMIT ?`,
        limit
      )
      .map((r) => ({
        id: r.id,
        kind: r.kind,
        points: r.points,
        reason: r.reason,
        createdAt: r.created_at,
        createdBy: r.created_by,
        member: { id: r.member_id, memberNo: r.member_no, name: r.name, phone: formatPhone(r.phone) },
      }));
  }

  return { MEMBER_NO, WEB_PREFIX, get, byNo, byPhone, isWebNo, normalizeNo, insert, nextWebNo, search, detail, update, memberView, register, registrations };
};

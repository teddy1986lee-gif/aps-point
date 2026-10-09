'use strict';
const { E } = require('../lib/errors');
const v = require('../lib/validate');
const { normalizePhone, nameKey, cleanText, parsePoints, parseDateTime } = require('../lib/format');

/*
 * 포인트 원장
 * - 총 보유  = 원장(적립·조정·교환 차감) 합계
 * - 사용 대기 = 지급 중·확인 필요인 교환의 포인트 합계 (풀팟 지급이 확인돼야 원장에서 차감)
 * - 사용 가능 = 총 보유 − 사용 대기
 * 같은 원본 건은 dedupe_key로 한 번만 들어간다.
 */
const MAX_POINTS = 1000000;

module.exports = function (s) {
  const { db } = s;
  const now = () => s.clock.now();

  function balance(memberId) {
    const total = db.get('SELECT COALESCE(SUM(amount), 0) AS t FROM ledger WHERE member_id = ?', memberId).t;
    const pending = db.get("SELECT COALESCE(SUM(total_points), 0) AS t FROM exchanges WHERE member_id = ? AND status IN ('issuing', 'check')", memberId).t;
    return { total, pending, available: total - pending };
  }

  function ledgerView(r) {
    return {
      id: r.id,
      kind: r.kind,
      amount: r.amount,
      memo: r.memo,
      sourceRef: r.source_ref,
      exchangeNo: r.exchange_no || null,
      occurredAt: r.occurred_at,
      createdAt: r.created_at,
      createdBy: r.created_by,
    };
  }

  function ledgerOf(memberId, limit = 50) {
    return db
      .all(
        `SELECT l.*, e.exchange_no FROM ledger l LEFT JOIN exchanges e ON e.id = l.exchange_id
         WHERE l.member_id = ? ORDER BY l.occurred_at DESC, l.id DESC LIMIT ?`,
        memberId,
        limit
      )
      .map(ledgerView);
  }

  function add({ memberId, kind, amount, memo, sourceRef, dedupeKey, exchangeId, uploadId, occurredAt, by }) {
    const at = now();
    return db.run(
      `INSERT INTO ledger (member_id, kind, amount, memo, source_ref, dedupe_key, exchange_id, upload_id, occurred_at, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      memberId,
      kind,
      amount,
      memo ?? null,
      sourceRef ?? null,
      dedupeKey ?? null,
      exchangeId ?? null,
      uploadId ?? null,
      occurredAt ?? at,
      at,
      by ?? null
    ).lastInsertRowid;
  }

  // 관리자 조정: 사유 필수, 사용 가능 포인트보다 많이 뺄 수 없음, 같은 요청 키는 한 번만
  function adjust(memberId, input, by) {
    const amount = v.int(input.amount, { label: '조정 포인트', field: 'amount', min: -MAX_POINTS, max: MAX_POINTS });
    if (amount === 0) throw E.bad('조정 포인트는 0이 아니어야 합니다.', { field: 'amount' });
    const reason = v.str(input.reason, { label: '조정 사유', field: 'reason', min: 2, max: 100 });
    const key = v.str(input.requestKey, { label: '요청 키', field: 'requestKey', min: 8, max: 64, pattern: /^[A-Za-z0-9_-]+$/ });
    return db.tx(() => {
      const m = s.members.get(memberId);
      if (!m) throw E.notFound('회원을 찾을 수 없습니다.');
      const dedupeKey = `adj:${key}`;
      if (db.get('SELECT id FROM ledger WHERE dedupe_key = ?', dedupeKey)) return { replayed: true, points: balance(memberId) };
      const bal = balance(memberId);
      if (amount < 0 && bal.available + amount < 0) {
        throw E.conflict('INSUFFICIENT_POINTS', `사용 가능 포인트(${bal.available}P)보다 많이 뺄 수 없습니다.`);
      }
      add({ memberId, kind: 'adjust', amount, memo: reason, dedupeKey, by });
      return { replayed: false, points: balance(memberId) };
    });
  }

  // ---------------- 엑셀·CSV 포인트 등록 ----------------
  // rows: [{ __row, source_ref, member_no, name, phone, points, earned_at, reason }]
  function classify(rows, basisAt) {
    if (!Array.isArray(rows) || !rows.length) throw E.bad('등록할 행이 없습니다. 파일 내용을 확인해 주세요.');
    if (rows.length > 20000) throw E.bad('한 번에 20,000행까지 올릴 수 있습니다. 파일을 나눠 올려 주세요.');
    const seenPair = new Map(); // 회원번호+건 번호 → 처음 나온 행
    const newMembers = new Map(); // 파일에서 새로 만들 회원번호 → { name, phone }
    const running = new Map(); // 회원별 사용 가능 포인트(파일 앞 행 반영)
    const items = [];

    for (let i = 0; i < rows.length; i++) {
      const raw = rows[i] || {};
      const row = Number(raw.__row) || i + 2;
      const has = (k) => raw[k] != null && String(raw[k]).trim() !== '';
      const errors = [];
      const warnings = [];

      const memberNo = s.members.normalizeNo(raw.member_no);
      if (!has('member_no')) errors.push('회원번호가 비어 있습니다.');
      else if (!memberNo) errors.push(`회원번호 형식이 올바르지 않습니다 (${cleanText(raw.member_no, 40)}).`);

      const sourceRef = cleanText(raw.source_ref, 61);
      if (!sourceRef) errors.push('건 번호가 비어 있습니다.');
      else if (sourceRef.length > 60) errors.push('건 번호는 60자 이하여야 합니다.');

      const points = parsePoints(raw.points);
      if (!has('points')) errors.push('포인트가 비어 있습니다.');
      else if (points == null || points === 0 || Math.abs(points) > MAX_POINTS) errors.push(`포인트는 0이 아닌 정수여야 합니다 (${cleanText(raw.points, 20)}).`);

      const name = cleanText(raw.name, 41);
      if (name.length > 40) errors.push('이름이 너무 깁니다.');
      let phone = null;
      if (has('phone')) {
        phone = normalizePhone(raw.phone);
        if (!phone) errors.push(`휴대폰 번호를 확인해 주세요 (${cleanText(raw.phone, 20)}).`);
      }

      let earnedAt = basisAt;
      if (has('earned_at')) {
        earnedAt = parseDateTime(raw.earned_at);
        if (earnedAt == null) errors.push(`적립일을 읽을 수 없습니다 (${cleanText(raw.earned_at, 30)}).`);
      }
      const reason = cleanText(raw.reason, 100) || (points != null && points < 0 ? '포인트 차감' : '포인트 적립');

      let result = 'ok';
      let member = null;
      if (memberNo) {
        member = s.members.byNo(memberNo);
        if (member) {
          if (name && nameKey(name) !== member.name_key) errors.push(`이름이 회원 기록(${member.name})과 다릅니다.`);
          if (phone && phone !== member.phone) warnings.push('휴대폰 번호가 회원 기록과 다릅니다. 회원 정보는 바꾸지 않습니다.');
        } else if (newMembers.has(memberNo)) {
          const first = newMembers.get(memberNo);
          if (name && nameKey(name) !== nameKey(first.name)) errors.push(`같은 회원번호의 이름이 ${first.row}행과 다릅니다.`);
          result = 'ok';
        } else {
          if (s.members.isWebNo(memberNo)) errors.push('WEB-로 시작하는 번호는 직접 등록용 내부 번호라 파일로 새 회원을 만들 수 없습니다.');
          else if (!name || !phone) errors.push('새 회원은 이름과 휴대폰 번호가 있어야 합니다.');
          else {
            const same = s.members.byPhone(phone).find((m) => m.name_key === nameKey(name));
            if (same && s.members.isWebNo(same.member_no)) {
              errors.push(`같은 이름·휴대폰 번호로 직접 등록한 회원(${same.member_no})이 있습니다. 같은 사람이면 회원 상세에서 회원번호를 ${memberNo}로 바꾼 뒤 다시 올려 주세요.`);
            } else if (same) errors.push(`같은 이름·휴대폰 번호의 회원(${same.member_no})이 이미 있습니다. 회원번호를 확인해 주세요.`);
          }
          result = 'new';
        }
      }

      if (memberNo && sourceRef) {
        const pairKey = `${memberNo}\u0000${sourceRef}`;
        if (seenPair.has(pairKey)) errors.push(`${seenPair.get(pairKey)}행과 회원번호·건 번호가 같습니다.`);
        else seenPair.set(pairKey, row);
      }

      if (!errors.length && member && db.get('SELECT id FROM ledger WHERE dedupe_key = ?', `src:${member.id}:${sourceRef}`)) {
        items.push({ row, result: 'dup', memberNo, name: name || member.name, points, sourceRef, reason, earnedAt, messages: ['이미 반영된 건입니다.'], warnings });
        continue;
      }

      if (!errors.length && points < 0) {
        const key = memberNo;
        const avail = running.has(key) ? running.get(key) : member ? balance(member.id).available : 0;
        if (avail + points < 0) errors.push(`사용 가능 포인트(${avail}P)보다 많이 뺄 수 없습니다.`);
      }

      if (errors.length) {
        items.push({ row, result: 'error', memberNo: memberNo || cleanText(raw.member_no, 40), name, points, sourceRef, reason, earnedAt, messages: errors, warnings });
        continue;
      }

      if (result === 'new') newMembers.set(memberNo, { name, phone, row });
      const key = memberNo;
      const base = running.has(key) ? running.get(key) : member ? balance(member.id).available : 0;
      running.set(key, base + points);
      items.push({ row, result, memberNo, name: name || (member ? member.name : newMembers.get(memberNo).name), phone, points, sourceRef, reason, earnedAt, messages: [], warnings });
    }

    const apply = items.filter((x) => x.result === 'ok' || x.result === 'new');
    return {
      items,
      summary: {
        total: items.length,
        apply: apply.length,
        newMembers: newMembers.size,
        dup: items.filter((x) => x.result === 'dup').length,
        error: items.filter((x) => x.result === 'error').length,
        points: apply.reduce((a, x) => a + x.points, 0),
      },
    };
  }

  function readBasis(input) {
    if (input.basisAt == null || input.basisAt === '') return now();
    const ms = typeof input.basisAt === 'number' ? input.basisAt : parseDateTime(input.basisAt);
    if (ms == null) throw E.bad('자료 기준 시점을 확인해 주세요.', { field: 'basisAt' });
    if (ms > now() + 60000) throw E.bad('자료 기준 시점은 지금보다 뒤일 수 없습니다.', { field: 'basisAt' });
    return ms;
  }

  function previewUpload(input) {
    return classify(input.rows, readBasis(input));
  }

  // 반영 직전에 다시 검사하고, 정상 행만 한 트랜잭션으로 반영한다.
  function commitUpload(input, by) {
    const basisAt = readBasis(input);
    const fileName = cleanText(input.fileName, 120) || null;
    return db.tx(() => {
      const { items, summary } = classify(input.rows, basisAt);
      if (!summary.apply) throw E.conflict('NOTHING_TO_APPLY', '반영할 정상 행이 없습니다.');
      const at = now();
      const uploadId = db.run(
        `INSERT INTO uploads (file_name, total_rows, applied_rows, applied_points, new_members, skipped_rows, basis_at, created_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        fileName,
        summary.total,
        summary.apply,
        summary.points,
        summary.newMembers,
        summary.total - summary.apply,
        basisAt,
        at,
        by ?? null
      ).lastInsertRowid;
      for (const it of items) {
        if (it.result !== 'ok' && it.result !== 'new') continue;
        let m = s.members.byNo(it.memberNo);
        if (!m) m = s.members.get(s.members.insert({ memberNo: it.memberNo, name: it.name, phone: it.phone }, at));
        add({
          memberId: m.id,
          kind: it.points > 0 ? 'earn' : 'adjust',
          amount: it.points,
          memo: it.reason,
          sourceRef: it.sourceRef,
          dedupeKey: `src:${m.id}:${it.sourceRef}`,
          uploadId,
          occurredAt: it.earnedAt,
          by,
        });
      }
      const asOf = s.settings.get('points_as_of');
      if (!asOf || basisAt > asOf) s.settings.set('points_as_of', basisAt, by);
      return { uploadId, summary };
    });
  }

  function uploads() {
    return db.all('SELECT * FROM uploads ORDER BY id DESC LIMIT 30').map((u) => ({
      id: u.id,
      fileName: u.file_name,
      totalRows: u.total_rows,
      appliedRows: u.applied_rows,
      appliedPoints: u.applied_points,
      newMembers: u.new_members,
      skippedRows: u.skipped_rows,
      basisAt: u.basis_at,
      createdAt: u.created_at,
      createdBy: u.created_by,
    }));
  }

  return { balance, ledgerOf, add, adjust, previewUpload, commitUpload, uploads };
};

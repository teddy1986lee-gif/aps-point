'use strict';
const { AppError, E } = require('../lib/errors');
const v = require('../lib/validate');
const C = require('../lib/crypto');
const { normalizePhone, maskPhone, nameKey } = require('../lib/format');
const { createLimiter } = require('../lib/ratelimit');

/*
 * 로그인
 * 회원: 이름 + 휴대폰 번호 → 문자 인증번호 → 회원 기록과 대조해 한 명으로 확정될 때만 로그인.
 *   회원 기록에 있는 번호에만 문자를 보내지만, 응답은 항상 같게 해서 가입 여부가 드러나지 않게 한다.
 *   같은 이름·번호 기록이 여러 건이면 자동으로 고르지 않고 운영팀 확인으로 안내한다.
 * 관리자: 아이디 + 비밀번호. 5번 틀리면 15분 잠금.
 */
module.exports = function (s) {
  const { db, config } = s;
  const otp = config.otp;
  const now = () => s.clock.now();
  const ipLimiter = createLimiter();

  const codeHash = (publicId, code) => C.hmacSha256Hex(config.secret, `${publicId}:${code}`);

  function enforceLimits(phone, ip, at) {
    const last = db.get('SELECT created_at FROM otp_codes WHERE phone = ? ORDER BY id DESC LIMIT 1', phone);
    if (last && at - last.created_at < otp.resendSec * 1000) {
      const wait = Math.ceil((last.created_at + otp.resendSec * 1000 - at) / 1000);
      throw E.rate(`인증번호는 ${wait}초 후에 다시 받을 수 있습니다.`, wait);
    }
    const hour = db.get('SELECT COUNT(*) AS c FROM otp_codes WHERE phone = ? AND created_at > ?', phone, at - 3600e3).c;
    if (hour >= otp.maxPerPhoneHour) throw E.rate('인증 요청이 너무 많습니다. 1시간 뒤에 다시 시도해 주세요.', 3600);
    const day = db.get('SELECT COUNT(*) AS c FROM otp_codes WHERE phone = ? AND created_at > ?', phone, at - 86400e3).c;
    if (day >= otp.maxPerPhoneDay) throw E.rate('오늘 인증 요청 횟수를 모두 사용했습니다. 내일 다시 시도해 주세요.', 86400);
    if (ip) {
      const byIp = db.get('SELECT COUNT(*) AS c FROM otp_codes WHERE ip = ? AND created_at > ?', ip, at - 3600e3).c;
      if (byIp >= otp.maxPerIpHour) throw E.rate('같은 네트워크에서 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.', 600);
    }
  }

  async function requestOtp({ name, phone, ip }) {
    const nm = v.str(name, { label: '이름', field: 'name', max: 40 });
    const ph = normalizePhone(phone);
    if (!ph) throw E.bad('휴대폰 번호를 확인해 주세요. 예) 010-1234-5678', { field: 'phone' });
    const at = now();
    const issued = db.tx(() => {
      enforceLimits(ph, ip, at);
      db.run('UPDATE otp_codes SET invalidated_at = ? WHERE phone = ? AND verified_at IS NULL AND invalidated_at IS NULL', at, ph);
      const known = !!db.get('SELECT 1 AS x FROM members WHERE phone = ? AND name_key = ? LIMIT 1', ph, nameKey(nm));
      const publicId = C.randomToken(18);
      const code = C.randomDigits(6);
      db.run(
        'INSERT INTO otp_codes (public_id, phone, name_key, code_hash, sent, expires_at, ip, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        publicId,
        ph,
        nameKey(nm),
        codeHash(publicId, code),
        known ? 1 : 0,
        at + otp.ttlSec * 1000,
        ip ?? null,
        at
      );
      return { publicId, code, known };
    });
    if (issued.known) {
      try {
        await s.sms.send({ to: ph, text: `[APS 포인트] 인증번호는 ${issued.code}입니다. ${Math.round(otp.ttlSec / 60)}분 안에 입력해 주세요.` });
      } catch {
        db.run('UPDATE otp_codes SET invalidated_at = ? WHERE public_id = ?', now(), issued.publicId);
        throw new AppError(502, 'SMS_FAILED', '문자를 보내지 못했습니다. 잠시 후 다시 시도해 주세요.');
      }
    }
    return {
      requestId: issued.publicId,
      phoneMasked: maskPhone(ph),
      issuedAt: at,
      expiresAt: at + otp.ttlSec * 1000,
      resendAt: at + otp.resendSec * 1000,
      devCode: config.exposeOtp && issued.known ? issued.code : undefined,
    };
  }

  // 시도 횟수는 실패해도 남아야 하므로 트랜잭션 없이 먼저 올린다.
  function verifyOtp({ requestId, code }) {
    const at = now();
    const row = db.get('SELECT * FROM otp_codes WHERE public_id = ?', String(requestId || ''));
    if (!row || row.invalidated_at || row.verified_at) throw new AppError(400, 'OTP_INVALID', '인증 요청이 만료됐습니다. 인증번호를 다시 받아 주세요.');
    if (at > row.expires_at) throw new AppError(400, 'OTP_EXPIRED', '인증 시간이 지났습니다. 인증번호를 다시 받아 주세요.');
    if (row.attempts >= otp.maxAttempts) throw new AppError(400, 'OTP_LOCKED', '입력 횟수를 모두 사용했습니다. 인증번호를 다시 받아 주세요.');
    db.run('UPDATE otp_codes SET attempts = attempts + 1 WHERE id = ?', row.id);
    const c = String(code ?? '').trim();
    const ok = row.sent === 1 && /^\d{6}$/.test(c) && C.safeEqual(codeHash(row.public_id, c), row.code_hash);
    if (!ok) {
      const left = otp.maxAttempts - (row.attempts + 1);
      if (left <= 0) throw new AppError(400, 'OTP_LOCKED', '입력 횟수를 모두 사용했습니다. 인증번호를 다시 받아 주세요.');
      throw new AppError(400, 'OTP_MISMATCH', `인증번호가 맞지 않습니다. (남은 입력 ${left}회)`, { remaining: left });
    }
    return db.tx(() => {
      const r = db.run('UPDATE otp_codes SET verified_at = ? WHERE id = ? AND verified_at IS NULL', at, row.id);
      if (r.changes !== 1) throw new AppError(400, 'OTP_INVALID', '이미 사용한 인증번호입니다. 다시 받아 주세요.');
      return finishMemberLogin(row.phone, row.name_key, at);
    });
  }

  function finishMemberLogin(phone, key, at) {
      const matched = s.members.byPhone(phone).filter((m) => m.name_key === key);
      if (!matched.length) return { result: 'no_match' };
      if (matched.length > 1) return { result: 'duplicate' };
      const m = matched[0];
      if (m.status !== 'active') return { result: 'stopped' };
      const token = C.randomToken(32);
      db.run(
        'INSERT INTO member_sessions (token_hash, member_id, phone, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
        C.sha256Hex(token),
        m.id,
        m.phone,
        at,
        at,
        at + config.session.memberHours * 3600e3
      );
      db.run('UPDATE members SET last_login_at = ? WHERE id = ?', at, m.id);
      return { result: 'ok', token, member: m };
  }

  // Only the browser demo opts into login without SMS verification.
  function demoLogin({ name, phone }) {
    if (config.demoDirectLogin !== true) throw E.unauth();
    const nm = v.str(name, { label: '이름', field: 'name', max: 40 });
    const ph = normalizePhone(phone);
    if (!ph) throw E.bad('휴대폰 번호를 확인해 주세요. 예) 010-1234-5678', { field: 'phone' });
    return db.tx(() => finishMemberLogin(ph, nameKey(nm), now()));
  }

  function memberSession(token) {
    if (!token) return null;
    const at = now();
    const sess = db.get('SELECT * FROM member_sessions WHERE token_hash = ?', C.sha256Hex(token));
    if (!sess || sess.revoked_at || sess.expires_at <= at) return null;
    const m = s.members.get(sess.member_id);
    if (!m || m.status !== 'active' || m.phone !== sess.phone) return null;
    if (at - sess.last_seen_at > 60000) db.run('UPDATE member_sessions SET last_seen_at = ? WHERE id = ?', at, sess.id);
    return m;
  }

  function memberLogout(token) {
    if (token) db.run('UPDATE member_sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL', now(), C.sha256Hex(token));
  }

  function revokeMemberSessions(memberId) {
    db.run('UPDATE member_sessions SET revoked_at = ? WHERE member_id = ? AND revoked_at IS NULL', now(), memberId);
  }

  // ---------------- 관리자 ----------------

  function checkPassword(pw) {
    const p = String(pw || '');
    if (p.length < 10 || !/[A-Za-z]/.test(p) || !/\d/.test(p)) throw E.bad('비밀번호는 영문과 숫자를 섞어 10자 이상으로 정해 주세요.', { field: 'password' });
    return p;
  }

  function createAdmin({ username, name, password }) {
    const u = v.str(username, { label: '아이디', field: 'username', min: 3, max: 30, pattern: /^[a-z0-9._-]+$/, patternMessage: '아이디는 영문 소문자, 숫자와 . _ - 만 쓸 수 있습니다.' });
    const n = v.str(name, { label: '이름', field: 'name', max: 30 });
    const p = checkPassword(password);
    if (db.get('SELECT id FROM admins WHERE username = ?', u)) throw E.conflict('USERNAME_TAKEN', '이미 있는 아이디입니다.');
    const id = db.run('INSERT INTO admins (username, name, password_hash, created_at) VALUES (?, ?, ?, ?)', u, n, C.hashPassword(p), now()).lastInsertRowid;
    return db.get('SELECT id, username, name FROM admins WHERE id = ?', id);
  }

  function adminLogin({ username, password, ip }) {
    const at = now();
    if (ip && !ipLimiter.hit(`admin:${ip}`, 30, 15 * 60000, at).ok) throw E.rate('로그인 시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.', 900);
    const a = db.get('SELECT * FROM admins WHERE username = ?', String(username || '').trim().toLowerCase());
    const fail = () => new AppError(401, 'LOGIN_FAILED', '아이디 또는 비밀번호가 맞지 않습니다.');
    if (!a || !a.active) {
      C.verifyPassword(String(password || ''), 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='); // 응답 시간 맞추기
      throw fail();
    }
    if (a.locked_until && a.locked_until > at) {
      throw new AppError(423, 'LOCKED', `로그인이 잠겨 있습니다. ${Math.ceil((a.locked_until - at) / 60000)}분 뒤에 다시 시도해 주세요.`);
    }
    if (!C.verifyPassword(String(password || ''), a.password_hash)) {
      const n = a.failed_logins + 1;
      const lock = n >= 5 ? at + 15 * 60000 : null;
      db.run('UPDATE admins SET failed_logins = ?, locked_until = ? WHERE id = ?', lock ? 0 : n, lock, a.id);
      if (lock) throw new AppError(423, 'LOCKED', '비밀번호를 5번 틀려 15분 동안 로그인이 잠겼습니다.');
      throw fail();
    }
    db.run('UPDATE admins SET failed_logins = 0, locked_until = NULL, last_login_at = ? WHERE id = ?', at, a.id);
    const token = C.randomToken(32);
    db.run(
      'INSERT INTO admin_sessions (token_hash, admin_id, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?)',
      C.sha256Hex(token),
      a.id,
      at,
      at,
      at + config.session.adminHours * 3600e3
    );
    return { token, admin: { username: a.username, name: a.name } };
  }

  function adminSession(token) {
    if (!token) return null;
    const at = now();
    const sess = db.get('SELECT * FROM admin_sessions WHERE token_hash = ?', C.sha256Hex(token));
    if (!sess || sess.revoked_at || sess.expires_at <= at) return null;
    if (at - sess.last_seen_at > config.session.adminIdleMinutes * 60000) return null;
    const a = db.get('SELECT * FROM admins WHERE id = ?', sess.admin_id);
    if (!a || !a.active) return null;
    if (at - sess.last_seen_at > 60000) db.run('UPDATE admin_sessions SET last_seen_at = ? WHERE id = ?', at, sess.id);
    return { admin: a, sessionId: sess.id };
  }

  function adminLogout(token) {
    if (token) db.run('UPDATE admin_sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL', now(), C.sha256Hex(token));
  }

  function changePassword(admin, sessionId, { current, next }) {
    if (!C.verifyPassword(String(current || ''), admin.password_hash)) throw E.bad('지금 비밀번호가 맞지 않습니다.', { field: 'current' });
    const p = checkPassword(next);
    if (p === String(current)) throw E.bad('지금과 다른 비밀번호로 정해 주세요.', { field: 'next' });
    db.run('UPDATE admins SET password_hash = ? WHERE id = ?', C.hashPassword(p), admin.id);
    // 다른 기기의 로그인은 끝낸다.
    db.run('UPDATE admin_sessions SET revoked_at = ? WHERE admin_id = ? AND id <> ? AND revoked_at IS NULL', now(), admin.id, sessionId);
  }

  function cleanup(at = now()) {
    const old = at - 30 * 86400e3;
    db.run('DELETE FROM otp_codes WHERE created_at < ?', old);
    db.run('DELETE FROM member_sessions WHERE expires_at < ?', old);
    db.run('DELETE FROM admin_sessions WHERE expires_at < ?', old);
  }

  return {
    demoLogin,
    requestOtp,
    verifyOtp,
    memberSession,
    memberLogout,
    revokeMemberSessions,
    createAdmin,
    adminLogin,
    adminSession,
    adminLogout,
    changePassword,
    cleanup,
  };
};

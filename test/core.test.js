'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeEnv, client, lastCode, loginMember, setupAdmin, upload, readyMember, exchangeId, reqKey } = require('./helpers');
const { migrate } = require('../server/db/schema');
const { openNodeDb } = require('../server/db/sqlite-node');

const H = 3600000;
const M = 60000;
const post = (c, qty, extra = {}) => c.post('/api/exchanges', { quantity: qty, requestKey: reqKey(), ...extra });

// ───────── 로그인 ─────────

test('이름과 번호만 알고 접근: 인증 전에는 포인트·회원정보 비공개', async () => {
  const env = await makeEnv();
  const admin = await setupAdmin(env);
  await upload(admin, [['APS-10023', '이형주', '010-1234-5678', 120]]);
  const c = client(env.app);

  assert.equal((await c.get('/api/me')).status, 401);
  // 회원 기록에 없는 이름이어도 응답 모양은 같고 문자는 가지 않는다.
  const unknown = await c.post('/api/auth/otp', { name: '홍길동', phone: '010-1234-5678' });
  assert.equal(unknown.status, 200);
  assert.deepEqual(Object.keys(unknown.body).sort(), ['expiresAt', 'issuedAt', 'phoneMasked', 'requestId', 'resendAt']);
  assert.equal(env.sms.outbox.length, 0);
  env.clock.advance(61000);

  const r1 = await c.post('/api/auth/otp', { name: '이형주', phone: '01012345678' });
  assert.equal(r1.body.phoneMasked, '010-****-5678');
  assert.equal(env.sms.outbox.length, 1);
  // 틀린 번호 5번이면 그 인증번호는 더 쓸 수 없다.
  const wrong = () => ('000000' === lastCode(env) ? '111111' : '000000');
  for (let i = 0; i < 4; i++) {
    const bad = await c.post('/api/auth/verify', { requestId: r1.body.requestId, code: wrong() });
    assert.equal(bad.body.error.code, 'OTP_MISMATCH');
  }
  const fifth = await c.post('/api/auth/verify', { requestId: r1.body.requestId, code: wrong() });
  assert.equal(fifth.body.error.code, 'OTP_LOCKED');
  const locked = await c.post('/api/auth/verify', { requestId: r1.body.requestId, code: lastCode(env) });
  assert.equal(locked.body.error.code, 'OTP_LOCKED');
  assert.equal((await c.get('/api/me')).status, 401);

  // 재발송 간격 안에는 다시 받을 수 없다.
  const tooSoon = await c.post('/api/auth/otp', { name: '이형주', phone: '010-1234-5678' });
  assert.equal(tooSoon.status, 429);
  env.clock.advance(61000);
  const ok = await loginMember(env, c, '이형주', '010 1234 5678');
  assert.equal(ok.body.result, 'ok');
  const me = await c.get('/api/me');
  assert.equal(me.body.member.name, '이형주');
  assert.equal(me.body.member.phone, '010-****-5678');
});

test('같은 이름·연락처의 회원 기록 중복: 자동으로 고르지 않고 운영팀 확인 안내', async () => {
  const env = await makeEnv();
  const admin = await setupAdmin(env);
  await upload(admin, [['APS-10026', '최지훈', '010-4444-5555', 80]]);
  // 업로드에서는 같은 이름·번호의 새 회원을 막는다.
  const pv = await admin.post('/api/admin/upload/preview', { rows: [{ __row: 2, member_no: 'APS-10031', name: '최지훈', phone: '01044445555', points: 40, source_ref: 'X' }] });
  assert.equal(pv.body.items[0].result, 'error');
  assert.match(pv.body.items[0].messages[0], /APS-10026/);
  // 예전 자료에 이미 둘이 있는 경우
  const id = env.s.members.insert({ memberNo: 'APS-10031', name: '최지훈', phone: '01044445555' });
  env.s.points.add({ memberId: id, kind: 'earn', amount: 40, memo: '최초 잔액' });
  const c = client(env.app);
  const r = await loginMember(env, c, '최지훈', '010-4444-5555');
  assert.equal(r.body.result, 'duplicate');
  assert.equal(c.jar.aps_sid, undefined);
  assert.equal((await c.get('/api/me')).status, 401);
});

// ───────── 풀팟 계정 즉시 연결 ─────────

test('즉시 연결: 계정 확인(닉네임) 뒤 승인 없이 바로 연결, 없는 ID·형식 오류·풀팟 확인 불가는 연결하지 않음', async () => {
  const env = await makeEnv();
  const admin = await setupAdmin(env);
  const c = await readyMember(env, admin, { fulpotId: null });
  assert.equal((await c.post('/api/link/lookup', { fulpotId: 'a b' })).status, 400);
  const none = await c.post('/api/link/lookup', { fulpotId: 'nobody_here' });
  assert.equal(none.status, 422);
  assert.equal(none.body.error.code, 'FULPOT_NOT_FOUND');
  assert.equal((await c.post('/api/link', { fulpotId: 'nobody_here' })).body.error.code, 'FULPOT_NOT_FOUND');

  // 확인 단계는 닉네임만 보여 주고 연결하지 않는다.
  const look = await c.post('/api/link/lookup', { fulpotId: 'TEDDY123' });
  assert.equal(look.status, 200);
  assert.deepEqual(look.body.account, { fulpotId: 'teddy123', nickname: '테디베어' });
  assert.equal((await c.get('/api/me')).body.link.active, null);

  // 연결: 운영자 승인 없이 그 자리에서
  const r = await c.post('/api/link', { fulpotId: 'TEDDY123' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.link.active.fulpotId, 'teddy123');
  assert.equal(r.body.link.active.nickname, '테디베어');
  assert.equal(r.body.me.link.active.fulpotId, 'teddy123');
  assert.equal(env.db.get("SELECT fulpot_uid FROM links WHERE status = 'active'").fulpot_uid, 'FP100231');
  assert.equal((await c.post('/api/link', { fulpotId: 'teddy123' })).body.error.code, 'LINK_SAME');

  // 풀팟 확인이 안 되면 연결하지 않고 기존 연결도 그대로
  env.mock.behavior.lookup = 'down';
  const down = await c.post('/api/link', { fulpotId: 'seoyeon_p' });
  assert.equal(down.status, 503);
  assert.equal(down.body.error.code, 'FULPOT_UNAVAILABLE');
  assert.equal((await c.get('/api/me')).body.link.active.fulpotId, 'teddy123');
});

test('다른 회원에게 연결된 풀팟 계정: 대소문자·풀팟 내부 번호 기준으로 막고, 동시에 연결해도 한 명만', async () => {
  const env = await makeEnv();
  const admin = await setupAdmin(env);
  await readyMember(env, admin, { fulpotId: 'teddy123' });
  const b = await readyMember(env, admin, { no: 'APS-10024', name: '김민준', phone: '010-2222-3333', fulpotId: null });
  const look = await b.post('/api/link/lookup', { fulpotId: 'Teddy123' });
  assert.equal(look.status, 409);
  assert.equal(look.body.error.code, 'ALREADY_LINKED');
  assert.match(look.body.error.message, /운영팀/);
  // ID 표기가 달라도 풀팟 내부 번호가 같으면 같은 계정
  env.mock.accounts.set('teddy_renamed', { uid: 'FP100231', fulpotId: 'teddy_renamed', nickname: '테디베어' });
  assert.equal((await b.post('/api/link', { fulpotId: 'teddy_renamed' })).body.error.code, 'ALREADY_LINKED');
  assert.equal(env.db.get("SELECT COUNT(*) AS c FROM links WHERE status = 'active'").c, 1);

  const c = await readyMember(env, admin, { no: 'APS-10025', name: '박서연', phone: '010-3333-4444', fulpotId: null });
  const [x, y] = await Promise.all([b.post('/api/link', { fulpotId: 'shared_id' }), c.post('/api/link', { fulpotId: 'SHARED_ID' })]);
  assert.deepEqual([x.status, y.status].sort(), [200, 409]);
  assert.equal(env.db.get("SELECT COUNT(*) AS c FROM links WHERE status = 'active' AND fulpot_key = 'shared_id'").c, 1);
});

test('계정 변경과 관리자 해제: 이전 연결은 해제 기록, 해제 사유는 회원 화면에, 해제 뒤에는 교환 막힘', async () => {
  const env = await makeEnv();
  const admin = await setupAdmin(env);
  const c = await readyMember(env, admin);
  const r = await c.post('/api/link', { fulpotId: 'teddy_new' });
  assert.equal(r.body.link.active.fulpotId, 'teddy_new');
  assert.equal(r.body.link.released, null); // 회원이 직접 바꾼 기록은 따로 안내하지 않는다
  const hist = env.db.all('SELECT fulpot_id, status, release_kind FROM links ORDER BY id').map((x) => [x.fulpot_id, x.status, x.release_kind]);
  assert.deepEqual(hist, [
    ['teddy123', 'released', 'changed'],
    ['teddy_new', 'active', null],
  ]);
  // 놓아 준 계정은 다른 회원이 연결할 수 있다.
  const b = await readyMember(env, admin, { no: 'APS-10024', name: '김민준', phone: '010-2222-3333', fulpotId: 'teddy123' });
  assert.equal((await b.get('/api/me')).body.link.active.fulpotId, 'teddy123');

  const list = (await admin.get('/api/admin/links?tab=active')).body;
  assert.equal(list.counts.active, 2);
  const target = list.rows.find((x) => x.fulpotId === 'teddy_new');
  assert.equal(target.nickname, '새테디');
  assert.equal((await admin.post(`/api/admin/links/${target.id}/release`, { reason: '' })).status, 400);
  const rel = await admin.post(`/api/admin/links/${target.id}/release`, { reason: '본인 계정이 아니라는 문의로 해제' });
  assert.equal(rel.body.link.status, 'released');
  assert.match(rel.body.link.releasedBy, /^운영자\(admin\d+\)$/);
  assert.equal((await admin.post(`/api/admin/links/${target.id}/release`, { reason: '두 번째' })).body.error.code, 'INVALID_STATE');

  const me = (await c.get('/api/me')).body;
  assert.equal(me.link.active, null);
  assert.equal(me.link.released.reason, '본인 계정이 아니라는 문의로 해제');
  assert.equal((await post(c, 1)).body.error.code, 'LINK_REQUIRED');
  const released = (await admin.get('/api/admin/links?tab=released')).body;
  assert.deepEqual(released.rows.map((x) => x.releaseKind).sort(), ['admin', 'changed']);
  // 다시 연결하면 안내는 사라진다.
  await c.post('/api/link', { fulpotId: 'seoyeon' });
  assert.equal((await c.get('/api/me')).body.link.released, null);
});

// ───────── 티켓 즉시 지급 ─────────

test('즉시 지급(기획서 7장 예시): 120P에서 1장 신청 → 그 자리에서 지급 완료, 포인트 차감, 지급 번호 표시', async () => {
  const env = await makeEnv();
  const admin = await setupAdmin(env);
  const c = await readyMember(env, admin);
  assert.equal((await c.get('/api/me')).body.exchangeable, 3);
  const r = await post(c, 1, { expectedUnitPoints: 40 });
  assert.equal(r.status, 201);
  assert.equal(r.body.exchange.status, 'completed');
  assert.equal(r.body.exchange.statusLabel, '지급 완료');
  assert.equal(r.body.exchange.issueId, 'FPX-' + r.body.exchange.no.slice(2));
  assert.deepEqual(r.body.me.points, { total: 80, pending: 0, available: 80 });
  assert.equal(r.body.me.history[0].kind, 'use');
  assert.equal(r.body.me.history[0].amount, -40);
  assert.equal(r.body.me.history[0].exchangeNo, r.body.exchange.no);
  assert.equal(r.body.me.recent[0].no, r.body.exchange.no);
  // 풀팟에는 신청번호를 요청 키로, 연결된 계정의 풀팟 내부 번호로 요청했다.
  assert.deepEqual(
    env.mock.calls.map((x) => [x.requestKey, x.uid, x.ticketCode, x.quantity]),
    [[r.body.exchange.no, 'FP100231', 'TKT-APS-SAT', 1]]
  );
  const list = (await admin.get('/api/admin/exchanges?tab=completed')).body;
  assert.equal(list.rows[0].handledBy, '자동');
  assert.equal(list.counts.check, 0);
  assert.equal((await admin.get('/api/admin/me')).body.badges.exchanges, 0);
});

test('풀팟 거절: 지급 실패와 사유 표시, 포인트는 그대로, 다시 신청 가능', async () => {
  const env = await makeEnv();
  const admin = await setupAdmin(env);
  const c = await readyMember(env, admin, { fulpotId: 'seyoung5' }); // 모의 풀팟의 이용 제한 계정
  const r = await post(c, 1);
  assert.equal(r.status, 201);
  assert.equal(r.body.exchange.status, 'failed');
  assert.match(r.body.exchange.reason, /이용 제한/);
  assert.deepEqual(r.body.me.points, { total: 120, pending: 0, available: 120 });
  assert.equal(env.db.get("SELECT COUNT(*) AS c FROM ledger WHERE kind = 'use'").c, 0);
  await c.post('/api/link', { fulpotId: 'teddy123' });
  assert.equal((await post(c, 1)).body.exchange.status, 'completed');
  assert.deepEqual((await c.get('/api/exchanges')).body.rows.map((x) => x.status), ['completed', 'failed']);
  assert.equal((await admin.get('/api/admin/exchanges?tab=failed')).body.rows[0].note, '풀팟이 지급을 거절함');
});

test('응답 유실: 확인 필요로 두고 포인트는 사용 대기 → 1분 확인 작업이 지급 기록을 찾아 자동 완료', async () => {
  const env = await makeEnv();
  const admin = await setupAdmin(env);
  const c = await readyMember(env, admin);
  env.mock.behavior.issue = 'lost'; // 풀팟은 지급했지만 응답이 오지 않음
  const r = await post(c, 2);
  assert.equal(r.status, 201);
  assert.equal(r.body.exchange.status, 'check');
  assert.equal(r.body.exchange.statusLabel, '지급 확인 중');
  assert.deepEqual(r.body.me.points, { total: 120, pending: 80, available: 40 });
  assert.equal(r.body.me.active.length, 1);
  assert.equal((await admin.get('/api/admin/me')).body.badges.exchanges, 1);
  const row = (await admin.get('/api/admin/exchanges?tab=check')).body.rows[0];
  assert.match(row.note, /풀팟 응답을 받지 못함/);
  // 사용 대기는 돌려주지 않으므로 남은 포인트까지만 신청할 수 있다.
  env.mock.behavior.issue = 'ok';
  assert.equal((await post(c, 2)).body.error.code, 'INSUFFICIENT_POINTS');

  const out = await env.app.checkIssues();
  assert.equal(out.completed, 1);
  const ex = (await c.get(`/api/exchanges/${r.body.exchange.no}`)).body.exchange;
  assert.equal(ex.status, 'completed');
  assert.equal(ex.issueId, 'FPX-' + r.body.exchange.no.slice(2));
  assert.deepEqual((await c.get('/api/me')).body.points, { total: 40, pending: 0, available: 40 });
  assert.equal(env.mock.issued.size, 1);
  assert.equal((await admin.get('/api/admin/me')).body.badges.exchanges, 0);
});

test('요청 유실: 지급 기록이 없으면 확인 필요로 남고, 관리자가 같은 신청번호로 다시 요청 → 한 번만 지급', async () => {
  const env = await makeEnv();
  const admin = await setupAdmin(env);
  const c = await readyMember(env, admin);
  env.mock.behavior.issue = 'down';
  const ex = (await post(c, 1)).body.exchange;
  assert.equal(ex.status, 'check');
  const id = exchangeId(env, ex.no);
  await env.app.checkIssues();
  const row = (await admin.get('/api/admin/exchanges?tab=check')).body.rows[0];
  assert.equal(row.note, '풀팟에 지급 기록 없음');
  assert.ok(row.checkedAt);

  const q1 = await admin.post(`/api/admin/exchanges/${id}/query`, { expected: 'check' });
  assert.equal(q1.body.result, 'not_found');
  assert.equal(q1.body.exchange.status, 'check');
  const r1 = await admin.post(`/api/admin/exchanges/${id}/retry`, { expected: 'check' });
  assert.equal(r1.body.result, 'check'); // 이번에도 응답 없음
  assert.equal(r1.body.exchange.attempts, 2);
  env.mock.behavior.issue = 'ok';
  const r2 = await admin.post(`/api/admin/exchanges/${id}/retry`, { expected: 'check' });
  assert.equal(r2.body.result, 'completed');
  assert.equal(r2.body.exchange.status, 'completed');
  assert.match(r2.body.exchange.handledBy, /^운영자\(admin\d+\)$/);
  assert.equal(r2.body.badges.exchanges, 0);
  // 같은 요청 키로 세 번 요청했지만 지급과 차감은 한 번
  assert.equal(env.mock.calls.filter((x) => x.requestKey === ex.no).length, 3);
  assert.equal(env.mock.issued.size, 1);
  assert.equal(env.db.get("SELECT COUNT(*) AS c FROM ledger WHERE kind = 'use'").c, 1);
  assert.equal((await admin.post(`/api/admin/exchanges/${id}/retry`, {})).body.error.code, 'INVALID_STATE');
});

test('응답 지연: 시간 안에 답이 없으면 확인 필요, 1분 넘게 지급 중으로 멈춘 요청도 확인 대상으로 옮김', async () => {
  const env = await makeEnv({ timeoutMs: 60 });
  const admin = await setupAdmin(env);
  const c = await readyMember(env, admin);
  env.mock.behavior.issue = 'hang';
  const r = await post(c, 1);
  assert.equal(r.body.exchange.status, 'check');
  assert.match(env.db.get('SELECT note FROM exchanges WHERE exchange_no = ?', r.body.exchange.no).note, /초 안에 오지 않았습니다/);

  // 서버가 요청 도중 멈춰 '지급 중'으로 남은 신청
  const m = env.s.members.byNo('APS-10023');
  const t = env.clock.now();
  env.db.run(
    `INSERT INTO exchanges (exchange_no, member_id, request_key, ticket_name, unit_points, quantity, total_points, fulpot_id, fulpot_uid, status, created_at, updated_at, requested_at)
     VALUES ('EX261007-0099', ?, 'stuck-request-key', '티켓', 40, 1, 40, 'teddy123', 'FP100231', 'issuing', ?, ?, ?)`,
    m.id,
    t,
    t,
    t
  );
  const stuckId = exchangeId(env, 'EX261007-0099');
  // 풀팟에 요청이 나가 있는 동안에는 관리자도 처리할 수 없다.
  assert.equal((await admin.post(`/api/admin/exchanges/${stuckId}/fail`, { reason: '처리' })).body.error.code, 'IN_FLIGHT');
  env.mock.behavior.issue = 'ok';
  assert.equal((await env.app.checkIssues()).moved, 0);
  env.clock.advance(61 * 1000);
  assert.equal((await env.app.checkIssues()).moved, 1);
  assert.equal(env.db.get('SELECT status FROM exchanges WHERE id = ?', stuckId).status, 'check');
  assert.deepEqual(env.s.points.balance(m.id), { total: 120, pending: 80, available: 40 });
});

test('관리자 지급 실패 처리: 직전에 풀팟 기록을 조회해 지급돼 있으면 완료, 없으면 실패·포인트 반환, 조회가 안 되면 막음', async () => {
  const env = await makeEnv();
  const admin = await setupAdmin(env);
  const c = await readyMember(env, admin, { points: 200 });
  // A: 실제로는 지급됨 → 실패 처리를 눌러도 지급 완료로 바뀐다.
  env.mock.behavior.issue = 'lost';
  const a = (await post(c, 1)).body.exchange;
  const fa = await admin.post(`/api/admin/exchanges/${exchangeId(env, a.no)}/fail`, { reason: '지급 안 된 것으로 보임', expected: 'check' });
  assert.equal(fa.body.result, 'issued');
  assert.equal(fa.body.exchange.status, 'completed');

  // B: 지급 안 됨 → 실패, 사용 대기 해제, 사유는 회원 화면에
  env.mock.behavior.issue = 'down';
  const b = (await post(c, 1)).body.exchange;
  const idB = exchangeId(env, b.no);
  assert.equal((await admin.post(`/api/admin/exchanges/${idB}/fail`, { reason: '' })).status, 400);
  env.mock.behavior.query = 'down';
  const blocked = await admin.post(`/api/admin/exchanges/${idB}/fail`, { reason: '풀팟 점검으로 지급 못 함' });
  assert.equal(blocked.body.error.code, 'FULPOT_UNREACHABLE');
  assert.equal(env.db.get('SELECT status FROM exchanges WHERE id = ?', idB).status, 'check');
  env.mock.behavior.query = 'ok';
  const fb = await admin.post(`/api/admin/exchanges/${idB}/fail`, { reason: '풀팟 점검으로 지급 못 함', expected: 'check' });
  assert.equal(fb.body.result, 'failed');
  const mine = (await c.get(`/api/exchanges/${b.no}`)).body.exchange;
  assert.equal(mine.status, 'failed');
  assert.equal(mine.reason, '풀팟 점검으로 지급 못 함');
  assert.deepEqual((await c.get('/api/me')).body.points, { total: 160, pending: 0, available: 160 });

  // C: 풀팟 관리 도구로 미지급을 직접 확인했다면 기록 조회 없이 실패 처리
  const cx = (await post(c, 1)).body.exchange;
  env.mock.behavior.query = 'down';
  const fc = await admin.post(`/api/admin/exchanges/${exchangeId(env, cx.no)}/fail`, { reason: '풀팟 관리 도구에서 미지급 확인', skipCheck: true });
  assert.equal(fc.body.result, 'failed');
  assert.match(fc.body.exchange.note, /확인 없이/);
});

test('실패 처리 뒤 늦은 지급: 하루 동안 지급 기록을 다시 보고, 지급이 확인되면 완료로 바로잡아 차감', async () => {
  const env = await makeEnv();
  const admin = await setupAdmin(env);
  const c = await readyMember(env, admin);
  env.mock.behavior.issue = 'down';
  const ex = (await post(c, 1)).body.exchange;
  await admin.post(`/api/admin/exchanges/${exchangeId(env, ex.no)}/fail`, { reason: '풀팟 기록 없음' });
  assert.deepEqual((await c.get('/api/me')).body.points, { total: 120, pending: 0, available: 120 });

  // 풀팟이 늦게 처리해 지급 기록이 생겼다.
  env.mock.issued.set(ex.no, { issueId: 'FPX-LATE-1', uid: 'FP100231', quantity: 1, issuedAt: env.clock.now() });
  env.clock.advance(5 * M);
  const out = await env.app.checkIssues();
  assert.equal(out.corrected, 1);
  const row = (await admin.get('/api/admin/exchanges?tab=completed')).body.rows[0];
  assert.equal(row.payoutRef, 'FPX-LATE-1');
  assert.match(row.note, /바로잡음/);
  assert.deepEqual((await c.get('/api/me')).body.points, { total: 80, pending: 0, available: 80 });

  // 하루가 지난 실패 건은 더 조회하지 않는다.
  const ex2 = (await post(c, 1)).body.exchange;
  await admin.post(`/api/admin/exchanges/${exchangeId(env, ex2.no)}/fail`, { reason: '풀팟 기록 없음' });
  env.clock.advance(25 * H);
  env.mock.issued.set(ex2.no, { issueId: 'FPX-LATE-2', issuedAt: env.clock.now() });
  assert.equal((await env.app.checkIssues()).checked, 0);
  assert.equal(env.db.get('SELECT status FROM exchanges WHERE exchange_no = ?', ex2.no).status, 'failed');
});

test('지급 번호로 완료: 확인 필요 건만, 같은 지급 번호는 두 신청에 못 씀, 다른 관리자가 먼저 처리하면 막힘', async () => {
  const env = await makeEnv();
  const admin = await setupAdmin(env);
  const other = await setupAdmin(env);
  const c = await readyMember(env, admin, { points: 200 });
  const done = (await post(c, 1)).body.exchange;
  env.mock.behavior.issue = 'down';
  const ex = (await post(c, 1)).body.exchange;
  const id = exchangeId(env, ex.no);
  assert.equal((await admin.post(`/api/admin/exchanges/${exchangeId(env, done.no)}/complete`, { payoutRef: 'X-1' })).body.error.code, 'INVALID_STATE');
  assert.equal((await admin.post(`/api/admin/exchanges/${id}/complete`, { expected: 'check' })).status, 400);
  assert.equal((await admin.post(`/api/admin/exchanges/${id}/complete`, { payoutRef: done.issueId, expected: 'check' })).body.error.code, 'PAYOUT_REF_DUP');
  const ok = await admin.post(`/api/admin/exchanges/${id}/complete`, { payoutRef: 'FPX-MANUAL-77', expected: 'check' });
  assert.equal(ok.body.exchange.status, 'completed');
  assert.equal(ok.body.exchange.payoutRef, 'FPX-MANUAL-77');
  const stale = await other.post(`/api/admin/exchanges/${id}/fail`, { reason: '옛 화면에서 처리', expected: 'check' });
  assert.equal(stale.body.error.code, 'STATE_CHANGED');
  assert.match(stale.body.error.message, /지급 완료/);
  assert.equal(env.db.get("SELECT COUNT(*) AS c FROM ledger WHERE kind = 'use'").c, 2);
  assert.deepEqual((await c.get('/api/me')).body.points, { total: 120, pending: 0, available: 120 });
});

test('두 기기에서 잔액을 넘는 동시 신청: 가진 포인트 안에서만 지급', async () => {
  const env = await makeEnv();
  const admin = await setupAdmin(env);
  const phone1 = await readyMember(env, admin, { points: 120 });
  const phone2 = client(env.app, { ip: '203.0.113.99' });
  await loginMember(env, phone2, '이형주', '010-1234-5678');
  const [a, b] = await Promise.all([post(phone1, 2, { expectedUnitPoints: 40 }), post(phone2, 2, { expectedUnitPoints: 40 })]);
  assert.deepEqual([a.status, b.status].sort(), [201, 409]);
  assert.equal((a.status === 409 ? a : b).body.error.code, 'INSUFFICIENT_POINTS');
  assert.deepEqual((await phone1.get('/api/me')).body.points, { total: 40, pending: 0, available: 40 });
  assert.equal(env.mock.calls.length, 1);
});

test('교환 버튼 연속 클릭·같은 요청 재전송: 신청도 풀팟 요청도 한 번만', async () => {
  const env = await makeEnv();
  const admin = await setupAdmin(env);
  const c = await readyMember(env, admin);
  const key = reqKey();
  const [a, b] = await Promise.all([c.post('/api/exchanges', { quantity: 1, requestKey: key }), c.post('/api/exchanges', { quantity: 1, requestKey: key })]);
  assert.deepEqual([a.status, b.status].sort(), [200, 201]);
  assert.equal(a.body.exchange.no, b.body.exchange.no);
  const again = await c.post('/api/exchanges', { quantity: 1, requestKey: key });
  assert.equal(again.status, 200);
  assert.equal(again.body.exchange.status, 'completed');
  assert.equal(env.db.get('SELECT COUNT(*) AS c FROM exchanges').c, 1);
  assert.equal(env.mock.calls.length, 1);
  assert.deepEqual((await c.get('/api/me')).body.points, { total: 80, pending: 0, available: 80 });
  assert.equal((await c.post('/api/exchanges', { quantity: 2, requestKey: key })).body.error.code, 'REQUEST_MISMATCH');
});

test('티켓 포인트 변경: 지급된 교환은 당시 값 유지, 옛 화면에서 신청하면 다시 확인', async () => {
  const env = await makeEnv();
  const admin = await setupAdmin(env);
  const c = await readyMember(env, admin, { points: 200 });
  const ex = (await post(c, 2, { expectedUnitPoints: 40 })).body.exchange;
  assert.equal((await admin.put('/api/admin/settings', { points_per_ticket: 50 })).status, 200);
  assert.equal((await post(c, 1, { expectedUnitPoints: 40 })).body.error.code, 'TERMS_CHANGED');
  const fresh = await post(c, 1, { expectedUnitPoints: 50 });
  assert.equal(fresh.body.exchange.totalPoints, 50);
  const old = (await c.get('/api/exchanges')).body.rows.find((x) => x.no === ex.no);
  assert.equal(old.unitPoints, 40);
  assert.equal(old.totalPoints, 80);
  const me = (await c.get('/api/me')).body;
  assert.deepEqual(me.points, { total: 70, pending: 0, available: 70 });
  assert.equal(me.exchangeable, 1);
});

test('교환 조건: 계정 연결 전·포인트 부족·최대 장수·신청 중지', async () => {
  const env = await makeEnv();
  const admin = await setupAdmin(env);
  const c = await readyMember(env, admin, { points: 39, fulpotId: null });
  const me = (await c.get('/api/me')).body;
  assert.equal(me.exchangeable, 0);
  assert.equal(me.shortfall, 1);
  assert.equal((await post(c, 1)).body.error.code, 'LINK_REQUIRED');
  await c.post('/api/link', { fulpotId: 'seoyeon' });
  const short = await post(c, 1);
  assert.equal(short.body.error.code, 'INSUFFICIENT_POINTS');
  assert.match(short.body.error.message, /1P 부족/);

  const m = env.s.members.byNo('APS-10023');
  await admin.post(`/api/admin/members/${m.id}/adjust`, { amount: 1000, reason: '테스트 적립', requestKey: reqKey() });
  await admin.put('/api/admin/settings', { max_per_exchange: 3 });
  assert.equal((await c.get('/api/me')).body.exchangeable, 3);
  assert.equal((await post(c, 4)).status, 400);
  await admin.put('/api/admin/settings', { exchange_open: false });
  assert.equal((await post(c, 1)).body.error.code, 'EXCHANGE_CLOSED');
  assert.equal(env.mock.calls.length, 0);
});

test('다른 회원의 신청번호 조회: 서버에서 거부', async () => {
  const env = await makeEnv();
  const admin = await setupAdmin(env);
  const a = await readyMember(env, admin);
  const b = await readyMember(env, admin, { no: 'APS-10024', name: '김민준', phone: '010-2222-3333', fulpotId: 'minjun_k' });
  const ex = (await post(a, 1)).body.exchange;
  assert.equal((await b.get(`/api/exchanges/${ex.no}`)).status, 404);
  assert.equal((await b.get('/api/exchanges')).body.rows.length, 0);
  assert.equal((await a.get(`/api/exchanges/${ex.no}`)).body.exchange.status, 'completed');
  // 회원 로그인으로는 지급 처리 API를 부를 수 없다.
  assert.equal((await a.post(`/api/admin/exchanges/${exchangeId(env, ex.no)}/retry`, {})).status, 401);
});

// ───────── 관리자 직접 등록 ─────────

test('관리자 직접 등록: 새 회원(WEB-00001)과 포인트, 같은 이름·휴대폰이면 새로 만들지 않고 그 회원에게 지급, 요청 키는 한 번만', async () => {
  const env = await makeEnv();
  const admin = await setupAdmin(env);
  await upload(admin, [['APS-10023', '이형주', '010-1234-5678', 120]]);
  const k1 = reqKey();
  const r1 = await admin.post('/api/admin/registrations', { name: '송하은', phone: '01024681357', points: '80', reason: 'APS 서울 위성전 현장 참가', requestKey: k1 });
  assert.equal(r1.status, 200);
  assert.equal(r1.body.result, 'created');
  assert.equal(r1.body.member.memberNo, 'WEB-00001');
  assert.equal(r1.body.member.phone, '010-2468-1357');
  assert.deepEqual(r1.body.member.points, { total: 80, pending: 0, available: 80 });
  const again = await admin.post('/api/admin/registrations', { name: '송하은', phone: '01024681357', points: 80, requestKey: k1 });
  assert.equal(again.body.replayed, true);
  assert.equal(env.s.points.balance(r1.body.member.id).total, 80);

  const r2 = await admin.post('/api/admin/registrations', { name: '문태양', phone: '010-1357-2468', requestKey: reqKey() });
  assert.equal(r2.body.member.memberNo, 'WEB-00002');
  assert.equal(r2.body.member.points.total, 0);
  // APS 회원번호를 알면 그 번호로. 이미 있는 번호·WEB- 번호는 안 됨
  assert.equal((await admin.post('/api/admin/registrations', { name: '고은별', phone: '010-9999-0001', memberNo: 'aps-10023', requestKey: reqKey() })).body.error.code, 'MEMBER_NO_DUP');
  assert.equal((await admin.post('/api/admin/registrations', { name: '고은별', phone: '010-9999-0001', memberNo: 'WEB-00009', requestKey: reqKey() })).status, 400);
  const r3 = await admin.post('/api/admin/registrations', { name: '고은별', phone: '010-9999-0001', memberNo: 'aps-10050', points: 40, requestKey: reqKey() });
  assert.equal(r3.body.member.memberNo, 'APS-10050');

  // 같은 이름(띄어쓰기 무시)·휴대폰 → 'exists' → 그 회원에게 지급
  const k4 = reqKey();
  const r4 = await admin.post('/api/admin/registrations', { name: '이 형주', phone: '010-1234-5678', points: 40, reason: '현장 이벤트', requestKey: k4 });
  assert.equal(r4.body.result, 'exists');
  assert.equal(r4.body.member.memberNo, 'APS-10023');
  assert.equal(env.db.get('SELECT COUNT(*) AS c FROM members').c, 4);
  const g = await admin.post('/api/admin/registrations', { memberId: r4.body.member.id, points: 40, reason: '현장 이벤트', requestKey: k4 });
  assert.equal(g.body.result, 'granted');
  assert.equal(g.body.member.points.total, 160);
  assert.equal((await admin.post('/api/admin/registrations', { memberId: r4.body.member.id, points: 40, requestKey: k4 })).body.replayed, true);
  assert.equal(env.s.points.balance(r4.body.member.id).total, 160);

  assert.equal((await admin.post('/api/admin/registrations', { name: '', phone: '010-1111-2222', requestKey: reqKey() })).status, 400);
  assert.equal((await admin.post('/api/admin/registrations', { name: '아무개', phone: '02-123-4567', requestKey: reqKey() })).status, 400);
  assert.equal((await admin.post('/api/admin/registrations', { name: '아무개', phone: '010-1111-2222', points: -5, requestKey: reqKey() })).status, 400);

  const list = (await admin.get('/api/admin/registrations')).body.rows;
  assert.deepEqual(
    list.map((x) => [x.kind, x.member.memberNo, x.points]),
    [
      ['granted', 'APS-10023', 40],
      ['created', 'APS-10050', 40],
      ['created', 'WEB-00002', 0],
      ['created', 'WEB-00001', 80],
    ]
  );
  assert.match(list[0].createdBy, /^운영자\(admin\d+\)$/);
  // 직접 등록한 회원은 바로 로그인해 포인트를 볼 수 있다.
  const c = client(env.app);
  assert.equal((await loginMember(env, c, '송하은', '010-2468-1357')).body.result, 'ok');
  const me = (await c.get('/api/me')).body;
  assert.equal(me.points.available, 80);
  assert.equal(me.history[0].memo, 'APS 서울 위성전 현장 참가');
});

test('직접 등록 회원이 APS 명단 파일에 공식 번호로 올라오면: 오류로 알리고, 회원번호를 바꾸면 같은 회원에게 반영', async () => {
  const env = await makeEnv();
  const admin = await setupAdmin(env);
  const r = await admin.post('/api/admin/registrations', { name: '송하은', phone: '010-2468-1357', points: 80, requestKey: reqKey() });
  const id = r.body.member.id;
  const rows = [{ __row: 2, member_no: 'APS-10041', name: '송하은', phone: '010-2468-1357', points: 40, source_ref: 'S2-W3' }];
  const pv = (await admin.post('/api/admin/upload/preview', { rows })).body;
  assert.equal(pv.items[0].result, 'error');
  assert.match(pv.items[0].messages[0], /직접 등록한 회원\(WEB-00001\)/);
  const web = (await admin.post('/api/admin/upload/preview', { rows: [{ __row: 2, member_no: 'WEB-00077', name: '새사람', phone: '010-7777-0000', points: 10, source_ref: 'X' }] })).body;
  assert.match(web.items[0].messages[0], /WEB-/);

  assert.equal((await admin.post(`/api/admin/members/${id}`, { memberNo: 'WEB-00005' })).status, 400);
  const up = await admin.post(`/api/admin/members/${id}`, { memberNo: 'aps-10041' });
  assert.equal(up.body.member.memberNo, 'APS-10041');
  const cm = (await admin.post('/api/admin/upload/commit', { rows })).body;
  assert.equal(cm.summary.apply, 1);
  assert.equal(cm.summary.newMembers, 0);
  assert.equal(env.s.points.balance(id).total, 120);
  await upload(admin, [['APS-10023', '이형주', '010-1234-5678', 10]]);
  assert.equal((await admin.post(`/api/admin/members/${id}`, { memberNo: 'APS-10023' })).body.error.code, 'MEMBER_NO_DUP');
});

// ───────── 파일 등록·포인트 ─────────

test('이미 처리한 적립 자료 재업로드: 중복 적립 없이 결과 안내', async () => {
  const env = await makeEnv();
  const admin = await setupAdmin(env);
  const rows = [
    ['APS-10023', '이형주', '010-1234-5678', 80, '최초잔액'],
    ['APS-10024', '김민준', '010-2222-3333', 150, '최초잔액'],
  ];
  const first = await upload(admin, rows);
  assert.equal(first.summary.apply, 2);
  assert.equal(first.summary.newMembers, 2);
  const earn = [{ __row: 2, member_no: 'aps-10023', name: '이형주', points: '40', source_ref: 'S2-W1', earned_at: '2026.10.04', reason: '시즌2 1주차' }];
  assert.equal((await admin.post('/api/admin/upload/commit', { rows: earn })).status, 200);

  const pv = await admin.post('/api/admin/upload/preview', { rows: earn });
  assert.equal(pv.body.summary.dup, 1);
  assert.equal(pv.body.items[0].messages[0], '이미 반영된 건입니다.');
  const again = await admin.post('/api/admin/upload/commit', { rows: earn });
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, 'NOTHING_TO_APPLY');
  const m = env.s.members.byNo('APS-10023');
  assert.equal(env.s.points.balance(m.id).total, 120);
  // 같은 건 번호라도 다른 회원이면 따로 적립된다.
  const other = await admin.post('/api/admin/upload/commit', { rows: [{ __row: 2, member_no: 'APS-10024', name: '김민준', points: 40, source_ref: 'S2-W1' }] });
  assert.equal(other.body.summary.apply, 1);
});

test('업로드 검사: 이름 불일치·새 회원 정보 누락·파일 안 중복·차감 초과·날짜 형식', async () => {
  const env = await makeEnv();
  const admin = await setupAdmin(env);
  await upload(admin, [['APS-10023', '이형주', '010-1234-5678', 50]]);
  const rows = [
    { __row: 2, member_no: 'APS-10023', name: '이형준', points: 10, source_ref: 'A' },
    { __row: 3, member_no: 'APS-20000', name: '새회원', points: 10, source_ref: 'A' },
    { __row: 4, member_no: 'APS-20001', name: '박새봄', phone: '1098765432', points: '1,000', source_ref: 'A', earned_at: '20261005' },
    { __row: 5, member_no: 'APS-20001', name: '박새봄', points: 5, source_ref: 'A' },
    { __row: 6, member_no: 'APS-10023', name: '이형주', points: -60, source_ref: 'B' },
    { __row: 7, member_no: 'APS-10023', points: 10, source_ref: 'C', earned_at: '어제' },
    { __row: 8, member_no: 'APS-20001', points: -500, source_ref: 'D' },
    { __row: 9, member_no: 'APS 1', points: 5, source_ref: 'E' },
  ];
  const pv = (await admin.post('/api/admin/upload/preview', { rows })).body;
  const by = Object.fromEntries(pv.items.map((x) => [x.row, x]));
  assert.match(by[2].messages[0], /이름이 회원 기록\(이형주\)과 다릅니다/);
  assert.match(by[3].messages[0], /새 회원은 이름과 휴대폰 번호/);
  assert.equal(by[4].result, 'new');
  assert.equal(by[4].points, 1000);
  assert.equal(by[5].result, 'error');
  assert.match(by[5].messages[0], /4행과 회원번호·건 번호가 같습니다/);
  assert.match(by[6].messages[0], /사용 가능 포인트\(50P\)/);
  assert.match(by[7].messages[0], /적립일을 읽을 수 없습니다/);
  assert.equal(by[8].result, 'ok');
  assert.match(by[9].messages[0], /회원번호 형식/);
  assert.deepEqual(pv.summary, { total: 8, apply: 2, newMembers: 1, dup: 0, error: 6, points: 500 });

  env.clock.advance(H);
  const cm = (await admin.post('/api/admin/upload/commit', { rows, fileName: '혼합.csv', basisAt: '2026-10-07 12:30' })).body;
  assert.equal(cm.summary.apply, 2);
  const nm = env.s.members.byNo('APS-20001');
  assert.equal(nm.phone, '01098765432');
  assert.equal(env.s.points.balance(nm.id).total, 500);
  assert.equal(env.s.settings.get('points_as_of'), Date.UTC(2026, 9, 7, 3, 30));
  const c = client(env.app);
  assert.equal((await loginMember(env, c, '박새봄', '010-9876-5432')).body.result, 'ok');
});

test('관리자 조정: 사유 필수, 사용 가능 포인트를 넘는 차감 금지, 같은 요청 키는 한 번만', async () => {
  const env = await makeEnv();
  const admin = await setupAdmin(env);
  const c = await readyMember(env, admin);
  env.mock.behavior.issue = 'lost'; // 확인 필요로 80P가 사용 대기
  await post(c, 2);
  const m = env.s.members.byNo('APS-10023');
  assert.equal((await admin.post(`/api/admin/members/${m.id}/adjust`, { amount: -10, reason: '', requestKey: reqKey() })).status, 400);
  const over = await admin.post(`/api/admin/members/${m.id}/adjust`, { amount: -41, reason: '다른 채널 사용분', requestKey: reqKey() });
  assert.equal(over.body.error.code, 'INSUFFICIENT_POINTS');
  const key = reqKey();
  assert.equal((await admin.post(`/api/admin/members/${m.id}/adjust`, { amount: -40, reason: '다른 채널 사용분', requestKey: key })).status, 200);
  const again = await admin.post(`/api/admin/members/${m.id}/adjust`, { amount: -40, reason: '다른 채널 사용분', requestKey: key });
  assert.equal(again.body.replayed, true);
  assert.deepEqual(env.s.points.balance(m.id), { total: 80, pending: 80, available: 0 });
  assert.match(again.body.ledger[0].createdBy, /^운영자\(admin\d+\)$/);
  assert.equal(again.body.exchanges[0].status, 'check');
});

// ───────── 보안·회원 관리 ─────────

test('보안: 전용 헤더 없는 상태 변경 차단, 로그인 없는 접근 차단, 관리자 비밀번호 5회 오류 잠금', async () => {
  const env = await makeEnv();
  const admin = await setupAdmin(env);
  const c = await readyMember(env, admin);
  const noHeader = await c.call('POST', '/api/exchanges', { quantity: 1, requestKey: reqKey() }, { 'x-requested-with': '' });
  assert.equal(noHeader.status, 403);
  assert.equal(noHeader.body.error.code, 'CSRF_BLOCKED');
  assert.equal((await c.call('POST', '/api/link', { fulpotId: 'minjun_k' }, { 'x-requested-with': '' })).status, 403);
  assert.equal((await client(env.app).get('/api/admin/exchanges')).status, 401);
  assert.equal((await client(env.app).post('/api/link/lookup', { fulpotId: 'teddy123' })).status, 401);
  assert.equal((await c.get('/api/admin/members')).status, 401);
  assert.equal((await c.post('/api/admin/registrations', { name: '아무개', phone: '010-1111-2222', requestKey: reqKey() })).status, 401);

  env.s.auth.createAdmin({ username: 'boss', name: '총괄', password: 'Passw0rd!123' });
  const x = client(env.app, { ip: '198.51.100.7' });
  for (let i = 0; i < 4; i++) assert.equal((await x.post('/api/admin/login', { username: 'boss', password: 'wrong-pass-1' })).status, 401);
  assert.equal((await x.post('/api/admin/login', { username: 'boss', password: 'wrong-pass-1' })).status, 423);
  assert.equal((await x.post('/api/admin/login', { username: 'boss', password: 'Passw0rd!123' })).status, 423);
  env.clock.advance(16 * 60000);
  assert.equal((await x.post('/api/admin/login', { username: 'boss', password: 'Passw0rd!123' })).status, 200);
  assert.equal((await x.post('/api/admin/password', { current: 'Passw0rd!123', next: 'short' })).status, 400);
  assert.equal((await x.post('/api/admin/password', { current: 'Passw0rd!123', next: 'NewPassw0rd!2026' })).status, 200);
});

test('풀팟 계정 확인 횟수 제한: 한 시간에 30번까지', async () => {
  const env = await makeEnv();
  const admin = await setupAdmin(env);
  const c = await readyMember(env, admin, { fulpotId: null });
  for (let i = 0; i < 30; i++) assert.notEqual((await c.post('/api/link/lookup', { fulpotId: `nobody${i}` })).status, 429);
  const limited = await c.post('/api/link/lookup', { fulpotId: 'teddy123' });
  assert.equal(limited.status, 429);
  env.clock.advance(H + 1000);
  assert.equal((await c.post('/api/link/lookup', { fulpotId: 'teddy123' })).status, 200);
});

test('회원 정보 변경: 번호를 바꾸거나 이용 중지하면 기존 로그인 종료', async () => {
  const env = await makeEnv();
  const admin = await setupAdmin(env);
  const c = await readyMember(env, admin);
  const m = env.s.members.byNo('APS-10023');
  const r = await admin.post(`/api/admin/members/${m.id}`, { phone: '010-1111-2222' });
  assert.equal(r.body.member.phone, '010-1111-2222');
  assert.equal((await c.get('/api/me')).status, 401);
  assert.equal((await loginMember(env, c, '이형주', '010-1111-2222')).body.result, 'ok');
  await admin.post(`/api/admin/members/${m.id}`, { status: 'stopped' });
  assert.equal((await c.get('/api/me')).status, 401);
  assert.equal((await loginMember(env, c, '이형주', '010-1111-2222')).body.result, 'stopped');
});

test('회원 검색과 상세: 이름·번호·회원번호·풀팟 ID로 찾기', async () => {
  const env = await makeEnv();
  const admin = await setupAdmin(env);
  await readyMember(env, admin);
  await upload(admin, [['APS-10024', '김민준', '010-2222-3333', 150]]);
  const byName = (await admin.get('/api/admin/members?q=' + encodeURIComponent('형주'))).body;
  assert.equal(byName.total, 1);
  assert.deepEqual(byName.rows[0].points, { total: 120, pending: 0, available: 120 });
  assert.equal(byName.rows[0].fulpotId, 'teddy123');
  assert.equal(byName.rows[0].fulpotNickname, '테디베어');
  assert.equal((await admin.get('/api/admin/members?q=2222')).body.rows[0].name, '김민준');
  assert.equal((await admin.get('/api/admin/members?q=TEDDY')).body.rows[0].memberNo, 'APS-10023');
  assert.equal((await admin.get('/api/admin/members?q=aps-1002')).body.total, 2);
  const d = (await admin.get(`/api/admin/members/${byName.rows[0].id}`)).body;
  assert.equal(d.links[0].fulpotId, 'teddy123');
  assert.equal(d.links[0].status, 'active');
  assert.equal(d.ledger.length, 1);
});

test('이전 버전(1.x) DB: 시작하지 않고 다시 만드는 방법을 안내', () => {
  const db = openNodeDb(':memory:');
  db.exec("CREATE TABLE members (id INTEGER PRIMARY KEY); CREATE TABLE exchanges (id INTEGER PRIMARY KEY, status TEXT CHECK (status IN ('received', 'paying')));");
  assert.throws(() => migrate(db), /이전 버전\(1\.x\)/);
  const fresh = openNodeDb(':memory:');
  migrate(fresh);
  migrate(fresh);
  assert.equal(fresh.get('PRAGMA user_version').user_version, 2);
});

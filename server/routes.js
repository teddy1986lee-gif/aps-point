'use strict';
const { E } = require('./lib/errors');

const MEMBER_COOKIE = 'aps_sid';
const ADMIN_COOKIE = 'aps_admin';

module.exports = function routes(r, s) {
  const b = (ctx) => ctx.req.body || {};
  const q = (ctx) => ctx.req.query || {};
  const idOf = (ctx) => {
    const n = Number(ctx.params.id);
    if (!Number.isInteger(n) || n < 1) throw E.notFound();
    return n;
  };

  // ---------------- 회원 ----------------
  const member = (ctx) => {
    const m = s.auth.memberSession(ctx.req.cookies[MEMBER_COOKIE]);
    if (!m) throw E.unauth('로그인이 필요합니다.');
    ctx.member = m;
  };

  function home(m) {
    const points = s.points.balance(m.id);
    const t = s.settings.ticket();
    let tickets = Math.floor(Math.max(points.available, 0) / t.unitPoints);
    if (t.maxPerExchange) tickets = Math.min(tickets, t.maxPerExchange);
    return {
      member: s.members.memberView(m),
      points,
      ticket: t,
      exchangeable: tickets,
      shortfall: points.available < t.unitPoints ? t.unitPoints - Math.max(points.available, 0) : 0,
      pointsAsOf: s.settings.get('points_as_of'),
      link: s.links.memberView(m.id),
      active: s.exchanges.activeForMember(m.id),
      recent: s.exchanges.listForMember(m.id, 3),
      history: s.points.ledgerOf(m.id, 30),
    };
  }

  r.get('/api/config', () => s.settings.publicConfig());

  r.post('/api/auth/otp', (ctx) => s.auth.requestOtp({ name: b(ctx).name, phone: b(ctx).phone, ip: ctx.ip }));

  r.post('/api/auth/verify', (ctx) => {
    const out = s.auth.verifyOtp({ requestId: b(ctx).requestId, code: b(ctx).code });
    if (out.result !== 'ok') return { result: out.result };
    ctx.setCookie(MEMBER_COOKIE, out.token, { maxAge: s.config.session.memberHours * 3600 });
    return { result: 'ok', me: home(out.member) };
  });

  r.post('/api/auth/logout', (ctx) => {
    s.auth.memberLogout(ctx.req.cookies[MEMBER_COOKIE]);
    ctx.clearCookie(MEMBER_COOKIE);
    return { ok: true };
  });

  r.get('/api/me', member, (ctx) => home(ctx.member));
  // 처음 화면을 열 때: 로그인 전이면 401 대신 { me: null }
  r.get('/api/session', (ctx) => {
    const m = s.auth.memberSession(ctx.req.cookies[MEMBER_COOKIE]);
    return { me: m ? home(m) : null };
  });

  // 풀팟 계정: 확인(닉네임 보여 주기) → 바로 연결
  r.post('/api/link/lookup', member, async (ctx) => ({ account: await s.links.lookup(ctx.member, b(ctx).fulpotId) }));
  r.post('/api/link', member, async (ctx) => {
    const link = await s.links.link(ctx.member, b(ctx).fulpotId);
    return { link, me: home(ctx.member) };
  });

  r.get('/api/exchanges', member, (ctx) => ({ rows: s.exchanges.listForMember(ctx.member.id) }));
  r.get('/api/exchanges/:no', member, (ctx) => ({ exchange: s.exchanges.getForMember(ctx.member, ctx.params.no) }));
  // 신청하면 바로 풀팟 지급까지 진행하고 결과(지급 완료·지급 실패·지급 확인 중)를 돌려준다.
  r.post('/api/exchanges', member, async (ctx) => {
    const out = await s.exchanges.create(ctx.member, b(ctx));
    ctx.res.status = out.replayed ? 200 : 201;
    return { exchange: out.exchange, me: home(ctx.member) };
  });

  // ---------------- 관리자 ----------------
  const admin = (ctx) => {
    const out = s.auth.adminSession(ctx.req.cookies[ADMIN_COOKIE]);
    if (!out) throw E.unauth('관리자 로그인이 필요합니다.');
    ctx.admin = out.admin;
    ctx.adminSessionId = out.sessionId;
    ctx.by = `${out.admin.name}(${out.admin.username})`;
  };

  function badges() {
    return { exchanges: s.exchanges.checkCount() };
  }

  r.post('/api/admin/login', (ctx) => {
    const out = s.auth.adminLogin({ username: b(ctx).username, password: b(ctx).password, ip: ctx.ip });
    ctx.setCookie(ADMIN_COOKIE, out.token, { sameSite: 'Strict', maxAge: s.config.session.adminHours * 3600 });
    return { admin: out.admin, badges: badges() };
  });
  r.post('/api/admin/logout', (ctx) => {
    s.auth.adminLogout(ctx.req.cookies[ADMIN_COOKIE]);
    ctx.clearCookie(ADMIN_COOKIE);
    return { ok: true };
  });
  r.get('/api/admin/me', admin, (ctx) => ({ admin: { username: ctx.admin.username, name: ctx.admin.name }, badges: badges() }));
  // 처음 화면을 열 때: 로그인 전이면 401 대신 { admin: null }
  r.get('/api/admin/session', (ctx) => {
    const out = s.auth.adminSession(ctx.req.cookies[ADMIN_COOKIE]);
    return out ? { admin: { username: out.admin.username, name: out.admin.name }, badges: badges() } : { admin: null };
  });
  r.post('/api/admin/password', admin, (ctx) => {
    s.auth.changePassword(ctx.admin, ctx.adminSessionId, b(ctx));
    return { ok: true };
  });

  // 티켓 지급: 확인 필요 건 처리(query 풀팟에서 확인 · retry 다시 요청 · complete 지급 번호로 완료 · fail 지급 실패 처리)
  r.get('/api/admin/exchanges', admin, (ctx) => s.exchanges.listAdmin({ tab: q(ctx).tab, q: q(ctx).q, page: q(ctx).page }));
  r.post('/api/admin/exchanges/:id/:action', admin, async (ctx) => {
    const out = await s.exchanges.act(idOf(ctx), ctx.params.action, b(ctx), ctx.by);
    return { ...out, badges: badges() };
  });

  // 풀팟 계정: 연결 목록·해제 기록, 연결 해제
  r.get('/api/admin/links', admin, (ctx) => s.links.listAdmin({ tab: q(ctx).tab, q: q(ctx).q }));
  r.post('/api/admin/links/:id/release', admin, (ctx) => ({ link: s.links.release(idOf(ctx), b(ctx), ctx.by) }));

  // 회원·포인트
  r.get('/api/admin/members', admin, (ctx) => s.members.search({ q: q(ctx).q, page: q(ctx).page }));
  r.get('/api/admin/members/:id', admin, (ctx) => s.members.detail(idOf(ctx)));
  r.post('/api/admin/members/:id', admin, (ctx) => s.members.update(idOf(ctx), b(ctx), ctx.by));
  r.post('/api/admin/members/:id/adjust', admin, (ctx) => {
    const out = s.points.adjust(idOf(ctx), b(ctx), ctx.by);
    return { ...s.members.detail(idOf(ctx)), replayed: out.replayed };
  });

  // 포인트 등록: 직접 등록(이름·휴대폰) + 엑셀·CSV 파일
  r.get('/api/admin/registrations', admin, () => ({ rows: s.members.registrations() }));
  r.post('/api/admin/registrations', admin, (ctx) => s.members.register(b(ctx), ctx.by));
  r.post('/api/admin/upload/preview', admin, (ctx) => s.points.previewUpload(b(ctx)));
  r.post('/api/admin/upload/commit', admin, (ctx) => s.points.commitUpload(b(ctx), ctx.by));
  r.get('/api/admin/uploads', admin, () => ({ uploads: s.points.uploads(), pointsAsOf: s.settings.get('points_as_of') }));

  r.get('/api/admin/settings', admin, () => ({ settings: s.settings.all(), fulpot: s.settings.fulpotInfo() }));
  r.put('/api/admin/settings', admin, (ctx) => ({ settings: s.settings.update(b(ctx), ctx.by), fulpot: s.settings.fulpotInfo() }));
};

module.exports.MEMBER_COOKIE = MEMBER_COOKIE;
module.exports.ADMIN_COOKIE = ADMIN_COOKIE;

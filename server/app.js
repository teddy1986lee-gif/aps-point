'use strict';
const { createRouter } = require('./lib/router');
const { AppError } = require('./lib/errors');
const { createServices } = require('./services');
const { createFulpot } = require('./fulpot');

/*
 * 앱 본체: 요청 객체 → 응답 객체.
 * Node HTTP 서버(server/index.js)와 브라우저 데모(demo/)가 같은 handle()을 쓴다.
 *   req: { method, path, query, headers, cookies, body, ip }
 *   res: { status, headers, cookies: [{ name, value, maxAge, ... }], body(string) }
 * fulpot을 주지 않으면 모의 풀팟으로 동작한다.
 */
function createApp({ db, config, clock, sms, fulpot, logger = console }) {
  const s = createServices({ db, config, clock, sms, fulpot: fulpot || createFulpot({ mode: 'mock' }) });
  const router = createRouter();
  require('./routes')(router, s);

  function json(status, body, cookies, extra) {
    return {
      status,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...(extra || {}) },
      cookies: cookies || [],
      body: JSON.stringify(body),
    };
  }

  async function handle(req) {
    const res = { status: 200, cookies: [] };
    const cookieBase = { httpOnly: true, sameSite: 'Lax', path: '/', secure: !!config.secureCookies };
    const ctx = {
      req: { method: req.method, path: req.path, query: req.query || {}, headers: req.headers || {}, cookies: req.cookies || {}, body: req.body },
      res,
      ip: req.ip || null,
      setCookie: (name, value, opts = {}) => res.cookies.push({ ...cookieBase, ...opts, name, value }),
      clearCookie: (name) => res.cookies.push({ ...cookieBase, name, value: '', maxAge: 0 }),
    };
    try {
      const m = ctx.req.method;
      // 다른 사이트의 폼이 쿠키를 싣고 상태를 바꾸지 못하도록, 상태 변경 요청에는 전용 헤더를 요구한다.
      if (m !== 'GET' && m !== 'HEAD' && ctx.req.headers['x-requested-with'] !== 'aps-web') {
        throw new AppError(403, 'CSRF_BLOCKED', '허용되지 않은 요청입니다. 페이지를 새로고침한 뒤 다시 시도해 주세요.');
      }
      const out = await router.dispatch(ctx);
      return json(res.status, out === undefined ? { ok: true } : out, res.cookies);
    } catch (err) {
      if (err instanceof AppError) {
        const extra = err.status === 429 && err.details && err.details.retryAfter ? { 'retry-after': String(err.details.retryAfter) } : undefined;
        return json(err.status, { error: { code: err.code, message: err.message, details: err.details } }, res.cookies, extra);
      }
      logger.error('[api]', req.method, req.path, err);
      return json(500, { error: { code: 'INTERNAL', message: '처리 중 문제가 생겼습니다. 잠시 후 다시 시도해 주세요.' } }, res.cookies);
    }
  }

  // 1시간마다: 오래된 인증 기록과 끝난 로그인 정리
  function runJobs(at = clock.now()) {
    s.auth.cleanup(at);
  }

  // 1분마다: 멈춘 지급 요청을 확인 필요로 옮기고, 확인 필요인 지급을 풀팟 기록으로 확인
  function checkIssues() {
    return s.exchanges.checkIssues();
  }

  return { handle, services: s, runJobs, checkIssues };
}

module.exports = { createApp };

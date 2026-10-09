'use strict';
const { AppError } = require('./errors');

// 의존성 없는 작은 라우터. 핸들러가 undefined를 돌려주면 다음 핸들러(미들웨어 체인)로 넘어간다.
function createRouter() {
  const routes = [];

  function add(method, pattern, handlers) {
    const keys = [];
    const source = pattern.replace(/:([a-zA-Z]+)/g, (_, k) => {
      keys.push(k);
      return '([^/]+)';
    });
    routes.push({ method, re: new RegExp('^' + source + '/?$'), keys, handlers });
  }

  async function dispatch(ctx) {
    const { method, path } = ctx.req;
    let pathMatched = false;
    for (const r of routes) {
      const m = r.re.exec(path);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== method) continue;
      ctx.params = {};
      r.keys.forEach((k, i) => {
        ctx.params[k] = decodeURIComponent(m[i + 1]);
      });
      for (const h of r.handlers) {
        const out = await h(ctx);
        if (out !== undefined) return out;
      }
      return { ok: true };
    }
    if (pathMatched) throw new AppError(405, 'METHOD_NOT_ALLOWED', '허용되지 않은 요청 방식입니다.');
    throw new AppError(404, 'NOT_FOUND', '요청한 주소를 찾을 수 없습니다.');
  }

  const api = { dispatch };
  for (const m of ['get', 'post', 'put', 'patch', 'delete']) {
    api[m] = (pattern, ...handlers) => add(m.toUpperCase(), pattern, handlers);
  }
  return api;
}

module.exports = { createRouter };

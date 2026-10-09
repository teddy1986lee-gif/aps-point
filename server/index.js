'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { readConfig, loadDotEnv, ROOT } = require('./config');
const { openNodeDb } = require('./db/sqlite-node');
const { migrate } = require('./db/schema');
const { createApp } = require('./app');
const { createSms } = require('./sms');
const { createFulpot } = require('./fulpot');

loadDotEnv();
let config;
let db;
try {
  config = readConfig();
  db = openNodeDb(config.dbPath);
  migrate(db);
} catch (e) {
  console.error(`서버를 시작하지 못했습니다: ${e.message}`);
  process.exit(1);
}
const fulpot = createFulpot(config.fulpot);
const app = createApp({
  db,
  config,
  clock: { now: () => Date.now() },
  sms: createSms(config.sms),
  fulpot,
});

const PUBLIC = path.join(ROOT, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.csv': 'text/csv; charset=utf-8',
};
// 글꼴: Pretendard(jsDelivr), Montserrat(Google Fonts). 외부 CDN을 쓰지 않으려면 README '글꼴' 안내 참고
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' https://fonts.googleapis.com https://cdn.jsdelivr.net",
  'font-src https://fonts.gstatic.com https://cdn.jsdelivr.net',
  "img-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

function baseHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (config.hsts) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    try {
      out[k] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      out[k] = part.slice(i + 1).trim();
    }
  }
  return out;
}

function serializeCookie(c) {
  const parts = [`${c.name}=${encodeURIComponent(c.value)}`, `Path=${c.path || '/'}`];
  if (c.maxAge != null) parts.push(`Max-Age=${Math.floor(c.maxAge)}`);
  if (c.httpOnly) parts.push('HttpOnly');
  if (c.secure) parts.push('Secure');
  if (c.sameSite) parts.push(`SameSite=${c.sameSite}`);
  return parts.join('; ');
}

function clientIp(req) {
  if (config.trustProxy) {
    const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (xff) return xff;
  }
  return req.socket.remoteAddress || null;
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function handleApi(req, res, url) {
  const big = url.pathname.startsWith('/api/admin/upload/');
  let body;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const raw = await readBody(req, big ? 20 * 1024 * 1024 : 256 * 1024);
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: { code: 'BAD_JSON', message: '요청 형식이 올바르지 않습니다.' } }));
        return;
      }
    }
  }
  const out = await app.handle({
    method: req.method,
    path: url.pathname,
    query: Object.fromEntries(url.searchParams),
    headers: req.headers,
    cookies: parseCookies(req.headers.cookie),
    body,
    ip: clientIp(req),
  });
  const headers = { ...out.headers };
  if (out.cookies.length) headers['set-cookie'] = out.cookies.map(serializeCookie);
  res.writeHead(out.status, headers);
  res.end(out.body);
}

function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405);
    res.end();
    return;
  }
  let p;
  try {
    p = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400);
    res.end();
    return;
  }
  if (p === '/admin') {
    res.writeHead(301, { Location: p + '/' });
    res.end();
    return;
  }
  if (p.endsWith('/')) p += 'index.html';
  const file = path.resolve(PUBLIC, '.' + p);
  if (!file.startsWith(PUBLIC + path.sep)) {
    res.writeHead(403);
    res.end();
    return;
  }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('페이지를 찾을 수 없습니다.');
      return;
    }
    const ext = path.extname(file).toLowerCase();
    const etag = `"${st.size.toString(36)}-${st.mtimeMs.toString(36)}"`;
    const headers = {
      'content-type': MIME[ext] || 'application/octet-stream',
      'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
      etag,
    };
    if (ext === '.html') headers['content-security-policy'] = CSP;
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      res.end();
      return;
    }
    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  baseHeaders(res);
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    res.writeHead(400);
    res.end();
    return;
  }
  try {
    if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else serveStatic(req, res, url);
  } catch (e) {
    if (!res.headersSent) {
      res.writeHead(e.status || 500, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: { code: e.status === 413 ? 'TOO_LARGE' : 'INTERNAL', message: e.status === 413 ? '요청이 너무 큽니다.' : '서버 오류가 발생했습니다.' } }));
    }
    if (e.status !== 413) console.error(e);
  } finally {
    if (url.pathname.startsWith('/api/')) console.log(`${req.method} ${url.pathname} ${res.statusCode} ${Date.now() - started}ms`);
  }
});

// 정기 작업 1: 1분마다 멈춘 지급 요청 정리와 '확인 필요' 지급의 풀팟 기록 조회
const checkTimer = setInterval(() => {
  app
    .checkIssues()
    .then((r) => {
      if (r && (r.moved || r.completed || r.corrected)) console.log(`[지급 확인] 확인 대상 ${r.moved}건 추가 · 자동 완료 ${r.completed}건 · 바로잡음 ${r.corrected}건`);
    })
    .catch((e) => console.error('[지급 확인]', e));
}, 60000);
checkTimer.unref();

// 정기 작업 2: 1시간마다 오래된 인증 기록과 끝난 로그인 정리
const timer = setInterval(() => {
  try {
    app.runJobs();
  } catch (e) {
    console.error('[jobs]', e);
  }
}, 3600000);
timer.unref();

server.listen(config.port, config.host, () => {
  console.log(`APS 포인트 교환 서버 실행: http://localhost:${config.port}`);
  console.log(`  회원 사이트  http://localhost:${config.port}/`);
  console.log(`  관리자 페이지 http://localhost:${config.port}/admin/`);
  console.log(`  문자 발송: ${config.sms.provider} · DB: ${config.dbPath}`);
  console.log(`  풀팟 연동: ${fulpot.label}${fulpot.baseUrl ? ` ${fulpot.baseUrl}` : ''}`);
});

function shutdown() {
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

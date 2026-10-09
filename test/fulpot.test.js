'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createFulpot } = require('../server/fulpot');
const { readConfig } = require('../server/config');

// 운영용 풀팟 API 연동(FULPOT_MODE=http)을 README 4장 규격대로 흉내 낸 작은 서버로 확인한다.
test('풀팟 API 연동(http): 응답 코드별로 지급·이미 지급·거절·결과 모름을 구분하고, 요청 키와 토큰을 보낸다', async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, idem: req.headers['idempotency-key'], body: body ? JSON.parse(body) : null });
      const send = (status, data) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(data));
      };
      if (req.url === '/v1/accounts/teddy123') return send(200, { uid: 'FP100231', fulpotId: 'teddy123', nickname: '테디베어' });
      if (req.url.startsWith('/v1/accounts/')) return send(404, { message: 'not found' });
      if (req.url === '/v1/tickets/issues' && req.method === 'POST') {
        const k = JSON.parse(body).requestKey;
        if (k === 'EX-OK') return send(201, { issueId: 'FPX-1' });
        if (k === 'EX-DUP') return send(409, { issueId: 'FPX-0' });
        if (k === 'EX-NO') return send(422, { reason: '계정 이용 제한' });
        if (k === 'EX-SLOW') return undefined; // 응답하지 않음 → 시간 초과
        if (k === 'EX-BADID') return send(200, { issueId: '<script>' });
        return send(500, { message: 'oops' });
      }
      if (req.url === '/v1/tickets/issues/EX-OK') return send(200, { issueId: 'FPX-1', issuedAt: '2026-10-09T08:15:00Z' });
      if (req.url.startsWith('/v1/tickets/issues/')) return send(404, {});
      return send(500, {});
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const f = createFulpot({ mode: 'http', baseUrl: `http://127.0.0.1:${port}/v1/`, token: 'tkn', timeoutMs: 300 });
  try {
    assert.equal(f.mode, 'http');
    assert.deepEqual(await f.lookupAccount('teddy123'), { status: 'found', uid: 'FP100231', fulpotId: 'teddy123', nickname: '테디베어' });
    assert.deepEqual(await f.lookupAccount('nobody'), { status: 'not_found' });
    const req = { uid: 'FP100231', ticketCode: 'TKT', quantity: 2 };
    assert.deepEqual(await f.issueTicket({ ...req, requestKey: 'EX-OK' }), { status: 'issued', issueId: 'FPX-1', duplicate: false });
    assert.deepEqual(await f.issueTicket({ ...req, requestKey: 'EX-DUP' }), { status: 'issued', issueId: 'FPX-0', duplicate: true });
    assert.deepEqual(await f.issueTicket({ ...req, requestKey: 'EX-NO' }), { status: 'rejected', reason: '계정 이용 제한' });
    assert.equal((await f.issueTicket({ ...req, requestKey: 'EX-ERR' })).status, 'unknown');
    assert.equal((await f.issueTicket({ ...req, requestKey: 'EX-SLOW' })).status, 'unknown');
    assert.equal((await f.issueTicket({ ...req, requestKey: 'EX-BADID' })).status, 'unknown');
    assert.deepEqual(await f.queryIssue('EX-OK'), { status: 'issued', issueId: 'FPX-1', issuedAt: Date.UTC(2026, 9, 9, 8, 15) });
    assert.deepEqual(await f.queryIssue('EX-NONE'), { status: 'not_found' });

    const issue = seen.find((x) => x.method === 'POST' && x.body.requestKey === 'EX-OK');
    assert.equal(issue.url, '/v1/tickets/issues');
    assert.equal(issue.auth, 'Bearer tkn');
    assert.equal(issue.idem, 'EX-OK');
    assert.deepEqual(issue.body, { requestKey: 'EX-OK', uid: 'FP100231', ticketCode: 'TKT', quantity: 2 });
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
  // 풀팟 서버가 꺼져 있으면 결과 모름
  const off = createFulpot({ mode: 'http', baseUrl: `http://127.0.0.1:${port}`, timeoutMs: 300 });
  assert.equal((await off.queryIssue('EX-OK')).status, 'unknown');
  assert.equal((await off.lookupAccount('teddy123')).status, 'unknown');
});

test('운영 설정: 풀팟 API 주소 없이는 시작하지 않고, 모의 풀팟은 개발에서만', () => {
  const base = { NODE_ENV: 'production', APP_SECRET: 'x'.repeat(40), SMS_PROVIDER: 'webhook', SMS_WEBHOOK_URL: 'https://sms.example/hook', DB_PATH: ':memory:' };
  assert.throws(() => readConfig(base), /FULPOT_MODE=http/);
  assert.throws(() => readConfig({ ...base, FULPOT_MODE: 'mock' }), /FULPOT_MODE=http/);
  const ok = readConfig({ ...base, FULPOT_MODE: 'http', FULPOT_API_URL: 'https://api.fulpot.example/v1', FULPOT_API_TOKEN: 't' });
  assert.equal(ok.fulpot.mode, 'http');
  assert.equal(ok.fulpot.timeoutMs, 8000);
  const dev = readConfig({ DB_PATH: ':memory:', APP_SECRET: 'dev' });
  assert.equal(dev.fulpot.mode, 'mock');
  assert.throws(() => createFulpot({ mode: 'ftp' }), /알 수 없는 FULPOT_MODE/);
});

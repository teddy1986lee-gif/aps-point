'use strict';
const { openNodeDb } = require('../server/db/sqlite-node');
const { migrate } = require('../server/db/schema');
const { createApp } = require('../server/app');
const { createSms } = require('../server/sms');
const { createFulpot } = require('../server/fulpot');

// 2026-10-07 12:00 KST
const T0 = Date.UTC(2026, 9, 7, 3, 0, 0);

// 시험에서만 쓰는 모의 풀팟 계정(기본 MOCK_ACCOUNTS에 더해짐)
const TEST_ACCOUNTS = {
  teddy_new: { uid: 'FP900001', nickname: '새테디' },
  shared_id: { uid: 'FP900002', nickname: '같이쓰는계정' },
  seoyeon: { uid: 'FP900003', nickname: '서연' },
};

// APS_TEST_DB=sqljs 이면 브라우저 데모와 같은 sql.js 엔진으로 같은 테스트를 돌린다.
let sqlJs = null;
async function openTestDb() {
  if (process.env.APS_TEST_DB === 'sqljs') {
    if (!sqlJs) sqlJs = await require(process.env.APS_SQLJS_PATH)();
    return require('../demo/db-sqljs').openSqlJsDb(sqlJs);
  }
  return openNodeDb(':memory:');
}

async function makeEnv({ timeoutMs = 300 } = {}) {
  const db = await openTestDb();
  migrate(db);
  let t = T0;
  const clock = { now: () => t, set: (ms) => (t = ms), advance: (ms) => (t += ms) };
  const sms = createSms({ provider: 'memory' });
  const fulpot = createFulpot({ mode: 'mock', accounts: TEST_ACCOUNTS, now: clock.now, timeoutMs });
  const config = {
    secret: 'test-secret',
    secureCookies: false,
    exposeOtp: false,
    otp: { ttlSec: 180, resendSec: 60, maxAttempts: 5, maxPerPhoneHour: 5, maxPerPhoneDay: 10, maxPerIpHour: 1000 },
    session: { memberHours: 12, adminHours: 12, adminIdleMinutes: 120 },
  };
  const app = createApp({ db, config, clock, sms, fulpot, logger: { error: (...a) => console.error(...a) } });
  return { db, clock, sms, app, s: app.services, config, fulpot, mock: fulpot.mock };
}

function client(app, { ip = '203.0.113.10' } = {}) {
  const jar = {};
  async function call(method, path, body, headers = {}) {
    const [p, qs] = path.split('?');
    const out = await app.handle({
      method,
      path: p,
      query: Object.fromEntries(new URLSearchParams(qs || '')),
      headers: { 'x-requested-with': 'aps-web', ...headers },
      cookies: { ...jar },
      body,
      ip,
    });
    for (const c of out.cookies) {
      if (c.maxAge === 0) delete jar[c.name];
      else jar[c.name] = c.value;
    }
    return { status: out.status, body: JSON.parse(out.body), cookies: out.cookies };
  }
  return { jar, call, get: (p) => call('GET', p), post: (p, b) => call('POST', p, b || {}), put: (p, b) => call('PUT', p, b || {}) };
}

function lastCode(env) {
  const msg = env.sms.outbox[env.sms.outbox.length - 1];
  return msg ? /(\d{6})/.exec(msg.text)[1] : null;
}

async function loginMember(env, c, name, phone) {
  const r1 = await c.post('/api/auth/otp', { name, phone });
  if (r1.status !== 200) throw new Error('otp request failed: ' + JSON.stringify(r1.body));
  const r2 = await c.post('/api/auth/verify', { requestId: r1.body.requestId, code: lastCode(env) });
  env.clock.advance(61000); // 재발송 간격
  return r2;
}

let adminSeq = 0;
async function setupAdmin(env) {
  const username = `admin${++adminSeq}`;
  env.s.auth.createAdmin({ username, name: '운영자', password: 'Passw0rd!123' });
  const c = client(env.app, { ip: '198.51.100.1' });
  const r = await c.post('/api/admin/login', { username, password: 'Passw0rd!123' });
  if (r.status !== 200) throw new Error('admin login failed: ' + JSON.stringify(r.body));
  return c;
}

// rows: [회원번호, 이름, 휴대폰, 포인트, 건 번호?]
async function upload(adminClient, rows, extra = {}) {
  const body = {
    fileName: 'test.csv',
    rows: rows.map(([no, name, phone, points, ref], i) => ({ __row: i + 2, member_no: no, name, phone, points, source_ref: ref || '최초잔액' })),
    ...extra,
  };
  const r = await adminClient.post('/api/admin/upload/commit', body);
  if (r.status !== 200) throw new Error('upload failed: ' + JSON.stringify(r.body));
  return r.body;
}

// 회원 등록 → 로그인 → 풀팟 계정 즉시 연결까지 한 번에
async function readyMember(env, admin, { no = 'APS-10023', name = '이형주', phone = '010-1234-5678', points = 120, fulpotId = 'teddy123' } = {}) {
  await upload(admin, [[no, name, phone, points]]);
  const c = client(env.app);
  const r = await loginMember(env, c, name, phone);
  if (r.body.result !== 'ok') throw new Error('member login failed: ' + JSON.stringify(r.body));
  if (fulpotId) {
    const l = await c.post('/api/link', { fulpotId });
    if (l.status !== 200) throw new Error('link failed: ' + JSON.stringify(l.body));
  }
  return c;
}

const exchangeId = (env, no) => env.db.get('SELECT id FROM exchanges WHERE exchange_no = ?', no).id;

let keySeq = 0;
const reqKey = () => `test-key-${String(++keySeq).padStart(6, '0')}`;

module.exports = { T0, makeEnv, client, lastCode, loginMember, setupAdmin, upload, readyMember, exchangeId, reqKey };

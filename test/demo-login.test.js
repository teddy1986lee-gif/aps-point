'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeEnv, client, setupAdmin, upload } = require('./helpers');
const { createApp } = require('../server/app');

test('demo direct login: session without SMS, invalid/duplicate/stopped records blocked, production route absent', async () => {
  const env = await makeEnv();
  const admin = await setupAdmin(env);
  await upload(admin, [['APS-1', '이형주', '010-1234-5678', 120], ['APS-2', '중복', '010-2222-3333', 40], ['APS-3', '중복', '010-2222-3333', 40]]);
  const data = { name: '이형주', phone: '01012345678' };
  assert.equal((await client(env.app).post('/api/auth/demo-login', data)).status, 404);
  assert.throws(() => env.s.auth.demoLogin(data));
  const app = createApp({ db: env.db, config: { ...env.config, demoDirectLogin: true }, clock: env.clock, sms: env.sms, fulpot: env.fulpot });
  const c = client(app);
  const out = await c.post('/api/auth/demo-login', data);
  assert.equal(out.body.result, 'ok');
  assert.equal((await c.get('/api/me')).status, 200);
  assert.equal(env.sms.outbox.length, 0);
  assert.equal(env.db.get('SELECT COUNT(*) AS n FROM otp_codes').n, 0);
  assert.equal((await c.post('/api/auth/demo-login', { ...data, name: '없는회원' })).body.result, 'no_match');
  assert.equal((await c.post('/api/auth/demo-login', { name: '중복', phone: '01022223333' })).body.result, 'duplicate');
  assert.equal((await c.post('/api/auth/demo-login', { ...data, phone: '123' })).status, 400);
  env.db.run("UPDATE members SET status = 'stopped' WHERE member_no = 'APS-1'");
  assert.equal((await c.post('/api/auth/demo-login', data)).body.result, 'stopped');
  assert.equal((await c.get('/api/me')).status, 401);
  env.db.close();
});

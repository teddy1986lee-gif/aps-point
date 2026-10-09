'use strict';
// 로컬에서 써 보기 위한 데모 데이터 넣기:  npm run seed:demo  (이미 데이터가 있으면 -- --reset)
const fs = require('node:fs');
const { readConfig, loadDotEnv } = require('../server/config');
const { openNodeDb } = require('../server/db/sqlite-node');
const { migrate } = require('../server/db/schema');
const { createApp } = require('../server/app');
const { createSms } = require('../server/sms');
const { createFulpot } = require('../server/fulpot');
const { seedDemo, createClock } = require('../server/seed');

(async () => {
  loadDotEnv();
  const config = readConfig();
  if (config.production) {
    console.error('운영 환경(NODE_ENV=production)에서는 데모 데이터를 넣을 수 없습니다.');
    process.exit(1);
  }
  const reset = process.argv.includes('--reset');
  if (fs.existsSync(config.dbPath)) {
    if (!reset) {
      const probe = openNodeDb(config.dbPath);
      migrate(probe);
      const n = probe.get('SELECT COUNT(*) AS c FROM members').c + probe.get('SELECT COUNT(*) AS c FROM admins').c;
      probe.close();
      if (n > 0) {
        console.error(`이미 데이터가 있습니다(${config.dbPath}). 지우고 다시 넣으려면: npm run seed:demo -- --reset`);
        process.exit(1);
      }
    } else {
      for (const suffix of ['', '-wal', '-shm']) fs.rmSync(config.dbPath + suffix, { force: true });
    }
  }
  const db = openNodeDb(config.dbPath);
  migrate(db);
  const clock = createClock();
  // 데모 교환은 항상 모의 풀팟으로 만든다(실제 풀팟에는 아무 요청도 보내지 않음).
  const app = createApp({ db, config, clock, sms: createSms({ provider: 'memory' }), fulpot: createFulpot({ mode: 'mock' }) });
  const out = await seedDemo(app.services, clock);
  db.close();
  console.log(`데모 데이터를 넣었습니다: ${config.dbPath}\n`);
  console.log(`관리자 페이지  아이디 ${out.admin.username} · 비밀번호 ${out.admin.password}`);
  console.log('회원 사이트    이형주 / 010-1234-5678 (인증번호는 서버 콘솔에 표시, DEV_EXPOSE_OTP=1이면 화면에도 표시)');
  console.log(`풀팟           모의 풀팟 · '확인 필요' 예시 신청 ${out.waiting}`);
})().catch((e) => {
  // DB 구조·설정 문제는 안내 문구만, 그 밖의 오류는 자세히
  console.error(e && /DB|FULPOT|APP_SECRET|SMS_/.test(e.message) ? e.message : e);
  process.exit(1);
});

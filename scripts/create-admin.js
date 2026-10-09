'use strict';
// 관리자 계정 만들기:  npm run create-admin   (비밀번호는 화면에 표시하지 않습니다)
const readline = require('node:readline');
const { readConfig, loadDotEnv } = require('../server/config');
const { openNodeDb } = require('../server/db/sqlite-node');
const { migrate } = require('../server/db/schema');
const { createApp } = require('../server/app');
const { createSms } = require('../server/sms');

function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      rl._writeToOutput = (s) => {
        if (s.includes(question)) rl.output.write(s);
      };
    }
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write('\n');
      resolve(answer.trim());
    });
  });
}

(async () => {
  loadDotEnv();
  let config;
  let db;
  try {
    config = readConfig();
    db = openNodeDb(config.dbPath);
    migrate(db);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  const app = createApp({ db, config, clock: { now: () => Date.now() }, sms: createSms({ provider: 'memory' }) });
  const username = await ask('아이디 (영문 소문자·숫자): ');
  const name = (await ask('이름 (예: 운영 담당): ')) || username;
  const password = await ask('비밀번호 (영문+숫자 10자 이상): ', { hidden: true });
  const again = await ask('비밀번호 다시 입력: ', { hidden: true });
  if (password !== again) {
    console.error('비밀번호가 서로 다릅니다.');
    process.exit(1);
  }
  try {
    const a = app.services.auth.createAdmin({ username, name, password });
    console.log(`\n관리자 계정을 만들었습니다: ${a.name}(${a.username})`);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  } finally {
    db.close();
  }
})();

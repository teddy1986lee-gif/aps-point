'use strict';
// 브라우저 데모 묶음의 시작점: 서버 코드를 그대로 가져와 window.APSDemoCore로 내보낸다.
const { createApp } = require('../server/app');
const { migrate } = require('../server/db/schema');
const { openSqlJsDb } = require('./db-sqljs');
const { createSms } = require('../server/sms');
const { createFulpot } = require('../server/fulpot');
const { seedDemo, createClock, DEMO_ADMIN } = require('../server/seed');
const { kstDateKey } = require('../server/lib/format');

module.exports = { createApp, migrate, openSqlJsDb, createSms, createFulpot, seedDemo, createClock, DEMO_ADMIN, kstDateKey };

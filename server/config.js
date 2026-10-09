'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');

function loadDotEnv(file = path.join(ROOT, '.env')) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    let val = m[2];
    if (/^".*"$/.test(val) || /^'.*'$/.test(val)) val = val.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = val;
  }
}

const int = (v, d) => (v == null || v === '' || Number.isNaN(Number(v)) ? d : Number(v));

// 개발 환경에서 APP_SECRET이 없으면 data/secret.key를 만들어 재시작해도 같은 값을 쓴다.
function devSecret(dataDir) {
  const file = path.join(dataDir, 'secret.key');
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  fs.mkdirSync(dataDir, { recursive: true });
  const secret = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

function readConfig(env = process.env) {
  const production = env.NODE_ENV === 'production';
  const dbPath = env.DB_PATH || path.join(ROOT, 'data', 'aps.db');
  const cfg = {
    production,
    port: int(env.PORT, 3000),
    host: env.HOST || '0.0.0.0',
    dbPath,
    secret: env.APP_SECRET || null,
    secureCookies: env.SECURE_COOKIES ? env.SECURE_COOKIES === '1' : production,
    trustProxy: env.TRUST_PROXY === '1',
    hsts: env.HSTS === '1',
    exposeOtp: !production && env.DEV_EXPOSE_OTP === '1',
    sms: {
      provider: env.SMS_PROVIDER || 'console',
      webhookUrl: env.SMS_WEBHOOK_URL || null,
      webhookToken: env.SMS_WEBHOOK_TOKEN || null,
      sender: env.SMS_SENDER || null,
    },
    otp: {
      ttlSec: int(env.OTP_TTL_SEC, 180),
      resendSec: int(env.OTP_RESEND_SEC, 60),
      maxAttempts: int(env.OTP_MAX_ATTEMPTS, 5),
      maxPerPhoneHour: int(env.OTP_MAX_PER_PHONE_HOUR, 5),
      maxPerPhoneDay: int(env.OTP_MAX_PER_PHONE_DAY, 10),
      maxPerIpHour: int(env.OTP_MAX_PER_IP_HOUR, 30),
    },
    session: {
      memberHours: int(env.MEMBER_SESSION_HOURS, 12),
      adminHours: int(env.ADMIN_SESSION_HOURS, 12),
      adminIdleMinutes: int(env.ADMIN_IDLE_MINUTES, 120),
    },
    // 풀팟 연동: mock(개발·데모용 모의 풀팟) | http(풀팟 API). 운영 환경은 http만 허용한다.
    fulpot: {
      mode: env.FULPOT_MODE || (production ? null : 'mock'),
      baseUrl: env.FULPOT_API_URL || null,
      token: env.FULPOT_API_TOKEN || null,
      timeoutMs: int(env.FULPOT_TIMEOUT_MS, 8000),
      // 개발용: 모의 풀팟의 지급 응답 바꾸기(ok | lost | down | reject)
      behavior: !production && env.FULPOT_MOCK_ISSUE ? { issue: env.FULPOT_MOCK_ISSUE } : undefined,
    },
  };
  if (!cfg.secret) {
    if (production) throw new Error('운영 환경에서는 APP_SECRET 환경변수(32자 이상 임의 문자열)가 필요합니다.');
    cfg.secret = devSecret(path.dirname(path.resolve(dbPath)));
  }
  if (production && cfg.sms.provider === 'console') {
    throw new Error('운영 환경에서는 SMS_PROVIDER=webhook으로 실제 문자 발송을 설정해야 합니다.');
  }
  if (production && (cfg.fulpot.mode !== 'http' || !cfg.fulpot.baseUrl)) {
    throw new Error('운영 환경에서는 FULPOT_MODE=http와 FULPOT_API_URL(풀팟 API 주소)이 필요합니다. 모의 풀팟은 개발에서만 쓸 수 있습니다.');
  }
  if (cfg.fulpot.mode === 'http' && !cfg.fulpot.baseUrl) throw new Error('FULPOT_MODE=http에는 FULPOT_API_URL이 필요합니다.');
  return cfg;
}

module.exports = { readConfig, loadDotEnv, ROOT };

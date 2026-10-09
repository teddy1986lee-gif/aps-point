'use strict';
const { maskPhone } = require('./lib/format');

/*
 * 문자 발송
 *  console : 개발용. 문자 내용을 서버 콘솔에 출력한다(운영 환경에서는 시작을 막는다).
 *  webhook : 운영용. { to, from, text }를 JSON으로 SMS_WEBHOOK_URL에 POST 한다.
 *            문자 대행사 API 앞에 작은 중계 함수를 두고 연결하면 된다(발신번호 사전 등록 필요).
 *  memory  : 테스트용. 보낸 문자를 배열에 쌓는다.
 *  callback: 브라우저 데모용. 화면에 문자 알림을 띄운다.
 */
function createSms(cfg = {}, opts = {}) {
  const provider = cfg.provider || 'console';
  if (provider === 'console') {
    return {
      name: 'console',
      async send({ to, text }) {
        console.log(`[문자:개발용] ${maskPhone(to)} ← ${text}`);
      },
    };
  }
  if (provider === 'memory') {
    const outbox = [];
    return {
      name: 'memory',
      outbox,
      async send(msg) {
        if (opts.fail) throw new Error('발송 실패(테스트)');
        outbox.push({ ...msg, at: Date.now() });
      },
    };
  }
  if (provider === 'callback') {
    return {
      name: 'callback',
      async send(msg) {
        await opts.onSend(msg);
      },
    };
  }
  if (provider === 'webhook') {
    if (!cfg.webhookUrl) throw new Error('SMS_WEBHOOK_URL이 필요합니다.');
    return {
      name: 'webhook',
      async send({ to, text }) {
        const res = await fetch(cfg.webhookUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(cfg.webhookToken ? { authorization: `Bearer ${cfg.webhookToken}` } : {}) },
          body: JSON.stringify({ to, from: cfg.sender || null, text }),
          signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) throw new Error(`문자 발송 서버 응답 ${res.status}`);
      },
    };
  }
  throw new Error(`알 수 없는 SMS_PROVIDER: ${provider}`);
}

module.exports = { createSms };

'use strict';
const { E } = require('../lib/errors');
const { parseDateTime, cleanText } = require('../lib/format');

// 관리자 화면 [설정]에서 바꿀 수 있는 값. 티켓은 한 종류만 운영한다.
const DEFS = {
  service_name: { def: 'APS 포인트 교환', type: 'text', max: 40, label: '서비스 이름' },
  ticket_name: { def: 'APS×FULPOT 위성 토너먼트 티켓', type: 'text', max: 60, label: '티켓 이름' },
  ticket_code: { def: 'TKT-APS-SAT', type: 'text', max: 60, label: '풀팟 티켓 코드', optional: true },
  points_per_ticket: { def: 40, type: 'int', min: 1, max: 100000, label: '티켓 1장당 포인트' },
  max_per_exchange: { def: 10, type: 'int', min: 0, max: 1000, label: '한 번에 신청할 수 있는 장수(0은 제한 없음)' },
  exchange_open: { def: true, type: 'bool', label: '교환 신청 받기' },
  ticket_terms: {
    def: '지급일로부터 30일 안에 풀팟홀덤 토너먼트 로비에서 사용할 수 있습니다.',
    type: 'text',
    max: 500,
    label: '티켓 사용 안내',
    optional: true,
  },
  payout_guide: {
    def: '신청하면 연결된 풀팟 계정으로 티켓이 바로 지급됩니다. 풀팟 응답이 늦을 때는 지급 결과를 확인한 뒤 이 화면에 알려 드립니다.',
    type: 'text',
    max: 300,
    label: '지급 안내',
    optional: true,
  },
  support_text: {
    def: '포인트 누락, 휴대폰 번호 변경, 계정 연결 문의는 APS 운영팀으로 연락해 주세요. 평일 10:00–18:00',
    type: 'text',
    max: 300,
    label: '문의 안내',
    optional: true,
  },
  points_as_of: { def: null, type: 'time', label: '포인트 자료 기준 시점' },
};

module.exports = function (s) {
  const { db } = s;

  function parse(raw) {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }

  function get(key) {
    const r = db.get('SELECT value FROM settings WHERE key = ?', key);
    return r ? parse(r.value) : DEFS[key] ? DEFS[key].def : undefined;
  }

  function all() {
    const out = {};
    for (const k of Object.keys(DEFS)) out[k] = DEFS[k].def;
    for (const r of db.all('SELECT key, value FROM settings')) if (DEFS[r.key]) out[r.key] = parse(r.value);
    return out;
  }

  function set(key, value, by) {
    db.run(
      `INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      key,
      JSON.stringify(value),
      s.clock.now(),
      by ?? null
    );
  }

  function coerce(key, value) {
    const d = DEFS[key];
    if (!d) throw E.bad(`알 수 없는 설정입니다: ${key}`);
    if (d.type === 'int') {
      const n = typeof value === 'number' ? value : Number(String(value ?? '').replace(/,/g, '').trim());
      if (!Number.isInteger(n) || n < d.min || n > d.max) throw E.bad(`${d.label}은(는) ${d.min}~${d.max} 사이 정수로 입력해 주세요.`, { field: key });
      return n;
    }
    if (d.type === 'bool') return value === true || value === 1 || value === '1' || value === 'true';
    if (d.type === 'time') {
      if (value == null || value === '') return null;
      const ms = typeof value === 'number' ? value : parseDateTime(value);
      if (ms == null) throw E.bad(`${d.label}을(를) 확인해 주세요.`, { field: key });
      return ms;
    }
    const t = cleanText(value, d.max + 1);
    if (!t && !d.optional) throw E.bad(`${d.label}을(를) 입력해 주세요.`, { field: key });
    if (t.length > d.max) throw E.bad(`${d.label}은(는) ${d.max}자 이하로 입력해 주세요.`, { field: key });
    return t;
  }

  function update(patch, by) {
    const changes = {};
    for (const [k, v] of Object.entries(patch || {})) {
      if (!DEFS[k]) continue;
      changes[k] = coerce(k, v);
    }
    db.tx(() => {
      for (const [k, v] of Object.entries(changes)) set(k, v, by);
    });
    return all();
  }

  // 회원 화면에 보여 줄 값
  function ticket() {
    const a = all();
    return {
      name: a.ticket_name,
      unitPoints: a.points_per_ticket,
      maxPerExchange: a.max_per_exchange || null,
      open: !!a.exchange_open,
      terms: a.ticket_terms,
      payoutGuide: a.payout_guide,
    };
  }

  function publicConfig() {
    const a = all();
    return {
      serviceName: a.service_name,
      supportText: a.support_text,
      pointsAsOf: a.points_as_of,
      ticket: ticket(),
      fulpotMode: s.fulpot ? s.fulpot.mode : null,
      // 개발 서버(문자 대신 콘솔 출력)일 때 인증번호 화면에서 어디를 보면 되는지 알려 준다.
      devSmsConsole: !(s.config && s.config.production) && !!s.sms && s.sms.name === 'console',
    };
  }

  // 관리자 [설정]에 보여 줄 풀팟 연동 정보(읽기 전용, .env에서 정한다)
  function fulpotInfo() {
    const f = s.fulpot;
    return f ? { mode: f.mode, label: f.label, baseUrl: f.baseUrl, timeoutSec: Math.round(f.timeoutMs / 100) / 10 } : null;
  }

  return { DEFS, get, all, set, update, ticket, publicConfig, fulpotInfo };
};

'use strict';
const { kstStartOfDay, DAY } = require('./lib/format');

/*
 * 데모 데이터: 회원 14명(같은 이름·번호 기록 1건 포함), 파일 등록 3건, 직접 등록 2건, 풀팟 연결, 상태별 교환.
 *   이형주 120P · teddy123 연결 → 바로 교환
 *   김민준 150P · 풀팟 미연결 → minjun_k를 넣으면 바로 연결
 *   박서연 39P  · 1장까지 1P 부족
 *   송하은 WEB-00001 · 관리자가 직접 등록한 회원(80P)
 *   윤태호 3장 신청이 풀팟 응답을 못 받아 '확인 필요'
 * 교환은 실제 흐름(신청 → 모의 풀팟 즉시 지급)으로 만든다. 모든 시각은 시드를 넣는 '지금'을 기준으로 잡는다.
 */
const DEMO_ADMIN = { username: 'admin', name: '운영 담당', password: 'demo-pass-2026' };
const H = 3600000;
const M = 60000;

// [회원번호, 이름, 휴대폰, 최초 잔액]
const MEMBERS = [
  ['APS-10023', '이형주', '010-1234-5678', 80],
  ['APS-10024', '김민준', '010-2222-3333', 150],
  ['APS-10025', '박서연', '010-3333-4444', 39],
  ['APS-10026', '최지훈', '010-4444-5555', 80],
  ['APS-10027', '한유진', '010-5555-6666', 200],
  ['APS-10028', '오세영', '010-6666-7777', 80],
  ['APS-10029', '정다은', '010-7777-1212', 40],
  ['APS-10030', '윤태호', '010-8888-2323', 300],
  ['APS-10032', '서지민', '010-2121-3434', 40],
  ['APS-10033', '임하늘', '010-4545-6767', 55],
  ['APS-10034', '강도윤', '010-9898-1010', 160],
  ['APS-10035', '조은비', '010-3131-4242', 20],
  ['APS-10036', '배승현', '010-5353-6464', 80],
];

function createClock() {
  let frozen = null;
  return {
    now: () => (frozen != null ? frozen : Date.now()),
    set(ms) {
      frozen = ms;
    },
    release() {
      frozen = null;
    },
  };
}

async function seedDemo(s, clock) {
  const mock = s.fulpot && s.fulpot.mock;
  if (!mock) throw new Error('데모 데이터는 모의 풀팟(FULPOT_MODE=mock)에서만 넣을 수 있습니다.');
  const T = clock.now();
  const base = kstStartOfDay(T); // 오늘 0시(한국시간)
  const at = (ms) => clock.set(Math.min(ms, T));
  const by = `${DEMO_ADMIN.name}(${DEMO_ADMIN.username})`;
  let keySeq = 0;
  const key = () => `seed-${String(++keySeq).padStart(4, '0')}-request`;
  const member = (no) => s.members.byNo(no);
  const keepBehavior = { ...mock.behavior };
  const keepLatency = mock.latency();
  mock.setLatency(0);

  try {
    at(base - 30 * DAY);
    s.auth.createAdmin(DEMO_ADMIN);

    // 1) 최초 잔액 파일 등록
    at(base - 18 * DAY + 10 * H);
    s.points.commitUpload(
      {
        fileName: 'APS_회원_잔액_0920.xlsx',
        basisAt: base - 19 * DAY + 18 * H,
        rows: MEMBERS.map(([no, name, phone, pts], i) => ({ __row: i + 2, source_ref: '최초잔액', member_no: no, name, phone, points: pts, reason: '최초 잔액' })),
      },
      by
    );
    // 같은 이름·번호로 회원번호가 둘인 예전 기록(로그인 시 운영팀 확인으로 안내)
    const dupId = s.members.insert({ memberNo: 'APS-10031', name: '최지훈', phone: '01044445555' }, base - 18 * DAY + 10 * H);
    s.points.add({ memberId: dupId, kind: 'earn', amount: 40, memo: '최초 잔액', sourceRef: '최초잔액', dedupeKey: `src:${dupId}:최초잔액`, occurredAt: base - 19 * DAY + 18 * H, by });

    // 2) 풀팟 계정 연결(회원이 직접, 즉시 연결)
    const link = async (no, fulpotId, when) => {
      at(when);
      await s.links.link(member(no), fulpotId);
    };
    await link('APS-10023', 'teddy123', base - 17 * DAY + 20 * H);
    await link('APS-10027', 'yujin_h', base - 16 * DAY + 13 * H);
    await link('APS-10028', 'seyoung5', base - 15 * DAY + 9 * H);
    await link('APS-10030', 'taeho_y', base - 15 * DAY + 22 * H);
    await link('APS-10032', 'jimin.s', base - 14 * DAY + 18 * H);
    await link('APS-10034', 'doyoon_k', base - 13 * DAY + 11 * H);
    await link('APS-10033', 'sky_lim', base - 9 * DAY + 21 * H);
    await link('APS-10029', 'dana_j', base - 6 * DAY + 19 * H);
    // 다른 사람 계정을 연결했다는 문의로 운영팀이 해제
    at(base - 5 * DAY + 11 * H);
    s.links.release(s.links.activeOf(member('APS-10029').id).id, { reason: '풀팟 계정 주인이 본인 계정이 아니라고 알려 와 연결을 해제했습니다. 본인 풀팟 ID로 다시 연결해 주세요.' }, by);

    // 3) 1주차 적립 파일
    at(base - 11 * DAY + 10 * H);
    s.points.commitUpload(
      {
        fileName: 'APS_시즌2_1주차_적립.csv',
        basisAt: base - 12 * DAY + 18 * H,
        rows: [
          { __row: 2, source_ref: 'S2-W1', member_no: 'APS-10023', name: '이형주', points: 40, earned_at: base - 12 * DAY + 15 * H, reason: 'APS 시즌2 데일리 리그 1주차' },
          { __row: 3, source_ref: 'S2-W1', member_no: 'APS-10036', name: '배승현', points: 40, earned_at: base - 12 * DAY + 15 * H, reason: 'APS 시즌2 데일리 리그 1주차' },
          { __row: 4, source_ref: 'S2-W1', member_no: 'APS-10030', name: '윤태호', points: 60, earned_at: base - 12 * DAY + 15 * H, reason: 'APS 시즌2 데일리 리그 1주차 입상' },
        ],
      },
      by
    );

    // 4) 교환: 신청 즉시 모의 풀팟 지급
    const exchange = async (no, qty, when, issue = 'ok') => {
      at(when);
      mock.behavior.issue = issue;
      const out = await s.exchanges.create(member(no), { quantity: qty, requestKey: key() });
      mock.behavior.issue = 'ok';
      return out.exchange;
    };
    const idOf = (exNo) => s.db.get('SELECT id FROM exchanges WHERE exchange_no = ?', exNo).id;

    await exchange('APS-10023', 1, base - 10 * DAY + 21 * H); // 지급 완료
    await exchange('APS-10034', 2, base - 8 * DAY + 13 * H); // 지급 완료
    await exchange('APS-10028', 1, base - 6 * DAY + 20 * H); // 이용 제한 계정 → 풀팟 거절 → 지급 실패
    // 풀팟 점검 중 신청 → 응답 없음 → 확인 필요 → 운영팀이 기록을 확인하고 실패 처리
    const e4 = await exchange('APS-10032', 1, base - 3 * DAY + 14 * H, 'down');
    at(base - 3 * DAY + 15 * H);
    await s.exchanges.act(idOf(e4.no), 'fail', { reason: '풀팟 점검 시간에 신청되어 티켓을 지급하지 못했습니다. 포인트는 돌려 드렸으니 다시 신청해 주세요.' }, by);

    // 5) 2주차 적립 파일(어제 18시 기준 자료)
    at(base - 1 * DAY + 19 * H);
    s.points.commitUpload(
      {
        fileName: 'APS_시즌2_2주차_적립.xlsx',
        basisAt: base - 1 * DAY + 18 * H,
        rows: [
          { __row: 2, source_ref: 'S2-W2', member_no: 'APS-10023', name: '이형주', points: 40, earned_at: base - 5 * DAY + 15 * H, reason: 'APS 시즌2 데일리 리그 2주차' },
          { __row: 3, source_ref: 'S2-W2', member_no: 'APS-10033', name: '임하늘', points: 40, earned_at: base - 5 * DAY + 15 * H, reason: 'APS 시즌2 데일리 리그 2주차' },
          { __row: 4, source_ref: 'S2-W2', member_no: 'APS-10027', name: '한유진', points: 40, earned_at: base - 5 * DAY + 15 * H, reason: 'APS 시즌2 데일리 리그 2주차' },
        ],
      },
      by
    );

    // 6) 관리자 직접 등록: 새 회원(내부 번호 WEB-00001)과 기존 회원 지급
    at(base - 1 * DAY + 20 * H);
    s.members.register({ name: '송하은', phone: '010-2468-1357', points: 80, reason: 'APS 서울 위성전 현장 참가', requestKey: key() }, by);
    at(base - 1 * DAY + 20 * H + 6 * M);
    s.members.register({ memberId: member('APS-10035').id, points: 20, reason: 'APS 서울 위성전 현장 이벤트', requestKey: key() }, by);

    await exchange('APS-10027', 2, base - 1 * DAY + 22 * H); // 지급 완료
    // 풀팟 응답을 받지 못한 신청: 확인 필요로 남는다(모의 풀팟에도 지급 기록 없음)
    const waiting = await exchange('APS-10030', 3, T - 25 * M, 'down');
    at(T - 12 * M);
    await s.exchanges.checkIssues();
    return { admin: DEMO_ADMIN, waiting: waiting.no };
  } finally {
    Object.assign(mock.behavior, keepBehavior);
    mock.setLatency(keepLatency);
    clock.release();
  }
}

module.exports = { seedDemo, createClock, DEMO_ADMIN, MEMBERS };

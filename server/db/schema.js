'use strict';

/*
 * 테이블 구성 (간편 버전 2.x)
 *   members        APS 회원(회원번호·이름·휴대폰). 직접 등록한 회원은 내부 번호 WEB-00001부터
 *   ledger         포인트 원장: 적립·조정·교환 차감이 한 줄씩 쌓인다. 총 보유 = 합계
 *   exchanges      티켓 교환. 신청 즉시 풀팟에 지급을 요청한다. 지급 중·확인 필요 상태의 포인트 합계가 '사용 대기'
 *   links          풀팟 계정 연결(풀팟에서 확인된 계정이면 바로 연결)과 해제 기록
 *   registrations  관리자 직접 등록 기록(새 회원 등록, 기존 회원 지급)
 *   otp_codes      문자 인증번호(해시로만 저장)
 *   member_sessions, admins, admin_sessions, uploads, settings
 */
const VERSION = 2;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER,
  updated_by TEXT
);

CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  last_login_at INTEGER
);

CREATE TABLE IF NOT EXISTS admin_sessions (
  id INTEGER PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  admin_id INTEGER NOT NULL REFERENCES admins(id),
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE TABLE IF NOT EXISTS members (
  id INTEGER PRIMARY KEY,
  member_no TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL,
  phone TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'stopped')),
  memo TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_login_at INTEGER
);
CREATE INDEX IF NOT EXISTS ix_members_phone ON members(phone);

CREATE TABLE IF NOT EXISTS otp_codes (
  id INTEGER PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  phone TEXT NOT NULL,
  name_key TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  sent INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,
  verified_at INTEGER,
  invalidated_at INTEGER,
  ip TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_otp_phone ON otp_codes(phone, created_at);
CREATE INDEX IF NOT EXISTS ix_otp_ip ON otp_codes(ip, created_at);

CREATE TABLE IF NOT EXISTS member_sessions (
  id INTEGER PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  member_id INTEGER NOT NULL REFERENCES members(id),
  phone TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE TABLE IF NOT EXISTS links (
  id INTEGER PRIMARY KEY,
  member_id INTEGER NOT NULL REFERENCES members(id),
  fulpot_id TEXT NOT NULL,
  fulpot_key TEXT NOT NULL,
  fulpot_uid TEXT NOT NULL,
  nickname TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'released')),
  linked_at INTEGER NOT NULL,
  released_at INTEGER,
  release_kind TEXT CHECK (release_kind IN ('changed', 'admin')),
  release_reason TEXT,
  released_by TEXT
);
-- 한 회원에 연결 하나, 한 풀팟 계정(ID·내부 번호)에 회원 한 명
CREATE UNIQUE INDEX IF NOT EXISTS ux_links_member_active ON links(member_id) WHERE status = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS ux_links_key_active ON links(fulpot_key) WHERE status = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS ux_links_uid_active ON links(fulpot_uid) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS ix_links_member ON links(member_id, id);

CREATE TABLE IF NOT EXISTS exchanges (
  id INTEGER PRIMARY KEY,
  exchange_no TEXT NOT NULL UNIQUE,
  member_id INTEGER NOT NULL REFERENCES members(id),
  request_key TEXT NOT NULL,
  ticket_name TEXT NOT NULL,
  ticket_code TEXT,
  unit_points INTEGER NOT NULL CHECK (unit_points > 0),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  total_points INTEGER NOT NULL CHECK (total_points > 0),
  fulpot_id TEXT NOT NULL,
  fulpot_uid TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('issuing', 'completed', 'failed', 'check')),
  payout_ref TEXT,
  reason TEXT,
  note TEXT,
  attempts INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  requested_at INTEGER NOT NULL,
  checked_at INTEGER,
  completed_at INTEGER,
  closed_at INTEGER,
  recheck_until INTEGER,
  handled_by TEXT,
  UNIQUE (member_id, request_key)
);
CREATE INDEX IF NOT EXISTS ix_exchanges_member ON exchanges(member_id, id);
CREATE INDEX IF NOT EXISTS ix_exchanges_status ON exchanges(status, id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_exchanges_payout_ref ON exchanges(payout_ref) WHERE payout_ref IS NOT NULL;

CREATE TABLE IF NOT EXISTS ledger (
  id INTEGER PRIMARY KEY,
  member_id INTEGER NOT NULL REFERENCES members(id),
  kind TEXT NOT NULL CHECK (kind IN ('earn', 'adjust', 'use')),
  amount INTEGER NOT NULL CHECK (amount <> 0),
  memo TEXT,
  source_ref TEXT,
  dedupe_key TEXT UNIQUE,
  exchange_id INTEGER REFERENCES exchanges(id),
  upload_id INTEGER,
  occurred_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  created_by TEXT
);
CREATE INDEX IF NOT EXISTS ix_ledger_member ON ledger(member_id, occurred_at);

CREATE TABLE IF NOT EXISTS uploads (
  id INTEGER PRIMARY KEY,
  file_name TEXT,
  total_rows INTEGER NOT NULL,
  applied_rows INTEGER NOT NULL,
  applied_points INTEGER NOT NULL,
  new_members INTEGER NOT NULL,
  skipped_rows INTEGER NOT NULL,
  basis_at INTEGER,
  created_at INTEGER NOT NULL,
  created_by TEXT
);

CREATE TABLE IF NOT EXISTS registrations (
  id INTEGER PRIMARY KEY,
  request_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('created', 'granted')),
  member_id INTEGER NOT NULL REFERENCES members(id),
  points INTEGER NOT NULL DEFAULT 0,
  reason TEXT,
  created_at INTEGER NOT NULL,
  created_by TEXT
);
`;

const OLD_DB_MESSAGE =
  '이전 버전(1.x)의 DB입니다. 2.x는 즉시 지급·즉시 연결로 DB 구조가 바뀌어 이 파일을 그대로 쓸 수 없습니다. ' +
  '개발용 DB는 npm run seed:demo -- --reset 으로 다시 만들고, 운영 DB는 새 DB_PATH로 시작한 뒤 회원·포인트를 다시 등록해 주세요.';

function migrate(db) {
  const row = db.get('PRAGMA user_version');
  const version = row ? Number(Object.values(row)[0]) || 0 : 0;
  if (version > VERSION) throw new Error(`이 프로그램보다 새 버전의 DB입니다(DB ${version}, 프로그램 ${VERSION}).`);
  if (version < VERSION) {
    // 1.x의 교환 테이블에는 풀팟 내부 번호(fulpot_uid)가 없다.
    const old = db.get("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'exchanges'");
    if (old && !/fulpot_uid/.test(old.sql)) throw new Error(OLD_DB_MESSAGE);
  }
  db.exec(SCHEMA);
  if (version !== VERSION) db.exec(`PRAGMA user_version = ${VERSION}`);
}

module.exports = { migrate, VERSION };

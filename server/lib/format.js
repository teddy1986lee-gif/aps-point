'use strict';
// 전화번호·이름·한국시간(KST)·포인트 값 정리 함수. 서버와 브라우저 데모가 함께 쓴다.

const KST = 9 * 3600 * 1000;
const DAY = 86400000;

const pad = (n, w = 2) => String(n).padStart(w, '0');

// 엑셀에서 앞자리 0이 빠진 번호(1012345678), +82 표기, 하이픈·공백을 모두 01012345678 형태로 맞춘다.
function normalizePhone(input) {
  if (input == null) return null;
  let s = String(input).trim();
  if (!s) return null;
  s = s.replace(/[\s\-().]/g, '');
  if (s.startsWith('+82')) s = '0' + s.slice(3);
  s = s.replace(/\D/g, '');
  if (s.startsWith('82') && (s.length === 11 || s.length === 12)) s = '0' + s.slice(2);
  if (s.length === 10 && s.startsWith('1')) s = '0' + s;
  return /^01[016789]\d{7,8}$/.test(s) ? s : null;
}

function formatPhone(p) {
  if (!p) return '';
  if (p.length === 11) return `${p.slice(0, 3)}-${p.slice(3, 7)}-${p.slice(7)}`;
  if (p.length === 10) return `${p.slice(0, 3)}-${p.slice(3, 6)}-${p.slice(6)}`;
  return p;
}

function maskPhone(p) {
  if (!p) return '';
  const f = formatPhone(p);
  return f.replace(/^(\d{3})-(\d{3,4})-(\d{4})$/, (_, a, b, c) => `${a}-${'*'.repeat(b.length)}-${c}`);
}

function cleanText(v, max = 200) {
  if (v == null) return '';
  return String(v).normalize('NFC').replace(/\s+/g, ' ').trim().slice(0, max);
}

// 회원 대조용 이름 키: 공백 제거, 대소문자 무시
function nameKey(name) {
  return String(name || '').normalize('NFC').replace(/\s+/g, '').toLowerCase();
}

function parsePoints(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isInteger(v) ? v : null;
  const s = String(v).replace(/[,\s]/g, '').replace(/(p|P|점|포인트)$/, '');
  if (!/^[-+]?\d+$/.test(s)) return null;
  const n = parseInt(s, 10);
  return Number.isSafeInteger(n) ? n : null;
}

// ---- 한국시간 ----
function kstParts(ms) {
  const d = new Date(ms + KST);
  return {
    y: d.getUTCFullYear(),
    mo: d.getUTCMonth() + 1,
    d: d.getUTCDate(),
    h: d.getUTCHours(),
    mi: d.getUTCMinutes(),
    s: d.getUTCSeconds(),
  };
}

function kstFromParts(y, mo, d, h = 0, mi = 0, s = 0) {
  const ms = Date.UTC(y, mo - 1, d, h, mi, s) - KST;
  const p = kstParts(ms);
  if (p.y !== y || p.mo !== mo || p.d !== d || p.h !== h || p.mi !== mi) return null;
  return ms;
}

function kstDateKey(ms) {
  const p = kstParts(ms);
  return `${p.y}-${pad(p.mo)}-${pad(p.d)}`;
}

function kstStartOfDay(ms) {
  const p = kstParts(ms);
  return Date.UTC(p.y, p.mo - 1, p.d) - KST;
}

function kstNextMidnight(ms) {
  return kstStartOfDay(ms) + DAY;
}

function fmtKst(ms) {
  if (ms == null) return '';
  const p = kstParts(ms);
  return `${p.y}-${pad(p.mo)}-${pad(p.d)} ${pad(p.h)}:${pad(p.mi)}`;
}

// 엑셀 일련번호(예: 46302.75)를 한국시간 기준으로 바꾼다.
function fromExcelSerial(n) {
  const wall = Math.round((n - 25569) * DAY);
  return wall - KST;
}

/**
 * 날짜·시각 문자열을 KST 기준 ms로 읽는다.
 * 허용: 2026-10-07, 2026.10.07, 2026/10/07, 20261007, 2026년 10월 7일, 뒤에 18:00(:00) 또는 18시(30분)
 * dateOnly 값은 opts.endOfDay가 true면 그날이 끝나는 시점(다음날 0시), 아니면 0시로 본다.
 */
function parseDateTime(v, opts = {}) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') {
    if (v > 1e11) return v;
    if (Number.isInteger(v) && v >= 19000101 && v <= 21001231) return parseDateTime(String(v), opts);
    if (v > 1 && v < 100000) return finishDate(fromExcelSerial(v), Number.isInteger(v), opts);
    return null;
  }
  const s = String(v).trim();
  if (!s) return null;
  if (/^\d{5}(\.\d+)?$/.test(s)) return parseDateTime(Number(s), opts);
  let m = /^(\d{4})[-./](\d{1,2})[-./](\d{1,2})\.?(?:[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
  if (!m) m = /^(\d{4})(\d{2})(\d{2})(?:[ T]?(\d{2}):?(\d{2})(?::?(\d{2}))?)?$/.exec(s);
  if (!m) {
    const k = /^(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일(?:\s*(\d{1,2})시(?:\s*(\d{1,2})분)?)?$/.exec(s);
    if (k) m = [k[0], k[1], k[2], k[3], k[4], k[4] != null ? k[5] || '0' : undefined, undefined];
  }
  if (m) {
    const hasTime = m[4] != null;
    const ms = kstFromParts(+m[1], +m[2], +m[3], hasTime ? +m[4] : 0, hasTime ? +m[5] : 0, m[6] ? +m[6] : 0);
    if (ms == null) return null;
    return finishDate(ms, !hasTime, opts);
  }
  if (/^\d{4}-\d{2}-\d{2}T.*(Z|[+-]\d{2}:?\d{2})$/.test(s)) {
    const t = Date.parse(s);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

function finishDate(ms, dateOnly, opts) {
  if (dateOnly && opts.endOfDay) return kstNextMidnight(ms);
  return ms;
}

// 관리자 화면의 기간 필터(YYYY-MM-DD)를 [시작, 끝) 범위로 바꾼다.
function dayRange(from, to, fallbackDays, now) {
  const start = from ? parseDateTime(from) : kstStartOfDay(now) - (fallbackDays - 1) * DAY;
  const end = to ? parseDateTime(to, { endOfDay: true }) : kstNextMidnight(now);
  return { start: start ?? kstStartOfDay(now), end: end ?? kstNextMidnight(now) };
}

function likeEscape(q) {
  return String(q).replace(/[\\%_]/g, (c) => '\\' + c);
}

module.exports = {
  KST,
  DAY,
  normalizePhone,
  formatPhone,
  maskPhone,
  cleanText,
  nameKey,
  parsePoints,
  kstParts,
  kstFromParts,
  kstDateKey,
  kstStartOfDay,
  kstNextMidnight,
  fmtKst,
  parseDateTime,
  dayRange,
  likeEscape,
};

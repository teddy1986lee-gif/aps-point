'use strict';
const { E } = require('./errors');

function str(v, { label, field, min = 1, max = 200, required = true, pattern, patternMessage } = {}) {
  const s = v == null ? '' : String(v).normalize('NFC').trim();
  if (!s) {
    if (required) throw E.bad(`${label}을(를) 입력해 주세요.`, { field });
    return null;
  }
  if (s.length < min) throw E.bad(`${label}은(는) ${min}자 이상 입력해 주세요.`, { field });
  if (s.length > max) throw E.bad(`${label}은(는) ${max}자 이하로 입력해 주세요.`, { field });
  if (pattern && !pattern.test(s)) throw E.bad(patternMessage || `${label} 형식을 확인해 주세요.`, { field });
  return s;
}

function int(v, { label, field, min = -Infinity, max = Infinity, required = true } = {}) {
  if (v == null || v === '') {
    if (required) throw E.bad(`${label}을(를) 입력해 주세요.`, { field });
    return null;
  }
  const n = typeof v === 'number' ? v : Number(String(v).replace(/,/g, '').trim());
  if (!Number.isInteger(n)) throw E.bad(`${label}은(는) 정수로 입력해 주세요.`, { field });
  if (n < min) throw E.bad(`${label}은(는) ${min} 이상이어야 합니다.`, { field });
  if (n > max) throw E.bad(`${label}은(는) ${max} 이하여야 합니다.`, { field });
  return n;
}

function oneOf(v, list, { label, field } = {}) {
  if (!list.includes(v)) throw E.bad(`${label} 값을 확인해 주세요.`, { field });
  return v;
}

function bool(v) {
  return v === true || v === 1 || v === '1' || v === 'true';
}

module.exports = { str, int, oneOf, bool };

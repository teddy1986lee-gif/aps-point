/* 사용자 화면·관리자 화면 공통 도구: HTML 이스케이프, 한국시간 표시, API 호출 */
(function (global) {
  'use strict';

  // ---- 안전한 HTML 조립: 값은 자동 이스케이프, raw()만 그대로 ----
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);
  function Raw(s) {
    this.s = s;
  }
  Raw.prototype.toString = function () {
    return this.s;
  };
  const raw = (s) => new Raw(String(s));
  function render(v) {
    if (v == null || v === false || v === true) return '';
    if (v instanceof Raw) return v.s;
    if (Array.isArray(v)) return v.map(render).join('');
    return esc(v);
  }
  function html(strings, ...vals) {
    let out = strings[0];
    for (let i = 0; i < vals.length; i++) out += render(vals[i]) + strings[i + 1];
    return new Raw(out);
  }

  // ---- 한국시간 표시 ----
  const KST = 9 * 3600000;
  const pad = (n) => String(n).padStart(2, '0');
  function parts(ms) {
    const d = new Date(Number(ms) + KST);
    return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), w: d.getUTCDay() };
  }
  const WD = ['일', '월', '화', '수', '목', '금', '토'];
  const fmt = {
    points: (n) => (n == null ? '-' : Number(n).toLocaleString('ko-KR') + 'P'),
    num: (n) => (n == null ? '-' : Number(n).toLocaleString('ko-KR')),
    signed: (n) => (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(Number(n)).toLocaleString('ko-KR') + 'P',
    date(ms) {
      if (ms == null) return '-';
      const p = parts(ms);
      return `${p.y}.${pad(p.m)}.${pad(p.d)}`;
    },
    dateTime(ms) {
      if (ms == null) return '-';
      const p = parts(ms);
      return `${p.y}.${pad(p.m)}.${pad(p.d)} ${pad(p.h)}:${pad(p.mi)}`;
    },
    short(ms) {
      if (ms == null) return '-';
      const p = parts(ms);
      const n = parts(Date.now());
      return p.y === n.y ? `${pad(p.m)}.${pad(p.d)} ${pad(p.h)}:${pad(p.mi)}` : `${p.y}.${pad(p.m)}.${pad(p.d)}`;
    },
    // 0시 정각이면 날짜만, 아니면 날짜와 시각
    smart(ms) {
      if (ms == null) return '-';
      const p = parts(ms);
      return p.h === 0 && p.mi === 0 ? `${p.y}.${pad(p.m)}.${pad(p.d)}` : `${p.y}.${pad(p.m)}.${pad(p.d)} ${pad(p.h)}:${pad(p.mi)}`;
    },
    asOf(ms) {
      if (ms == null) return '아직 없음';
      const p = parts(ms);
      return `${p.y}년 ${p.m}월 ${p.d}일 ${p.h}시${p.mi ? ` ${p.mi}분` : ''}`;
    },
    day(ms) {
      if (ms == null) return '-';
      const p = parts(ms);
      return `${p.m}월 ${p.d}일 (${WD[p.w]})`;
    },
    relative(ms, now = Date.now()) {
      const diff = Math.round((now - ms) / 60000);
      if (diff < 1) return '방금';
      if (diff < 60) return `${diff}분 전`;
      if (diff < 24 * 60) return `${Math.floor(diff / 60)}시간 전`;
      return `${Math.floor(diff / 1440)}일 전`;
    },
    minutes(min) {
      if (min == null) return '-';
      if (min < 60) return `${min}분`;
      const h = Math.floor(min / 60);
      return min % 60 ? `${h}시간 ${min % 60}분` : `${h}시간`;
    },
    // <input type="date"> / datetime-local 값 ↔ ms (한국시간)
    dayInput(ms) {
      if (ms == null) return '';
      const p = parts(ms);
      return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
    },
    dateTimeInput(ms) {
      if (ms == null) return '';
      const p = parts(ms);
      return `${p.y}-${pad(p.m)}-${pad(p.d)}T${pad(p.h)}:${pad(p.mi)}`;
    },
    parseInput(v) {
      if (!v) return null;
      const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/.exec(v);
      if (!m) return null;
      return Date.UTC(+m[1], +m[2] - 1, +m[3], m[4] ? +m[4] : 0, m[5] ? +m[5] : 0) - KST;
    },
    phoneInput(v) {
      const d = String(v).replace(/\D/g, '').slice(0, 11);
      if (d.length < 4) return d;
      if (d.length < 8) return `${d.slice(0, 3)}-${d.slice(3)}`;
      if (d.length === 10) return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
      return `${d.slice(0, 3)}-${d.slice(3, 7)}-${d.slice(7)}`;
    },
  };

  // ---- API ----
  class ApiError extends Error {
    constructor(status, code, message, details) {
      super(message);
      this.status = status;
      this.code = code;
      this.details = details;
    }
  }

  function createApi(transport) {
    async function call(method, path, body) {
      const res = await transport({ method, path, body });
      if (res.status >= 200 && res.status < 300) return res.data;
      const e = (res.data && res.data.error) || { code: 'HTTP_' + res.status, message: '요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.' };
      throw new ApiError(res.status, e.code, e.message, e.details);
    }
    return {
      get: (p) => call('GET', p),
      post: (p, b) => call('POST', p, b || {}),
      put: (p, b) => call('PUT', p, b || {}),
      del: (p) => call('DELETE', p),
      file: (p) => transport({ method: 'GET', path: p, raw: true }),
    };
  }

  function fetchTransport() {
    return async ({ method, path, body, raw: wantRaw }) => {
      let res;
      try {
        res = await fetch(path, {
          method,
          credentials: 'same-origin',
          headers: { 'x-requested-with': 'aps-web', ...(body ? { 'content-type': 'application/json' } : {}) },
          body: body ? JSON.stringify(body) : undefined,
        });
      } catch {
        return { status: 0, data: { error: { code: 'NETWORK', message: '인터넷 연결을 확인한 뒤 다시 시도해 주세요.' } } };
      }
      const type = res.headers.get('content-type') || '';
      if (wantRaw || !type.includes('application/json')) {
        return { status: res.status, data: await res.text(), headers: { 'content-type': type, 'content-disposition': res.headers.get('content-disposition') || '' } };
      }
      let data = null;
      try {
        data = await res.json();
      } catch {
        data = null;
      }
      return { status: res.status, data };
    };
  }

  function uuid() {
    if (global.crypto && global.crypto.randomUUID) return global.crypto.randomUUID();
    const b = new Uint8Array(16);
    global.crypto.getRandomValues(b);
    return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  }

  function qs(obj) {
    const p = Object.entries(obj || {}).filter(([, v]) => v != null && v !== '');
    return p.length ? '?' + p.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&') : '';
  }

  // 화면 라우터: 실제 페이지는 주소의 #, 데모는 메모리(두 앱이 한 페이지에 있으므로)
  function createNav(mode, onChange) {
    let current = '';
    const stack = [];
    const read = () => decodeURIComponent((global.location.hash || '').replace(/^#\/?/, ''));
    if (mode === 'hash') {
      global.addEventListener('hashchange', () => {
        current = read();
        onChange(current);
      });
    }
    return {
      get: () => (mode === 'hash' ? read() : current),
      go(route, { replace = false } = {}) {
        if (mode === 'hash') {
          const target = '#/' + route;
          if (global.location.hash === target) onChange(route);
          else if (replace) {
            global.history.replaceState(null, '', target);
            onChange(route);
          } else global.location.hash = target;
          return;
        }
        if (!replace && current) stack.push(current);
        current = route;
        onChange(route);
      },
      back(fallback) {
        if (mode === 'hash' && global.history.length > 1) return global.history.back();
        const prev = stack.pop();
        this.go(prev || fallback, { replace: true });
      },
    };
  }

  // 교환 상태: 회원 화면용과 관리자 화면용 이름이 조금 다르다(확인 필요 = 회원에게는 '지급 확인 중').
  const EXCHANGE = {
    issuing: { label: '지급 중', tone: 'info' },
    check: { label: '지급 확인 중', tone: 'warn' },
    completed: { label: '지급 완료', tone: 'ok' },
    failed: { label: '지급 실패', tone: 'danger' },
  };
  const EXCHANGE_ADMIN = {
    issuing: { label: '지급 요청 중', tone: 'info' },
    check: { label: '확인 필요', tone: 'warn' },
    completed: { label: '지급 완료', tone: 'ok' },
    failed: { label: '지급 실패', tone: 'danger' },
  };
  const PENDING = ['issuing', 'check'];
  const LINK = {
    active: { label: '연결됨', tone: 'ok' },
    released: { label: '해제됨', tone: 'muted' },
  };
  const LEDGER = { earn: '적립', adjust: '조정', use: '티켓 교환' };

  // 폼 제출을 브라우저 기본 동작에 맡기지 않는다.
  // 앱 안 파일 미리보기·임베드처럼 폼 제출이 막힌 곳(sandbox에 allow-forms 없음)에서는 submit 이벤트가 아예 오지 않아
  // 버튼이 눌러도 아무 일이 없다. 그래서 제출 버튼 클릭과 Enter 키를 직접 받아 handler(form, submitter)를 부른다.
  // 한글 입력 중(조합 중) Enter는 글자를 확정할 뿐 제출하지 않는다(브라우저 기본 동작과 같게).
  const NO_IMPLICIT = { checkbox: 1, radio: 1, file: 1, button: 1, submit: 1, reset: 1, image: 1, hidden: 1, range: 1, color: 1 };
  function bindForms(root, handler) {
    const ours = (form) => !!form && form.hasAttribute('data-form') && root.contains(form);
    const submitterOf = (form) => form.querySelector('button[type="submit"], input[type="submit"]');
    root.addEventListener('click', (ev) => {
      const b = ev.target.closest && ev.target.closest('button[type="submit"], input[type="submit"]');
      if (!b || !root.contains(b) || !ours(b.form)) return;
      ev.preventDefault();
      if (!b.disabled) handler(b.form, b);
    });
    root.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter' || ev.isComposing || ev.keyCode === 229 || ev.shiftKey || ev.altKey || ev.ctrlKey || ev.metaKey) return;
      const el = ev.target;
      if (!el || el.tagName !== 'INPUT' || NO_IMPLICIT[el.type] || !ours(el.form)) return;
      ev.preventDefault();
      const b = submitterOf(el.form);
      if (b && b.disabled) return;
      handler(el.form, b);
    });
    // 코드에서 requestSubmit()을 부르는 경우 등 실제 submit 이벤트가 오면 같은 처리로
    root.addEventListener('submit', (ev) => {
      const form = ev.target;
      if (!ours(form)) return;
      ev.preventDefault();
      handler(form, ev.submitter || submitterOf(form));
    });
  }

  // 키보드로 입력 중인 칸이 있는지: 자동 새로고침이 입력을 지우지 않게 할 때 쓴다.
  function typing(root) {
    const a = global.document.activeElement;
    return !!(a && root.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) && a.type !== 'checkbox' && a.type !== 'button' && a.type !== 'submit');
  }

  global.APSUI = { html, raw, esc, fmt, ApiError, createApi, fetchTransport, uuid, qs, createNav, EXCHANGE, EXCHANGE_ADMIN, PENDING, LINK, LEDGER, typing, bindForms };
})(window);

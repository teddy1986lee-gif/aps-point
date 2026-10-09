/* 데모 구동: sql.js 위에 서버 앱(모의 풀팟 포함)을 띄우고, 회원 웹사이트와 관리자 페이지를 같은 페이지에 붙인다. */
(function () {
  'use strict';
  const C = window.APSDemoCore;
  const U = window.APSUI;
  const { html } = U;
  const KEY = 'aps-web-demo:v2'; // 2.x는 DB 구조가 달라 1.x 저장본과 섞지 않는다
  const CHECK_MS = 30000; // 실제 서버는 1분마다, 데모는 30초마다 '확인 필요' 지급을 조회한다
  const $ = (s, r = document) => r.querySelector(s);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const store = {
    get(k) {
      try {
        return window.localStorage.getItem(`${KEY}:${k}`);
      } catch {
        return null;
      }
    },
    set(k, v) {
      try {
        window.localStorage.setItem(`${KEY}:${k}`, v);
      } catch {
        /* 저장이 막힌 브라우저: 새로고침하면 처음 상태로 시작 */
      }
    },
    del(k) {
      try {
        window.localStorage.removeItem(`${KEY}:${k}`);
      } catch {
        /* 무시 */
      }
    },
  };
  const KEYS = ['db', 'jars', 'fulpot'];

  const PEOPLE = [
    ['이형주', '010-1234-5678', '120P · 바로 교환'],
    ['김민준', '010-2222-3333', '풀팟 미연결'],
    ['박서연', '010-3333-4444', '1장까지 1P 부족'],
    ['송하은', '010-2468-1357', '직접 등록 회원'],
    ['최지훈', '010-4444-5555', '같은 기록 2건'],
  ];

  const CONFIG = {
    secret: 'aps-web-demo-secret',
    secureCookies: false,
    exposeOtp: false,
    otp: { ttlSec: 180, resendSec: 20, maxAttempts: 5, maxPerPhoneHour: 60, maxPerPhoneDay: 200, maxPerIpHour: 1000 },
    session: { memberHours: 12, adminHours: 12, adminIdleMinutes: 120 },
  };

  let SQL = null;
  let env = null;
  let siteRoot = $('#dw-site');
  let adminRoot = $('#dw-admin');
  let lastCode = null;
  let smsTimer = null;
  let smsCount = 0;
  let tipTimer = null;
  let saveTimer = null;
  let checkTimer = null;
  const refreshTimers = {};

  // ---------- 저장 ----------
  function toB64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function fromB64(b64) {
    const s = atob(b64);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }
  function loadSaved() {
    const db = store.get('db');
    if (!db) return null;
    try {
      return { bytes: fromB64(db), jars: JSON.parse(store.get('jars') || 'null'), fulpot: JSON.parse(store.get('fulpot') || 'null') };
    } catch {
      return null;
    }
  }
  function save() {
    if (!env) return;
    try {
      store.set('db', toB64(env.db.exportBytes()));
      store.set('jars', JSON.stringify(env.jars));
      store.set('fulpot', JSON.stringify(env.fulpot.mock.exportState()));
    } catch (e) {
      console.warn('데모 상태를 저장하지 못했습니다.', e);
    }
  }
  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 600);
  }

  // ---------- 서버 연결(브라우저 안) ----------
  function makeTransport(jar, ip, who) {
    return async ({ method, path, body }) => {
      const [p, qs] = String(path).split('?');
      const smsBefore = smsCount;
      const res = await env.app.handle({
        method,
        path: p,
        query: Object.fromEntries(new URLSearchParams(qs || '')),
        headers: { 'x-requested-with': 'aps-web' },
        cookies: { ...jar },
        body: body === undefined ? undefined : JSON.parse(JSON.stringify(body)),
        ip,
      });
      for (const c of res.cookies) {
        if (c.maxAge === 0 || c.value === '') delete jar[c.name];
        else jar[c.name] = c.value;
      }
      if (method !== 'GET') afterMutation(who);
      if (p === '/api/auth/otp' && res.status === 200 && smsCount === smsBefore) {
        showTip('체험판 회원 기록에 없는 이름·휴대폰 번호라 문자를 보내지 않았습니다(실제 서비스도 같습니다). 위쪽 체험 회원 버튼을 누르거나 그 이름·번호를 그대로 넣어 보세요.');
      }
      return { status: res.status, data: JSON.parse(res.body) };
    };
  }

  function refreshPane(which) {
    clearTimeout(refreshTimers[which]);
    refreshTimers[which] = setTimeout(() => {
      const inst = which === 'site' ? env.site : env.admin;
      if (inst) inst.refresh();
    }, 300);
  }

  function afterMutation(who) {
    scheduleSave();
    updateCount();
    refreshPane(who === 'site' ? 'admin' : 'site');
  }

  // 실제 서버의 1분 정기 작업과 같은 일: 멈춘 요청 정리, '확인 필요' 지급의 풀팟 기록 조회
  async function runCheck() {
    if (!env) return;
    try {
      const r = await env.app.checkIssues();
      if (r && (r.moved || r.completed || r.corrected)) {
        scheduleSave();
        updateCount();
        refreshPane('site');
        refreshPane('admin');
      }
    } catch (e) {
      console.warn('지급 확인 작업 오류', e);
    }
  }

  function updateCount() {
    if (!env) return;
    const n = env.app.services.exchanges.checkCount();
    const el = $('[data-count]');
    el.textContent = n;
    el.hidden = !n;
    el.setAttribute('aria-label', `확인 필요 ${n}건`);
  }

  function freshRoot(el) {
    const n = document.createElement('div');
    n.id = el.id;
    el.replaceWith(n);
    return n;
  }

  function sampleRows() {
    const day = C.kstDateKey(Date.now());
    const r = 'APS 시즌2 데일리 리그 3주차';
    return [
      { __row: 2, member_no: 'APS-10023', name: '이형주', points: 40, source_ref: 'S2-W3', earned_at: day, reason: r },
      { __row: 3, member_no: 'APS-10025', name: '박서연', points: 40, source_ref: 'S2-W3', earned_at: day, reason: r },
      { __row: 4, member_no: 'APS-10024', name: '김민주', points: 40, source_ref: 'S2-W3', earned_at: day, reason: r },
      { __row: 5, member_no: 'APS-10041', name: '송하은', phone: '010-2468-1357', points: 80, source_ref: 'S2-W3', earned_at: day, reason: r + ' 입상' },
      { __row: 6, member_no: 'APS-10023', name: '이형주', points: 40, source_ref: 'S2-W2', earned_at: day, reason: 'APS 시즌2 데일리 리그 2주차' },
    ];
  }

  function setUrl(which, route) {
    const el = $(`[data-url="${which}"]`);
    if (which === 'site') el.textContent = route === 'login' ? 'aps-points.example/' : `aps-points.example/#/${route}`;
    else el.textContent = route === 'login' ? 'aps-points.example/admin/' : `aps-points.example/admin/#/${route}`;
    const win = $(which === 'site' ? '#dw-pane-site' : '#dw-pane-admin');
    const top = win.getBoundingClientRect().top;
    if (top < 0) window.scrollBy({ top, behavior: 'auto' });
  }

  function mountApps() {
    siteRoot = freshRoot(siteRoot);
    adminRoot = freshRoot(adminRoot);
    env.siteTransport = makeTransport(env.jars.site, '203.0.113.7', 'site');
    env.adminTransport = makeTransport(env.jars.admin, '198.51.100.20', 'admin');
    env.site = window.APSSite.mount(siteRoot, { transport: env.siteTransport, routing: 'memory', onRoute: (r) => setUrl('site', r) });
    env.admin = window.APSAdmin.mount(adminRoot, {
      transport: env.adminTransport,
      routing: 'memory',
      download: showDownload,
      sampleRows,
      sampleName: '예시_시즌2_3주차_적립.csv',
      onRoute: (r) => setUrl('admin', r),
    });
    updateCount();
  }

  async function start(saved) {
    const clock = C.createClock();
    const db = C.openSqlJsDb(SQL, saved ? saved.bytes : undefined);
    C.migrate(db);
    const sms = C.createSms({ provider: 'callback' }, { onSend: onSms });
    const fulpot = C.createFulpot({ mode: 'mock', latencyMs: 600 });
    const app = C.createApp({ db, config: CONFIG, clock, sms, fulpot, logger: console });
    const seeded = db.get('SELECT COUNT(*) AS c FROM admins').c > 0;
    if (seeded && saved && saved.fulpot) fulpot.mock.importState(saved.fulpot);
    if (!seeded) await C.seedDemo(app.services, clock);
    const jars = seeded && saved && saved.jars && saved.jars.site ? saved.jars : { site: {}, admin: {} };
    env = { db, app, clock, jars, fulpot };
    window.APSDemo = { env };
    showMock();
    mountApps();
    if (!seeded) save();
    clearInterval(checkTimer);
    checkTimer = setInterval(runCheck, CHECK_MS);
  }

  // ---------- 모의 풀팟 응답 ----------
  function showMock() {
    const mode = env ? env.fulpot.mock.behavior.issue : 'ok';
    document.querySelectorAll('[data-mock]').forEach((b) => b.setAttribute('aria-pressed', b.dataset.mock === mode ? 'true' : 'false'));
  }
  function setMock(mode) {
    if (!env) return;
    env.fulpot.mock.behavior.issue = mode;
    showMock();
    scheduleSave();
  }

  // ---------- 문자 ----------
  function showTip(text) {
    const el = $('.dw-tip');
    el.querySelector('.dw-tip-text').textContent = text;
    el.hidden = false;
    clearTimeout(tipTimer);
    tipTimer = setTimeout(() => {
      el.hidden = true;
    }, 12000);
  }

  function onSms(msg) {
    smsCount++;
    $('.dw-tip').hidden = true;
    const code = (String(msg.text).match(/\d{6}/) || [])[0] || null;
    lastCode = code;
    const el = $('.dw-sms');
    const text = String(html`${msg.text}`);
    el.querySelector('.dw-sms-text').innerHTML = code ? text.replace(code, `<b>${code}</b>`) : text;
    el.hidden = false;
    clearTimeout(smsTimer);
    smsTimer = setTimeout(() => {
      el.hidden = true;
    }, 20000);
  }

  function fillCode() {
    $('.dw-sms').hidden = true;
    if (!lastCode) return;
    showPane('site');
    env.site.fillCode(lastCode);
  }

  // ---------- 체험 계정 ----------
  async function waitFor(fn, ms = 3000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const v = fn();
      if (v) return v;
      await sleep(40);
    }
    return null;
  }

  async function loginMember(name, phone) {
    showPane('site');
    if (env.site.route() !== 'login') await env.site.logout();
    if (!(await waitFor(() => env.site.fillLogin(name, phone)))) return;
    pressSubmit(siteRoot.querySelector('form[data-form="otp"]'));
  }

  async function loginAdmin() {
    showPane('admin');
    if (env.admin.route() !== 'login') return;
    if (!(await waitFor(() => env.admin.fillLogin(C.DEMO_ADMIN.username, C.DEMO_ADMIN.password)))) return;
    pressSubmit(adminRoot.querySelector('form[data-form="login"]'));
  }

  // requestSubmit()은 폼 제출이 막힌 미리보기 창에서 동작하지 않으므로 제출 버튼을 누른 것처럼 처리한다.
  function pressSubmit(form) {
    const b = form && form.querySelector('button[type="submit"]');
    if (b) b.click();
  }

  function renderPeople() {
    $('#dw-people').innerHTML = PEOPLE.map(
      ([name, phone, note]) => String(html`<button type="button" class="dw-person" data-demo="member" data-name="${name}" data-phone="${phone}"><b>${name}</b><span>${note}</span></button>`)
    ).join('');
  }

  // ---------- 화면 전환·창 ----------
  function showPane(which) {
    document.querySelectorAll('[data-pane]').forEach((b) => b.setAttribute('aria-selected', b.dataset.pane === which ? 'true' : 'false'));
    $('#dw-pane-site').hidden = which !== 'site';
    $('#dw-pane-admin').hidden = which !== 'admin';
    document.querySelectorAll('[data-helper]').forEach((h) => (h.hidden = h.dataset.helper !== which));
  }

  function dialog(title, bodyHtml, actions) {
    const host = $('.dw-dialog-host');
    host.innerHTML = String(html`<div class="dw-dialog" role="dialog" aria-modal="true" aria-labelledby="dw-dialog-title">
      <h2 id="dw-dialog-title">${title}</h2>${U.raw(bodyHtml)}
      <div class="dw-dialog-foot">${actions.map((a, i) => html`<button type="button" class="dw-btn ${a.primary ? 'dw-btn-primary' : ''}" data-dialog="${i}">${a.label}</button>`)}</div>
    </div>`);
    host.hidden = false;
    host.onclick = async (ev) => {
      const b = ev.target.closest('[data-dialog]');
      if (ev.target === host) host.hidden = true;
      if (!b) return;
      const a = actions[Number(b.dataset.dialog)];
      if (a.onClick) await a.onClick(host);
      if (!a.keepOpen) host.hidden = true;
    };
    const first = host.querySelector('button');
    if (first) first.focus();
  }

  function showDownload(filename, text) {
    dialog(
      '양식 미리보기',
      String(html`<p>실제 사이트에서는 <b>${filename}</b> 파일로 내려받습니다. 데모에서는 내용을 보여 드립니다. 엑셀에서 이 열 이름으로 표를 만들면 됩니다.</p><textarea readonly aria-label="파일 내용">${String(text).replace(/^﻿/, '')}</textarea>`),
      [
        {
          label: '내용 복사',
          keepOpen: true,
          onClick: async (host) => {
            const t = host.querySelector('textarea');
            try {
              await navigator.clipboard.writeText(t.value);
            } catch {
              t.select();
            }
          },
        },
        { label: '닫기', primary: true },
      ]
    );
  }

  function confirmReset() {
    dialog('처음 상태로 되돌릴까요?', '<p>이 브라우저에 남은 데모 기록을 지우고 예시 데이터로 다시 시작합니다.</p>', [
      { label: '닫기' },
      {
        label: '처음 상태로',
        primary: true,
        onClick: async () => {
          clearTimeout(saveTimer);
          KEYS.forEach((k) => store.del(k));
          lastCode = null;
          $('.dw-sms').hidden = true;
          await start(null);
          showPane('site');
        },
      },
    ]);
  }

  document.addEventListener('click', async (ev) => {
    const tab = ev.target.closest('[data-pane]');
    if (tab) return showPane(tab.dataset.pane);
    const mock = ev.target.closest('[data-mock]');
    if (mock) return setMock(mock.dataset.mock);
    const el = ev.target.closest('[data-demo]');
    if (!el || !env) return;
    const what = el.dataset.demo;
    if (what === 'sms-fill') return fillCode();
    if (what === 'tip-close') {
      $('.dw-tip').hidden = true;
      return;
    }
    if (what === 'reset') return confirmReset();
    el.disabled = true;
    try {
      if (what === 'member') await loginMember(el.dataset.name, el.dataset.phone);
      if (what === 'admin-login') await loginAdmin();
    } finally {
      el.disabled = false;
    }
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') {
      const host = $('.dw-dialog-host');
      if (!host.hidden) host.hidden = true;
    }
    // 탭 목록: 좌우 화살표로 이동
    if ((ev.key === 'ArrowRight' || ev.key === 'ArrowLeft') && ev.target.matches('[role="tab"]')) {
      const next = ev.target.dataset.pane === 'site' ? 'admin' : 'site';
      showPane(next);
      $(`[data-pane="${next}"]`).focus();
    }
  });

  async function boot() {
    renderPeople();
    if (typeof window.initSqlJs !== 'function') {
      const msg = '<p class="dw-error">데모 엔진(sql.js)을 불러오지 못했습니다. 인터넷 연결을 확인한 뒤 새로고침해 주세요.</p>';
      siteRoot.innerHTML = msg;
      adminRoot.innerHTML = msg;
      return;
    }
    try {
      SQL = await window.initSqlJs();
      const saved = loadSaved();
      try {
        await start(saved);
      } catch (e) {
        if (!saved) throw e;
        console.warn('저장된 데모 상태를 열지 못해 처음 상태로 시작합니다.', e);
        KEYS.forEach((k) => store.del(k));
        await start(null);
      }
    } catch (e) {
      console.error(e);
      const msg = `<p class="dw-error">데모를 시작하지 못했습니다: ${String(html`${e.message || e}`)}</p>`;
      siteRoot.innerHTML = msg;
      adminRoot.innerHTML = msg;
    }
  }

  window.addEventListener('pagehide', save);
  boot();
})();

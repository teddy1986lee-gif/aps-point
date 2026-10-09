/* APS 포인트 교환 — 회원 웹사이트
   화면: 로그인 / 내 포인트 / 티켓 교환 / 교환 내역 / 풀팟 계정
   티켓은 신청 즉시 풀팟으로 지급되고, 풀팟 계정은 확인 즉시 연결된다.
   mount(root, { transport, routing: 'hash' | 'memory', onRoute }) */
(function (global) {
  'use strict';
  const U = global.APSUI;
  const { html, fmt } = U;

  const PAGES = [
    ['', '내 포인트'],
    ['exchange', '티켓 교환'],
    ['orders', '교환 내역'],
    ['account', '풀팟 계정'],
  ];
  const TITLE = Object.fromEntries(PAGES);
  const HERO = {
    '': ['MY POINT'],
    exchange: ['TICKET EXCHANGE', '티켓 교환', 'TICKET'],
    orders: ['HISTORY', '교환 내역', 'HISTORY'],
    account: ['FULPOT ACCOUNT', '풀팟 계정', 'FULPOT'],
  };
  const RESULT = {
    duplicate: {
      title: '운영팀 확인이 필요합니다',
      text: '같은 이름과 휴대폰 번호로 등록된 APS 회원 기록이 여러 건이라 자동으로 로그인할 수 없습니다. 아래 문의처로 연락해 주시면 기록을 정리해 드립니다.',
    },
    no_match: {
      title: '회원 기록을 찾지 못했습니다',
      text: 'APS 대회에 등록할 때 쓴 이름과 휴대폰 번호인지 확인해 주세요. 번호를 바꾸셨다면 운영팀에 알려 주세요.',
    },
    stopped: {
      title: '이용이 중지된 회원입니다',
      text: '자세한 내용은 운영팀에 문의해 주세요.',
    },
  };
  const POLL_MS = 4000; // 지급 확인 중일 때 다시 보는 간격(바뀐 게 없으면 30초까지 점점 늘림)
  const POLL_MAX_MS = 30000;

  function mount(root, opts = {}) {
    const api = U.createApi(opts.transport);
    const routing = opts.routing || 'hash';
    const st = {
      ready: false,
      config: null,
      me: null,
      orders: null,
      route: '',
      login: freshLogin(),
      ex: freshExchange(),
      link: freshLink(),
      flash: null,
      busy: false,
    };
    let tick = null;
    let flashTimer = null;
    let pollTimer = null;
    let pollDelay = POLL_MS;

    function freshLogin(keep) {
      return { step: 'form', name: keep ? keep.name : '', phone: keep ? keep.phone : '', error: null };
    }
    function freshExchange() {
      return { qty: 1, agree: false, key: U.uuid(), error: null, done: null, sending: false };
    }
    function freshLink() {
      return { input: '', found: null, error: null };
    }

    root.classList.add('ws');
    const nav = U.createNav(routing, (r) => {
      st.route = normRoute(r);
      onRoute();
    });

    function normRoute(r) {
      const p = String(r || '').split('?')[0].replace(/\/+$/, '');
      return TITLE[p] != null ? p : '';
    }

    // ───────── 데이터 ─────────
    async function call(fn) {
      try {
        return await fn();
      } catch (e) {
        if (e.status === 401 && st.me) {
          st.me = null;
          st.login = freshLogin();
          showFlash('danger', '로그인 시간이 지났습니다. 다시 로그인해 주세요.');
          render();
        }
        throw e;
      }
    }

    async function loadMe() {
      const had = !!st.me;
      st.me = (await api.get('/api/session')).me;
      if (had && !st.me) {
        st.login = freshLogin();
        showFlash('danger', '로그인 시간이 지났습니다. 다시 로그인해 주세요.');
      }
    }

    async function loadOrders() {
      const r = await call(() => api.get('/api/exchanges'));
      st.orders = r.rows;
    }

    async function start() {
      st.route = normRoute(nav.get());
      try {
        st.config = await api.get('/api/config');
        await loadMe();
        if (st.me && st.route === 'orders') await loadOrders();
      } catch (e) {
        st.loadError = e.message;
      }
      st.ready = true;
      render();
      notifyRoute();
    }

    async function onRoute() {
      if (st.route !== 'account') st.link = freshLink();
      if (st.route !== 'exchange' && st.ex.done) st.ex = freshExchange();
      render();
      notifyRoute();
      if (!st.me) return;
      try {
        if (st.route === 'orders') await loadOrders();
        else await call(loadMe);
        render();
      } catch {
        /* 화면에 이미 안내됨 */
      }
    }

    function notifyRoute() {
      if (routing === 'hash') {
        global.scrollTo(0, 0);
        document.title = `${st.me ? TITLE[st.route] : '로그인'} · ${(st.config && st.config.serviceName) || 'APS 포인트 교환'}`;
      }
      if (opts.onRoute) opts.onRoute(st.me ? st.route : 'login');
    }

    async function refresh() {
      if (!st.ready) return;
      try {
        await loadMe();
        if (st.me && st.route === 'orders') await loadOrders();
        if (st.me && st.ex.done && U.PENDING.includes(st.ex.done.status)) {
          st.ex.done = (await api.get(`/api/exchanges/${encodeURIComponent(st.ex.done.no)}`)).exchange;
        }
      } catch {
        /* 다음 새로고침에서 다시 */
      }
      if (U.typing(root)) st.stale = true;
      else render();
    }

    // 지급 확인 중인 신청이 있으면 결과가 나올 때까지 몇 초마다 다시 본다.
    function pending() {
      if (!st.me) return false;
      return st.me.active.length > 0 || !!(st.ex.done && U.PENDING.includes(st.ex.done.status));
    }
    function schedulePoll() {
      clearTimeout(pollTimer);
      pollTimer = null;
      if (!pending()) return;
      pollTimer = setTimeout(async () => {
        pollTimer = null;
        if (!root.isConnected || !pending()) return;
        pollDelay = Math.min(POLL_MAX_MS, Math.round(pollDelay * 1.5));
        const before = JSON.stringify([st.me.active, st.me.points, st.ex.done]);
        try {
          await loadMe();
          if (st.me && st.ex.done && U.PENDING.includes(st.ex.done.status)) {
            st.ex.done = (await api.get(`/api/exchanges/${encodeURIComponent(st.ex.done.no)}`)).exchange;
          }
          if (st.me && st.route === 'orders') await loadOrders();
        } catch {
          /* 다음 차례에 다시 */
        }
        const after = JSON.stringify(st.me ? [st.me.active, st.me.points, st.ex.done] : null);
        if (after === before) return schedulePoll();
        pollDelay = POLL_MS;
        if (U.typing(root)) {
          st.stale = true; // 입력 중이면 입력을 마친 뒤 다시 그린다
          return schedulePoll();
        }
        render();
      }, pollDelay);
    }

    function showFlash(tone, text) {
      st.flash = { tone, text };
      clearTimeout(flashTimer);
      flashTimer = setTimeout(() => {
        st.flash = null;
        const el = root.querySelector('.ws-flash');
        if (el) el.remove();
      }, 6000);
    }

    // ───────── 공통 틀 ─────────
    function render() {
      st.stale = false;
      clearInterval(tick);
      tick = null;
      root.innerHTML = String(page());
      if (st.login.step === 'code' && !st.me) {
        tick = setInterval(updateTimer, 1000);
        updateTimer();
      }
      schedulePoll();
    }

    function page() {
      if (!st.ready) return html`<p class="ws-loading">불러오는 중</p>`;
      return html`${header()}
        <main class="ws-body" id="ws-main">
          ${st.loadError ? html`<div class="ws-main"><p class="ws-error" role="alert">${st.loadError}</p></div>` : st.me ? body() : loginPage()}
        </main>
        ${footer()}`;
    }

    function serviceName() {
      return (st.config && st.config.serviceName) || 'APS 포인트 교환';
    }

    function header() {
      const me = st.me;
      return html`<header class="ws-top">
        <div class="ws-top-in">
          <a class="ws-brand" href="#/" data-go=""><span class="aps-mark" aria-hidden="true">APS</span><span class="ws-brand-name">${serviceName()}</span></a>
          ${me
            ? html`<nav class="ws-nav" aria-label="주 메뉴">
                  ${PAGES.map(([r, label]) => html`<a href="#/${r}" data-go="${r}" ${st.route === r ? html`aria-current="page"` : ''}>${label}</a>`)}
                </nav>
                <div class="ws-user"><span><b>${me.member.name}</b>님</span><button type="button" class="ws-pill-line" data-act="logout">로그아웃</button></div>`
            : html`<span class="ws-top-tag">FULPOT TICKET EXCHANGE</span>`}
        </div>
      </header>`;
    }

    function footer() {
      const c = st.config || {};
      return html`<footer class="ws-foot">
        <div class="ws-foot-in">
          <div class="ws-foot-brand">
            <p><span class="aps-mark" aria-hidden="true">APS</span><b>${serviceName()}</b></p>
            <p>APS 대회에서 쌓은 포인트를 풀팟홀덤 토너먼트 티켓으로 바꾸는 서비스입니다.</p>
          </div>
          <div><h2>Support</h2><p>${c.supportText || ''}</p></div>
          <div><h2>Notice</h2><p>포인트는 APS 운영팀이 반영한 자료 기준입니다. 티켓은 연결한 풀팟 계정으로 신청 즉시 지급됩니다.</p></div>
        </div>
        <p class="ws-foot-copy">${serviceName()}${c.fulpotMode === 'mock' ? ' · 개발용 모의 풀팟으로 동작 중이며 실제 티켓은 지급되지 않습니다.' : ''}</p>
      </footer>`;
    }

    function hero(route, title, sub, tall) {
      const [eyebrow, , deco] = HERO[route] || HERO[''];
      return html`<section class="ws-hero${tall ? ' ws-hero-tall' : ''}">
        <div class="ws-hero-in">
          <p class="ws-eyebrow">${eyebrow}</p>
          <h1>${title}</h1>
          ${sub ? html`<p class="ws-hero-sub">${sub}</p>` : ''}
          <span class="ws-hero-deco" aria-hidden="true">${deco || 'POINT'}</span>
        </div>
      </section>`;
    }

    function flashHtml() {
      return st.flash ? html`<p class="ws-note ws-flash" data-tone="${st.flash.tone}" role="status">${st.flash.text}</p>` : '';
    }

    function body() {
      if (st.route === 'exchange') return exchangePage();
      if (st.route === 'orders') return ordersPage();
      if (st.route === 'account') return accountPage();
      return homePage();
    }

    const chip = (map, status) => {
      const x = map[status] || { label: status, tone: 'muted' };
      return html`<span class="tone-chip" data-tone="${x.tone}">${x.label}</span>`;
    };
    const panelHead = (eyebrow, title, extra) =>
      html`<div class="ws-panel-head"><div><p class="ws-eyebrow">${eyebrow}</p><h2>${title}</h2></div>${extra || ''}</div>`;

    // ───────── 로그인 ─────────
    function loginPage() {
      const c = st.config || {};
      const t = c.ticket || { unitPoints: 40 };
      const L = st.login;
      let card;
      if (L.step === 'result') {
        const r = RESULT[L.result] || RESULT.no_match;
        card = html`<p class="ws-eyebrow">MEMBER CHECK</p><h2>${r.title}</h2>
          <div class="ws-form">
            <p class="ws-note" data-tone="warn">${r.text}</p>
            <p class="ws-note">${c.supportText || ''}</p>
            <button type="button" class="ws-btn ws-btn-line ws-btn-wide" data-act="otp-back">처음으로</button>
          </div>`;
      } else if (L.step === 'code') {
        card = html`<p class="ws-eyebrow">VERIFICATION</p><h2>인증번호 입력</h2>
          <p class="ws-card-sub"><b>${L.phoneMasked}</b> 번호로 보낸 6자리 숫자를 입력하세요. APS 회원 기록에 있는 이름·번호일 때만 문자가 갑니다.</p>
          <form class="ws-form" data-form="verify" novalidate>
            ${L.devCode
              ? html`<p class="ws-dev">개발용 표시 · 인증번호 <b>${L.devCode}</b></p>`
              : c.devSmsConsole
                ? html`<p class="ws-dev">개발 서버라 문자를 실제로 보내지 않습니다. 인증번호는 서버를 실행한 창(콘솔)에 찍힙니다. 화면에 바로 보이게 하려면 .env에 DEV_EXPOSE_OTP=1을 넣고 서버를 다시 켜세요.</p>`
                : ''}
            <label class="ws-field" for="ws-code">
              <span>인증번호</span>
              <input class="ws-input ws-code" id="ws-code" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]*" required ${L.error ? html`aria-invalid="true"` : ''} />
            </label>
            <p class="ws-timer"><span>남은 시간 <b data-timer="left">3:00</b></span><span data-timer="resend"></span></p>
            ${L.error ? html`<p class="ws-error" role="alert">${L.error}</p>` : ''}
            <button class="ws-btn ws-btn-wide" type="submit">로그인</button>
            <button type="button" class="ws-link" data-act="otp-back">이름·번호 다시 입력</button>
          </form>`;
      } else {
        card = html`<p class="ws-eyebrow">MEMBER LOGIN</p><h2>로그인</h2>
          <p class="ws-card-sub">APS 대회에 등록한 이름과 휴대폰 번호로 로그인합니다.</p>
          <form class="ws-form" data-form="otp" novalidate>
            <label class="ws-field" for="ws-name">
              <span>이름</span>
              <input class="ws-input" id="ws-name" name="name" autocomplete="name" maxlength="40" value="${L.name}" required />
            </label>
            <label class="ws-field" for="ws-phone">
              <span>휴대폰 번호</span>
              <input class="ws-input" id="ws-phone" name="phone" type="tel" inputmode="numeric" autocomplete="tel" placeholder="010-0000-0000" maxlength="13" value="${L.phone}" required />
            </label>
            ${L.error ? html`<p class="ws-error" role="alert">${L.error}</p>` : ''}
            <button class="ws-btn ws-btn-wide" type="submit">인증번호 받기</button>
          </form>
          <p class="ws-privacy">입력한 이름과 휴대폰 번호는 APS 회원 확인과 포인트 조회에만 씁니다. 문자 인증은 번호의 주인인지 확인하는 절차이며 실명 확인이 아닙니다.</p>`;
      }
      return html`<section class="ws-login">
          <div class="ws-login-in">
            <div class="ws-intro">
              <p class="ws-eyebrow">APS POINT EXCHANGE</p>
              <h1>APS 포인트를<br />풀팟 티켓으로</h1>
              <p>APS 대회에서 쌓은 포인트를 확인하고, 연결한 풀팟홀덤 계정으로 토너먼트 티켓을 바로 받으세요.</p>
              <div class="ws-rate" aria-label="교환 비율 ${t.unitPoints}P에 티켓 1장">
                <span class="ws-rate-points" aria-hidden="true"><b class="ws-num">${t.unitPoints}</b><small>POINT</small></span>
                <span class="ws-rate-eq" aria-hidden="true">=</span>
                <span class="ws-rate-ticket" aria-hidden="true"><small>FULPOT TOURNAMENT</small>티켓 1장</span>
              </div>
            </div>
            <section class="ws-login-card" aria-label="로그인">${card}</section>
          </div>
          <span class="ws-login-deco" aria-hidden="true">APS POINT</span>
        </section>
        <section class="ws-how" aria-labelledby="ws-how-title">
          <div class="ws-how-in">
            <p class="ws-eyebrow">HOW IT WORKS</p>
            <h2 id="ws-how-title">이용 방법</h2>
            <ol class="ws-steps">
              <li><b>문자 인증 로그인</b><span>APS에 등록한 이름과 휴대폰 번호로 로그인해 포인트를 확인합니다.</span></li>
              <li><b>풀팟 계정 바로 연결</b><span>풀팟 ID를 넣고 닉네임을 확인하면 그 자리에서 연결됩니다.</span></li>
              <li><b>티켓 바로 받기</b><span>장수를 고르고 신청하면 풀팟 계정으로 티켓이 즉시 지급됩니다.</span></li>
              <li><b>내역 확인</b><span>지급 번호와 사용한 포인트를 교환 내역에서 언제든 볼 수 있습니다.</span></li>
            </ol>
          </div>
        </section>`;
    }

    function updateTimer() {
      const L = st.login;
      const left = root.querySelector('[data-timer="left"]');
      const resend = root.querySelector('[data-timer="resend"]');
      if (!left) return;
      const now = Date.now();
      const sec = Math.max(0, Math.round((L.expiresAt - now) / 1000));
      left.textContent = sec ? `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}` : '만료';
      const wait = Math.max(0, Math.ceil((L.resendAt - now) / 1000));
      if (wait) resend.textContent = `${wait}초 후 다시 받기`;
      else if (!resend.querySelector('button')) resend.innerHTML = '<button type="button" class="ws-link" data-act="otp-resend">인증번호 다시 받기</button>';
    }

    // ───────── 내 포인트 ─────────
    function passCard() {
      const me = st.me;
      const p = me.points;
      const t = me.ticket;
      const link = me.link;
      let action;
      if (!t.open) action = html`<p class="ws-pass-msg">지금은 교환 신청을 받지 않습니다.</p>`;
      else if (!link.active) action = html`<a class="ws-btn" href="#/account" data-go="account">풀팟 계정 연결하기</a>`;
      else if (me.exchangeable > 0) action = html`<a class="ws-btn" href="#/exchange" data-go="exchange">티켓 받기</a>`;
      else action = html`<p class="ws-pass-msg">${me.shortfall ? `다음 1장까지 ${fmt.num(me.shortfall)}P 부족` : '지금은 받을 수 있는 티켓이 없습니다'}</p>`;
      return html`<section class="ws-pass" aria-label="포인트 요약">
        <div class="ws-pass-main">
          <p class="ws-pass-label"><span class="ws-en">AVAILABLE</span>사용 가능 포인트</p>
          <p class="ws-pass-big"><span class="ws-num">${fmt.num(p.available)}</span><small>P</small></p>
          <dl class="ws-pass-sub">
            <div><dt>총 보유</dt><dd>${fmt.points(p.total)}</dd></div>
            <div><dt>사용 대기</dt><dd>${fmt.points(p.pending)}</dd></div>
            <div><dt>풀팟 계정</dt><dd>${link.active ? link.active.fulpotId : '연결 안 됨'}</dd></div>
          </dl>
        </div>
        <div class="ws-pass-stub">
          <p class="ws-pass-label"><span class="ws-en">TICKETS</span>지금 받을 수 있는 티켓</p>
          <p class="ws-pass-count"><span class="ws-num">${me.exchangeable}</span><small>장</small></p>
          <p class="ws-pass-rate">티켓 1장 ${fmt.points(t.unitPoints)}</p>
          ${action}
        </div>
      </section>`;
    }

    function activeNotice() {
      const list = st.me.active;
      if (!list.length) return '';
      const sum = list.reduce((a, x) => a + x.totalPoints, 0);
      return html`<div class="ws-note ws-checking" data-tone="warn" role="status">
        <span class="ws-pulse" aria-hidden="true"></span>
        <p><b>지급 결과를 확인하고 있는 신청이 ${list.length}건 있습니다.</b> 풀팟 응답이 늦어 확인 중이며, 확인되면 화면이 저절로 바뀝니다. 그동안 ${fmt.points(sum)}는 사용 대기로 잡혀 있습니다.</p>
        <a href="#/orders" data-go="orders">교환 내역</a>
      </div>`;
    }

    function homePage() {
      const me = st.me;
      return html`${hero('', `${me.member.name}님의 APS 포인트`, html`포인트 자료 기준 <b>${fmt.asOf(me.pointsAsOf)}</b>`, true)}
        <div class="ws-main ws-main-lift">
          <div class="ws-pass-wrap">${passCard()}</div>
          ${flashHtml()}
          ${activeNotice()}
          <div class="ws-cols">
            <section class="ws-panel" aria-label="포인트 내역">
              ${panelHead('POINT HISTORY', '포인트 내역', html`<span class="ws-muted">최근 30건</span>`)}
              ${me.history.length ? historyTable(me.history) : html`<div class="ws-empty"><p>아직 포인트 내역이 없습니다.</p><p>대회 포인트는 운영팀이 자료를 올리면 반영됩니다.</p></div>`}
            </section>
            <div class="ws-stack">
              ${accountMini()}
              ${recentPanel()}
            </div>
          </div>
        </div>`;
    }

    function historyTable(rows) {
      return html`<div class="ws-table-wrap"><table class="ws-table ws-ledger">
        <thead><tr><th scope="col">날짜</th><th scope="col">내용</th><th scope="col" class="ws-r">포인트</th></tr></thead>
        <tbody>
          ${rows.map(
            (r) => html`<tr>
              <td class="ws-nowrap ws-muted ws-ledger-date">${fmt.date(r.occurredAt)}</td>
              <td>${r.memo || U.LEDGER[r.kind]}<span class="ws-sub"><span class="ws-narrow-only">${fmt.date(r.occurredAt)} · </span>${U.LEDGER[r.kind]}${r.exchangeNo ? html` · <span class="ws-code-text">${r.exchangeNo}</span>` : ''}</span></td>
              <td class="ws-r"><span class="${r.amount > 0 ? 'ws-plus' : 'ws-minus'}">${fmt.signed(r.amount)}</span></td>
            </tr>`
          )}
        </tbody>
      </table></div>`;
    }

    function accountMini() {
      const l = st.me.link;
      let content;
      if (l.active) {
        content = html`<div class="ws-account"><span class="ws-account-id">${l.active.fulpotId}</span>${l.active.nickname ? html`<span class="ws-account-nick">${l.active.nickname}</span>` : ''}<span class="ws-sub">${fmt.date(l.active.since)} 연결 · 티켓은 이 계정으로 바로 지급됩니다.</span></div>`;
      } else if (l.released) {
        content = html`<p class="ws-note" data-tone="danger">운영팀이 <b>${l.released.fulpotId}</b> 연결을 해제했습니다. 본인 풀팟 계정을 다시 연결해 주세요.</p>`;
      } else {
        content = html`<p class="ws-muted">연결된 계정이 없습니다. 풀팟 ID를 넣으면 바로 연결됩니다.</p>`;
      }
      return html`<section class="ws-panel" aria-label="풀팟 계정">
        ${panelHead('FULPOT ACCOUNT', '풀팟 계정', html`<a href="#/account" data-go="account">${l.active ? '바꾸기' : '연결하기'}</a>`)}
        <div class="ws-panel-body">${content}</div>
      </section>`;
    }

    function recentPanel() {
      const list = st.me.recent || [];
      return html`<section class="ws-panel" aria-label="최근 교환">
        ${panelHead('RECENT', '최근 교환', html`<a href="#/orders" data-go="orders">전체 보기</a>`)}
        <div class="ws-panel-body">
          ${list.length
            ? html`<ul class="ws-side-list">
                ${list.map(
                  (x) => html`<li>
                    <div class="ws-side-row"><span>${x.quantity}장 · ${fmt.points(x.totalPoints)}</span>${chip(U.EXCHANGE, x.status)}</div>
                    <span class="ws-sub">${fmt.dateTime(x.createdAt)} · <span class="ws-code-text">${x.no}</span></span>
                  </li>`
                )}
              </ul>`
            : html`<p class="ws-muted">아직 교환한 티켓이 없습니다.</p>`}
        </div>
      </section>`;
    }

    // ───────── 티켓 교환 ─────────
    function maxQty() {
      return Math.max(0, st.me.exchangeable);
    }

    function resultPanel(d) {
      const t = st.me.ticket;
      if (d.status === 'completed') {
        return html`<section class="ws-panel ws-result" data-tone="ok" aria-live="polite">
          <span class="ws-stamp">지급 완료</span>
          <h2>풀팟 계정으로 티켓 ${d.quantity}장을 보냈습니다</h2>
          <dl class="ws-kv ws-result-kv">
            <div><dt>받은 계정</dt><dd class="ws-code-text">${d.fulpotId}</dd></div>
            <div><dt>풀팟 지급 번호</dt><dd class="ws-code-text">${d.issueId}</dd></div>
            <div><dt>신청번호</dt><dd class="ws-code-text">${d.no}</dd></div>
            <div><dt>사용한 포인트</dt><dd>${fmt.points(d.totalPoints)}</dd></div>
          </dl>
          ${t.terms ? html`<p class="ws-muted">${t.terms}</p>` : ''}
          <div class="ws-done-actions">
            <a class="ws-btn" href="#/orders" data-go="orders">교환 내역 보기</a>
            <button type="button" class="ws-btn ws-btn-line" data-act="ex-again">더 받기</button>
          </div>
        </section>`;
      }
      if (d.status === 'failed') {
        return html`<section class="ws-panel ws-result" data-tone="danger" aria-live="polite">
          <span class="ws-stamp">지급 실패</span>
          <h2>티켓을 지급하지 못했습니다</h2>
          <p class="ws-reason">${d.reason}</p>
          <p>포인트는 차감되지 않았습니다. 사유를 확인한 뒤 다시 신청해 주세요.</p>
          <div class="ws-done-actions">
            <button type="button" class="ws-btn" data-act="ex-again">다시 신청하기</button>
            <a class="ws-btn ws-btn-line" href="#/account" data-go="account">풀팟 계정 확인</a>
          </div>
        </section>`;
      }
      return html`<section class="ws-panel ws-result" data-tone="warn" aria-live="polite">
        <span class="ws-stamp"><span class="ws-pulse" aria-hidden="true"></span>지급 확인 중</span>
        <h2>지급 결과를 확인하고 있습니다</h2>
        <p>풀팟 응답이 늦어지고 있습니다. 결과가 확인되면 이 화면이 저절로 바뀝니다.</p>
        <p class="ws-muted">그동안 ${fmt.points(d.totalPoints)}는 사용 대기로 잡혀 있고, 같은 신청이 두 번 지급되지는 않습니다. 신청번호 <span class="ws-code-text">${d.no}</span></p>
        <div class="ws-done-actions"><a class="ws-btn ws-btn-line" href="#/orders" data-go="orders">교환 내역 보기</a></div>
      </section>`;
    }

    function exchangePage() {
      const me = st.me;
      const t = me.ticket;
      const E = st.ex;
      const main = E.done
        ? resultPanel(E.done)
        : html`<section class="ws-panel">
            <div class="ws-ticket">
              <div class="ws-ticket-face" aria-hidden="true"><span class="ws-en">TICKET</span><b class="ws-num">${t.unitPoints}</b><small>POINT</small></div>
              <div>
                <p class="ws-eyebrow">FULPOT TOURNAMENT</p>
                <h2>${t.name}</h2>
                <p>티켓 1장에 ${fmt.points(t.unitPoints)}${t.maxPerExchange ? ` · 한 번에 ${t.maxPerExchange}장까지` : ''}</p>
                ${t.terms ? html`<p class="ws-muted">${t.terms}</p>` : ''}
              </div>
            </div>
            <div class="ws-panel-body">${exchangeForm()}</div>
          </section>`;
      return html`${hero('exchange', '티켓 교환', `포인트 ${fmt.points(t.unitPoints)}로 풀팟홀덤 토너먼트 티켓 1장을 바로 받습니다.`)}
        <div class="ws-main">
          ${flashHtml()}
          <div class="ws-cols">
            ${main}
            <div class="ws-stack">
              <section class="ws-panel" aria-label="내 포인트">
                ${panelHead('MY POINT', '내 포인트')}
                <div class="ws-panel-body">
                  <dl class="ws-kv">
                    <div><dt>총 보유</dt><dd>${fmt.points(me.points.total)}</dd></div>
                    <div><dt>사용 대기</dt><dd>${fmt.points(me.points.pending)}</dd></div>
                    <div class="ws-kv-total"><dt>사용 가능</dt><dd>${fmt.points(me.points.available)}</dd></div>
                  </dl>
                </div>
              </section>
              <section class="ws-panel" aria-label="지급 안내">
                ${panelHead('GUIDE', '지급 안내')}
                <div class="ws-panel-body">
                  <p>${t.payoutGuide || '신청하면 연결된 풀팟 계정으로 티켓이 바로 지급됩니다.'}</p>
                  <p class="ws-muted">지급이 끝나면 포인트가 차감됩니다. 풀팟이 지급을 거절하면 포인트는 그대로 남고, 응답이 늦으면 결과를 확인할 때까지 사용 대기로 잡아 둡니다.</p>
                </div>
              </section>
            </div>
          </div>
        </div>`;
    }

    function exchangeForm() {
      const me = st.me;
      const t = me.ticket;
      const E = st.ex;
      const link = me.link;
      if (!t.open) return html`<p class="ws-note" data-tone="warn">지금은 교환 신청을 받지 않습니다. 다시 열리면 이 화면에서 신청할 수 있습니다.</p>`;
      if (!link.active) {
        return html`<div class="ws-note" data-tone="warn"><p>티켓을 받을 풀팟 계정을 먼저 연결해 주세요. 풀팟에 있는 계정이면 바로 연결됩니다.</p><a class="ws-btn ws-btn-small" href="#/account" data-go="account">풀팟 계정 연결하기</a></div>`;
      }
      const max = maxQty();
      if (max < 1) {
        return html`<p class="ws-note">사용 가능 포인트가 ${fmt.points(me.points.available)}입니다. ${me.shortfall ? `티켓 1장까지 ${fmt.num(me.shortfall)}P가 더 필요합니다.` : ''}</p>`;
      }
      const qty = Math.min(Math.max(1, E.qty), max);
      E.qty = qty;
      return html`<form class="ws-form" data-form="exchange" novalidate>
        <div class="ws-qty">
          <div class="ws-stepper" role="group" aria-label="수량">
            <button type="button" data-act="qty" data-d="-1" aria-label="1장 줄이기" ${qty <= 1 ? 'disabled' : ''}>−</button>
            <input type="number" name="qty" data-qty min="1" max="${max}" value="${qty}" inputmode="numeric" aria-label="받을 장수" />
            <button type="button" data-act="qty" data-d="1" aria-label="1장 늘리기" ${qty >= max ? 'disabled' : ''}>+</button>
          </div>
          <span class="ws-muted">최대 ${max}장까지 받을 수 있습니다.</span>
        </div>
        <dl class="ws-kv">
          <div><dt>받을 풀팟 계정</dt><dd><span class="ws-code-text">${link.active.fulpotId}</span>${link.active.nickname ? html` <span class="ws-muted">(${link.active.nickname})</span>` : ''}</dd></div>
          <div><dt>사용할 포인트</dt><dd data-out="used">${fmt.points(qty * t.unitPoints)}</dd></div>
          <div class="ws-kv-total"><dt>받은 뒤 사용 가능</dt><dd data-out="after">${fmt.points(me.points.available - qty * t.unitPoints)}</dd></div>
        </dl>
        <label class="ws-check" for="ws-agree">
          <input type="checkbox" id="ws-agree" name="agree" ${E.agree ? 'checked' : ''} />
          <span>받을 계정과 장수를 확인했습니다. 티켓은 신청 즉시 지급되어 취소할 수 없습니다.</span>
        </label>
        ${E.error ? html`<p class="ws-error" role="alert">${E.error}</p>` : ''}
        <button class="ws-btn ws-btn-wide" type="submit" data-submit ${E.agree && !E.sending ? '' : 'disabled'}><span>${E.sending ? '풀팟에 지급 요청 중…' : html`티켓 <span data-out="qty">${qty}</span>장 바로 받기`}</span></button>
      </form>`;
    }

    function updateQty(q) {
      const max = maxQty();
      const t = st.me.ticket;
      st.ex.qty = Math.min(Math.max(1, q || 1), Math.max(1, max));
      const used = st.ex.qty * t.unitPoints;
      const set = (sel, v) => {
        const el = root.querySelector(sel);
        if (el) el.textContent = v;
      };
      set('[data-out="used"]', fmt.points(used));
      set('[data-out="after"]', fmt.points(st.me.points.available - used));
      set('[data-out="qty"]', String(st.ex.qty));
      const input = root.querySelector('[data-qty]');
      if (input && String(input.value) !== String(st.ex.qty) && document.activeElement !== input) input.value = st.ex.qty;
      const minus = root.querySelector('[data-act="qty"][data-d="-1"]');
      const plus = root.querySelector('[data-act="qty"][data-d="1"]');
      if (minus) minus.disabled = st.ex.qty <= 1;
      if (plus) plus.disabled = st.ex.qty >= max;
    }

    // ───────── 교환 내역 ─────────
    function ordersPage() {
      const rows = st.orders;
      let content;
      if (!rows) content = html`<p class="ws-loading">불러오는 중</p>`;
      else if (!rows.length) content = html`<div class="ws-empty"><p>아직 교환한 티켓이 없습니다.</p><p><a href="#/exchange" data-go="exchange">티켓 받으러 가기</a></p></div>`;
      else
        content = html`<div class="ws-table-wrap"><table class="ws-table ws-table-cards">
          <thead><tr><th scope="col">신청번호</th><th scope="col">신청일시</th><th scope="col">내용</th><th scope="col" class="ws-r">포인트</th><th scope="col">받은 계정</th><th scope="col">상태</th></tr></thead>
          <tbody>${rows.map(orderRow)}</tbody>
        </table></div>`;
      return html`${hero('orders', '교환 내역', '티켓은 신청하는 즉시 지급됩니다. 지급 확인 중인 신청은 결과가 나오면 저절로 바뀝니다.')}
        <div class="ws-main">
          ${flashHtml()}
          <section class="ws-panel">${content}</section>
        </div>`;
    }

    function orderRow(x) {
      let detail = '';
      if (x.status === 'completed') detail = html`<span class="ws-sub">${fmt.dateTime(x.completedAt)} 지급 · <span class="ws-code-text">${x.issueId}</span></span>`;
      else if (x.status === 'failed') detail = html`<span class="ws-reason">${x.reason}</span><span class="ws-sub">포인트는 차감되지 않았습니다.</span>`;
      else detail = html`<span class="ws-sub">풀팟 응답 확인 중 · ${fmt.points(x.totalPoints)} 사용 대기</span>`;
      return html`<tr>
          <td><span class="ws-code-text">${x.no}</span></td>
          <td class="ws-nowrap" data-label="신청일시">${fmt.dateTime(x.createdAt)}</td>
          <td data-label="내용">${x.ticketName} ${x.quantity}장</td>
          <td class="ws-r" data-label="포인트">${fmt.points(x.totalPoints)}</td>
          <td data-label="받은 계정"><span class="ws-code-text">${x.fulpotId}</span></td>
          <td data-label="상태"><span class="ws-status">${chip(U.EXCHANGE, x.status)}${detail}</span></td>
        </tr>`;
    }

    // ───────── 풀팟 계정 ─────────
    function accountPage() {
      const l = st.me.link;
      const K = st.link;
      let current = '';
      if (l.active) {
        current = html`<div class="ws-account ws-account-big">
          <span class="ws-muted">연결된 풀팟 계정</span>
          <span class="ws-account-id">${l.active.fulpotId}</span>
          ${l.active.nickname ? html`<span class="ws-account-nick">${l.active.nickname}</span>` : ''}
          <span class="ws-sub">${fmt.dateTime(l.active.since)} 연결</span>
        </div>`;
      } else if (l.released) {
        current = html`<div class="ws-note" data-tone="danger"><p>운영팀이 <b>${l.released.fulpotId}</b> 연결을 해제했습니다. (${fmt.dateTime(l.released.at)})</p><p>${l.released.reason}</p></div>`;
      }
      let form;
      if (K.found) {
        form = html`<div class="ws-found" aria-live="polite">
          <p class="ws-eyebrow">FOUND</p>
          <p class="ws-found-title">풀팟에서 이 계정을 찾았습니다</p>
          <div class="ws-account"><span class="ws-account-id">${K.found.fulpotId}</span>${K.found.nickname ? html`<span class="ws-account-nick">${K.found.nickname}</span>` : ''}</div>
          <p class="ws-muted">닉네임을 보고 본인 계정이 맞는지 확인해 주세요. 연결하면 앞으로 받는 티켓은 이 계정으로 바로 지급됩니다.${l.active ? ` 지금 연결된 ${l.active.fulpotId}는 해제됩니다.` : ''}</p>
          ${K.error ? html`<p class="ws-error" role="alert">${K.error}</p>` : ''}
          <div class="ws-actions">
            <button type="button" class="ws-btn" data-act="link-confirm">이 계정으로 연결</button>
            <button type="button" class="ws-btn ws-btn-line" data-act="link-reset">다시 입력</button>
          </div>
        </div>`;
      } else {
        form = html`<form class="ws-form ws-form-narrow" data-form="lookup" novalidate>
          <label class="ws-field" for="ws-fp">
            <span>${l.active ? '바꿀 풀팟 ID' : '풀팟 ID'}</span>
            <input class="ws-input" id="ws-fp" name="fulpotId" value="${K.input}" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="30" required ${K.error ? html`aria-invalid="true"` : ''} />
            <small>풀팟홀덤 앱의 내 정보 화면에 있는 ID를 입력하세요.</small>
          </label>
          ${K.error ? html`<p class="ws-error" role="alert">${K.error}</p>` : ''}
          <div><button class="ws-btn" type="submit">계정 확인</button></div>
        </form>`;
      }
      return html`${hero('account', '풀팟 계정', '티켓은 여기에 연결한 풀팟홀덤 계정으로 바로 지급됩니다.')}
        <div class="ws-main">
          ${flashHtml()}
          <div class="ws-cols">
            <section class="ws-panel">
              ${panelHead('MY ACCOUNT', l.active ? '연결된 계정' : '계정 연결', l.active ? chip(U.LINK, 'active') : '')}
              <div class="ws-panel-body">
                ${current}
                ${form}
              </div>
            </section>
            <section class="ws-panel" aria-label="연결 안내">
              ${panelHead('HOW TO LINK', '연결 안내')}
              <div class="ws-panel-body">
                <ol class="ws-mini-steps">
                  <li><span>풀팟 ID를 넣고 <b>계정 확인</b>을 누릅니다.</span></li>
                  <li><span>풀팟에서 찾은 닉네임이 내 계정인지 봅니다.</span></li>
                  <li><span><b>이 계정으로 연결</b>을 누르면 바로 연결됩니다. 운영자 승인은 없습니다.</span></li>
                </ol>
                <p class="ws-muted">한 풀팟 계정은 한 회원에게만 연결됩니다. 다른 사람의 계정을 연결하면 티켓이 그 계정으로 가니 닉네임을 꼭 확인하세요. 계정을 바꿔도 이미 받은 티켓에는 영향이 없습니다.</p>
              </div>
            </section>
          </div>
        </div>`;
    }

    // ───────── 동작 ─────────
    async function logout() {
      try {
        await api.post('/api/auth/logout');
      } catch {
        /* 이미 끝난 로그인 */
      }
      st.me = null;
      st.orders = null;
      st.flash = null;
      st.login = freshLogin();
      st.ex = freshExchange();
      st.link = freshLink();
      nav.go('', { replace: true });
    }

    // 요청 하나가 끝날 때까지 다른 동작을 받지 않는다. 누른 버튼은 바로 잠근다.
    async function withBusy(fn, button) {
      if (st.busy) return;
      st.busy = true;
      if (button) button.disabled = true;
      try {
        await fn();
      } finally {
        st.busy = false;
      }
    }

    async function requestOtp(name, phone) {
      st.login.name = name;
      st.login.phone = phone;
      try {
        const r = await api.post('/api/auth/otp', { name, phone });
        // 서버와 브라우저 시계가 달라도 남은 시간이 맞도록 서버가 준 간격만 쓴다.
        const now = Date.now();
        st.login = {
          ...st.login,
          step: 'code',
          error: null,
          requestId: r.requestId,
          phoneMasked: r.phoneMasked,
          expiresAt: now + (r.expiresAt - r.issuedAt),
          resendAt: now + (r.resendAt - r.issuedAt),
          devCode: r.devCode,
        };
      } catch (e) {
        st.login.error = e.message;
      }
    }

    async function confirmLink(button) {
      const K = st.link;
      if (!K.found) return;
      await withBusy(async () => {
        try {
          const r = await call(() => api.post('/api/link', { fulpotId: K.found.fulpotId }));
          st.me = r.me;
          showFlash('ok', `${r.link.active.fulpotId} 계정을 연결했습니다. 이제 티켓을 받을 수 있습니다.`);
          st.link = freshLink();
        } catch (e) {
          if (e.status === 401) return;
          K.error = e.message;
          if (e.code === 'FULPOT_NOT_FOUND' || e.code === 'ALREADY_LINKED' || e.code === 'LINK_SAME') {
            st.link = { ...freshLink(), input: K.found.fulpotId, error: e.message };
          }
        }
        render();
      }, button);
    }

    root.addEventListener('click', (ev) => {
      const go = ev.target.closest('[data-go]');
      if (go && root.contains(go)) {
        ev.preventDefault();
        nav.go(go.getAttribute('data-go'));
        return;
      }
      const el = ev.target.closest('[data-act]');
      if (!el || !root.contains(el)) return;
      const act = el.getAttribute('data-act');
      if (act === 'logout') {
        withBusy(logout);
      } else if (act === 'otp-back') {
        st.login = freshLogin(st.login);
        render();
        focus('#ws-name');
      } else if (act === 'otp-resend') {
        withBusy(async () => {
          await requestOtp(st.login.name, st.login.phone);
          render();
          focus('#ws-code');
        }, el);
      } else if (act === 'qty') {
        updateQty(st.ex.qty + Number(el.getAttribute('data-d')));
      } else if (act === 'ex-again') {
        st.ex = freshExchange();
        render();
      } else if (act === 'link-reset') {
        st.link = { ...freshLink(), input: st.link.found ? st.link.found.fulpotId : '' };
        render();
        focus('#ws-fp');
      } else if (act === 'link-confirm') {
        confirmLink(el);
      }
    });

    root.addEventListener('input', (ev) => {
      if (ev.target.matches('[data-qty]')) {
        const n = parseInt(ev.target.value, 10);
        if (Number.isInteger(n)) updateQty(n);
      } else if (ev.target.id === 'ws-phone') {
        const f = fmt.phoneInput(ev.target.value);
        if (f !== ev.target.value) ev.target.value = f;
      } else if (ev.target.id === 'ws-code') {
        ev.target.value = ev.target.value.replace(/\D/g, '').slice(0, 6);
      } else if (ev.target.id === 'ws-fp') {
        st.link.input = ev.target.value;
      }
    });

    root.addEventListener('focusout', () => {
      if (!st.stale) return;
      setTimeout(() => {
        if (st.stale && !U.typing(root)) render();
      }, 150);
    });

    root.addEventListener('change', (ev) => {
      if (ev.target.name === 'agree') {
        st.ex.agree = ev.target.checked;
        const b = root.querySelector('[data-submit]');
        if (b) b.disabled = !st.ex.agree;
      } else if (ev.target.matches('[data-qty]')) {
        updateQty(parseInt(ev.target.value, 10));
        ev.target.value = st.ex.qty;
      }
    });

    // 제출 버튼·Enter를 직접 받는다(폼 제출이 막힌 미리보기 창에서도 동작하도록, ui.js bindForms 참고)
    U.bindForms(root, (form, submitBtn) => {
      if (st.busy) return;
      const kind = form.getAttribute('data-form');
      const val = (n) => (form.elements[n] ? form.elements[n].value.trim() : '');
      if (kind === 'otp') {
        const name = val('name');
        const phone = val('phone');
        if (!name || !phone) {
          st.login = { ...st.login, name, phone, error: '이름과 휴대폰 번호를 입력해 주세요.' };
          render();
          focus(name ? '#ws-phone' : '#ws-name');
          return;
        }
        withBusy(async () => {
          await requestOtp(name, phone);
          render();
          focus(st.login.step === 'code' ? '#ws-code' : '#ws-phone');
        }, submitBtn);
      } else if (kind === 'verify') {
        const code = val('code');
        if (!/^\d{6}$/.test(code)) {
          st.login.error = '인증번호 6자리를 입력해 주세요.';
          render();
          focus('#ws-code');
          return;
        }
        withBusy(async () => {
          try {
            const r = await api.post('/api/auth/verify', { requestId: st.login.requestId, code });
            if (r.result === 'ok') {
              st.me = r.me;
              st.login = freshLogin();
              st.flash = null;
              if (st.route === 'orders') await loadOrders().catch(() => {});
              render();
              notifyRoute();
              return;
            }
            st.login = { ...st.login, step: 'result', result: r.result, error: null };
          } catch (e) {
            st.login.error = e.message;
            if (e.code === 'OTP_EXPIRED' || e.code === 'OTP_LOCKED' || e.code === 'OTP_INVALID') st.login.resendAt = 0;
          }
          render();
          focus('#ws-code');
        }, submitBtn);
      } else if (kind === 'exchange') {
        if (!st.ex.agree) return;
        withBusy(async () => {
          st.ex.sending = true;
          st.ex.error = null;
          render();
          try {
            const r = await call(() => api.post('/api/exchanges', { quantity: st.ex.qty, requestKey: st.ex.key, expectedUnitPoints: st.me.ticket.unitPoints }));
            st.me = r.me;
            st.ex = { ...freshExchange(), done: r.exchange };
            pollDelay = POLL_MS;
          } catch (e) {
            st.ex.sending = false;
            if (e.status === 401) return;
            st.ex.error = e.message;
            if (e.code === 'TERMS_CHANGED' || e.code === 'INSUFFICIENT_POINTS' || e.code === 'LINK_REQUIRED' || e.code === 'EXCHANGE_CLOSED') {
              st.ex.key = U.uuid();
              st.ex.agree = false;
              await loadMe().catch(() => {});
            }
          }
          render();
        }, submitBtn);
      } else if (kind === 'lookup') {
        const fulpotId = val('fulpotId');
        st.link.input = fulpotId;
        if (!fulpotId) {
          st.link.error = '풀팟 ID를 입력해 주세요.';
          render();
          focus('#ws-fp');
          return;
        }
        withBusy(async () => {
          try {
            const r = await call(() => api.post('/api/link/lookup', { fulpotId }));
            st.link = { input: fulpotId, found: r.account, error: null };
          } catch (e) {
            if (e.status === 401) return;
            st.link = { input: fulpotId, found: null, error: e.message };
          }
          render();
          if (st.link.found) focus('[data-act="link-confirm"]');
          else focus('#ws-fp');
        }, submitBtn);
      }
    });

    function focus(sel) {
      const el = root.querySelector(sel);
      if (el) el.focus({ preventScroll: routing !== 'hash' });
    }

    start();
    return {
      refresh,
      logout,
      go: (r) => nav.go(r),
      route: () => (st.me ? st.route : 'login'),
      fillLogin(name, phone) {
        if (st.me) return false;
        st.login = { ...freshLogin(), name, phone };
        render();
        focus('#ws-phone');
        return true;
      },
      fillCode(code) {
        const el = root.querySelector('#ws-code');
        if (!el) return false;
        el.value = code;
        el.focus({ preventScroll: true });
        return true;
      },
    };
  }

  global.APSSite = { mount };
})(window);

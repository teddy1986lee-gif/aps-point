/* APS 포인트 교환 — 관리자 페이지
   메뉴: 티켓 지급 / 풀팟 계정 / 회원·포인트 / 포인트 등록 / 설정
   티켓은 신청 즉시 풀팟으로 지급되므로, 여기서는 풀팟 응답을 받지 못한 '확인 필요' 건만 처리한다.
   mount(root, { transport, routing: 'hash' | 'memory', download(filename, text), sampleRows(), onRoute }) */
(function (global) {
  'use strict';
  const U = global.APSUI;
  const S = global.APSSheet;
  const { html, fmt } = U;

  const MENU = [
    ['exchanges', '티켓 지급', 'exchanges'],
    ['links', '풀팟 계정'],
    ['members', '회원·포인트'],
    ['upload', '포인트 등록'],
    ['settings', '설정'],
  ];
  const EYEBROW = { exchanges: 'TICKET ISSUE', links: 'FULPOT ACCOUNTS', members: 'MEMBERS & POINTS', upload: 'REGISTER POINTS', settings: 'SETTINGS' };
  const EX_TABS = [
    ['check', '확인 필요'],
    ['completed', '지급 완료'],
    ['failed', '지급 실패'],
    ['all', '전체'],
  ];
  const FAIL_PRESETS = [
    '풀팟 점검 시간에 신청되어 티켓을 지급하지 못했습니다. 포인트는 돌려 드렸으니 다시 신청해 주세요.',
    '풀팟 계정 상태 때문에 티켓을 지급하지 못했습니다. 운영팀에 문의해 주세요.',
    '같은 내용의 신청이 이미 지급되어 이 신청은 지급하지 않았습니다.',
  ];
  const RELEASE_PRESETS = [
    '회원 요청으로 연결을 해제했습니다.',
    '본인 계정이 아니라는 문의가 있어 연결을 해제했습니다. 본인 풀팟 ID로 다시 연결해 주세요.',
    '풀팟 계정 분실·양도 문의로 연결을 해제했습니다.',
  ];

  function defaultDownload(filename, text) {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function mount(root, opts = {}) {
    const api = U.createApi(opts.transport);
    const routing = opts.routing || 'hash';
    const download = opts.download || defaultDownload;
    const st = {
      ready: false,
      admin: null,
      badges: { exchanges: 0 },
      route: 'exchanges',
      id: null,
      ex: { tab: 'check', q: '', page: 1, data: null },
      links: { tab: 'active', q: '', data: null },
      members: { q: '', page: 1, data: null },
      member: { data: null },
      upload: freshUpload(),
      tab: 'direct',
      reg: freshReg(),
      settings: { data: null, fulpot: null },
      loginError: null,
      dialog: null,
      toast: null,
      loading: false,
    };
    let toastTimer = null;
    let busy = false;
    let deferred = false;

    function freshUpload() {
      return { basisAt: null, fileName: null, rows: null, preview: null, result: null, error: null, history: null, pointsAsOf: null, filter: 'all', missing: null };
    }
    function freshReg(keep) {
      return {
        key: U.uuid().replace(/-/g, ''),
        name: '',
        phone: '',
        memberNo: '',
        points: keep ? keep.points : '',
        reason: keep ? keep.reason : '',
        error: null,
        field: null,
        result: null,
        rows: keep ? keep.rows : null,
      };
    }

    const nav = U.createNav(routing, (r) => {
      parseRoute(r);
      load();
    });

    function parseRoute(r) {
      const [pagePart, id] = String(r || '').split('?')[0].split('/');
      st.route = MENU.some((m) => m[0] === pagePart) ? pagePart : 'exchanges';
      st.id = st.route === 'members' && id ? Number(id) : null;
      if (st.route === 'upload' && (id === 'direct' || id === 'file')) st.tab = id;
    }

    // ───────── 데이터 ─────────
    async function call(fn) {
      try {
        return await fn();
      } catch (e) {
        if (e.status === 401) {
          if (st.admin) toast('로그인이 끝났습니다. 다시 로그인해 주세요.', 'danger');
          st.admin = null;
          st.dialog = null;
          render();
        }
        throw e;
      }
    }

    async function start() {
      parseRoute(nav.get());
      try {
        const r = await api.get('/api/admin/session');
        st.admin = r.admin;
        if (r.badges) st.badges = r.badges;
      } catch (e) {
        st.fatal = e.message;
      }
      st.ready = true;
      if (st.admin) await load();
      else render();
    }

    async function load({ quiet = false } = {}) {
      if (!st.admin) return render();
      if (!quiet) {
        st.loading = true;
        render();
      }
      try {
        const q = U.qs;
        if (st.route === 'exchanges') st.ex.data = await call(() => api.get('/api/admin/exchanges' + q({ tab: st.ex.tab, q: st.ex.q, page: st.ex.page })));
        else if (st.route === 'links') st.links.data = await call(() => api.get('/api/admin/links' + q({ tab: st.links.tab, q: st.links.q })));
        else if (st.route === 'members' && st.id) st.member.data = await call(() => api.get(`/api/admin/members/${st.id}`));
        else if (st.route === 'members') st.members.data = await call(() => api.get('/api/admin/members' + q({ q: st.members.q, page: st.members.page })));
        else if (st.route === 'upload') {
          const [u, r] = await Promise.all([call(() => api.get('/api/admin/uploads')), call(() => api.get('/api/admin/registrations'))]);
          st.upload.history = u.uploads;
          st.upload.pointsAsOf = u.pointsAsOf;
          st.reg.rows = r.rows;
        } else if (st.route === 'settings') {
          const r = await call(() => api.get('/api/admin/settings'));
          st.settings.data = r.settings;
          st.settings.fulpot = r.fulpot;
        }
        const me = await call(() => api.get('/api/admin/me'));
        st.badges = me.badges;
      } catch (e) {
        if (e.status !== 401) toast(e.message, 'danger');
      }
      st.loading = false;
      render();
      if (!quiet) {
        if (routing === 'hash') global.scrollTo(0, 0);
        if (opts.onRoute) opts.onRoute(currentRoute());
      }
    }

    function currentRoute() {
      if (!st.admin) return 'login';
      return st.id ? `${st.route}/${st.id}` : st.route;
    }

    // 다른 곳(회원 화면, 정기 확인)에서 바뀐 내용 반영. 입력 중이면 입력을 마친 뒤에 다시 그린다.
    async function refresh() {
      if (!st.ready || !st.admin) return;
      if (st.dialog || U.typing(root)) {
        deferred = true;
        return;
      }
      deferred = false;
      await load({ quiet: true });
    }

    function toast(text, tone) {
      st.toast = { text, tone };
      clearTimeout(toastTimer);
      const el = root.querySelector('.ad-toast');
      if (el) {
        el.textContent = text;
        el.dataset.tone = tone || '';
      } else root.insertAdjacentHTML('beforeend', String(toastHtml()));
      toastTimer = setTimeout(() => {
        st.toast = null;
        const t = root.querySelector('.ad-toast');
        if (t) t.remove();
      }, 5000);
    }
    const toastHtml = () => (st.toast ? html`<div class="ad-toast" data-tone="${st.toast.tone || ''}" role="status">${st.toast.text}</div>` : '');

    // ───────── 그리기 ─────────
    function render() {
      if (!st.ready) {
        root.className = 'ad ad-guest';
        root.innerHTML = '<p class="ad-loading">불러오는 중</p>';
        return;
      }
      if (!st.admin) {
        root.className = 'ad ad-guest';
        root.innerHTML = String(loginPage()) + String(toastHtml());
        return;
      }
      root.className = 'ad';
      root.innerHTML = String(html`${top()}${side()}<main class="ad-main">${page()}</main>${dialog()}${toastHtml()}`);
      if (st.dialog && st.dialog.focus) {
        const el = root.querySelector(st.dialog.focus);
        if (el) el.focus({ preventScroll: true });
        st.dialog.focus = null;
      }
    }

    function top() {
      return html`<header class="ad-top">
        <div class="ad-brand"><span class="aps-mark" aria-hidden="true">APS</span><span>포인트 관리</span><span class="ad-brand-tag">ADMIN</span></div>
        <div class="ad-who"><span>${st.admin.name}</span><button type="button" class="ad-pill-line" data-act="logout">로그아웃</button></div>
      </header>`;
    }

    function side() {
      return html`<aside class="ad-side"><nav class="ad-nav" aria-label="관리 메뉴">
        ${MENU.map(([r, label, badge]) => {
          const n = badge ? st.badges[badge] : 0;
          return html`<a href="#/${r}" data-go="${r}" ${st.route === r ? html`aria-current="page"` : ''}><span>${label}</span>${n ? html`<span class="ad-badge" aria-label="확인 필요 ${n}건">${n}</span>` : ''}</a>`;
        })}
      </nav></aside>`;
    }

    function page() {
      if (st.route === 'links') return linksPage();
      if (st.route === 'members') return st.id ? memberPage() : membersPage();
      if (st.route === 'upload') return uploadPage();
      if (st.route === 'settings') return settingsPage();
      return exchangesPage();
    }

    const chip = (map, status) => {
      const x = map[status] || { label: status, tone: 'muted' };
      return html`<span class="tone-chip" data-tone="${x.tone}">${x.label}</span>`;
    };
    const loadingRow = () => html`<p class="ad-loading">불러오는 중</p>`;
    const head = (route, title, desc, actions) =>
      html`<div class="ad-head"><div><p class="ad-eyebrow">${EYEBROW[route]}</p><h1>${title}</h1>${desc ? html`<p>${desc}</p>` : ''}</div>${actions || ''}</div>`;

    function tabs(list, current, counts) {
      return html`<div class="ad-tabs" role="group" aria-label="보기">
        ${list.map(([k, label]) => html`<button type="button" data-act="tab" data-tab="${k}" aria-pressed="${current === k ? 'true' : 'false'}">${label}${counts && counts[k] != null ? html` <b>${counts[k]}</b>` : ''}</button>`)}
      </div>`;
    }

    function search(q, placeholder) {
      return html`<form class="ad-search" data-form="search" role="search">
        <input class="ad-input" name="q" value="${q}" placeholder="${placeholder}" aria-label="검색어" />
        <button class="ad-btn ad-btn-line" type="submit">검색</button>
      </form>`;
    }

    function pager(d) {
      if (!d || d.total <= d.pageSize) return '';
      const last = Math.ceil(d.total / d.pageSize);
      return html`<div class="ad-pager"><span>${fmt.num(d.total)}건 중 ${(d.page - 1) * d.pageSize + 1}–${Math.min(d.total, d.page * d.pageSize)}</span>
        <span class="ad-actions">
          <button type="button" class="ad-btn ad-btn-line ad-btn-sm" data-act="page" data-page="${d.page - 1}" ${d.page <= 1 ? 'disabled' : ''}>이전</button>
          <button type="button" class="ad-btn ad-btn-line ad-btn-sm" data-act="page" data-page="${d.page + 1}" ${d.page >= last ? 'disabled' : ''}>다음</button>
        </span></div>`;
    }

    // ───────── 로그인 ─────────
    function loginPage() {
      return html`<div class="ad-login">
        <span class="ad-login-deco" aria-hidden="true">ADMIN</span>
        <section class="ad-login-card" aria-label="관리자 로그인">
          <div class="ad-brand"><span class="aps-mark" aria-hidden="true">APS</span><span>포인트 관리</span></div>
          <p class="ad-eyebrow">ADMIN LOGIN</p>
          <h1>관리자 로그인</h1>
          <form class="ad-form" data-form="login" novalidate>
            <label class="ad-field" for="ad-user"><span>아이디</span><input class="ad-input" id="ad-user" name="username" autocomplete="username" autocapitalize="off" spellcheck="false" required /></label>
            <label class="ad-field" for="ad-pass"><span>비밀번호</span><input class="ad-input" id="ad-pass" name="password" type="password" autocomplete="current-password" required /></label>
            ${st.loginError ? html`<p class="ad-error" role="alert">${st.loginError}</p>` : ''}
            <button class="ad-btn" type="submit">로그인</button>
          </form>
          <p class="ad-login-note">비밀번호를 5번 틀리면 15분 동안 로그인이 잠깁니다. 관리자 계정은 서버 담당자가 만듭니다.</p>
        </section>
      </div>`;
    }

    // ───────── 티켓 지급 ─────────
    function exStatusDetail(x) {
      if (x.status === 'check') {
        return html`<span class="ad-sub ad-note-text">${x.note || '풀팟 응답을 받지 못함'}</span><span class="ad-sub">요청 ${x.attempts}회 · 마지막 조회 ${x.checkedAt ? fmt.relative(x.checkedAt) : '아직 없음'}</span>`;
      }
      if (x.status === 'issuing') return html`<span class="ad-sub">풀팟 응답 기다리는 중 · ${fmt.relative(x.requestedAt)} 요청</span>`;
      if (x.status === 'completed') {
        return html`<span class="ad-sub">지급 번호 <span class="ad-code">${x.payoutRef}</span></span><span class="ad-sub">${fmt.short(x.completedAt)} · ${x.handledBy || '자동'}${x.note && /바로잡음|관리자/.test(x.note) ? ` · ${x.note}` : ''}</span>`;
      }
      if (x.status === 'failed') return html`<span class="ad-sub ad-fail-reason">${x.reason}</span><span class="ad-sub">${fmt.short(x.closedAt)} · ${x.handledBy || '자동'}</span>`;
      return '';
    }

    function exActions(x) {
      if (x.status === 'check') {
        return html`<div class="ad-action-grid">
          <button type="button" class="ad-btn ad-btn-sm" data-act="ex-query" data-id="${x.id}">풀팟에서 확인</button>
          <button type="button" class="ad-btn ad-btn-line ad-btn-sm" data-act="ex-retry" data-id="${x.id}">다시 요청</button>
          <button type="button" class="ad-btn ad-btn-line ad-btn-sm" data-act="ex-complete" data-id="${x.id}">지급 번호로 완료</button>
          <button type="button" class="ad-btn ad-btn-danger ad-btn-sm" data-act="ex-fail" data-id="${x.id}">지급 실패 처리</button>
        </div>`;
      }
      if (x.status === 'issuing') return html`<span class="ad-muted">결과 기다리는 중</span>`;
      return '';
    }

    function exTable(rows, { showMember = true } = {}) {
      return html`<div class="ad-table-wrap"><table class="ad-table">
        <thead><tr><th scope="col">신청번호</th>${showMember ? html`<th scope="col">회원</th>` : ''}<th scope="col">받을 계정</th><th scope="col" class="ad-r">수량</th><th scope="col">상태</th><th scope="col">처리</th></tr></thead>
        <tbody>${rows.map(
          (x) => html`<tr ${x.status === 'check' ? html`data-attn="true"` : ''}>
            <td><span class="ad-code">${x.no}</span><span class="ad-sub">${fmt.dateTime(x.createdAt)} 신청</span></td>
            ${showMember ? html`<td><a href="#/members/${x.member.id}" data-go="members/${x.member.id}">${x.member.name}</a><span class="ad-sub">${x.member.memberNo} · ${x.member.phone}</span></td>` : ''}
            <td><span class="ad-code">${x.fulpotId}</span><span class="ad-sub">풀팟 번호 ${x.fulpotUid}</span></td>
            <td class="ad-r">${x.quantity}장<span class="ad-sub">${fmt.points(x.totalPoints)}</span></td>
            <td class="ad-wrap">${chip(U.EXCHANGE_ADMIN, x.status)}${exStatusDetail(x)}</td>
            <td>${exActions(x)}</td>
          </tr>`
        )}</tbody>
      </table></div>`;
    }

    function exchangesPage() {
      const E = st.ex;
      const d = E.data;
      let table;
      if (!d) table = loadingRow();
      else if (!d.rows.length) {
        table = html`<div class="ad-empty">${E.q ? html`<p>검색 결과가 없습니다.</p>` : E.tab === 'check' ? html`<p class="ad-empty-title">확인할 지급이 없습니다</p><p>회원 신청은 풀팟에 바로 지급되고 있습니다.</p>` : html`<p>신청이 없습니다.</p>`}</div>`;
      } else table = html`${exTable(d.rows)}${pager(d)}`;
      const counts = d ? d.counts : null;
      return html`${head('exchanges', '티켓 지급', '회원이 신청하면 풀팟에 바로 지급됩니다. 풀팟 응답을 받지 못한 신청만 확인 필요에 남고, 서버가 1분마다 풀팟 지급 기록을 조회해 지급된 건은 자동으로 완료합니다.')}
        ${E.tab === 'check' && d && d.rows.length
          ? html`<div class="ad-callout ad-gap ad-howto" data-tone="warn">
              <p><b>확인 필요 처리 순서</b> 먼저 <b>풀팟에서 확인</b>으로 지급 기록을 조회합니다. 기록이 없으면 <b>다시 요청</b>하거나(같은 신청번호라 두 번 지급되지 않음) <b>지급 실패 처리</b>로 포인트를 돌려줍니다. 풀팟 관리 도구에서 지급을 직접 확인했다면 <b>지급 번호로 완료</b>를 씁니다.</p>
            </div>`
          : ''}
        <div class="ad-toolbar">${tabs(EX_TABS, E.tab, counts)}${search(E.q, '이름, 회원번호, 신청번호, 풀팟 ID, 지급 번호')}</div>
        <section class="ad-panel">${table}</section>`;
    }

    // ───────── 풀팟 계정 ─────────
    function linksPage() {
      const L = st.links;
      const d = L.data;
      const active = L.tab !== 'released';
      let table;
      if (!d) table = loadingRow();
      else if (!d.rows.length) table = html`<p class="ad-empty">${L.q ? '검색 결과가 없습니다.' : active ? '연결된 계정이 없습니다.' : '해제 기록이 없습니다.'}</p>`;
      else
        table = html`<div class="ad-table-wrap"><table class="ad-table">
          <thead><tr><th scope="col">${active ? '연결일시' : '해제일시'}</th><th scope="col">회원</th><th scope="col">풀팟 계정</th>${active ? html`<th scope="col">처리</th>` : html`<th scope="col">구분</th><th scope="col">사유·처리자</th>`}</tr></thead>
          <tbody>${d.rows.map((x) => (active ? linkActiveRow(x) : linkReleasedRow(x)))}</tbody>
        </table></div>`;
      return html`${head('links', '풀팟 계정', '회원이 풀팟 ID를 넣으면 풀팟에서 계정을 확인해 바로 연결합니다(승인 없음). 잘못 연결됐거나 분실·양도 문의가 있으면 연결을 해제하세요.')}
        <div class="ad-toolbar">${tabs(
          [
            ['active', '연결됨'],
            ['released', '해제 기록'],
          ],
          active ? 'active' : 'released',
          d ? d.counts : null
        )}${search(L.q, '이름, 회원번호, 풀팟 ID, 닉네임')}</div>
        <section class="ad-panel">${table}</section>`;
    }

    const accountCell = (x) => html`<span class="ad-code">${x.fulpotId}</span>${x.nickname ? html`<span class="ad-sub">닉네임 ${x.nickname}</span>` : ''}<span class="ad-sub">풀팟 번호 ${x.fulpotUid}</span>`;

    function linkActiveRow(x) {
      return html`<tr>
        <td>${fmt.dateTime(x.linkedAt)}</td>
        <td><a href="#/members/${x.member.id}" data-go="members/${x.member.id}">${x.member.name}</a><span class="ad-sub">${x.member.memberNo} · ${x.member.phone}</span>${x.member.status !== 'active' ? html`<span class="ad-warn">이용 중지된 회원</span>` : ''}</td>
        <td>${accountCell(x)}</td>
        <td><button type="button" class="ad-btn ad-btn-danger ad-btn-sm" data-act="link-release" data-id="${x.id}">연결 해제</button></td>
      </tr>`;
    }

    function linkReleasedRow(x) {
      return html`<tr>
        <td>${fmt.dateTime(x.releasedAt)}</td>
        <td><a href="#/members/${x.member.id}" data-go="members/${x.member.id}">${x.member.name}</a><span class="ad-sub">${x.member.memberNo}</span></td>
        <td>${accountCell(x)}<span class="ad-sub">${fmt.short(x.linkedAt)} 연결</span></td>
        <td>${chip({ changed: { label: '회원이 변경', tone: 'muted' }, admin: { label: '관리자 해제', tone: 'warn' } }, x.releaseKind)}</td>
        <td class="ad-wrap">${x.releaseReason || ''}<span class="ad-sub">${x.releasedBy || ''}</span></td>
      </tr>`;
    }

    // ───────── 회원·포인트 ─────────
    function membersPage() {
      const M = st.members;
      const d = M.data;
      let table;
      if (!d) table = loadingRow();
      else if (!d.rows.length) table = html`<p class="ad-empty">${M.q ? '검색 결과가 없습니다.' : '등록된 회원이 없습니다. 포인트 등록에서 직접 등록하거나 파일을 올리면 회원이 만들어집니다.'}</p>`;
      else
        table = html`<div class="ad-table-wrap"><table class="ad-table">
          <thead><tr><th scope="col">회원번호</th><th scope="col">이름</th><th scope="col">휴대폰</th><th scope="col">풀팟 계정</th><th scope="col" class="ad-r">총 보유</th><th scope="col" class="ad-r">사용 대기</th><th scope="col" class="ad-r">사용 가능</th><th scope="col">상태</th></tr></thead>
          <tbody>${d.rows.map(
            (m) => html`<tr data-href="members/${m.id}">
              <td><a href="#/members/${m.id}" data-go="members/${m.id}" class="ad-code">${m.memberNo}</a>${m.direct ? html`<span class="ad-sub">직접 등록</span>` : ''}</td>
              <td>${m.name}</td>
              <td>${m.phone}</td>
              <td>${m.fulpotId ? html`<span class="ad-code">${m.fulpotId}</span>${m.fulpotNickname ? html`<span class="ad-sub">${m.fulpotNickname}</span>` : ''}` : html`<span class="ad-muted">연결 안 됨</span>`}</td>
              <td class="ad-r">${fmt.points(m.points.total)}</td>
              <td class="ad-r">${m.points.pending ? fmt.points(m.points.pending) : html`<span class="ad-muted">0P</span>`}</td>
              <td class="ad-r"><b>${fmt.points(m.points.available)}</b></td>
              <td>${m.status === 'active' ? html`<span class="ad-muted">이용 중</span>` : chip({ stopped: { label: '이용 중지', tone: 'danger' } }, 'stopped')}${m.checks ? html` ${chip({ c: { label: `확인 필요 ${m.checks}`, tone: 'warn' } }, 'c')}` : ''}</td>
            </tr>`
          )}</tbody>
        </table></div>${pager(d)}`;
      return html`${head(
        'members',
        '회원·포인트',
        '회원을 눌러 포인트 내역, 티켓 지급 내역, 정보 수정과 포인트 조정을 할 수 있습니다.',
        html`<button type="button" class="ad-btn" data-go="upload/direct">회원 직접 등록</button>`
      )}
        <div class="ad-toolbar"><span class="ad-muted">${d ? `${fmt.num(d.total)}명` : ''}</span>${search(M.q, '이름, 휴대폰, 회원번호, 풀팟 ID')}</div>
        <section class="ad-panel">${table}</section>`;
    }

    function memberPage() {
      const d = st.member.data;
      if (!d || d.member.id !== st.id) return html`<a class="ad-back" href="#/members" data-go="members">회원 목록으로</a>${loadingRow()}`;
      const m = d.member;
      const p = m.points;
      const activeLink = d.links.find((l) => l.status === 'active');
      const ledgerRows = d.ledger.length
        ? html`<div class="ad-table-wrap"><table class="ad-table">
            <thead><tr><th scope="col">발생일</th><th scope="col">구분</th><th scope="col">내용</th><th scope="col" class="ad-r">포인트</th><th scope="col">처리</th></tr></thead>
            <tbody>${d.ledger.map(
              (r) => html`<tr>
                <td>${fmt.smart(r.occurredAt)}</td>
                <td>${U.LEDGER[r.kind]}</td>
                <td class="ad-wrap">${r.memo || ''}${r.sourceRef ? html`<span class="ad-sub">건 번호 ${r.sourceRef}</span>` : ''}${r.exchangeNo ? html`<span class="ad-sub ad-code">${r.exchangeNo}</span>` : ''}</td>
                <td class="ad-r"><b>${fmt.signed(r.amount)}</b></td>
                <td><span class="ad-sub">${fmt.short(r.createdAt)} · ${r.createdBy || '-'}</span></td>
              </tr>`
            )}</tbody></table></div>`
        : html`<p class="ad-empty">포인트 내역이 없습니다.</p>`;
      const exRows = d.exchanges.length ? exTable(d.exchanges, { showMember: false }) : html`<p class="ad-empty">티켓 교환 내역이 없습니다.</p>`;
      const linkRows = d.links.length
        ? html`<div class="ad-table-wrap"><table class="ad-table">
            <thead><tr><th scope="col">풀팟 계정</th><th scope="col">상태</th><th scope="col">연결</th><th scope="col">해제</th></tr></thead>
            <tbody>${d.links.map(
              (l) => html`<tr>
                <td>${accountCell(l)}</td>
                <td>${chip(U.LINK, l.status)}</td>
                <td>${fmt.dateTime(l.linkedAt)}</td>
                <td class="ad-wrap">${l.status === 'released' ? html`${l.releaseReason || ''}<span class="ad-sub">${fmt.short(l.releasedAt)} · ${l.releasedBy || ''}</span>` : html`<button type="button" class="ad-btn ad-btn-danger ad-btn-sm" data-act="link-release" data-id="${l.id}">연결 해제</button>`}</td>
              </tr>`
            )}</tbody></table></div>`
        : html`<p class="ad-empty">풀팟 계정을 연결한 적이 없습니다.</p>`;

      return html`<a class="ad-back" href="#/members" data-go="members">회원 목록으로</a>
        <div class="ad-head"><div><p class="ad-eyebrow">MEMBER</p><h1>${m.name} <span class="ad-code ad-h1-no">${m.memberNo}</span></h1>
          <p>${m.phone} · 풀팟 ${activeLink ? `${activeLink.fulpotId}${activeLink.nickname ? ` (${activeLink.nickname})` : ''}` : '연결 안 됨'}${m.lastLoginAt ? ` · 최근 로그인 ${fmt.short(m.lastLoginAt)}` : ''}${m.direct ? ' · 관리자 직접 등록' : ''}</p></div>
          ${m.status === 'active' ? chip({ a: { label: '이용 중', tone: 'ok' } }, 'a') : chip({ s: { label: '이용 중지', tone: 'danger' } }, 's')}</div>
        ${m.duplicates.length ? html`<p class="ad-callout ad-gap" data-tone="warn">같은 이름·휴대폰 번호의 회원 기록이 더 있습니다: ${m.duplicates.join(', ')}. 이 상태에서는 회원이 로그인할 수 없으니 한쪽 기록의 번호를 고치거나 이용 중지해 주세요.</p>` : ''}
        <div class="ad-grid2">
          <section class="ad-panel">
            <div class="ad-panel-head"><h2>포인트</h2></div>
            <div class="ad-panel-body">
              <dl class="ad-points">
                <div class="ad-points-main"><dt>사용 가능</dt><dd>${fmt.points(p.available)}</dd></div>
                <div><dt>총 보유</dt><dd>${fmt.points(p.total)}</dd></div>
                <div><dt>사용 대기</dt><dd>${fmt.points(p.pending)}</dd></div>
              </dl>
              <form class="ad-form" data-form="adjust" novalidate>
                <div class="ad-form-row">
                  <label class="ad-field" for="ad-amt"><span>조정 포인트</span><input class="ad-input" id="ad-amt" name="amount" inputmode="numeric" placeholder="예) 40 또는 -40" required /></label>
                  <label class="ad-field" for="ad-why"><span>사유</span><input class="ad-input" id="ad-why" name="reason" maxlength="100" placeholder="예) 9월 대회 누락분" required /></label>
                </div>
                <div class="ad-actions"><button class="ad-btn" type="submit">포인트 조정</button><span class="ad-sub ad-hint">빼는 경우 사용 가능 포인트까지만 뺄 수 있습니다.</span></div>
              </form>
            </div>
          </section>
          <section class="ad-panel">
            <div class="ad-panel-head"><h2>회원 정보</h2></div>
            <div class="ad-panel-body">
              <form class="ad-form" data-form="member" novalidate>
                <div class="ad-form-row">
                  <label class="ad-field" for="ad-mno"><span>회원번호</span><input class="ad-input" id="ad-mno" name="memberNo" value="${m.memberNo}" maxlength="30" autocapitalize="characters" spellcheck="false" required />${m.memberNo.startsWith('WEB-') ? html`<small>APS 공식 회원번호가 나오면 바꿔 주세요. 그래야 명단 파일이 이 회원에게 반영됩니다.</small>` : ''}</label>
                  <label class="ad-field" for="ad-mname"><span>이름</span><input class="ad-input" id="ad-mname" name="name" value="${m.name}" maxlength="40" required /></label>
                </div>
                <div class="ad-form-row">
                  <label class="ad-field" for="ad-mphone"><span>휴대폰</span><input class="ad-input" id="ad-mphone" name="phone" value="${m.phone}" inputmode="numeric" required /></label>
                  <label class="ad-field" for="ad-mstatus"><span>상태</span>
                    <select class="ad-select" id="ad-mstatus" name="status">
                      <option value="active" ${m.status === 'active' ? 'selected' : ''}>이용 중</option>
                      <option value="stopped" ${m.status === 'stopped' ? 'selected' : ''}>이용 중지 (로그인과 교환 막음)</option>
                    </select></label>
                </div>
                <label class="ad-field" for="ad-mmemo"><span>메모</span><input class="ad-input" id="ad-mmemo" name="memo" value="${m.memo}" maxlength="300" placeholder="운영팀만 보는 메모" /></label>
                <div class="ad-actions"><button class="ad-btn ad-btn-line" type="submit">회원 정보 저장</button><span class="ad-sub ad-hint">번호를 바꾸면 회원의 기존 로그인은 끝납니다.</span></div>
              </form>
            </div>
          </section>
        </div>
        <section class="ad-panel"><div class="ad-panel-head"><h2>티켓 지급</h2><span class="ad-muted">${d.exchanges.length}건</span></div>${exRows}</section>
        <section class="ad-panel"><div class="ad-panel-head"><h2>풀팟 계정</h2><span class="ad-muted">한 회원에 계정 하나, 바꾸면 이전 연결은 해제 기록으로 남습니다</span></div>${linkRows}</section>
        <section class="ad-panel"><div class="ad-panel-head"><h2>포인트 내역</h2><span class="ad-muted">${d.ledger.length}건</span></div>${ledgerRows}</section>`;
    }

    // ───────── 포인트 등록: 직접 등록 + 엑셀 파일 ─────────
    const RESULT = {
      ok: ['반영', 'ok'],
      new: ['새 회원 + 반영', 'info'],
      dup: ['이미 반영됨', 'muted'],
      error: ['오류', 'danger'],
    };

    function uploadPage() {
      return html`${head(
        'upload',
        '포인트 등록',
        '현장·전화로 받은 회원은 이름과 휴대폰 번호로 바로 등록하고, 대회 적립 자료는 엑셀·CSV 파일로 한꺼번에 올립니다.',
        st.tab === 'file' ? html`<button type="button" class="ad-btn ad-btn-line" data-act="template">양식 내려받기</button>` : ''
      )}
        <div class="ad-toolbar">${tabs(
          [
            ['direct', '직접 등록'],
            ['file', '엑셀 파일 등록'],
          ],
          st.tab
        )}</div>
        ${st.tab === 'file' ? filePage() : directPage()}`;
    }

    function regResult() {
      const R = st.reg.result;
      if (!R) return '';
      const m = R.member;
      const who = html`<b>${m.name}</b> <span class="ad-code">${m.memberNo}</span> · ${m.phone}`;
      const detailLink = html`<button type="button" class="ad-link" data-go="members/${m.id}">회원 상세</button>`;
      if (R.result === 'exists') {
        const pts = Number(R.points) || 0;
        return html`<div class="ad-callout ad-reg-result" data-tone="warn" role="status">
          <p>이미 등록된 회원입니다: ${who} · 사용 가능 ${fmt.points(m.points.available)}${R.duplicates && R.duplicates.length ? ` (같은 기록 ${R.duplicates.join(', ')})` : ''}</p>
          <p>새 회원을 만들지 않았습니다.${pts ? ' 이 회원에게 포인트를 지급할까요?' : ''}</p>
          <div class="ad-actions">
            ${pts ? html`<button type="button" class="ad-btn" data-act="reg-grant" data-id="${m.id}">이 회원에게 ${fmt.points(pts)} 지급</button>` : ''}
            ${detailLink}
            <button type="button" class="ad-link" data-act="reg-dismiss">닫기</button>
          </div>
        </div>`;
      }
      const msg =
        R.result === 'granted'
          ? html`${who}에게 ${fmt.points(R.points)}를 지급했습니다. 사용 가능 ${fmt.points(m.points.available)}`
          : html`${who} 회원을 등록했습니다.${R.points ? html` ${fmt.points(R.points)}를 지급했습니다.` : ''}`;
      return html`<div class="ad-callout ad-reg-result" data-tone="ok" role="status">
        <p>${msg}${R.replayed ? ' (이미 처리된 요청)' : ''}</p>
        ${(R.warnings || []).map((w) => html`<p class="ad-warn">${w}</p>`)}
        <div class="ad-actions">${detailLink}</div>
      </div>`;
    }

    function directPage() {
      const R = st.reg;
      const bad = (f) => (R.error && R.field === f ? html`aria-invalid="true"` : '');
      const rows = R.rows;
      const history = rows
        ? rows.length
          ? html`<div class="ad-table-wrap"><table class="ad-table">
              <thead><tr><th scope="col">처리일시</th><th scope="col">구분</th><th scope="col">회원</th><th scope="col" class="ad-r">포인트</th><th scope="col">사유</th><th scope="col">처리</th></tr></thead>
              <tbody>${rows.map(
                (r) => html`<tr>
                  <td>${fmt.dateTime(r.createdAt)}</td>
                  <td>${chip({ created: { label: '새 회원', tone: 'info' }, granted: { label: '기존 회원 지급', tone: 'ok' } }, r.kind)}</td>
                  <td><a href="#/members/${r.member.id}" data-go="members/${r.member.id}">${r.member.name}</a><span class="ad-sub">${r.member.memberNo} · ${r.member.phone}</span></td>
                  <td class="ad-r">${r.points ? fmt.signed(r.points) : html`<span class="ad-muted">-</span>`}</td>
                  <td class="ad-wrap">${r.reason || ''}</td>
                  <td><span class="ad-sub">${r.createdBy || '-'}</span></td>
                </tr>`
              )}</tbody></table></div>`
          : html`<p class="ad-empty">아직 직접 등록한 기록이 없습니다.</p>`
        : loadingRow();
      return html`<div class="ad-grid2 ad-grid-reg">
          <section class="ad-panel">
            <div class="ad-panel-head"><h2>회원 직접 등록</h2><span class="ad-muted">* 표시는 꼭 입력</span></div>
            <div class="ad-panel-body">
              <form class="ad-form" data-form="register" novalidate>
                <div class="ad-form-row">
                  <label class="ad-field" for="ad-r-name"><span>이름 *</span><input class="ad-input" id="ad-r-name" name="name" value="${R.name}" maxlength="40" autocomplete="off" required ${bad('name')} /></label>
                  <label class="ad-field" for="ad-r-phone"><span>휴대폰 번호 *</span><input class="ad-input" id="ad-r-phone" name="phone" value="${R.phone}" inputmode="numeric" placeholder="010-0000-0000" maxlength="13" autocomplete="off" required ${bad('phone')} /></label>
                </div>
                <div class="ad-form-row">
                  <label class="ad-field" for="ad-r-points"><span>지급 포인트</span><input class="ad-input" id="ad-r-points" name="points" value="${R.points}" inputmode="numeric" placeholder="예) 80" ${bad('points')} /><small>비우면 포인트 없이 회원만 등록</small></label>
                  <label class="ad-field" for="ad-r-reason"><span>지급 사유</span><input class="ad-input" id="ad-r-reason" name="reason" value="${R.reason}" maxlength="100" placeholder="예) APS 서울 위성전 현장 참가" ${bad('reason')} /><small>회원 포인트 내역에 보입니다</small></label>
                </div>
                <label class="ad-field" for="ad-r-no"><span>APS 회원번호 (선택)</span><input class="ad-input" id="ad-r-no" name="memberNo" value="${R.memberNo}" maxlength="30" autocapitalize="characters" spellcheck="false" placeholder="예) APS-10041" ${bad('memberNo')} /><small>모르면 비워 두세요. 공식 번호와 겹치지 않는 내부 번호 WEB-00001부터 붙습니다.</small></label>
                ${R.error ? html`<p class="ad-error" role="alert">${R.error}</p>` : ''}
                <div class="ad-actions"><button class="ad-btn" type="submit">등록하기</button><span class="ad-sub ad-hint">같은 이름·휴대폰의 회원이 있으면 새로 만들지 않습니다.</span></div>
              </form>
              ${regResult()}
            </div>
          </section>
          <section class="ad-panel">
            <div class="ad-panel-head"><h2>이렇게 처리됩니다</h2></div>
            <div class="ad-panel-body">
              <ol class="ad-steps">
                <li><span>이름·휴대폰 번호로 회원을 만들고, 넣은 포인트를 바로 적립합니다. 회원은 그 번호로 곧바로 로그인할 수 있습니다.</span></li>
                <li><span>같은 이름·휴대폰의 회원이 이미 있으면 새로 만들지 않고, <b>그 회원에게 지급</b>할지 묻습니다.</span></li>
                <li><span>등록한 뒤에도 지급 포인트와 사유는 칸에 남아, 같은 대회 참가자를 이어서 등록할 수 있습니다.</span></li>
                <li><span>나중에 APS 명단 파일에 공식 회원번호로 올라오면 파일 등록이 그 행을 오류로 알려 줍니다. 회원 상세에서 회원번호를 공식 번호로 바꾼 뒤 다시 올리세요.</span></li>
              </ol>
            </div>
          </section>
        </div>
        <section class="ad-panel"><div class="ad-panel-head"><h2>직접 등록 기록</h2><span class="ad-muted">최근 50건</span></div>${history}</section>`;
    }

    function filePage() {
      const P = st.upload;
      const fields = S.FIELDS.points;
      const basis = P.basisAt != null ? P.basisAt : Date.now();
      let previewPanel = '';
      if (P.preview) {
        const sum = P.preview.summary;
        const items = P.preview.items.filter((x) => (P.filter === 'apply' ? x.result === 'ok' || x.result === 'new' : P.filter === 'skip' ? x.result === 'error' || x.result === 'dup' : true));
        previewPanel = html`<section class="ad-panel">
          <div class="ad-panel-head"><h2>2. 미리보기 · ${P.fileName}</h2>
            <div class="ad-summary">
              <span data-tone="ok">반영 ${sum.apply}건</span>
              ${sum.newMembers ? html`<span data-tone="info">새 회원 ${sum.newMembers}명</span>` : ''}
              ${sum.dup ? html`<span>이미 반영 ${sum.dup}건</span>` : ''}
              ${sum.error ? html`<span data-tone="danger">오류 ${sum.error}건</span>` : ''}
              <span>합계 ${fmt.signed(sum.points)}</span>
            </div></div>
          <div class="ad-panel-body">
            <div class="ad-toolbar ad-toolbar-flush">
              <div class="ad-tabs" role="group" aria-label="미리보기 보기">
                ${[
                  ['all', `전체 ${sum.total}`],
                  ['apply', `반영할 행 ${sum.apply}`],
                  ['skip', `건너뛸 행 ${sum.total - sum.apply}`],
                ].map(([k, label]) => html`<button type="button" data-act="filter" data-tab="${k}" aria-pressed="${P.filter === k ? 'true' : 'false'}">${label}</button>`)}
              </div>
              <div class="ad-actions">
                <button type="button" class="ad-btn ad-btn-line" data-act="upload-reset">다른 파일 고르기</button>
                <button type="button" class="ad-btn" data-act="upload-commit" ${sum.apply ? '' : 'disabled'}>${sum.apply}건 반영하기</button>
              </div>
            </div>
          </div>
          <div class="ad-table-wrap"><table class="ad-table">
            <thead><tr><th scope="col" class="ad-r">행</th><th scope="col">결과</th><th scope="col">회원번호</th><th scope="col">이름</th><th scope="col" class="ad-r">포인트</th><th scope="col">건 번호</th><th scope="col">적립일</th><th scope="col">사유·확인할 점</th></tr></thead>
            <tbody>${items.slice(0, 500).map(
              (x) => html`<tr>
                <td class="ad-r ad-muted">${x.row}</td>
                <td>${chip({ [x.result]: { label: RESULT[x.result][0], tone: RESULT[x.result][1] } }, x.result)}</td>
                <td class="ad-code">${x.memberNo || ''}</td>
                <td>${x.name || ''}</td>
                <td class="ad-r">${x.points != null ? fmt.signed(x.points) : ''}</td>
                <td>${x.sourceRef || ''}</td>
                <td>${x.earnedAt ? fmt.smart(x.earnedAt) : ''}</td>
                <td class="ad-wrap"><ul class="ad-msgs">
                  ${x.result !== 'error' ? html`<li>${x.reason}</li>` : ''}
                  ${x.messages.map((t) => html`<li data-tone="${x.result === 'error' ? 'danger' : ''}">${t}</li>`)}
                  ${x.warnings.map((t) => html`<li data-tone="warn">${t}</li>`)}
                </ul></td>
              </tr>`
            )}</tbody></table></div>
          ${items.length > 500 ? html`<p class="ad-pager">처음 500행만 보여 줍니다. 반영은 모든 정상 행에 적용됩니다.</p>` : ''}
        </section>`;
      }
      const history = P.history
        ? P.history.length
          ? html`<div class="ad-table-wrap"><table class="ad-table">
              <thead><tr><th scope="col">반영일시</th><th scope="col">파일</th><th scope="col">자료 기준</th><th scope="col" class="ad-r">반영</th><th scope="col" class="ad-r">포인트</th><th scope="col" class="ad-r">새 회원</th><th scope="col" class="ad-r">건너뜀</th><th scope="col">처리</th></tr></thead>
              <tbody>${P.history.map(
                (u) => html`<tr>
                  <td>${fmt.dateTime(u.createdAt)}</td>
                  <td class="ad-wrap">${u.fileName || '-'}</td>
                  <td>${fmt.dateTime(u.basisAt)}</td>
                  <td class="ad-r">${u.appliedRows}건</td>
                  <td class="ad-r">${fmt.signed(u.appliedPoints)}</td>
                  <td class="ad-r">${u.newMembers}명</td>
                  <td class="ad-r">${u.skippedRows}건</td>
                  <td><span class="ad-sub">${u.createdBy || '-'}</span></td>
                </tr>`
              )}</tbody></table></div>`
          : html`<p class="ad-empty">아직 등록한 파일이 없습니다.</p>`
        : loadingRow();

      return html`${P.result ? html`<p class="ad-callout ad-gap" data-tone="ok">${P.result}</p>` : ''}
        <div class="ad-grid2">
          <section class="ad-panel">
            <div class="ad-panel-head"><h2>1. 파일 고르기</h2></div>
            <div class="ad-panel-body ad-form">
              <label class="ad-field" for="ad-basis"><span>자료 기준 시점</span>
                <input class="ad-input" id="ad-basis" name="basisAt" type="datetime-local" value="${fmt.dateTimeInput(basis)}" />
                <small>회원 화면에 '포인트 자료 기준'으로 보입니다. 지금 기준: ${fmt.asOf(P.pointsAsOf)}</small></label>
              <div class="ad-drop" data-drop>
                <p>파일을 여기에 끌어 놓거나</p>
                <label class="ad-btn ad-btn-line" for="ad-file">파일 고르기</label>
                <input id="ad-file" type="file" accept=".xlsx,.xlsm,.csv,.tsv,.txt" data-file hidden />
                <span class="ad-sub">.xlsx 또는 .csv · 첫 번째 시트를 읽습니다</span>
              </div>
              ${opts.sampleRows ? html`<button type="button" class="ad-link" data-act="sample">예시 자료로 해 보기</button>` : ''}
              ${P.missing ? html`<p class="ad-error" role="alert">필수 열을 찾지 못했습니다: ${P.missing.join(', ')}. 첫 줄에 열 이름이 있는지 확인해 주세요.</p>` : ''}
              ${P.error ? html`<p class="ad-error" role="alert">${P.error}</p>` : ''}
            </div>
          </section>
          <section class="ad-panel">
            <div class="ad-panel-head"><h2>파일 형식</h2></div>
            <div class="ad-panel-body ad-form">
              <div class="ad-columns">${fields.map((f) => html`<code>${f.label}${f.required ? html`<b>*</b>` : ''}</code>`)}</div>
              <ul class="ad-msgs ad-bullets">
                <li>* 표시 열은 꼭 있어야 합니다. 열 순서와 띄어쓰기는 상관없습니다.</li>
                <li>처음 보는 회원번호는 이름과 휴대폰 번호가 있으면 새 회원으로 등록합니다.</li>
                <li>있는 회원은 이름이 회원 기록과 같아야 반영합니다.</li>
                <li>포인트를 뺄 때는 음수(-40)로 적습니다. 사용 가능 포인트까지만 뺄 수 있습니다.</li>
                <li>같은 회원에게 같은 건 번호는 한 번만 반영되어, 같은 파일을 다시 올려도 두 번 쌓이지 않습니다.</li>
              </ul>
            </div>
          </section>
        </div>
        ${previewPanel}
        <section class="ad-panel"><div class="ad-panel-head"><h2>파일 등록 기록</h2></div>${history}</section>`;
    }

    async function readUpload(file) {
      const P = st.upload;
      P.error = null;
      P.missing = null;
      P.result = null;
      try {
        const out = await S.readFile(file);
        if (!out.rows.length) throw new Error('파일에 내용이 없습니다.');
        const det = S.detect(out.rows, 'points');
        const missing = det.fields.filter((f) => f.required && det.mapping[f.key] == null).map((f) => f.label);
        if (missing.length) {
          P.missing = missing;
          P.preview = null;
          return render();
        }
        await previewRows(file.name, S.toObjects(out.rows, det.headerIndex, det.mapping));
      } catch (e) {
        P.error = e.message;
        P.preview = null;
        render();
      }
    }

    async function previewRows(fileName, rows) {
      const P = st.upload;
      const basisEl = root.querySelector('#ad-basis');
      if (basisEl) P.basisAt = fmt.parseInput(basisEl.value);
      P.fileName = fileName;
      P.rows = rows;
      P.filter = 'all';
      try {
        P.preview = await call(() => api.post('/api/admin/upload/preview', { fileName, rows, basisAt: P.basisAt }));
        P.error = null;
      } catch (e) {
        if (e.status === 401) return;
        P.error = e.message;
        P.preview = null;
      }
      render();
    }

    async function submitRegister(body) {
      const R = st.reg;
      try {
        const r = await call(() => api.post('/api/admin/registrations', { ...body, requestKey: R.key }));
        if (r.result === 'exists') {
          R.result = r;
          R.error = null;
          R.field = null;
        } else {
          st.reg = { ...freshReg(R), result: r };
          toast(r.result === 'granted' ? `${r.member.name} 회원에게 ${fmt.points(r.points)}를 지급했습니다.` : `${r.member.name}(${r.member.memberNo}) 회원을 등록했습니다.`);
          try {
            st.reg.rows = (await call(() => api.get('/api/admin/registrations'))).rows;
          } catch {
            /* 다음에 다시 */
          }
        }
      } catch (e) {
        if (e.status === 401) return;
        R.error = e.message;
        R.field = (e.details && e.details.field) || null;
        R.result = null;
      }
      render();
      if (st.reg.result && st.reg.result.result !== 'exists') focusEl('#ad-r-name');
      else if (R.field) focusEl(`[name="${R.field}"]`);
    }

    // ───────── 설정 ─────────
    function settingsPage() {
      const s = st.settings.data;
      const f = st.settings.fulpot;
      if (!s) return html`${head('settings', '설정')}${loadingRow()}`;
      return html`${head('settings', '설정', '바꾼 값은 저장하는 즉시 회원 화면에 반영됩니다.')}
        ${f
          ? html`<section class="ad-panel ad-gap">
              <div class="ad-panel-head"><h2>풀팟 연동</h2>${chip({ mock: { label: '모의 풀팟', tone: 'warn' }, http: { label: '풀팟 API', tone: 'ok' } }, f.mode)}</div>
              <div class="ad-panel-body">
                <dl class="ad-kv ad-kv-wide">
                  <div><dt>연동 방식</dt><dd>${f.label}</dd></div>
                  ${f.baseUrl ? html`<div><dt>API 주소</dt><dd class="ad-code">${f.baseUrl}</dd></div>` : ''}
                  <div><dt>응답 기다리는 시간</dt><dd>${f.timeoutSec}초 (넘으면 '확인 필요')</dd></div>
                  <div><dt>지급 기록 자동 확인</dt><dd>1분마다</dd></div>
                </dl>
                <p class="ad-sub ad-gap-top-sm">연동 방식과 주소는 서버 설정 파일(.env)의 FULPOT_MODE, FULPOT_API_URL, FULPOT_API_TOKEN에서 바꿉니다.</p>
              </div>
            </section>`
          : ''}
        <form class="ad-form" data-form="settings" novalidate>
          <section class="ad-panel">
            <div class="ad-panel-head"><h2>티켓 교환</h2></div>
            <div class="ad-panel-body ad-form">
              <label class="ad-check" for="ad-open"><input type="checkbox" id="ad-open" name="exchange_open" ${s.exchange_open ? 'checked' : ''} /><span>교환 신청 받기</span><small>끄면 회원 화면에서 새 신청을 받지 않습니다.</small></label>
              <div class="ad-form-row">
                <label class="ad-field" for="ad-tname"><span>티켓 이름</span><input class="ad-input" id="ad-tname" name="ticket_name" value="${s.ticket_name}" maxlength="60" /></label>
                <label class="ad-field" for="ad-tcode"><span>풀팟 티켓 코드</span><input class="ad-input" id="ad-tcode" name="ticket_code" value="${s.ticket_code || ''}" maxlength="60" /><small>풀팟에 지급을 요청할 때 보내는 티켓 코드</small></label>
              </div>
              <div class="ad-form-row">
                <label class="ad-field" for="ad-ppt"><span>티켓 1장당 포인트</span><input class="ad-input" id="ad-ppt" name="points_per_ticket" value="${s.points_per_ticket}" inputmode="numeric" /><small>바꾸면 새 신청부터 적용됩니다.</small></label>
                <label class="ad-field" for="ad-max"><span>한 번에 받을 수 있는 장수</span><input class="ad-input" id="ad-max" name="max_per_exchange" value="${s.max_per_exchange}" inputmode="numeric" /><small>0이면 제한 없음</small></label>
              </div>
              <label class="ad-field" for="ad-terms"><span>티켓 사용 안내</span><textarea class="ad-textarea" id="ad-terms" name="ticket_terms" maxlength="500">${s.ticket_terms || ''}</textarea></label>
              <label class="ad-field" for="ad-guide"><span>지급 안내</span><textarea class="ad-textarea" id="ad-guide" name="payout_guide" maxlength="300">${s.payout_guide || ''}</textarea></label>
            </div>
          </section>
          <section class="ad-panel">
            <div class="ad-panel-head"><h2>사이트 문구</h2></div>
            <div class="ad-panel-body ad-form">
              <div class="ad-form-row">
                <label class="ad-field" for="ad-sname"><span>서비스 이름</span><input class="ad-input" id="ad-sname" name="service_name" value="${s.service_name}" maxlength="40" /></label>
                <label class="ad-field" for="ad-asof"><span>포인트 자료 기준 시점</span><input class="ad-input" id="ad-asof" name="points_as_of" type="datetime-local" value="${fmt.dateTimeInput(s.points_as_of)}" /><small>파일 등록 때 자동으로 바뀝니다.</small></label>
              </div>
              <label class="ad-field" for="ad-support"><span>문의 안내</span><textarea class="ad-textarea" id="ad-support" name="support_text" maxlength="300">${s.support_text || ''}</textarea><small>회원 화면 아래쪽과 로그인 안내에 보입니다.</small></label>
            </div>
          </section>
          <div class="ad-actions"><button class="ad-btn" type="submit">설정 저장</button></div>
        </form>
        <section class="ad-panel ad-gap-top">
          <div class="ad-panel-head"><h2>내 비밀번호 바꾸기</h2></div>
          <div class="ad-panel-body">
            <form class="ad-form ad-narrow" data-form="password" novalidate>
              <label class="ad-field" for="ad-pw0"><span>지금 비밀번호</span><input class="ad-input" id="ad-pw0" name="current" type="password" autocomplete="current-password" /></label>
              <label class="ad-field" for="ad-pw1"><span>새 비밀번호</span><input class="ad-input" id="ad-pw1" name="next" type="password" autocomplete="new-password" /><small>영문과 숫자를 섞어 10자 이상</small></label>
              <div class="ad-actions"><button class="ad-btn ad-btn-line" type="submit">비밀번호 바꾸기</button></div>
            </form>
          </div>
        </section>`;
    }

    // ───────── 대화 상자 ─────────
    function findExchange(id) {
      const lists = [st.ex.data && st.ex.data.rows, st.member.data && st.member.data.exchanges];
      for (const l of lists) {
        const x = l && l.find((r) => r.id === id);
        if (x) return x.member ? x : { ...x, member: st.member.data.member };
      }
      return null;
    }
    function findLink(id) {
      const lists = [st.links.data && st.links.data.rows, st.member.data && st.member.data.links];
      for (const l of lists) {
        const x = l && l.find((r) => r.id === id);
        if (x) return x.member ? x : { ...x, member: st.member.data.member };
      }
      return null;
    }

    function openDialog(kind, target) {
      st.dialog = { kind, target, values: {}, error: null, unreachable: false, focus: kind === 'ex-complete' ? '#ad-d-ref' : '#ad-d-text' };
      render();
    }

    function dialog() {
      const D = st.dialog;
      if (!D) return '';
      const t = D.target;
      const v = D.values;
      let title;
      let bodyHtml;
      let okLabel;
      let danger = false;
      if (D.kind === 'ex-complete') {
        title = '지급 번호로 완료';
        okLabel = '지급 완료로 바꾸기';
        bodyHtml = html`<p><b class="ad-code">${t.no}</b> · ${t.member.name} · 풀팟 <b class="ad-code">${t.fulpotId}</b>에 ${t.ticketName} <b>${t.quantity}장</b></p>
          <p class="ad-callout">풀팟 관리 도구에서 신청번호 <b class="ad-code">${t.no}</b>로 지급된 것을 직접 확인했을 때만 쓰세요. 완료하면 회원 포인트 ${fmt.points(t.totalPoints)}가 차감됩니다.</p>
          <label class="ad-field" for="ad-d-ref"><span>풀팟 지급 번호</span><input class="ad-input" id="ad-d-ref" name="payoutRef" value="${v.payoutRef || ''}" autocomplete="off" placeholder="예) FPX-70412" required /></label>`;
      } else if (D.kind === 'ex-fail') {
        title = '지급 실패 처리';
        okLabel = D.unreachable ? '기록 확인 없이 실패 처리' : '실패 처리';
        danger = true;
        bodyHtml = html`<p><b class="ad-code">${t.no}</b> · ${t.member.name} · ${t.quantity}장 ${fmt.points(t.totalPoints)}</p>
          <p class="ad-callout">처리하기 직전에 풀팟 지급 기록을 한 번 더 조회합니다. 지급돼 있으면 실패 대신 <b>지급 완료</b>로 바뀝니다. 실패로 처리하면 사용 대기 ${fmt.points(t.totalPoints)}가 회원에게 돌아가고, 사유가 회원 화면에 보입니다.</p>
          <div class="ad-presets">${FAIL_PRESETS.map((p) => html`<button type="button" data-act="preset" data-text="${p}">${p.split('.')[0]}</button>`)}</div>
          <label class="ad-field" for="ad-d-text"><span>실패 사유 (회원 화면에 보임)</span><textarea class="ad-textarea" id="ad-d-text" name="text" maxlength="200" required>${v.text || ''}</textarea></label>
          ${D.unreachable
            ? html`<label class="ad-check ad-confirm" for="ad-d-skip"><input type="checkbox" id="ad-d-skip" name="skipCheck" ${v.skipCheck ? 'checked' : ''} /><span>풀팟 관리 도구에서 이 신청이 지급되지 않은 것을 직접 확인했습니다.</span><small>확인하지 않았다면 닫고 잠시 뒤 다시 시도하세요. 실패 처리 뒤에도 하루 동안 지급 기록을 조회해, 늦게 지급된 것이 보이면 지급 완료로 바로잡습니다.</small></label>`
            : ''}`;
      } else if (D.kind === 'link-release') {
        title = '풀팟 계정 연결 해제';
        okLabel = '연결 해제';
        danger = true;
        bodyHtml = html`<p>${t.member.name}(${t.member.memberNo}) ↔ 풀팟 <b class="ad-code">${t.fulpotId}</b>${t.nickname ? ` (${t.nickname})` : ''}</p>
          <p class="ad-callout" data-tone="warn">해제하면 회원은 다시 연결하기 전까지 티켓을 받을 수 없습니다. 이미 지급한 티켓과 지급 확인 중인 신청은 그대로입니다.</p>
          <div class="ad-presets">${RELEASE_PRESETS.map((p) => html`<button type="button" data-act="preset" data-text="${p}">${p.split('.')[0]}</button>`)}</div>
          <label class="ad-field" for="ad-d-text"><span>해제 사유 (회원 화면에 보임)</span><textarea class="ad-textarea" id="ad-d-text" name="text" maxlength="200" required>${v.text || ''}</textarea></label>`;
      }
      return html`<div class="ad-dialog-wrap" data-act="dialog-scrim"><form class="ad-dialog" data-form="dialog" role="dialog" aria-modal="true" aria-labelledby="ad-d-title" novalidate>
        <h2 id="ad-d-title">${title}</h2>
        <div class="ad-dialog-body">${bodyHtml}${D.error ? html`<p class="ad-error" role="alert">${D.error}</p>` : ''}</div>
        <div class="ad-dialog-foot">
          <button type="button" class="ad-btn ad-btn-line" data-act="dialog-close">닫기</button>
          <button type="submit" class="ad-btn ${danger ? 'ad-btn-solid-danger' : ''}">${okLabel}</button>
        </div>
      </form></div>`;
    }

    async function submitDialog(form) {
      const D = st.dialog;
      const fd = new FormData(form);
      D.values = { ...Object.fromEntries(fd.entries()), skipCheck: fd.get('skipCheck') === 'on' };
      const t = D.target;
      try {
        let r;
        if (D.kind === 'ex-complete') {
          r = await call(() => api.post(`/api/admin/exchanges/${t.id}/complete`, { payoutRef: D.values.payoutRef, expected: 'check' }));
          toast(`${t.no}을 지급 완료로 바꿨습니다.`);
        } else if (D.kind === 'ex-fail') {
          if (D.unreachable && !D.values.skipCheck) {
            D.error = '풀팟 관리 도구에서 직접 확인했다면 확인란을 체크해 주세요.';
            return render();
          }
          r = await call(() => api.post(`/api/admin/exchanges/${t.id}/fail`, { reason: D.values.text, expected: 'check', skipCheck: D.unreachable && D.values.skipCheck }));
          if (r.result === 'issued') toast(`풀팟에 지급 기록이 있어 ${t.no}을 실패 대신 지급 완료로 처리했습니다.`);
          else if (r.result === 'conflict') toast(`풀팟이 돌려준 지급 번호가 다른 신청에 있어 확인 필요로 남겼습니다.`, 'danger');
          else toast(`${t.no}을 지급 실패로 처리했습니다. 포인트가 회원에게 돌아갔습니다.`);
        } else if (D.kind === 'link-release') {
          r = await call(() => api.post(`/api/admin/links/${t.id}/release`, { reason: D.values.text }));
          toast(`${t.member.name} 회원의 ${t.fulpotId} 연결을 해제했습니다.`);
        }
        if (r && r.badges) st.badges = r.badges;
        st.dialog = null;
        await load({ quiet: true });
      } catch (e) {
        if (e.status === 401) return;
        D.error = e.message;
        if (e.code === 'FULPOT_UNREACHABLE') {
          D.unreachable = true;
          D.error = e.message;
          return render();
        }
        if (e.code === 'STATE_CHANGED' || e.code === 'INVALID_STATE' || e.code === 'IN_FLIGHT') {
          st.dialog = null;
          toast(e.message, 'danger');
          await load({ quiet: true });
          return;
        }
        render();
      }
    }

    async function exAction(action, id, button) {
      const x = findExchange(id);
      const label = x ? x.no : '신청';
      try {
        const r = await call(() => api.post(`/api/admin/exchanges/${id}/${action}`, { expected: 'check' }));
        st.badges = r.badges;
        const out = r.result;
        if (action === 'query') {
          if (out === 'completed' || out === 'corrected') toast(`풀팟에 지급 기록이 있어 ${label}을 지급 완료로 바꿨습니다 (${r.exchange.payoutRef}).`);
          else if (out === 'not_found') toast(`풀팟에 ${label} 지급 기록이 없습니다. 다시 요청하거나 지급 실패로 처리해 주세요.`, 'warn');
          else if (out === 'conflict') toast('풀팟이 돌려준 지급 번호가 다른 신청에 있습니다. 풀팟 관리 도구에서 확인해 주세요.', 'danger');
          else toast(`풀팟 지급 기록을 조회하지 못했습니다. ${r.message || ''}`, 'danger');
        } else {
          if (out === 'completed') toast(`${label} 지급 완료 (풀팟 지급 번호 ${r.exchange.payoutRef}).`);
          else if (out === 'failed') toast(`풀팟이 지급을 거절해 ${label}이 지급 실패로 바뀌었습니다: ${r.message || ''}`, 'danger');
          else if (out === 'conflict') toast('풀팟이 돌려준 지급 번호가 다른 신청에 있습니다. 풀팟 관리 도구에서 확인해 주세요.', 'danger');
          else toast(`이번에도 풀팟 응답을 받지 못했습니다. 잠시 뒤 '풀팟에서 확인'을 눌러 주세요.`, 'warn');
        }
      } catch (e) {
        if (e.status !== 401) toast(e.message, 'danger');
      }
      if (button) button.disabled = false;
      await load({ quiet: true });
    }

    // ───────── 이벤트 ─────────
    async function guarded(fn, button) {
      if (busy) return;
      busy = true;
      if (button) button.disabled = true;
      try {
        await fn();
      } finally {
        busy = false;
      }
    }

    function focusEl(sel) {
      const el = root.querySelector(sel);
      if (el) el.focus({ preventScroll: routing !== 'hash' });
    }

    root.addEventListener('click', (ev) => {
      const go = ev.target.closest('[data-go]');
      if (go && root.contains(go)) {
        ev.preventDefault();
        const target = go.getAttribute('data-go');
        if (target.startsWith('upload/')) {
          st.tab = target.split('/')[1];
          nav.go('upload');
        } else nav.go(target);
        return;
      }
      const el = ev.target.closest('[data-act]');
      if (!el || !root.contains(el)) {
        const row = ev.target.closest('tr[data-href]');
        if (row && root.contains(row)) nav.go(row.getAttribute('data-href'));
        return;
      }
      const act = el.getAttribute('data-act');
      const id = Number(el.getAttribute('data-id'));
      if (act === 'dialog-scrim') {
        if (ev.target === el) {
          st.dialog = null;
          render();
          if (deferred) refresh();
        }
        return;
      }
      if (act === 'dialog-close') {
        st.dialog = null;
        render();
        if (deferred) refresh();
      } else if (act === 'preset') {
        const ta = root.querySelector('#ad-d-text');
        if (ta) {
          ta.value = el.getAttribute('data-text');
          ta.focus();
        }
      } else if (act === 'logout') {
        guarded(async () => {
          try {
            await api.post('/api/admin/logout');
          } catch {
            /* 이미 끝난 로그인 */
          }
          st.admin = null;
          render();
          if (opts.onRoute) opts.onRoute('login');
        });
      } else if (act === 'tab') {
        const tab = el.getAttribute('data-tab');
        if (st.route === 'exchanges') {
          st.ex.tab = tab;
          st.ex.page = 1;
          st.ex.data = null;
        } else if (st.route === 'links') {
          st.links.tab = tab;
          st.links.data = null;
        } else if (st.route === 'upload') {
          st.tab = tab;
          return render();
        }
        load({ quiet: true });
        render();
      } else if (act === 'filter') {
        st.upload.filter = el.getAttribute('data-tab');
        render();
      } else if (act === 'page') {
        const p = Number(el.getAttribute('data-page'));
        if (st.route === 'exchanges') st.ex.page = p;
        else st.members.page = p;
        load({ quiet: true });
      } else if (act === 'ex-query' || act === 'ex-retry') {
        guarded(() => exAction(act === 'ex-query' ? 'query' : 'retry', id, el), el);
      } else if (act === 'ex-complete' || act === 'ex-fail') {
        const x = findExchange(id);
        if (x) openDialog(act, x);
      } else if (act === 'link-release') {
        const x = findLink(id);
        if (x) openDialog(act, x);
      } else if (act === 'reg-grant') {
        const R = st.reg;
        guarded(() => submitRegister({ memberId: Number(el.getAttribute('data-id')), points: R.result ? R.result.points : R.points, reason: R.reason }), el);
      } else if (act === 'reg-dismiss') {
        st.reg.result = null;
        render();
      } else if (act === 'template') {
        download('APS_포인트_등록_양식.csv', S.template('points'));
      } else if (act === 'sample') {
        guarded(() => previewRows(opts.sampleName || '예시_적립자료.csv', opts.sampleRows()));
      } else if (act === 'upload-reset') {
        const keep = st.upload;
        st.upload = { ...freshUpload(), history: keep.history, pointsAsOf: keep.pointsAsOf, basisAt: keep.basisAt };
        render();
      } else if (act === 'upload-commit') {
        const P = st.upload;
        guarded(async () => {
          try {
            const r = await call(() => api.post('/api/admin/upload/commit', { fileName: P.fileName, rows: P.rows, basisAt: P.basisAt }));
            const s = r.summary;
            st.upload = { ...freshUpload(), result: `${P.fileName}: ${s.apply}건, ${fmt.signed(s.points)} 반영했습니다.${s.newMembers ? ` 새 회원 ${s.newMembers}명을 등록했습니다.` : ''}${s.total - s.apply ? ` ${s.total - s.apply}행은 건너뛰었습니다.` : ''}` };
          } catch (e) {
            if (e.status === 401) return;
            P.error = e.message;
          }
          await load({ quiet: true });
        }, el);
      }
    });

    // 직접 등록 칸은 다시 그려도 값이 남도록 입력할 때마다 기억한다.
    root.addEventListener('input', (ev) => {
      const f = ev.target.closest('form[data-form="register"]');
      if (!f) return;
      const name = ev.target.name;
      if (name === 'phone') {
        const v = fmt.phoneInput(ev.target.value);
        if (v !== ev.target.value) ev.target.value = v;
      }
      if (name in st.reg) st.reg[name] = ev.target.value;
    });

    root.addEventListener('focusout', () => {
      if (!deferred) return;
      setTimeout(() => {
        if (deferred && !st.dialog && !U.typing(root)) refresh();
      }, 200);
    });

    root.addEventListener('change', (ev) => {
      if (ev.target.matches('[data-file]') && ev.target.files && ev.target.files[0]) {
        const f = ev.target.files[0];
        guarded(() => readUpload(f));
      }
    });

    root.addEventListener('dragover', (ev) => {
      const z = ev.target.closest('[data-drop]');
      if (!z) return;
      ev.preventDefault();
      z.dataset.over = 'true';
    });
    root.addEventListener('dragleave', (ev) => {
      const z = ev.target.closest('[data-drop]');
      if (z) z.dataset.over = 'false';
    });
    root.addEventListener('drop', (ev) => {
      const z = ev.target.closest('[data-drop]');
      if (!z) return;
      ev.preventDefault();
      z.dataset.over = 'false';
      const f = ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files[0];
      if (f) guarded(() => readUpload(f));
    });

    root.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape' && st.dialog) {
        st.dialog = null;
        render();
      }
    });

    // 제출 버튼·Enter를 직접 받는다(폼 제출이 막힌 미리보기 창에서도 동작하도록, ui.js bindForms 참고)
    U.bindForms(root, (form, btn) => {
      const kind = form.getAttribute('data-form');
      const fd = new FormData(form);
      const val = (k) => String(fd.get(k) ?? '').trim();
      if (kind === 'login') {
        guarded(async () => {
          try {
            const r = await api.post('/api/admin/login', { username: val('username'), password: fd.get('password') });
            st.admin = r.admin;
            st.badges = r.badges;
            st.loginError = null;
            await load();
          } catch (e) {
            st.loginError = e.message;
            render();
            const pw = root.querySelector('#ad-pass');
            const user = root.querySelector('#ad-user');
            if (user) user.value = val('username');
            if (pw) pw.focus();
          }
        }, btn);
      } else if (kind === 'search') {
        const q = val('q');
        if (st.route === 'exchanges') Object.assign(st.ex, { q, page: 1 });
        else if (st.route === 'links') st.links.q = q;
        else Object.assign(st.members, { q, page: 1 });
        load({ quiet: true });
      } else if (kind === 'dialog') {
        guarded(() => submitDialog(form), btn);
      } else if (kind === 'register') {
        const R = st.reg;
        Object.assign(R, { name: val('name'), phone: val('phone'), points: val('points'), reason: val('reason'), memberNo: val('memberNo') });
        if (!R.name || !R.phone) {
          R.error = '이름과 휴대폰 번호를 입력해 주세요.';
          R.field = R.name ? 'phone' : 'name';
          render();
          focusEl(`[name="${R.field}"]`);
          return;
        }
        R.result = null;
        guarded(() => submitRegister({ name: R.name, phone: R.phone, points: R.points, reason: R.reason, memberNo: R.memberNo }), btn);
      } else if (kind === 'adjust') {
        guarded(async () => {
          try {
            st.member.data = await call(() => api.post(`/api/admin/members/${st.id}/adjust`, { amount: val('amount'), reason: val('reason'), requestKey: U.uuid().replace(/-/g, '') }));
            toast('포인트를 조정했습니다.');
          } catch (e) {
            if (e.status !== 401) toast(e.message, 'danger');
            if (btn) btn.disabled = false;
            return;
          }
          render();
        }, btn);
      } else if (kind === 'member') {
        guarded(async () => {
          try {
            st.member.data = await call(() => api.post(`/api/admin/members/${st.id}`, { memberNo: val('memberNo'), name: val('name'), phone: val('phone'), status: val('status'), memo: val('memo') }));
            toast('회원 정보를 저장했습니다.');
          } catch (e) {
            if (e.status !== 401) toast(e.message, 'danger');
            if (btn) btn.disabled = false;
            return;
          }
          render();
        }, btn);
      } else if (kind === 'settings') {
        const body = {
          exchange_open: fd.get('exchange_open') === 'on',
          ticket_name: val('ticket_name'),
          ticket_code: val('ticket_code'),
          points_per_ticket: val('points_per_ticket'),
          max_per_exchange: val('max_per_exchange'),
          ticket_terms: val('ticket_terms'),
          payout_guide: val('payout_guide'),
          service_name: val('service_name'),
          support_text: val('support_text'),
          points_as_of: fmt.parseInput(val('points_as_of')),
        };
        guarded(async () => {
          try {
            const r = await call(() => api.put('/api/admin/settings', body));
            st.settings.data = r.settings;
            st.settings.fulpot = r.fulpot;
            toast('설정을 저장했습니다.');
          } catch (e) {
            if (e.status !== 401) toast(e.message, 'danger');
            if (btn) btn.disabled = false;
            return;
          }
          render();
        }, btn);
      } else if (kind === 'password') {
        guarded(async () => {
          try {
            await call(() => api.post('/api/admin/password', { current: fd.get('current'), next: fd.get('next') }));
            toast('비밀번호를 바꿨습니다. 다른 기기의 로그인은 끝났습니다.');
            form.reset();
          } catch (e) {
            if (e.status !== 401) toast(e.message, 'danger');
          }
          if (btn) btn.disabled = false;
        }, btn);
      }
    });

    start();
    return {
      refresh,
      go: (r) => nav.go(r),
      route: currentRoute,
      fillLogin(username, password) {
        const u = root.querySelector('#ad-user');
        const p = root.querySelector('#ad-pass');
        if (!u || !p) return false;
        u.value = username;
        p.value = password;
        p.focus({ preventScroll: true });
        return true;
      },
    };
  }

  global.APSAdmin = { mount };
})(window);

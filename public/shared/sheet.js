/* 엑셀(.xlsx)·CSV 읽기 — 외부 라이브러리 없이 브라우저에서 첫 번째 시트를 행 배열로 읽는다.
   날짜 서식 셀은 'YYYY-MM-DD HH:mm' 문자열로 바꾸고(엑셀 값은 한국시간으로 본다), 숫자는 숫자로 둔다. */
(function (global) {
  'use strict';

  // 포인트 등록 파일의 열. 머리글 이름이 조금 달라도(띄어쓰기·괄호 무시) 자동으로 연결한다.
  const FIELDS = {
    points: [
      { key: 'member_no', label: '회원번호', required: true, names: ['aps회원번호', '회원번호', 'aps번호', 'memberno', '회원id', '회원아이디'] },
      { key: 'name', label: '이름', names: ['이름', '성명', '회원명', 'name'] },
      { key: 'phone', label: '휴대폰', names: ['휴대폰', '휴대폰번호', '전화번호', '핸드폰', '핸드폰번호', '연락처', '휴대전화', 'phone', 'mobile'] },
      { key: 'points', label: '포인트', required: true, names: ['포인트', '적립포인트', '적립', '잔액', '포인트잔액', '보유포인트', 'points', 'point', 'balance'] },
      { key: 'source_ref', label: '건 번호', required: true, names: ['건번호', '원본건번호', '원본번호', '적립번호', '적립건번호', '대회번호', '대회id', 'sourceref', 'ref'] },
      { key: 'earned_at', label: '적립일', names: ['적립일', '적립일시', '발생일', '일자', '날짜', 'earnedat', 'date'] },
      { key: 'reason', label: '사유', names: ['사유', '대회명', '적립사유', '내용', '비고', 'reason', 'memo'] },
    ],
  };

  const norm = (s) =>
    String(s == null ? '' : s)
      .toLowerCase()
      .replace(/\(.*?\)|\[.*?\]/g, '')
      .replace(/[\s_\-./·:]/g, '');

  // ---- CSV ----
  function decodeText(bytes) {
    let text = new TextDecoder('utf-8').decode(bytes);
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    if (text.includes('\uFFFD')) {
      try {
        text = new TextDecoder('euc-kr').decode(bytes); // 한글 엑셀에서 저장한 CSV(CP949)
      } catch {
        /* 그대로 */
      }
    }
    return text;
  }

  function parseCsv(text, delimiter) {
    const d = delimiter || ((text.split('\n')[0].match(/\t/g) || []).length > (text.split('\n')[0].match(/,/g) || []).length ? '\t' : ',');
    const rows = [];
    let row = [];
    let cell = '';
    let quoted = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (quoted) {
        if (c === '"') {
          if (text[i + 1] === '"') {
            cell += '"';
            i++;
          } else quoted = false;
        } else cell += c;
      } else if (c === '"') quoted = true;
      else if (c === d) {
        row.push(cell);
        cell = '';
      } else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(cell);
        rows.push(row);
        row = [];
        cell = '';
      } else cell += c;
    }
    if (cell !== '' || row.length) {
      row.push(cell);
      rows.push(row);
    }
    return rows;
  }

  // ---- XLSX ----
  async function inflateRaw(bytes) {
    if (typeof global.DecompressionStream !== 'function') {
      throw new Error('이 브라우저는 xlsx 파일을 읽지 못합니다. 엑셀에서 CSV로 저장해 올려 주세요.');
    }
    const ds = new global.DecompressionStream('deflate-raw');
    const out = new Response(new Blob([bytes]).stream().pipeThrough(ds));
    return new Uint8Array(await out.arrayBuffer());
  }

  function unzipIndex(buf) {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    let eocd = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error('xlsx 파일 구조를 읽을 수 없습니다. 파일이 손상되지 않았는지 확인해 주세요.');
    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const files = new Map();
    const dec = new TextDecoder('utf-8');
    for (let n = 0; n < count; n++) {
      if (dv.getUint32(p, true) !== 0x02014b50) break;
      const method = dv.getUint16(p + 10, true);
      const csize = dv.getUint32(p + 20, true);
      const nameLen = dv.getUint16(p + 28, true);
      const extraLen = dv.getUint16(p + 30, true);
      const commentLen = dv.getUint16(p + 32, true);
      const local = dv.getUint32(p + 42, true);
      const name = dec.decode(buf.subarray(p + 46, p + 46 + nameLen));
      files.set(name, { method, csize, local });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return {
      has: (name) => files.has(name),
      async text(name) {
        const f = files.get(name);
        if (!f) return null;
        const nl = dv.getUint16(f.local + 26, true);
        const el = dv.getUint16(f.local + 28, true);
        const start = f.local + 30 + nl + el;
        const raw = buf.subarray(start, start + f.csize);
        const bytes = f.method === 0 ? raw : f.method === 8 ? await inflateRaw(raw) : null;
        if (!bytes) throw new Error('지원하지 않는 압축 방식입니다.');
        return dec.decode(bytes);
      },
    };
  }

  const xml = (text) => new global.DOMParser().parseFromString(text, 'application/xml');
  const byTag = (node, tag) => Array.from(node.getElementsByTagNameNS('*', tag));

  function isDateFormat(code) {
    const c = String(code).replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '').replace(/\\./g, '');
    return /[ymdhs]/i.test(c) && !/^general$/i.test(c.trim());
  }
  const BUILTIN_DATE = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);

  function serialToText(n) {
    const ms = Math.round((n - 25569) * 86400000);
    const d = new Date(ms);
    const pad = (x) => String(x).padStart(2, '0');
    const day = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
    const hasTime = Math.abs(n - Math.floor(n)) > 1e-9;
    return hasTime ? `${day} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}` : day;
  }

  function colIndex(ref) {
    const m = /^([A-Z]+)/.exec(ref || '');
    if (!m) return -1;
    let n = 0;
    for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n - 1;
  }

  async function readXlsx(buf) {
    const zip = unzipIndex(buf);
    const wb = xml(await zip.text('xl/workbook.xml'));
    const firstSheet = byTag(wb, 'sheet')[0];
    if (!firstSheet) throw new Error('엑셀 파일에서 시트를 찾지 못했습니다.');
    const rid = firstSheet.getAttribute('r:id') || firstSheet.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id');
    let target = 'worksheets/sheet1.xml';
    const relsText = await zip.text('xl/_rels/workbook.xml.rels');
    if (relsText) {
      const rel = byTag(xml(relsText), 'Relationship').find((r) => r.getAttribute('Id') === rid);
      if (rel) target = rel.getAttribute('Target');
    }
    const sheetPath = target.startsWith('/') ? target.slice(1) : 'xl/' + target.replace(/^\.\//, '');
    const shared = [];
    const ssText = await zip.text('xl/sharedStrings.xml');
    if (ssText) {
      for (const si of byTag(xml(ssText), 'si')) {
        shared.push(
          byTag(si, 't')
            .filter((t) => !(t.parentNode && t.parentNode.localName === 'rPh'))
            .map((t) => t.textContent)
            .join('')
        );
      }
    }
    const dateStyles = new Set();
    const stText = await zip.text('xl/styles.xml');
    if (stText) {
      const st = xml(stText);
      const custom = new Map(byTag(st, 'numFmt').map((f) => [Number(f.getAttribute('numFmtId')), f.getAttribute('formatCode')]));
      const xfsParent = byTag(st, 'cellXfs')[0];
      if (xfsParent) {
        Array.from(xfsParent.children).forEach((xf, i) => {
          const id = Number(xf.getAttribute('numFmtId') || 0);
          if (BUILTIN_DATE.has(id) || (custom.has(id) && isDateFormat(custom.get(id)))) dateStyles.add(i);
        });
      }
    }
    const sheetText = await zip.text(sheetPath);
    if (!sheetText) throw new Error('엑셀 시트 내용을 찾지 못했습니다.');
    const rows = [];
    for (const r of byTag(xml(sheetText), 'row')) {
      const rowNo = Number(r.getAttribute('r')) || rows.length + 1;
      const cells = [];
      for (const c of byTag(r, 'c')) {
        const idx = colIndex(c.getAttribute('r'));
        const t = c.getAttribute('t');
        const vNode = byTag(c, 'v')[0];
        const v = vNode ? vNode.textContent : '';
        let val = '';
        if (t === 's') val = shared[Number(v)] ?? '';
        else if (t === 'inlineStr') val = byTag(c, 't').map((x) => x.textContent).join('');
        else if (t === 'b') val = v === '1' ? 'TRUE' : 'FALSE';
        else if (t === 'str' || t === 'e') val = v;
        else if (v !== '') {
          const num = Number(v);
          val = dateStyles.has(Number(c.getAttribute('s') || 0)) ? serialToText(num) : num;
        }
        cells[idx >= 0 ? idx : cells.length] = val;
      }
      for (let i = 0; i < cells.length; i++) if (cells[i] === undefined) cells[i] = '';
      while (rows.length < rowNo - 1) rows.push([]);
      rows.push(cells);
    }
    return rows;
  }

  async function sha256Hex(buf) {
    if (!(global.crypto && global.crypto.subtle)) return null;
    try {
      const h = await global.crypto.subtle.digest('SHA-256', buf);
      return Array.from(new Uint8Array(h), (b) => b.toString(16).padStart(2, '0')).join('');
    } catch {
      return null;
    }
  }

  async function readFile(file) {
    const name = file.name || '';
    const ext = (name.split('.').pop() || '').toLowerCase();
    const buf = new Uint8Array(await file.arrayBuffer());
    if (ext === 'xls') throw new Error('예전 엑셀 형식(.xls)은 읽을 수 없습니다. 엑셀에서 .xlsx나 CSV로 저장해 올려 주세요.');
    let rows;
    if (ext === 'xlsx' || ext === 'xlsm' || (buf[0] === 0x50 && buf[1] === 0x4b)) rows = await readXlsx(buf);
    else rows = parseCsv(decodeText(buf), ext === 'tsv' ? '\t' : null);
    const trimmed = rows.map((r) => r.map((c) => (typeof c === 'string' ? c.trim() : c)));
    return { name, rows: trimmed.filter((r) => r.some((c) => c !== '' && c != null)).length ? trimmed : [], hash: await sha256Hex(buf) };
  }

  // 머리글 행 찾기와 열 자동 연결
  function detect(rows, kind) {
    const fields = FIELDS[kind];
    let best = { index: -1, score: 0 };
    for (let i = 0; i < Math.min(rows.length, 15); i++) {
      const cells = (rows[i] || []).map(norm);
      const score = fields.filter((f) => cells.some((c) => f.names.includes(c))).length;
      if (score > best.score) best = { index: i, score };
    }
    const headerIndex = best.index >= 0 ? best.index : 0;
    const header = (rows[headerIndex] || []).map((c) => String(c ?? ''));
    const mapping = {};
    const used = new Set();
    for (const f of fields) {
      for (const name of f.names) {
        const i = header.findIndex((h, idx) => !used.has(idx) && norm(h) === name);
        if (i >= 0) {
          mapping[f.key] = i;
          used.add(i);
          break;
        }
      }
    }
    return { headerIndex, header, mapping, fields };
  }

  function toObjects(rows, headerIndex, mapping) {
    const out = [];
    for (let i = headerIndex + 1; i < rows.length; i++) {
      const r = rows[i] || [];
      if (!r.some((c) => c !== '' && c != null)) continue;
      const o = { __row: i + 1 };
      for (const [key, idx] of Object.entries(mapping)) if (idx != null && idx >= 0) o[key] = r[idx] ?? '';
      out.push(o);
    }
    return out;
  }

  function template(kind) {
    const f = FIELDS[kind];
    const rows = [
      ['APS-10001', '홍길동', '010-0000-0000', '120', '최초잔액', '2026-10-01', '최초 잔액'],
      ['APS-10001', '홍길동', '', '40', 'S2-W3', '2026-10-14', 'APS 시즌2 데일리 리그 3주차'],
    ];
    return '\uFEFF' + [f.map((x) => x.label), ...rows].map((r) => r.join(',')).join('\r\n') + '\r\n';
  }

  global.APSSheet = { FIELDS, readFile, detect, toObjects, parseCsv, template };
})(window);

'use strict';
/*
 * 브라우저 데모 한 장짜리 HTML 만들기:  npm run build:demo  →  dist/aps-web-demo.html (+ GitHub Pages용 index.html)
 * 서버 코드(server/)를 그대로 묶고, DB는 sql.js, 암호 함수는 demo/crypto-browser.js로 바꿔 끼운다.
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const ALIAS = { 'server/lib/crypto.js': 'demo/crypto-browser.js' };

function bundle(entry) {
  const mods = new Map();
  function resolve(fromId, spec) {
    if (!spec.startsWith('.')) throw new Error(`데모에 넣을 수 없는 모듈입니다: ${spec} (${fromId})`);
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromId), spec));
    const found = [base, base + '.js', base + '/index.js'].find((c) => {
      const abs = path.join(ROOT, c);
      return fs.existsSync(abs) && fs.statSync(abs).isFile();
    });
    if (!found) throw new Error(`모듈을 찾을 수 없습니다: ${spec} (${fromId})`);
    return ALIAS[found] || found;
  }
  function add(id) {
    if (mods.has(id)) return;
    const code = read(id);
    const deps = {};
    mods.set(id, { code, deps });
    const re = /require\(\s*'([^']+)'\s*\)/g;
    let m;
    while ((m = re.exec(code))) {
      const dep = resolve(id, m[1]);
      deps[m[1]] = dep;
      add(dep);
    }
  }
  add(entry);
  let out = '(function () {\n"use strict";\nvar __defs = {};\n';
  for (const [id, { code, deps }] of mods) {
    out += `__defs[${JSON.stringify(id)}] = { deps: ${JSON.stringify(deps)}, fn: function (module, exports, require) {\n${code}\n} };\n`;
  }
  out += `var __cache = {};
function __load(id) {
  if (__cache[id]) return __cache[id].exports;
  var def = __defs[id];
  var module = { exports: {} };
  __cache[id] = module;
  def.fn.call(module.exports, module, module.exports, function (spec) {
    var dep = def.deps[spec];
    if (!dep) throw new Error('module not found: ' + spec);
    return __load(dep);
  });
  return module.exports;
}
window.APSDemoCore = __load(${JSON.stringify(entry)});
})();\n`;
  return { code: out, modules: [...mods.keys()] };
}

function inlineScript(js, name) {
  if (/<\/script/i.test(js) || js.includes('<!--')) throw new Error(`${name}에 인라인 스크립트로 넣을 수 없는 문자열이 있습니다.`);
  return `<script>\n${js}\n</script>`;
}

const styles = ['public/shared/tokens.css', 'public/site/site.css', 'public/admin/admin.css', 'demo/shell.css'].map(read).join('\n');
const core = bundle('demo/entry.js');
const scripts = [
  ['public/shared/ui.js', read('public/shared/ui.js')],
  ['public/shared/sheet.js', read('public/shared/sheet.js')],
  ['public/site/site.js', read('public/site/site.js')],
  ['public/admin/admin.js', read('public/admin/admin.js')],
  ['server bundle', core.code],
  ['demo/shell.js', read('demo/shell.js')],
];
const page = read('demo/shell.html')
  .replace('/*__STYLES__*/', () => styles)
  .replace('<!--__SCRIPTS__-->', () => scripts.map(([name, js]) => inlineScript(js, name)).join('\n'));

fs.mkdirSync(path.join(ROOT, 'dist'), { recursive: true });
const outFile = path.join(ROOT, 'dist', 'aps-web-demo.html');
fs.writeFileSync(outFile, page);
// GitHub Pages에서 저장소 주소로 바로 열리도록 맨 위 index.html에도 같은 내용을 둔다.
fs.writeFileSync(path.join(ROOT, 'index.html'), page);
console.log(`dist/aps-web-demo.html, index.html (${(page.length / 1024).toFixed(0)}KB) · 서버 모듈 ${core.modules.length}개 포함`);

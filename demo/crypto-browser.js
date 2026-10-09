'use strict';
// 브라우저 데모용 암호 함수(server/lib/crypto.js와 같은 이름). SHA-256을 동기식으로 직접 계산한다.
// 비밀번호 해시는 데모 전용 형식이며 실제 서버는 scrypt를 쓴다.
const enc = new TextEncoder();
const toBytes = (x) => (typeof x === 'string' ? enc.encode(x) : x instanceof Uint8Array ? x : new Uint8Array(x));
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const ror = (x, n) => (x >>> n) | (x << (32 - n));

function pad64(m) {
  const total = Math.ceil((m.length + 9) / 64) * 64;
  const buf = new Uint8Array(total);
  buf.set(m);
  buf[m.length] = 0x80;
  const dv = new DataView(buf.buffer);
  const bits = m.length * 8;
  dv.setUint32(total - 8, Math.floor(bits / 4294967296));
  dv.setUint32(total - 4, bits >>> 0);
  return { buf, dv, total };
}

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
  0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
  0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function sha256(data) {
  const { dv, total } = pad64(toBytes(data));
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = ror(w[i - 15], 7) ^ ror(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = ror(w[i - 2], 17) ^ ror(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = (hh + (ror(e, 6) ^ ror(e, 11) ^ ror(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0;
      const t2 = ((ror(a, 2) ^ ror(a, 13) ^ ror(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] += a;
    h[1] += b;
    h[2] += c;
    h[3] += d;
    h[4] += e;
    h[5] += f;
    h[6] += g;
    h[7] += hh;
  }
  const out = new Uint8Array(32);
  const odv = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) odv.setUint32(i * 4, h[i]);
  return out;
}

function hmac(hash, key, msg) {
  let k = toBytes(key);
  if (k.length > 64) k = hash(k);
  const block = new Uint8Array(64);
  block.set(k);
  const inner = new Uint8Array(64 + toBytes(msg).length);
  const outer = new Uint8Array(64 + 32);
  for (let i = 0; i < 64; i++) {
    inner[i] = block[i] ^ 0x36;
    outer[i] = block[i] ^ 0x5c;
  }
  inner.set(toBytes(msg), 64);
  outer.set(hash(inner), 64);
  return hash(outer);
}

function randomBytes(n) {
  const b = new Uint8Array(n);
  globalThis.crypto.getRandomValues(b);
  return b;
}

function randomToken(bytes = 32) {
  let s = '';
  for (const b of randomBytes(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomDigits(n) {
  let out = '';
  while (out.length < n) {
    for (const b of randomBytes(n)) if (b < 250 && out.length < n) out += String(b % 10);
  }
  return out;
}

function safeEqual(a, b) {
  const x = String(a);
  const y = String(b);
  if (x.length !== y.length) return false;
  let r = 0;
  for (let i = 0; i < x.length; i++) r |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return r === 0;
}

function demoHash(password, saltHex) {
  let h = sha256(saltHex + ':' + password);
  for (let i = 0; i < 1500; i++) h = sha256(h);
  return hex(h);
}

module.exports = {
  randomToken,
  randomDigits,
  sha256Hex: (s) => hex(sha256(String(s))),
  hmacSha256Hex: (key, s) => hex(hmac(sha256, String(key), String(s))),
  safeEqual,
  hashPassword(password) {
    const salt = hex(randomBytes(12));
    return `demo$${salt}$${demoHash(String(password), salt)}`;
  },
  verifyPassword(password, stored) {
    const p = String(stored || '').split('$');
    if (p.length !== 3 || p[0] !== 'demo') return false;
    return safeEqual(demoHash(String(password), p[1]), p[2]);
  },
};

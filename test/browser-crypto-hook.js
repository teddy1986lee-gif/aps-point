'use strict';
// APS_TEST_CRYPTO=browser 일 때 server/lib/crypto.js 대신 브라우저 데모용 구현을 쓰게 한다.
const Module = require('node:module');
const path = require('node:path');
const target = path.join(__dirname, '..', 'server', 'lib', 'crypto.js');
const replacement = path.join(__dirname, '..', 'demo', 'crypto-browser.js');
const orig = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  const resolved = orig.call(this, request, parent, ...rest);
  return resolved === target ? replacement : resolved;
};

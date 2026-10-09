'use strict';

// 서비스 묶음. 서로 필요한 기능은 실행 시점에 s.이름으로 찾는다.
function createServices({ db, config, clock, sms, fulpot }) {
  const s = { db, config, clock, sms, fulpot };
  s.settings = require('./settings')(s);
  s.members = require('./members')(s);
  s.points = require('./points')(s);
  s.links = require('./links')(s);
  s.exchanges = require('./exchanges')(s);
  s.auth = require('./auth')(s);
  return s;
}

module.exports = { createServices };

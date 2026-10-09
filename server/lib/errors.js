'use strict';

// 모든 업무 오류는 AppError로 던지고, 라우터가 { error: { code, message, details } } 형태로 응답한다.
class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const E = {
  bad: (message, details) => new AppError(400, 'VALIDATION', message, details),
  unauth: (message = '다시 인증해 주세요.') => new AppError(401, 'UNAUTHENTICATED', message),
  forbidden: (message = '이 작업을 할 권한이 없습니다.') => new AppError(403, 'FORBIDDEN', message),
  notFound: (message = '대상을 찾을 수 없습니다.') => new AppError(404, 'NOT_FOUND', message),
  conflict: (code, message, details) => new AppError(409, code, message, details),
  rate: (message, retryAfter) => new AppError(429, 'RATE_LIMITED', message, { retryAfter }),
  reauth: () =>
    new AppError(403, 'REAUTH_REQUIRED', '본인 확인을 위해 문자 인증을 한 번 더 진행해 주세요.'),
};

function isUniqueViolation(err) {
  return /UNIQUE constraint failed/i.test(String(err && err.message));
}

module.exports = { AppError, E, isUniqueViolation };

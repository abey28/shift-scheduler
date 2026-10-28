/**
 * 共用：從 Cloudflare Access (Zero Trust) 注入的 JWT 取出登入者 Email。
 * Access 已驗證過簽章，這裡只解碼 payload。本機開發沒有此 header → dev@local。
 */
export function getUserEmail(request) {
  const jwt = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!jwt) return 'dev@local';
  try {
    let b64 = jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4 !== 0) b64 += '=';
    const payload = JSON.parse(atob(b64));
    return payload.email || payload.sub || 'unknown';
  } catch {
    return 'unknown';
  }
}

/** 一個月班表的筆數（只算有排人的班別） */
export function countFilled(assignments) {
  let n = 0;
  for (const arr of Object.values(assignments || {})) if (arr && arr.length) n++;
  return n;
}

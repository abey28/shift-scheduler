/**
 * GET /api/whoami → { email, name }
 *
 * v2.10 起前端改從 GET /api/state 的 user 欄位取得登入者，不再呼叫此端點；
 * 保留它是為了相容尚未重新整理的舊版頁面。
 */
import { getUserEmail } from '../../lib/auth.js';

export async function onRequestGet({ request }) {
  const email = getUserEmail(request);
  return Response.json({ email, name: email.split('@')[0] });
}

/**
 * GET /api/whoami → { email, name }
 *
 * Cloudflare Access (Zero Trust) injects a signed JWT into every request
 * via the "Cf-Access-Jwt-Assertion" header.
 * We decode the payload (no signature verification needed — CF already verified it)
 * to extract the user's email.
 *
 * When running locally with `wrangler pages dev`, this header won't be present,
 * so we fall back to a dev identity.
 */

function decodeJwtPayload(jwt) {
  const parts = jwt.split('.');
  if (parts.length !== 3) return null;

  // base64url → base64: replace chars and add padding
  let base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4 !== 0) base64 += '=';

  try {
    return JSON.parse(atob(base64));
  } catch {
    return null;
  }
}

export async function onRequestGet({ request }) {
  try {
    const jwt = request.headers.get('Cf-Access-Jwt-Assertion');

    if (!jwt) {
      // Local dev fallback
      return Response.json({ email: 'dev@local', name: 'dev' });
    }

    const payload = decodeJwtPayload(jwt);
    if (!payload) {
      return Response.json({ email: 'unknown', name: 'unknown' });
    }

    const email = payload.email || payload.sub || 'unknown';
    // Derive a short display name from email prefix
    const name = email.split('@')[0];

    return Response.json({ email, name });
  } catch (e) {
    return Response.json({ email: 'unknown', name: 'unknown' });
  }
}

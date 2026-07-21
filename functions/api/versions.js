/**
 * 班表版本快照 API（手動「儲存班表」建立還原點）
 *
 * GET  /api/versions?month=2026-07
 *      → { ok, versions: [{ savedAt, savedBy, count }] }（新到舊）
 *
 * POST /api/versions?month=2026-07&action=save
 *      → 讀取目前 schedule:MONTH 的 assignments，存為一個新版本（cap 10）
 *      → { ok, versions: [...] }
 *
 * POST /api/versions?month=2026-07&action=undo
 *      → 移除最新版本，並把「上一版本」的 assignments 還原回 schedule:MONTH
 *      → { ok, restored: true, assignments, savedAt, savedBy, versions: [...] }
 *      → 若不足兩個版本，回 { ok:false, error:'no_previous_version' }
 *
 * KV key: versions:schedule:YYYY-MM = [{ assignments, savedAt, savedBy }]（新到舊，index 0 最新）
 */

const MAX_VERSIONS = 10;

function getUserEmail(request) {
  const jwt = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!jwt) return 'dev@local';
  try {
    let b64 = jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4 !== 0) b64 += '=';
    return JSON.parse(atob(b64)).email || 'unknown';
  } catch { return 'unknown'; }
}

function metaList(versions) {
  return versions.map(v => ({
    savedAt: v.savedAt,
    savedBy: v.savedBy,
    count: Object.keys(v.assignments || {}).length,
  }));
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const month = url.searchParams.get('month') || '';
  if (!/^\d{4}-\d{2}$/.test(month)) {
    return Response.json({ ok: false, error: 'bad_month' }, { status: 400 });
  }
  try {
    const raw = await env.SCHEDULER_KV.get(`versions:schedule:${month}`);
    const versions = raw ? JSON.parse(raw) : [];
    return Response.json({ ok: true, versions: metaList(versions) });
  } catch (e) {
    return Response.json({ ok: false, error: e.message }, { status: 500 });
  }
}

export async function onRequestPost({ request, env }) {
  const url = new URL(request.url);
  const month = url.searchParams.get('month') || '';
  const action = url.searchParams.get('action') || 'save';
  const userEmail = getUserEmail(request);

  if (!/^\d{4}-\d{2}$/.test(month)) {
    return Response.json({ ok: false, error: 'bad_month' }, { status: 400 });
  }

  try {
    const vKey = `versions:schedule:${month}`;
    const sKey = `schedule:${month}`;
    const [vRaw, sRaw] = await Promise.all([
      env.SCHEDULER_KV.get(vKey),
      env.SCHEDULER_KV.get(sKey),
    ]);
    let versions = vRaw ? JSON.parse(vRaw) : [];

    if (action === 'save') {
      const cur = sRaw ? JSON.parse(sRaw) : {};
      const assignments = cur.assignments || {};
      const savedAt = new Date().toISOString();
      // 置於陣列最前（最新）
      versions.unshift({ assignments, savedAt, savedBy: userEmail });
      if (versions.length > MAX_VERSIONS) versions = versions.slice(0, MAX_VERSIONS);
      await env.SCHEDULER_KV.put(vKey, JSON.stringify(versions));
      return Response.json({ ok: true, savedAt, savedBy: userEmail, versions: metaList(versions) });
    }

    if (action === 'undo') {
      if (versions.length < 2) {
        return Response.json({ ok: false, error: 'no_previous_version',
          message: '目前沒有可返回的上一版本（需先儲存至少兩個版本）。' }, { status: 400 });
      }
      // 移除最新版本，還原上一版本
      versions.shift();                 // 丟棄目前（最新）版本
      const prev = versions[0];         // 新的最新 = 上一版本
      const savedAt = new Date().toISOString();
      await Promise.all([
        env.SCHEDULER_KV.put(vKey, JSON.stringify(versions)),
        env.SCHEDULER_KV.put(sKey, JSON.stringify({
          assignments: prev.assignments || {},
          updatedAt: savedAt,
          updatedBy: userEmail,
        })),
      ]);
      return Response.json({
        ok: true, restored: true,
        assignments: prev.assignments || {},
        savedAt, savedBy: userEmail,
        versions: metaList(versions),
      });
    }

    return Response.json({ ok: false, error: 'bad_action' }, { status: 400 });
  } catch (e) {
    return Response.json({ ok: false, error: e.message }, { status: 500 });
  }
}

/**
 * 班表版本快照 API（手動「儲存班表」建立還原點）
 *
 * GET  /api/versions?month=2026-07
 *      → { ok, versions: [{ savedAt, savedBy, count }] }（新到舊）
 *
 * POST /api/versions?month=2026-07&action=save   body: { assignments }
 *      → 把前端目前的班表存成新版本（cap 10）。與最新版本內容相同時不重複建立。
 *      → { ok, unchanged?, versions: [...] }
 *
 * POST /api/versions?month=2026-07&action=undo
 *      → 移除最新版本，並把「上一版本」還原回 schedule:MONTH
 *      → { ok, restored: true, assignments, savedAt, savedBy, versions: [...] }
 *      → 不足兩個版本 → 400 no_previous_version
 *
 * KV key: versions:schedule:YYYY-MM = [{ assignments, savedAt, savedBy }]（index 0 最新）
 */
import { getUserEmail, countFilled } from '../../lib/auth.js';

const MAX_VERSIONS = 10;

function metaList(versions) {
  return versions.map(v => ({ savedAt: v.savedAt, savedBy: v.savedBy, count: countFilled(v.assignments) }));
}

function badMonth(month) {
  return !/^\d{4}-\d{2}$/.test(month);
}

export async function onRequestGet({ request, env }) {
  const month = new URL(request.url).searchParams.get('month') || '';
  if (badMonth(month)) return Response.json({ ok: false, error: 'bad_month' }, { status: 400 });
  try {
    const raw = await env.SCHEDULER_KV.get(`versions:schedule:${month}`);
    return Response.json({ ok: true, versions: metaList(raw ? JSON.parse(raw) : []) });
  } catch (e) {
    return Response.json({ ok: false, error: e.message }, { status: 500 });
  }
}

export async function onRequestPost({ request, env }) {
  const url = new URL(request.url);
  const month = url.searchParams.get('month') || '';
  const action = url.searchParams.get('action') || 'save';
  const userEmail = getUserEmail(request);
  if (badMonth(month)) return Response.json({ ok: false, error: 'bad_month' }, { status: 400 });

  const vKey = `versions:schedule:${month}`;
  const sKey = `schedule:${month}`;

  try {
    const vRaw = await env.SCHEDULER_KV.get(vKey);
    let versions = vRaw ? JSON.parse(vRaw) : [];

    if (action === 'save') {
      // 以前端送來的班表為準；舊版前端沒送 body 時才退回讀 KV
      let assignments = null;
      try { assignments = (await request.json()).assignments || null; } catch {}
      if (!assignments) {
        const sRaw = await env.SCHEDULER_KV.get(sKey);
        assignments = sRaw ? (JSON.parse(sRaw).assignments || {}) : {};
      }
      // 與最新版本相同 → 不重複建立（省一次寫入，也避免「返回上一版本」看起來沒反應）
      if (versions.length && JSON.stringify(versions[0].assignments || {}) === JSON.stringify(assignments)) {
        return Response.json({ ok: true, unchanged: true, savedAt: versions[0].savedAt, versions: metaList(versions) });
      }
      const savedAt = new Date().toISOString();
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
      versions.shift();             // 丟棄目前（最新）版本
      const prev = versions[0];     // 上一版本
      const assignments = prev.assignments || {};
      const savedAt = new Date().toISOString();
      // 版本只記班表；當月可上班日保持不變
      const sRaw = await env.SCHEDULER_KV.get(sKey);
      const availability = sRaw ? JSON.parse(sRaw).availability : undefined;
      await Promise.all([
        env.SCHEDULER_KV.put(vKey, JSON.stringify(versions)),
        env.SCHEDULER_KV.put(sKey, JSON.stringify({ assignments, availability, updatedAt: savedAt, updatedBy: userEmail }), {
          metadata: { count: countFilled(assignments), updatedAt: savedAt, updatedBy: userEmail, backupAt: 0 },
        }),
      ]);
      return Response.json({ ok: true, restored: true, assignments, savedAt, savedBy: userEmail, versions: metaList(versions) });
    }

    return Response.json({ ok: false, error: 'bad_action' }, { status: 400 });
  } catch (e) {
    return Response.json({ ok: false, error: e.message }, { status: 500 });
  }
}

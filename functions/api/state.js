/**
 * GET  /api/state?month=2026-04  → { data: { ...global, assignments, year, month } }
 * PUT  /api/state?month=2026-04  ← body: full state object
 *
 * KV keys:
 *   "global"                  → stores, employees, storeSettings, constraints, conflictPairs
 *   "schedule:2026-04"        → { assignments, updatedAt, updatedBy }
 *   "backup:global"           → previous generation of "global" (rolling, 1 世代)
 *   "backup:schedule:2026-04" → previous generation of that month (rolling, 1 世代)
 *
 * 防護機制：
 *   - PUT 會先讀取現有資料，內容相同時跳過寫入（避免 KV rate limit）
 *   - 覆寫前先把舊值寫進 backup: key（誤刪可救回一個世代）
 *   - 若請求會「用空資料覆蓋非空資料」→ 拒絕並回 409（除非 ?force=1）
 */

function getUserEmail(request) {
  const jwt = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!jwt) return 'dev@local';
  try {
    let b64 = jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4 !== 0) b64 += '=';
    return JSON.parse(atob(b64)).email || 'unknown';
  } catch { return 'unknown'; }
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const month = url.searchParams.get('month') || '';

  try {
    const [globalRaw, monthRaw] = await Promise.all([
      env.SCHEDULER_KV.get('global'),
      month ? env.SCHEDULER_KV.get(`schedule:${month}`) : Promise.resolve(null),
    ]);

    const globalData = globalRaw ? JSON.parse(globalRaw) : {};
    const monthData  = monthRaw  ? JSON.parse(monthRaw)  : {};

    // Parse year/month from query param so frontend state is always consistent
    let year  = new Date().getFullYear();
    let monthNum = new Date().getMonth() + 1;
    if (month && /^\d{4}-\d{2}$/.test(month)) {
      [year, monthNum] = month.split('-').map(Number);
    }

    const data = {
      ...globalData,
      assignments: monthData.assignments || {},
      year,
      month: monthNum,
    };

    return Response.json({
      ok: true,
      data,
      monthUpdatedAt: monthData.updatedAt || null,
      monthUpdatedBy: monthData.updatedBy || null,
    });
  } catch (e) {
    return Response.json({ ok: false, error: e.message }, { status: 500 });
  }
}

export async function onRequestPut({ request, env }) {
  const url = new URL(request.url);
  const month = url.searchParams.get('month') || '';
  const force = url.searchParams.get('force') === '1';
  const userEmail = getUserEmail(request);

  try {
    const body = await request.json();

    // Split state: global (shared across months) vs per-month assignments
    const { assignments, year, month: _m, tab, ...globalPart } = body;
    const newGlobalStr = JSON.stringify(globalPart);
    const newAssignments = assignments || {};

    // Read current values for diff / backup / safety checks
    const [curGlobalRaw, curMonthRaw] = await Promise.all([
      env.SCHEDULER_KV.get('global'),
      month ? env.SCHEDULER_KV.get(`schedule:${month}`) : Promise.resolve(null),
    ]);

    // ── 防護：拒絕用空資料覆蓋非空資料 ──
    if (!force && curGlobalRaw) {
      const cur = JSON.parse(curGlobalRaw);
      const curEmpCount = (cur.employees || []).length;
      const newEmpCount = (globalPart.employees || []).length;
      if (curEmpCount > 0 && newEmpCount === 0) {
        return Response.json({
          ok: false,
          error: 'empty_overwrite_blocked',
          message: `雲端目前有 ${curEmpCount} 位員工資料，但這次儲存的員工名單是空的。已阻止覆寫以保護資料。`,
        }, { status: 409 });
      }
    }
    if (!force && month && curMonthRaw) {
      const curMonth = JSON.parse(curMonthRaw);
      const curCount = Object.keys(curMonth.assignments || {}).length;
      const newCount = Object.keys(newAssignments).length;
      if (curCount > 0 && newCount === 0) {
        return Response.json({
          ok: false,
          error: 'empty_overwrite_blocked',
          message: `雲端 ${month} 已有 ${curCount} 筆排班紀錄，但這次儲存是空白班表。已阻止覆寫以保護資料。若確定要清空，請使用「清除排班」功能。`,
        }, { status: 409 });
      }
    }

    const savedAt = new Date().toISOString();
    const writes = [];

    // ── global：內容有變才寫，寫入前備份舊值 ──
    if (curGlobalRaw !== newGlobalStr) {
      if (curGlobalRaw) writes.push(env.SCHEDULER_KV.put('backup:global', curGlobalRaw));
      writes.push(env.SCHEDULER_KV.put('global', newGlobalStr));
    }

    // ── 月排班：內容有變才寫，寫入前備份舊值 ──
    if (month) {
      const newMonthStr = JSON.stringify({ assignments: newAssignments, updatedAt: savedAt, updatedBy: userEmail });
      const curAssignStr = curMonthRaw ? JSON.stringify(JSON.parse(curMonthRaw).assignments || {}) : null;
      if (curAssignStr !== JSON.stringify(newAssignments)) {
        if (curMonthRaw) writes.push(env.SCHEDULER_KV.put(`backup:schedule:${month}`, curMonthRaw));
        writes.push(env.SCHEDULER_KV.put(`schedule:${month}`, newMonthStr));
      }
    }

    await Promise.all(writes);

    return Response.json({ ok: true, savedAt, savedBy: userEmail, writes: writes.length });
  } catch (e) {
    return Response.json({ ok: false, error: e.message }, { status: 500 });
  }
}

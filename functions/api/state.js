/**
 * GET  /api/state?month=2026-04  → { ok, data: { ...global, assignments, year, month }, user, monthUpdatedAt, monthUpdatedBy }
 * PUT  /api/state?month=2026-04  ← body: full state object
 *
 * KV keys:
 *   "global"                  → stores, employees, storeSettings, constraints, conflictPairs, buddyPairs
 *   "schedule:2026-04"        → { assignments, updatedAt, updatedBy }
 *                               metadata: { count, updatedAt, updatedBy, backupAt }（供 /api/months 免讀值）
 *   "backup:global"           → 「global」的舊世代備份
 *   "backup:schedule:2026-04" → 該月的舊世代備份
 *
 * 用量控制（KV 免費額度：寫入 1,000 次/天，是最吃緊的一項）：
 *   - 內容沒變就不寫
 *   - 備份最多每 30 分鐘寫一次（時間記在 KV metadata，讀主資料時一併取得，不多花一次讀取）
 *   - 從未存過的月份，若班表是空的就不建立 key
 *
 * 防護：用空資料覆蓋非空資料 → 409（刻意清空帶 ?force=1）
 */
import { getUserEmail, countFilled } from '../../lib/auth.js';

const BACKUP_INTERVAL_MS = 30 * 60 * 1000;

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const month = url.searchParams.get('month') || '';
  const email = getUserEmail(request);

  try {
    const [globalRaw, monthRaw] = await Promise.all([
      env.SCHEDULER_KV.get('global'),
      month ? env.SCHEDULER_KV.get(`schedule:${month}`) : Promise.resolve(null),
    ]);

    const globalData = globalRaw ? JSON.parse(globalRaw) : {};
    const monthData  = monthRaw  ? JSON.parse(monthRaw)  : {};

    let year  = new Date().getFullYear();
    let monthNum = new Date().getMonth() + 1;
    if (month && /^\d{4}-\d{2}$/.test(month)) {
      [year, monthNum] = month.split('-').map(Number);
    }

    return Response.json({
      ok: true,
      data: { ...globalData, assignments: monthData.assignments || {}, year, month: monthNum },
      // 登入者資訊一起回傳，前端不必再呼叫 /api/whoami
      user: { email, name: email.split('@')[0] },
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
    const { assignments, year, month: _m, tab, ...globalPart } = body;
    const newGlobalStr = JSON.stringify(globalPart);
    const newAssignments = assignments || {};
    const newAssignStr = JSON.stringify(newAssignments);

    // 一次讀取同時拿到值與 metadata（備份時間）
    const [g, m] = await Promise.all([
      env.SCHEDULER_KV.getWithMetadata('global'),
      month ? env.SCHEDULER_KV.getWithMetadata(`schedule:${month}`) : Promise.resolve({ value: null, metadata: null }),
    ]);
    const curGlobalRaw = g.value;
    const curMonth = m.value ? JSON.parse(m.value) : null;

    // ── 防護：拒絕用空資料覆蓋非空資料 ──
    if (!force && curGlobalRaw) {
      const curEmpCount = (JSON.parse(curGlobalRaw).employees || []).length;
      const newEmpCount = (globalPart.employees || []).length;
      if (curEmpCount > 0 && newEmpCount === 0) {
        return Response.json({
          ok: false,
          error: 'empty_overwrite_blocked',
          message: `雲端目前有 ${curEmpCount} 位員工資料，但這次儲存的員工名單是空的。已阻止覆寫以保護資料。`,
        }, { status: 409 });
      }
    }
    if (!force && curMonth) {
      const curCount = Object.keys(curMonth.assignments || {}).length;
      if (curCount > 0 && Object.keys(newAssignments).length === 0) {
        return Response.json({
          ok: false,
          error: 'empty_overwrite_blocked',
          message: `雲端 ${month} 已有 ${curCount} 筆排班紀錄，但這次儲存是空白班表。已阻止覆寫以保護資料。若確定要清空，請使用「清除排班」功能。`,
        }, { status: 409 });
      }
    }

    const now = Date.now();
    const savedAt = new Date(now).toISOString();
    const backupDue = (meta) => !meta || !meta.backupAt || now - meta.backupAt >= BACKUP_INTERVAL_MS;
    const writes = [];
    let monthWritten = false;

    // ── global：內容有變才寫；備份節流 ──
    if (curGlobalRaw !== newGlobalStr) {
      let backupAt = (g.metadata && g.metadata.backupAt) || 0;
      if (curGlobalRaw && backupDue(g.metadata)) {
        writes.push(env.SCHEDULER_KV.put('backup:global', curGlobalRaw));
        backupAt = now;
      }
      writes.push(env.SCHEDULER_KV.put('global', newGlobalStr, { metadata: { backupAt } }));
    }

    // ── 月排班：內容有變才寫；新月份且是空班表 → 不建立 key ──
    if (month) {
      const curAssignStr = curMonth ? JSON.stringify(curMonth.assignments || {}) : null;
      const changed = curAssignStr !== newAssignStr;
      const emptyNewMonth = !curMonth && countFilled(newAssignments) === 0;
      if (changed && !emptyNewMonth) {
        let backupAt = (m.metadata && m.metadata.backupAt) || 0;
        if (m.value && backupDue(m.metadata)) {
          writes.push(env.SCHEDULER_KV.put(`backup:schedule:${month}`, m.value));
          backupAt = now;
        }
        writes.push(env.SCHEDULER_KV.put(
          `schedule:${month}`,
          JSON.stringify({ assignments: newAssignments, updatedAt: savedAt, updatedBy: userEmail }),
          { metadata: { count: countFilled(newAssignments), updatedAt: savedAt, updatedBy: userEmail, backupAt } },
        ));
        monthWritten = true;
      }
    }

    await Promise.all(writes);
    return Response.json({ ok: true, savedAt, savedBy: userEmail, writes: writes.length, monthWritten });
  } catch (e) {
    return Response.json({ ok: false, error: e.message }, { status: 500 });
  }
}

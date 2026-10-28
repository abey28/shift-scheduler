/**
 * GET  /api/state?month=2026-04  → { ok, data: { ...global, assignments, year, month }, user, monthUpdatedAt, monthUpdatedBy,
 *                                    availabilitySource, availabilityFrom }
 * PUT  /api/state?month=2026-04  ← body: full state object
 *
 * KV keys:
 *   "global"                  → stores, employees（不含可上班日）, storeSettings, constraints, conflictPairs, buddyPairs
 *   "schedule:2026-04"        → { assignments, availability, updatedAt, updatedBy }
 *                               availability = 當月可上班日 { 員工 id: [日, ...] }（v2.11 起按月份儲存，見 lib/availability.js）
 *                               metadata: { count, updatedAt, updatedBy, backupAt }（供 /api/months 免讀值）
 *   "backup:global"           → 「global」的舊世代備份
 *   "backup:schedule:2026-04" → 該月的舊世代備份
 *
 * 用量控制（KV 免費額度：寫入 1,000 次/天，是最吃緊的一項）：
 *   - 內容沒變就不寫
 *   - 備份最多每 30 分鐘寫一次（時間記在 KV metadata，讀主資料時一併取得，不多花一次讀取）
 *   - 從未存過的月份，若班表與可上班日都是空的就不建立 key
 *
 * 防護：用空資料覆蓋非空資料 → 409（刻意清空帶 ?force=1）
 */
import { getUserEmail, countFilled } from '../../lib/auth.js';
import { splitAvailability, mergeAvailability, resolveAvailability, monthInfo } from '../../lib/availability.js';

const BACKUP_INTERVAL_MS = 30 * 60 * 1000;

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const month = url.searchParams.get('month') || '';
  const info = monthInfo(month);
  const email = getUserEmail(request);

  try {
    const [globalRaw, monthRaw] = await Promise.all([
      env.SCHEDULER_KV.get('global'),
      info ? env.SCHEDULER_KV.get(`schedule:${month}`) : Promise.resolve(null),
    ]);

    const globalData = globalRaw ? JSON.parse(globalRaw) : {};
    const monthData  = monthRaw  ? JSON.parse(monthRaw)  : {};

    let year  = new Date().getFullYear();
    let monthNum = new Date().getMonth() + 1;
    let availabilitySource = null, availabilityFrom = null;

    if (info) {
      ({ year, month: monthNum } = info);
      // 新月份才需要讀上個月（帶入上月可上班日）；讀取額度充裕，不影響寫入
      const prevRaw = monthRaw ? null : await env.SCHEDULER_KV.get(`schedule:${info.prevMonth}`);
      const { availability, source } = resolveAvailability({
        globalEmployees: globalData.employees,
        monthData: monthRaw ? monthData : null,
        prevMonthData: prevRaw ? JSON.parse(prevRaw) : null,
        daysInMonth: info.daysInMonth,
      });
      if (globalData.employees) globalData.employees = mergeAvailability(globalData.employees, availability);
      availabilitySource = source;
      if (source === 'inherited' && prevRaw) availabilityFrom = info.prevMonth;
    }

    return Response.json({
      ok: true,
      data: { ...globalData, assignments: monthData.assignments || {}, year, month: monthNum },
      // 登入者資訊一起回傳，前端不必再呼叫 /api/whoami
      user: { email, name: email.split('@')[0] },
      monthUpdatedAt: monthData.updatedAt || null,
      monthUpdatedBy: monthData.updatedBy || null,
      availabilitySource,
      availabilityFrom,
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
    // 可上班日從員工身上拆出來，存到月份 key；global 只留跨月共用的員工資料
    const info = monthInfo(month);
    let newAvail = null;
    if (info && Array.isArray(globalPart.employees)) {
      const split = splitAvailability(globalPart.employees, info.daysInMonth);
      globalPart.employees = split.employees;
      newAvail = split.availability;
    }
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

    // ── 月排班＋可上班日：內容有變才寫；新月份且兩者皆空 → 不建立 key ──
    if (month) {
      const curAssignStr = curMonth ? JSON.stringify(curMonth.assignments || {}) : null;
      const availability = newAvail || (curMonth && curMonth.availability) || {};
      const availChanged = newAvail !== null &&
        JSON.stringify((curMonth && curMonth.availability) || null) !== JSON.stringify(newAvail);
      const changed = curAssignStr !== newAssignStr || availChanged;
      const emptyNewMonth = !curMonth && countFilled(newAssignments) === 0 && Object.keys(availability).length === 0;
      if (changed && !emptyNewMonth) {
        let backupAt = (m.metadata && m.metadata.backupAt) || 0;
        if (m.value && backupDue(m.metadata)) {
          writes.push(env.SCHEDULER_KV.put(`backup:schedule:${month}`, m.value));
          backupAt = now;
        }
        writes.push(env.SCHEDULER_KV.put(
          `schedule:${month}`,
          JSON.stringify({ assignments: newAssignments, availability, updatedAt: savedAt, updatedBy: userEmail }),
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

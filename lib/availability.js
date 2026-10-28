/**
 * 可上班日（availability）按月份儲存（v2.11 起）
 *
 * 舊版把可上班日存在 global 的每位員工身上、只記日期數字，所有月份共用同一份，
 * 每次設定新月份就會蓋掉上個月。v2.11 起改存在 schedule:YYYY-MM 的 availability：
 *   { [員工 id]: [1, 5, 12, ...] }（只存有設定的員工）
 *
 * 前端協定不變：GET 時後端把當月可上班日放回每位員工的 availability 欄位；
 * PUT 時後端再從員工身上拆出來存到月份 key。所以還沒重新整理的舊版頁面也能正確讀寫。
 */

/** slot key 格式：YYYY-MM-DD_storeId_SHIFT → 取出日 */
function dayOfSlotKey(key) {
  return parseInt(key.slice(8, 10), 10);
}

function cleanDays(days, daysInMonth) {
  const set = new Set();
  for (const d of days || []) {
    const n = Number(d);
    if (Number.isInteger(n) && n >= 1 && n <= daysInMonth) set.add(n);
  }
  return [...set].sort((a, b) => a - b);
}

/** 從員工清單拆出可上班日 → { employees（不含 availability）, availability（當月 map） } */
export function splitAvailability(employees, daysInMonth) {
  const availability = {};
  const stripped = (employees || []).map(({ availability: days, ...emp }) => {
    const clean = cleanDays(days, daysInMonth);
    if (clean.length) availability[emp.id] = clean;
    return emp;
  });
  return { employees: stripped, availability };
}

/** 把當月可上班日放回員工身上（沒有設定的員工 → 空陣列） */
export function mergeAvailability(employees, availability) {
  return (employees || []).map(emp => ({ ...emp, availability: (availability && availability[emp.id]) || [] }));
}

/** 從已排的班反推：有排班的日子視為可上班 */
export function deriveFromAssignments(assignments, daysInMonth) {
  const byEmp = {};
  for (const [key, ids] of Object.entries(assignments || {})) {
    const d = dayOfSlotKey(key);
    for (const id of ids || []) (byEmp[id] || (byEmp[id] = [])).push(d);
  }
  const out = {};
  for (const [id, days] of Object.entries(byEmp)) {
    const clean = cleanDays(days, daysInMonth);
    if (clean.length) out[id] = clean;
  }
  return out;
}

/** 舊版 global 上的可上班日；global 已遷移（員工身上沒有 availability 欄位）→ null */
function legacyGlobalAvailability(globalEmployees, daysInMonth) {
  const emps = globalEmployees || [];
  if (!emps.some(e => Array.isArray(e.availability))) return null;
  const out = {};
  for (const e of emps) {
    const clean = cleanDays(e.availability, daysInMonth);
    if (clean.length) out[e.id] = clean;
  }
  return out;
}

function covers(avail, required) {
  for (const [id, days] of Object.entries(required)) {
    const have = new Set(avail[id] || []);
    if (days.some(d => !have.has(d))) return false;
  }
  return true;
}

/**
 * 決定某月份的可上班日。
 * source：
 *   saved     月份 key 已有 availability
 *   legacy    舊資料，且 global 上的設定與該月班表完全吻合（就是當初為這個月設定的）→ 沿用
 *   derived   舊資料，global 設定與該月班表不符（是其他月份的設定）→ 依已排的班反推
 *   inherited 新月份，先帶入上個月的設定（與舊版行為一致，使用者再自行調整）
 *   none      沒有任何資料
 */
export function resolveAvailability({ globalEmployees, monthData, prevMonthData, daysInMonth }) {
  if (monthData && monthData.availability) {
    return { availability: monthData.availability, source: 'saved' };
  }
  const legacy = legacyGlobalAvailability(globalEmployees, daysInMonth);
  if (monthData) {
    const assigned = deriveFromAssignments(monthData.assignments, daysInMonth);
    if (legacy && covers(legacy, assigned)) return { availability: legacy, source: 'legacy' };
    return { availability: assigned, source: 'derived' };
  }
  if (prevMonthData && prevMonthData.availability) {
    const out = {};
    for (const [id, days] of Object.entries(prevMonthData.availability)) {
      const clean = cleanDays(days, daysInMonth);
      if (clean.length) out[id] = clean;
    }
    return { availability: out, source: 'inherited' };
  }
  if (legacy) return { availability: legacy, source: 'inherited' };
  return { availability: {}, source: 'none' };
}

/** "2026-11" → { daysInMonth: 30, prevMonth: "2026-10" }；格式錯誤 → null */
export function monthInfo(month) {
  if (!/^\d{4}-\d{2}$/.test(month || '')) return null;
  const [y, m] = month.split('-').map(Number);
  const daysInMonth = new Date(y, m, 0).getDate();
  const py = m === 1 ? y - 1 : y;
  const pm = m === 1 ? 12 : m - 1;
  return { year: y, month: m, daysInMonth, prevMonth: `${py}-${String(pm).padStart(2, '0')}` };
}

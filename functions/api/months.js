/**
 * GET /api/months → { ok: true, months: [{ month: "2026-04", updatedAt, updatedBy, count }] }
 *
 * 列出 KV 中所有有排班資料的月份（掃描 schedule:* keys），
 * 供前端「歷史班表」選單使用。
 */

export async function onRequestGet({ env }) {
  try {
    const list = await env.SCHEDULER_KV.list({ prefix: 'schedule:' });
    const keys = list.keys.map(k => k.name);

    // Read each month to report assignment count + last update info
    const values = await Promise.all(keys.map(k => env.SCHEDULER_KV.get(k)));

    const months = keys.map((k, i) => {
      let data = {};
      try { data = values[i] ? JSON.parse(values[i]) : {}; } catch {}
      return {
        month: k.replace('schedule:', ''),
        count: Object.keys(data.assignments || {}).length,
        updatedAt: data.updatedAt || null,
        updatedBy: data.updatedBy || null,
      };
    }).sort((a, b) => b.month.localeCompare(a.month)); // 新到舊

    return Response.json({ ok: true, months });
  } catch (e) {
    return Response.json({ ok: false, error: e.message }, { status: 500 });
  }
}

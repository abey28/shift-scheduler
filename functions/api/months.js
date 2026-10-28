/**
 * GET /api/months → { ok: true, months: [{ month: "2026-04", updatedAt, updatedBy, count }] }
 *
 * 列出 KV 中所有有排班資料的月份，供「歷史班表」選單使用。
 * 筆數與更新資訊直接取自 key 的 metadata（list 一次就拿到，不必逐月讀值）；
 * 只有 v2.10 以前寫入、尚無 metadata 的舊月份才會退回讀取該月資料。
 */
import { countFilled } from '../../lib/auth.js';

export async function onRequestGet({ env }) {
  try {
    const keys = [];
    let cursor;
    do {
      const page = await env.SCHEDULER_KV.list({ prefix: 'schedule:', cursor });
      keys.push(...page.keys);
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);

    const months = await Promise.all(keys.map(async (k) => {
      const month = k.name.slice('schedule:'.length);
      const md = k.metadata;
      if (md && typeof md.count === 'number') {
        return { month, count: md.count, updatedAt: md.updatedAt || null, updatedBy: md.updatedBy || null };
      }
      // 舊資料（無 metadata）→ 讀值計算
      let data = {};
      try { data = JSON.parse(await env.SCHEDULER_KV.get(k.name) || '{}'); } catch {}
      return { month, count: countFilled(data.assignments), updatedAt: data.updatedAt || null, updatedBy: data.updatedBy || null };
    }));

    months.sort((a, b) => b.month.localeCompare(a.month)); // 新到舊
    return Response.json({ ok: true, months });
  } catch (e) {
    return Response.json({ ok: false, error: e.message }, { status: 500 });
  }
}

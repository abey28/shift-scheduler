/**
 * GET  /api/state?month=2026-04  → { data: { ...global, assignments, year, month } }
 * PUT  /api/state?month=2026-04  ← body: full state object
 *
 * KV keys:
 *   "global"           → employees, storeSettings, constraints, conflictPairs, tab
 *   "schedule:2026-04" → { assignments }
 */

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

    return Response.json({ data });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}

export async function onRequestPut({ request, env }) {
  const url = new URL(request.url);
  const month = url.searchParams.get('month') || '';

  try {
    const body = await request.json();

    // Split state: global (shared across months) vs per-month assignments
    const { assignments, year, month: _m, tab, ...globalPart } = body;

    const writes = [
      env.SCHEDULER_KV.put('global', JSON.stringify(globalPart)),
    ];

    if (month) {
      writes.push(
        env.SCHEDULER_KV.put(`schedule:${month}`, JSON.stringify({ assignments: assignments || {} }))
      );
    }

    await Promise.all(writes);

    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}

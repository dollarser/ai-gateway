export function webSearchTotalsStatement(store, uid, day) {
  return store.stmt(
    "SELECT coalesce(sum(CASE WHEN settled=1 THEN web_search_calls ELSE 0 END),0) used,coalesce(sum(CASE WHEN settled=0 THEN web_search_calls ELSE 0 END),0) reserved FROM luna_usage WHERE user_id=? AND web_search_day=?",
    uid,
    day,
  );
}

export function webSearchResetsAt(day) {
  return new Date(Date.parse(day + "T00:00:00+08:00") + 86400000).toISOString();
}

export function webSearchUsage(user, day, totals) {
  const limit = user.web_search_daily_calls;
  const { used, reserved } = totals;
  return {
    day,
    timezone: "Asia/Shanghai",
    limit,
    used,
    reserved,
    remaining: Math.max(0, limit - used - reserved),
    resets_at: webSearchResetsAt(day),
  };
}

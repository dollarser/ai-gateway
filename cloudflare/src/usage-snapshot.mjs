import {
  webSearchTotalsStatement,
  webSearchUsage,
} from "./web-search-usage.mjs";
import { Denied, day } from "./store.mjs";
import { cloudUsageValue } from "./luna.mjs";
import { audioUsageValue } from "./audio.mjs";
const pageSize = 20;
function historyQuery(store, uid, before = null) {
  const columns = "started,ended,service,status,response_bytes,id";
  return store.stmt(
    "SELECT " +
      columns +
      " FROM requests WHERE user_id=?" +
      (before ? " AND (started,id)<(?,?)" : "") +
      " ORDER BY started DESC,id DESC LIMIT ?",
    uid,
    ...(before ?? []),
    pageSize + 1,
  );
}
function historyPage(rows) {
  const visible = rows.slice(0, pageSize);
  const last = visible.at(-1);
  return {
    requests: visible.map(({ id, ...record }) => record),
    next:
      rows.length > pageSize ? JSON.stringify([last.started, last.id]) : null,
  };
}
export async function usageHistory(store, uid, cursor) {
  let before;
  try {
    before = JSON.parse(cursor);
  } catch {
    throw new Denied(422, "用量记录游标无效");
  }
  if (
    !Array.isArray(before) ||
    before.length !== 2 ||
    !Number.isFinite(before[0]) ||
    before[0] < 0 ||
    typeof before[1] !== "string" ||
    !before[1] ||
    before[1].length > 128
  )
    throw new Denied(422, "用量记录游标无效");
  return historyPage((await historyQuery(store, uid, before).all()).results);
}

export async function usageSnapshot(store, user) {
  const today = day(),
    month = today.slice(0, 7),
    uid = user.id;
  const rows = await store.db.batch([
    store.stmt(
      "SELECT service,count(*) requests,coalesce(sum(response_bytes),0) response_bytes FROM requests WHERE day=? AND user_id=? GROUP BY service",
      today,
      uid,
    ),
    historyQuery(store, uid),
    store.stmt(
      "SELECT used_tokens n,reserved_tokens reserved,requests,prompt_tokens,completion_tokens FROM luna_user_month_totals WHERE user_id=? AND month=?",
      uid,
      month,
    ),
    store.stmt(
      "SELECT kind,sum(charged_units) used,sum(CASE WHEN settled=0 THEN charged_units ELSE 0 END) reserved,count(*) requests FROM audio_usage WHERE user_id=? AND day=? GROUP BY kind",
      uid,
      today,
    ),
    webSearchTotalsStatement(store, uid, today),
  ]);
  const cloud = rows[2].results[0] ?? {
    n: 0,
    reserved: 0,
    requests: 0,
    prompt_tokens: 0,
    completion_tokens: 0,
  };
  const history = historyPage(rows[1].results);
  return {
    usage: { today, totals: rows[0].results, requests: history.requests },
    history_next: history.next,
    web_search: webSearchUsage(user, today, rows[4].results[0]),
    luna: cloudUsageValue(user, cloud, month),
    audio: audioUsageValue(user, rows[3].results, today),
  };
}

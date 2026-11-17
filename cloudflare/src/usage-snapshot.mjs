import { day } from "./store.mjs";
import { cloudUsageValue } from "./luna.mjs";
import { audioUsageValue } from "./audio.mjs";
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
    store.stmt(
      "SELECT * FROM requests WHERE user_id=? ORDER BY started DESC LIMIT 100",
      uid,
    ),
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
  ]);
  const cloud = rows[2].results[0] ?? {
    n: 0,
    reserved: 0,
    requests: 0,
    prompt_tokens: 0,
    completion_tokens: 0,
  };
  return {
    usage: { today, totals: rows[0].results, requests: rows[1].results },
    luna: cloudUsageValue(user, cloud, month),
    audio: audioUsageValue(user, rows[3].results, today),
  };
}

import { Denied, day } from "./store.mjs";
export const PRICE = { input: 100, cached: 10, write: 125, output: 500 };
export function lunaCost(usage) {
  return (
    Math.max(0, usage.input - usage.cached - usage.writes) * PRICE.input +
    usage.cached * PRICE.cached +
    usage.writes * PRICE.write +
    usage.output * PRICE.output
  );
}
export function budgetError(error) {
  const text = String(error);
  if (
    !/global_(cloud_disabled|luna_budget_exhausted|audio_budget_exhausted)/.test(
      text,
    )
  )
    return null;
  const e = new Denied(
    text.includes("global_cloud_disabled") ? 503 : 429,
    text.includes("global_cloud_disabled")
      ? "管理员已暂停云模型服务"
      : "全站模型预算已达到上限，请联系管理员",
  );
  e.code = text.includes("global_cloud_disabled")
    ? "global_cloud_disabled"
    : "global_budget_exhausted";
  e.retryable = false;
  return e;
}
export async function globalUsage(store) {
  const limits = JSON.parse(
      (
        await store.first(
          "SELECT value FROM settings WHERE name='global_limits'",
        )
      ).value,
    ),
    month = day().slice(0, 7);
  const luna = await store.first(
    "SELECT coalesce((SELECT cost_nanos FROM luna_spend_totals WHERE month=?),0) charged,coalesce((SELECT reserved_cost_nanos FROM luna_spend_totals WHERE month=?),0) reserved",
    month,
    month,
  );
  const audio = await store.all(
    "SELECT kind,units used FROM audio_spend_totals WHERE day=?",
    day(),
  );
  return {
    limits,
    month,
    day: day(),
    timezone: "Asia/Shanghai",
    luna: {
      used_usd: luna.charged / 1e9,
      reserved_usd: luna.reserved / 1e9,
      remaining_usd: Math.max(0, limits.luna_monthly_usd - luna.charged / 1e9),
      pricing_usd_per_million: {
        input: 0.1,
        cached: 0.01,
        cache_write: 0.125,
        output: 0.5,
      },
    },
    embedding_pricing_usd_per_million: { "text-embedding-3-small": 0.02 },
    audio: Object.fromEntries(audio.map((r) => [r.kind, r.used])),
  };
}
export function validateLimits(b) {
  const fields = [
    "cloud_enabled",
    "luna_monthly_usd",
    "asr_daily_minutes",
    "tts_daily_characters",
  ];
  if (
    !b ||
    typeof b !== "object" ||
    Array.isArray(b) ||
    Object.keys(b).length !== fields.length ||
    Object.keys(b).some((k) => !fields.includes(k)) ||
    typeof b.cloud_enabled !== "boolean"
  )
    throw new Denied(422, "全站预算字段无效");
  if (
    !Number.isFinite(b.luna_monthly_usd) ||
    b.luna_monthly_usd < 0 ||
    b.luna_monthly_usd > 1000000 ||
    Math.abs(b.luna_monthly_usd * 100 - Math.round(b.luna_monthly_usd * 100)) >
      1e-6
  )
    throw new Denied(422, "美元预算应为 0–100 万，最多两位小数");
  for (const k of ["asr_daily_minutes", "tts_daily_characters"])
    if (
      b[k] !== null &&
      (!Number.isSafeInteger(b[k]) || b[k] < 0 || b[k] > 1e9)
    )
      throw new Denied(422, "语音全站上限应为非负整数或 null");
  return b;
}

import { Denied } from "./store.mjs";

const endpoint = "https://api.openai.com/v1/organization/costs";
const daySeconds = 86400;

export async function organizationCosts(key, period, fetchCosts = fetch) {
  if (!["month", "7d", "30d"].includes(period))
    throw new Denied(422, "费用时间范围无效");
  if (!key) throw new Denied(503, "尚未配置 OpenAI 费用查询密钥");

  const end = Math.floor(Date.now() / 1000);
  const today = end - (end % daySeconds);
  const date = new Date(today * 1000);
  const start =
    period === "month"
      ? Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1) / 1000
      : today - (parseInt(period, 10) - 1) * daySeconds;
  const url = new URL(endpoint);
  url.search = new URLSearchParams({
    start_time: String(start),
    end_time: String(Math.max(end, start + 1)),
    bucket_width: "1d",
    limit: "31",
  });
  const buckets = new Map();
  const cursors = new Set();
  const signal = AbortSignal.timeout(10000);

  try {
    for (;;) {
      const response = await fetchCosts(url, {
        headers: { Authorization: "Bearer " + key, Accept: "application/json" },
        redirect: "manual",
        signal,
      });
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 401 || response.status === 403)
          throw new Denied(
            502,
            "OpenAI 拒绝费用查询，请检查组织 Admin API Key 权限",
          );
        throw new Denied(502, "OpenAI 费用暂时不可用，请稍后重试");
      }
      const page = await response.json();
      if (!Array.isArray(page.data) || typeof page.has_more !== "boolean")
        throw new Error("Invalid costs page");
      for (const bucket of page.data) {
        const ts = bucket.start_time;
        if (
          !Number.isSafeInteger(ts) ||
          ts < start ||
          ts > today ||
          buckets.has(ts) ||
          !Array.isArray(bucket.results)
        )
          throw new Error("Invalid costs bucket");
        const amounts = new Map();
        for (const { amount } of bucket.results) {
          if (
            !/^[a-z]{3}$/.test(amount?.currency ?? "") ||
            !Number.isFinite(amount?.value)
          )
            throw new Error("Invalid currency amount");
          amounts.set(
            amount.currency,
            (amounts.get(amount.currency) ?? 0) + amount.value,
          );
        }
        buckets.set(ts, Object.fromEntries(amounts));
      }
      if (!page.has_more) break;
      if (
        typeof page.next_page !== "string" ||
        !page.next_page ||
        cursors.has(page.next_page) ||
        cursors.size >= 4
      )
        throw new Error("Invalid costs cursor");
      cursors.add(page.next_page);
      url.searchParams.set("page", page.next_page);
    }
  } catch (error) {
    if (error instanceof Denied) throw error;
    throw new Denied(502, "读取 OpenAI 费用失败，请稍后重试");
  }

  return {
    start_time: start,
    end_time: end,
    fetched_at: Math.floor(Date.now() / 1000),
    days: [...buckets]
      .sort(([a], [b]) => a - b)
      .map(([ts, amounts]) => ({
        date: new Date(ts * 1000).toISOString().slice(0, 10),
        amounts,
      })),
  };
}

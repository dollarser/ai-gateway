import { schemaValidationHint } from "./worker-logs.mjs";
import { Denied } from "./store.mjs";
const safe = (v) =>
  typeof v === "string" && /^[a-zA-Z0-9_.\[\]-]{1,128}$/.test(v) ? v : null;
export function providerEventError(value, status = 502, kind = "request") {
  const code = safe(value?.code),
    param = safe(value?.param);
  let name = "provider_rejected",
    message = "模型服务拒绝请求",
    retryable = false;
  if (code === "unsupported_country_region_territory") {
    name = "provider_region_restricted";
    message = "OpenAI 拒绝了当前地区的访问，请联系管理员核查";
  } else if (
    status === 401 ||
    ["invalid_api_key", "invalid_authentication"].includes(code)
  ) {
    name = "provider_auth_failed";
    message = "模型服务凭据异常，请联系管理员";
  } else if (
    [
      "insufficient_quota",
      "credit_balance_exhausted",
      "billing_hard_limit_reached",
      "organization_spend_limit_exceeded",
      "project_spend_limit_exceeded",
    ].includes(code)
  ) {
    name = "provider_credit_exhausted";
    message = "模型服务余额或账单限额不足，请联系管理员";
  } else if (status === 429) {
    name = "provider_rate_limited";
    message = "模型服务请求过于频繁，请稍后重试";
    retryable = true;
  } else if (status === 400 || status === 422) {
    name = "provider_invalid_request";
    message = "模型服务不接受请求参数" + (param ? "：" + param : "");
  } else if (status >= 500) {
    name = "provider_unavailable";
    message = "模型服务暂不可用";
    retryable = true;
  }
  const e = new Denied(
    status === 400 || status === 422 ? status : status === 429 ? 429 : 502,
    message,
  );
  Object.assign(e, {
    code: name,
    upstream_error_code: code,
    upstream_error_param: param,
    upstream_status: status,
    retryable,
    provider_operation: kind,
  });
  return e;
}
export async function providerFailure(response, kind) {
  let value = null;
  try {
    const reader = response.body?.getReader();
    let text = "",
      n = 0;
    if (reader)
      try {
        while (true) {
          const r = await reader.read();
          if (r.done) break;
          n += r.value.length;
          if (n > 16384) break;
          text += new TextDecoder().decode(r.value);
        }
      } finally {
        await reader.cancel();
      }
    value = JSON.parse(text)?.error;
  } catch {}
  const e = providerEventError(value, response.status, kind);
  e.validation_hint = schemaValidationHint(value?.message);
  e.upstream_request_id = safe(
    response.headers?.get("x-openai-request-id") ??
      response.headers?.get("x-request-id"),
  );
  const retry = response.headers?.get("retry-after");
  if (e.retryable && /^\d{1,4}$/.test(retry ?? ""))
    e.retry_after = Math.min(3600, Math.max(1, Number(retry)));
  return e;
}

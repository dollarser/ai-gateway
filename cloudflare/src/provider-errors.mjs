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
export async function readErrorBody(response) {
  try {
    const reader = response.body?.getReader();
    if (!reader) return null;
    const decoder = new TextDecoder();
    let text = "";
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) return JSON.parse(text + decoder.decode());
        size += value.length;
        if (size > 65536) return null;
        text += decoder.decode(value, { stream: true });
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
  } catch {
    return null;
  }
}

export function nativeError(value) {
  if (typeof value?.message !== "string" || typeof value.type !== "string")
    return null;
  const { message, type, code = null, param = null } = value;
  if (
    ![code, param].every((field) => field === null || typeof field === "string")
  )
    return null;
  return { message, type, param, code };
}

export async function providerFailure(response, kind) {
  const value = (await readErrorBody(response))?.error;
  const e = providerEventError(value, response.status, kind);
  // The upstream credential belongs to the gateway and may be echoed by the provider.
  if (
    e.code !== "provider_auth_failed" &&
    (response.status !== 403 || e.code === "provider_region_restricted")
  ) {
    e.native_error = nativeError(value);
    if (e.native_error)
      e.native_retry_after = response.headers.get("retry-after");
  }
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

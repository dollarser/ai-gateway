"use strict";
const $ = (id) => document.getElementById(id);
let csrf = "",
  user = null;
function message(text, error = false) {
  $("message").textContent = text;
  $("message").classList.toggle("error", error);
}
async function api(path, method = "GET", body, signal) {
  const response = await fetch(path, {
    method,
    signal,
    headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) {
    const labels = {
      provider_region_restricted:
        "OpenAI 拒绝当前地区访问，请联系管理员核查；不要自动重试",
      provider_auth_failed: "上游密钥异常，请联系管理员，无需重新登录",
      provider_credit_exhausted: "上游余额或账单限额不足",
      global_budget_exhausted: "全站模型预算已达到上限，不代表个人额度清零",
      global_cloud_disabled: "管理员已暂停云模型服务",
      account_luna_budget_exhausted: "个人 Luna 月额度不足",
      account_asr_budget_exhausted: "个人今日识别时长不足",
      account_tts_budget_exhausted: "个人今日合成字符不足",
      provider_stream_interrupted: "响应未完整结束，用量待核对，请勿自动重发",
    };
    const error = new Error(
      (labels[data.error_code] ??
        (typeof data.detail === "string" ? data.detail : "请求失败")) +
        (data.request_id ? " · 请求 ID：" + data.request_id : ""),
    );
    error.status = response.status;
    error.code = data.error_code;
    error.retryable = data.retryable === true;
    error.request_id = data.request_id;
    error.retry_after = response.headers.get("Retry-After");
    throw error;
  }
  return data;
}
function run(fn) {
  return async (event) => {
    event?.preventDefault();
    const button = event?.submitter;
    if (button) button.disabled = true;
    try {
      await fn(event);
    } catch (error) {
      message(error.message, true);
    } finally {
      if (button) button.disabled = false;
    }
  };
}
function selected(form) {
  return Array.from(form.querySelectorAll("input[name=services]:checked")).map(
    (x) => x.value,
  );
}
function action(text, fn, danger = false) {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = text;
  if (danger) b.className = "danger";
  b.addEventListener("click", run(fn));
  return b;
}
function row(target, values, buttons = []) {
  const tr = document.createElement("tr");
  for (const value of values) {
    const td = document.createElement("td");
    td.textContent = String(value);
    tr.append(td);
  }
  const td = document.createElement("td");
  buttons.forEach((b) => td.append(b));
  tr.append(td);
  $(target).append(tr);
}
function date(value) {
  return new Date(value * 1000).toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
  });
}

function webSearchSummary(quota) {
  if (!quota) return "";
  return (
    "Luna 网页搜索 · 已用 " +
    quota.used +
    " 次 · 预留 " +
    quota.reserved +
    " 次 · 剩余 " +
    quota.remaining +
    " / " +
    quota.limit +
    " 次 · " +
    date(Date.parse(quota.resets_at) / 1000) +
    "（北京时间）重置"
  );
}

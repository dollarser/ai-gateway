"""Actionable gateway errors; never replay model requests automatically."""

import json
import httpx

MESSAGES = {
    "provider_region_restricted": "OpenAI 拒绝当前地区访问，请联系管理员核查；不要自动重试。",
    "provider_auth_failed": "上游服务密钥异常，请联系管理员；无需重新登录。",
    "provider_credit_exhausted": "上游服务余额或账单限额不足，请联系管理员。",
    "global_budget_exhausted": "全站模型预算已达到上限；不是个人额度清零。",
    "global_cloud_disabled": "管理员已暂停云模型服务。",
    "account_luna_budget_exhausted": "个人 Luna 月额度不足，请降低输出上限或联系管理员。",
    "account_asr_budget_exhausted": "个人今日识别时长不足。",
    "account_tts_budget_exhausted": "个人今日合成字符额度不足。",
    "account_daily_limit": "个人当日请求上限已达到。",
    "key_token_budget_exhausted": "当前 API Key 的 token 额度已达到上限。",
    "provider_rate_limited": "上游限流，请按 Retry-After 稍后再试。",
    "account_rate_limited": "账号请求过于频繁，请稍后再试。",
    "account_concurrency_limited": "账号并发已满，请等待已有请求结束。",
    "provider_stream_interrupted": "响应未完整结束，用量待核对；不要自动重发。",
}


class GatewayError(RuntimeError):
    def __init__(
        self, code, message, status, request_id=None, retryable=False, retry_after=None
    ):
        self.code, self.status, self.request_id = code, status, request_id
        self.retryable, self.retry_after = retryable, retry_after
        super().__init__(message + (" 请求 ID：" + request_id if request_id else ""))


def require_success(response):
    if response.is_success:
        return
    raw = bytearray()
    try:
        for part in response.iter_bytes():
            raw.extend(part)
            if len(raw) > 16384:
                break
        data = json.loads(raw[:16384])
        if not isinstance(data, dict):
            data = {}
    except (ValueError, RuntimeError, httpx.HTTPError):
        data = {}
    finally:
        response.close()
    code = data.get("error_code", "request_failed")
    if not isinstance(code, str) or len(code) > 128:
        code = "request_failed"
    message = MESSAGES.get(
        code,
        "登录凭证无效或已过期。"
        if response.status_code == 401
        else "网关请求失败，请根据请求 ID 联系管理员。",
    )
    request_id = response.headers.get("X-Request-ID")
    if request_id and (
        len(request_id) > 128 or not all(c.isalnum() or c in "_.:-" for c in request_id)
    ):
        request_id = None
    retry = response.headers.get("Retry-After", "")
    raise GatewayError(
        code,
        message,
        response.status_code,
        request_id,
        data.get("retryable") is True,
        int(retry) if retry.isdigit() and len(retry) < 6 else None,
    )

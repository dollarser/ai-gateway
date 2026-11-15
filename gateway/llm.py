"""Pure Qwen request normalization, model capabilities and context recovery."""

from __future__ import annotations

import logging
import os
import re
from typing import Any, Optional

from .openai import MAX_TOKENS_FIELDS

logger = logging.getLogger("gateway.sglang_compat")

# Qwen3.8 模板的有效值。Anthropic/OpenAI `high` 在此模型映射为 `xhigh`。
REASONING_EFFORT_ALIASES = {"high": "xhigh"}
QWEN_REASONING_EFFORTS = frozenset(("low", "medium", "xhigh"))
QWEN_DEFAULT_REASONING_EFFORT = "xhigh"


class UnsupportedReasoningEffort(ValueError):
    """Effort value has no defined mapping in the active Qwen chat template."""


# 降 max_tokens 重试时预留的安全边距。
# 上游算出的「可用预算」是按它自己的 tokenizer 数的，与最终实际生成可能
# 有几十个 token 的出入；贴着上限重试容易二次溢出，留 512 个 token 兜底。
CONTEXT_RETRY_SAFETY_TOKENS = int(os.getenv("CONTEXT_RETRY_SAFETY_TOKENS", "512"))

# SGLang 用这个状态码表达「上下文溢出」。各家基本都用 400，不是 SGLang 特有，
# 但集中在这里便于将来换成解析 error.type 时一并调整。
CONTEXT_OVERFLOW_STATUS = 400

# 「输入 + 输出 超过窗口」的报错文案。上游措辞一旦变化，只需要改这里。
_CONTEXT_OVERFLOW_RE = re.compile(
    r"maximum context length of (\d+) tokens.*?"
    r"(\d+) tokens from the input messages and (\d+) tokens for the completion",
    flags=re.DOTALL,
)


# ---------------- 消息规范化 ----------------


def _as_parts(content: Any) -> list[Any]:
    if content is None or content == "":
        return []
    return (
        list(content)
        if isinstance(content, list)
        else [{"type": "text", "text": str(content)}]
    )


def _merge_content(left: Any, right: Any) -> Any:
    """Append developer content without flattening image/audio/video content parts."""
    if isinstance(left, str) and isinstance(right, str):
        left, right = left.strip(), right.strip()
        return "\n\n".join(part for part in (left, right) if part)
    left_parts, right_parts = _as_parts(left), _as_parts(right)
    if left_parts and right_parts:
        left_parts.append({"type": "text", "text": "\n\n"})
    return left_parts + right_parts


def normalize_messages(messages: Any) -> Any:
    """把 `developer` 角色折叠进第一条 system 消息。

    SGLang 不认 `developer`，直接 400。折叠策略与 OpenAI 的语义一致：
    developer 指令的优先级高于普通 system，但实际影响很小，统一并进
    第一条 system 即可。

    没有 system 消息时，在最前面插一条；没有任何 developer 时原样返回
    （不复制、不重建，避免无谓开销）。
    """
    if not isinstance(messages, list):
        return messages

    developer_contents: list[Any] = []
    for msg in messages:
        if isinstance(msg, dict) and msg.get("role") == "developer":
            content = msg.get("content")
            if content not in (None, "", []):
                developer_contents.append(content)

    if not developer_contents:
        return messages

    merged: Any = developer_contents[0]
    for content in developer_contents[1:]:
        merged = _merge_content(merged, content)
    out: list[Any] = []
    inserted = False

    for msg in messages:
        if not isinstance(msg, dict):
            out.append(msg)
            continue
        role = msg.get("role")
        if role == "developer":
            continue
        if role == "system" and not inserted:
            # 新建 dict 而不是原地改：调用方可能还持有原 payload 做别的用途
            out.append({**msg, "content": _merge_content(msg.get("content"), merged)})
            inserted = True
            continue
        out.append(msg)

    if not inserted:
        out.insert(0, {"role": "system", "content": merged})

    return out


def rewrite_payload(payload: Any) -> Any:
    """对请求体做兼容改写，返回新的 dict（不改动入参）。

    只处理认识的结构，遇到意外类型一律原样放过——兼容层绝不能因为
    自己的解析假设把正常请求搞坏。
    """
    if not isinstance(payload, dict):
        return payload

    out = dict(payload)
    notes: list[str] = []

    # 1. developer -> system
    messages = out.get("messages")
    normalized = normalize_messages(messages)
    if normalized is not messages:
        out["messages"] = normalized
        notes.append("developer->system")

    # 2. Map both client conventions to SGLang's actual chat-template parameter.
    # Keep other output_config keys intact; never forward its unsupported effort field.
    output_config = out.get("output_config")
    effort = out.get("reasoning_effort")
    effort_source = "reasoning_effort"
    if not isinstance(effort, str) and isinstance(output_config, dict):
        effort = output_config.get("effort")
        effort_source = "output_config.effort"
    if isinstance(effort, str):
        original = effort.strip().lower()
        mapped = REASONING_EFFORT_ALIASES.get(original, original)
        if mapped in QWEN_REASONING_EFFORTS:
            kwargs = (
                dict(out.get("chat_template_kwargs"))
                if isinstance(out.get("chat_template_kwargs"), dict)
                else {}
            )
            kwargs["reasoning_effort"] = mapped
            out["chat_template_kwargs"] = kwargs
            notes.append(f"{effort_source}:{original}->{mapped}")
        else:
            raise UnsupportedReasoningEffort(
                f"unsupported reasoning effort {original!r}; expected low, medium, high, or xhigh"
            )
    out.pop("reasoning_effort", None)

    if isinstance(output_config, dict) and "effort" in output_config:
        trimmed = {k: v for k, v in output_config.items() if k != "effort"}
        if trimmed:
            out["output_config"] = trimmed
        else:
            out.pop("output_config", None)
        notes.append("drop output_config.effort")

    if notes:
        logger.info("兼容改写: %s", ", ".join(notes))

    return out


# ---------------- 模型元信息 ----------------


def parse_model_max_len(models_payload: Any) -> int:
    """从 `/v1/models` 的响应里取出模型的上下文窗口。

    `max_model_len` **不是 OpenAI 规范字段**（OpenAI 的 `/v1/models` 只返回
    `id` / `object` / `created` / `owned_by`），是 vLLM / SGLang 系自己加的，
    所以这条解析规则属于兼容层，不属于通用网关。

    多个模型时取最小值——网关只能按最保守的窗口做钳制。
    取不到返回 0，表示「不做窗口钳制」（调用方据此退化，不视为错误）。
    """
    if not isinstance(models_payload, dict):
        return 0
    lens: list[int] = []
    for model in models_payload.get("data") or []:
        if not isinstance(model, dict):
            continue
        value = model.get("max_model_len")
        if isinstance(value, (int, float)) and value > 0:
            lens.append(int(value))
    return min(lens) if lens else 0


def add_reasoning_capabilities(
    models_payload: Any,
    supported: tuple[str, ...] = tuple(sorted(QWEN_REASONING_EFFORTS)),
    default: str = QWEN_DEFAULT_REASONING_EFFORT,
) -> Any:
    """在 OpenAI `/v1/models` 响应中附加网关已配置的思考强度能力。"""
    if not isinstance(models_payload, dict):
        return models_payload
    data = models_payload.get("data")
    if not isinstance(data, list):
        return models_payload
    out = dict(models_payload)
    out["data"] = [
        {
            **model,
            "supported_reasoning_efforts": list(supported),
            "default_reasoning_effort": default,
            "reasoning_effort_aliases": dict(REASONING_EFFORT_ALIASES),
        }
        if isinstance(model, dict)
        else model
        for model in data
    ]
    return out


# ---------------- 上下文溢出重试 ----------------


def context_retry_budget(error_body: bytes, payload: Any) -> Optional[tuple[str, int]]:
    """从「上下文溢出」的 400 错误里算出可用的输出预算。

    返回 `(字段名, 建议值)`；不是这种错误、或算出来不比原来小，返回 None。

    上游的文案形如：

        Requested token count exceeds the model's maximum context length of
        262144 tokens. You requested a total of 271206 tokens: 9062 tokens
        from the input messages and 262144 tokens for the completion.

    可用预算 = 窗口 - 输入 - 安全边距。**必须比原值小**，否则重试毫无意义，
    只会把同一个请求再打一遍上游。
    """
    if not isinstance(payload, dict) or not error_body:
        return None

    message = error_body.decode("utf-8", "replace")
    match = _CONTEXT_OVERFLOW_RE.search(message)
    if not match:
        return None

    context_limit = int(match.group(1))
    input_tokens = int(match.group(2))

    available = context_limit - input_tokens - CONTEXT_RETRY_SAFETY_TOKENS
    if available < 1:
        # 输入本身就把窗口吃满了，降 max_tokens 也救不回来——让上游的报错原样透出
        logger.warning(
            "上下文已无可用输出预算（窗口 %d，输入 %d），不再重试",
            context_limit,
            input_tokens,
        )
        return None

    for field in MAX_TOKENS_FIELDS:
        value = payload.get(field)
        if isinstance(value, int) and value > available:
            return field, available

    return None


def plan_context_retry(error_body: bytes, payload: Any) -> Optional[tuple[dict, str]]:
    """给调用方用的「重试计划」：返回 `(新 payload, 日志说明)`，不需要重试则 None。

    调用方只管「拿到新 payload 就原样重发一次」，不需要知道是哪个字段、
    降到了多少、怎么算的——那些都是这个服务栈的内部细节。

    入参 payload 不会被改动，返回的是新 dict。
    """
    budget = context_retry_budget(error_body, payload)
    if budget is None:
        return None
    field, reduced = budget
    note = f"{field} {payload[field]} -> {reduced}"
    return {**payload, field: reduced}, note

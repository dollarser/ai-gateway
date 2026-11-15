#!/usr/bin/env python3
"""Pure Qwen protocol regression tests."""

from __future__ import annotations

import json
import unittest

from gateway import llm

CONTEXT_ERROR = (
    b'{"message":"Requested token count exceeds the model\'s maximum context length of '
    b"262144 tokens. You requested a total of 271206 tokens: 9062 tokens from the input "
    b'messages and 262144 tokens for the completion."}'
)


class TestNormalizeMessages(unittest.TestCase):
    def test_folds_into_existing_system(self):
        payload = {
            "messages": [
                {"role": "system", "content": "S"},
                {"role": "developer", "content": "D"},
                {"role": "user", "content": "U"},
            ]
        }
        out = llm.rewrite_payload(payload)["messages"]
        self.assertEqual([m["role"] for m in out], ["system", "user"])
        self.assertEqual(out[0]["content"], "S\n\nD")

    def test_inserts_system_when_absent(self):
        payload = {
            "messages": [
                {"role": "developer", "content": "D"},
                {"role": "user", "content": "U"},
            ]
        }
        out = llm.rewrite_payload(payload)["messages"]
        self.assertEqual(out[0], {"role": "system", "content": "D"})
        self.assertEqual(out[1]["role"], "user")

    def test_multiple_developers_merged_in_order(self):
        payload = {
            "messages": [
                {"role": "developer", "content": "A"},
                {"role": "developer", "content": "B"},
            ]
        }
        out = llm.rewrite_payload(payload)["messages"]
        self.assertEqual(out, [{"role": "system", "content": "A\n\nB"}])

    def test_multimodal_content_structure_preserved(self):
        payload = {
            "messages": [
                {
                    "role": "developer",
                    "content": [
                        {"type": "text", "text": "A"},
                        {
                            "type": "image_url",
                            "image_url": {"url": "data:image/png;base64,abc"},
                        },
                    ],
                }
            ]
        }
        out = llm.rewrite_payload(payload)["messages"]
        self.assertEqual(out[0]["content"], payload["messages"][0]["content"])

    def test_merge_keeps_system_and_developer_parts(self):
        messages = [
            {"role": "system", "content": [{"type": "text", "text": "S"}]},
            {
                "role": "developer",
                "content": [
                    {"type": "text", "text": "D"},
                    {
                        "type": "image_url",
                        "image_url": {"url": "https://example.invalid/a.png"},
                    },
                ],
            },
        ]
        merged = llm.normalize_messages(messages)[0]["content"]
        self.assertEqual(merged[0], {"type": "text", "text": "S"})
        self.assertEqual(merged[2], {"type": "text", "text": "D"})
        self.assertEqual(merged[3], messages[1]["content"][1])

    def test_untouched_when_no_developer(self):
        """没有 developer 时不能重建 messages —— 避免无谓开销。"""
        messages = [{"role": "user", "content": "U"}]
        out = llm.rewrite_payload({"messages": messages})["messages"]
        self.assertIs(out, messages)

    def test_non_list_messages_passthrough(self):
        self.assertEqual(llm.normalize_messages("nonsense"), "nonsense")
        self.assertIsNone(llm.normalize_messages(None))


class TestReasoningEffort(unittest.TestCase):
    def test_alias_applied(self):
        out = llm.rewrite_payload({"reasoning_effort": "high"})
        self.assertEqual(out["chat_template_kwargs"]["reasoning_effort"], "xhigh")
        self.assertNotIn("reasoning_effort", out)

    def test_alias_is_case_insensitive(self):
        out = llm.rewrite_payload({"reasoning_effort": "HIGH"})
        self.assertEqual(out["chat_template_kwargs"]["reasoning_effort"], "xhigh")

    def test_other_values_untouched(self):
        for value in ("low", "medium", "xhigh"):
            out = llm.rewrite_payload({"reasoning_effort": value})
            self.assertEqual(
                out["chat_template_kwargs"]["reasoning_effort"], value, value
            )
        with self.assertRaises(llm.UnsupportedReasoningEffort):
            llm.rewrite_payload({"reasoning_effort": "minimal"})


class TestOutputConfig(unittest.TestCase):
    def test_only_effort_dropped(self):
        out = llm.rewrite_payload(
            {"output_config": {"effort": "high", "format": "json"}}
        )
        self.assertEqual(out["output_config"], {"format": "json"})
        self.assertEqual(out["chat_template_kwargs"]["reasoning_effort"], "xhigh")

    def test_key_removed_when_empty(self):
        out = llm.rewrite_payload({"output_config": {"effort": "high"}})
        self.assertNotIn("output_config", out)
        self.assertEqual(out["chat_template_kwargs"]["reasoning_effort"], "xhigh")

    def test_untouched_without_effort(self):
        out = llm.rewrite_payload({"output_config": {"format": "json"}})
        self.assertEqual(out["output_config"], {"format": "json"})


class TestPurity(unittest.TestCase):
    def test_does_not_mutate_input(self):
        src = {
            "messages": [{"role": "developer", "content": "D"}],
            "reasoning_effort": "high",
        }
        snapshot = json.dumps(src, sort_keys=True)
        llm.rewrite_payload(src)
        self.assertEqual(json.dumps(src, sort_keys=True), snapshot)

    def test_non_dict_passthrough(self):
        self.assertEqual(llm.rewrite_payload("nope"), "nope")
        self.assertEqual(llm.rewrite_payload(None), None)

    def test_no_rewrite_needed_returns_equal_copy(self):
        src = {"model": "m", "messages": [{"role": "user", "content": "U"}]}
        self.assertEqual(llm.rewrite_payload(src), src)


class TestParseModelMaxLen(unittest.TestCase):
    """`max_model_len` 不是 OpenAI 规范字段，解析规则属于这一层。"""

    def test_picks_the_field(self):
        payload = {"data": [{"id": "Qwen3.8-27B", "max_model_len": 262144}]}
        self.assertEqual(llm.parse_model_max_len(payload), 262144)

    def test_takes_minimum_across_models(self):
        payload = {
            "data": [
                {"id": "a", "max_model_len": 262144},
                {"id": "b", "max_model_len": 32768},
            ]
        }
        self.assertEqual(llm.parse_model_max_len(payload), 32768)

    def test_zero_means_no_clamping(self):
        """取不到时返回 0，调用方据此退化为「不钳制」，不是错误。"""
        self.assertEqual(llm.parse_model_max_len({}), 0)
        self.assertEqual(llm.parse_model_max_len({"data": []}), 0)
        self.assertEqual(llm.parse_model_max_len({"data": [{"id": "a"}]}), 0)
        self.assertEqual(llm.parse_model_max_len(None), 0)
        self.assertEqual(llm.parse_model_max_len("nope"), 0)


class TestModelReasoningCapabilities(unittest.TestCase):
    def test_adds_configured_efforts_without_dropping_model_fields(self):
        source = {
            "object": "list",
            "data": [{"id": "Qwen3.8-27B", "owned_by": "sglang"}],
        }
        result = llm.add_reasoning_capabilities(source)
        self.assertEqual(
            result["data"][0]["supported_reasoning_efforts"], ["low", "medium", "xhigh"]
        )
        self.assertEqual(result["data"][0]["default_reasoning_effort"], "xhigh")
        self.assertEqual(
            result["data"][0]["reasoning_effort_aliases"], {"high": "xhigh"}
        )
        self.assertEqual(result["data"][0]["owned_by"], "sglang")
        self.assertNotIn("supported_reasoning_efforts", source["data"][0])

    def test_non_model_payload_is_unchanged(self):
        for source in (None, [], {"data": "invalid"}):
            self.assertEqual(llm.add_reasoning_capabilities(source), source)

    def test_ignores_bogus_entries(self):
        payload = {
            "data": [
                {"max_model_len": "not-a-number"},
                {"max_model_len": -5},
                "a string",
                {"max_model_len": 4096},
            ]
        }
        self.assertEqual(llm.parse_model_max_len(payload), 4096)


class TestContextRetryBudget(unittest.TestCase):
    def test_budget_math(self):
        got = llm.context_retry_budget(CONTEXT_ERROR, {"max_tokens": 262144})
        self.assertEqual(
            got, ("max_tokens", 262144 - 9062 - llm.CONTEXT_RETRY_SAFETY_TOKENS)
        )

    def test_max_completion_tokens_takes_priority(self):
        got = llm.context_retry_budget(
            CONTEXT_ERROR, {"max_completion_tokens": 262144, "max_tokens": 100}
        )
        self.assertEqual(got[0], "max_completion_tokens")

    def test_not_a_context_error(self):
        body = b'{"message":"Unexpected message role.","type":"BadRequest"}'
        self.assertIsNone(llm.context_retry_budget(body, {"max_tokens": 10}))

    def test_empty_body(self):
        self.assertIsNone(llm.context_retry_budget(b"", {"max_tokens": 10}))

    def test_existing_value_already_fits(self):
        """算出来不比原值小就没有重试的意义，必须返回 None。"""
        self.assertIsNone(llm.context_retry_budget(CONTEXT_ERROR, {"max_tokens": 100}))

    def test_input_alone_fills_window(self):
        body = (
            b"maximum context length of 262144 tokens. You requested a total of 262144 "
            b"tokens: 262144 tokens from the input messages and 100 tokens for the completion."
        )
        self.assertIsNone(llm.context_retry_budget(body, {"max_tokens": 100}))

    def test_no_max_tokens_field(self):
        self.assertIsNone(llm.context_retry_budget(CONTEXT_ERROR, {"model": "m"}))

    def test_non_dict_payload(self):
        self.assertIsNone(llm.context_retry_budget(CONTEXT_ERROR, None))


class TestPlanContextRetry(unittest.TestCase):
    """`plan_context_retry` 是给调用方用的门面：拿到新 payload 直接重发即可。"""

    def test_returns_new_payload_and_note(self):
        payload = {"model": "m", "max_tokens": 262144}
        plan = llm.plan_context_retry(CONTEXT_ERROR, payload)
        self.assertIsNotNone(plan)
        new_payload, note = plan
        self.assertEqual(
            new_payload["max_tokens"], 262144 - 9062 - llm.CONTEXT_RETRY_SAFETY_TOKENS
        )
        self.assertIn("max_tokens", note)

    def test_other_fields_preserved(self):
        payload = {
            "model": "m",
            "messages": [{"role": "user", "content": "U"}],
            "max_tokens": 262144,
        }
        new_payload, _ = llm.plan_context_retry(CONTEXT_ERROR, payload)
        self.assertEqual(new_payload["model"], "m")
        self.assertEqual(new_payload["messages"], payload["messages"])

    def test_does_not_mutate_input(self):
        """调用方还持有原 payload（比如要拿 model 字段记账），不能被动过。"""
        payload = {"model": "m", "max_tokens": 262144}
        llm.plan_context_retry(CONTEXT_ERROR, payload)
        self.assertEqual(payload["max_tokens"], 262144)

    def test_none_when_not_retryable(self):
        self.assertIsNone(
            llm.plan_context_retry(b'{"message":"nope"}', {"max_tokens": 10})
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)

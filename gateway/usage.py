"""Bounded streaming/nonstream token accounting; never retains text after request."""

import json
import math
from gateway.openai import usage_from_response
from gateway.tracking import safe_id


class UsageTracker:
    def __init__(self, streaming=False, input_characters=0):
        self.response_id = None
        self.streaming = streaming
        self.pending = b""
        self.body = bytearray()
        self.prompt = 0
        self.completion = 0
        self.exact = False
        self.output_characters = 0
        self.input_characters = input_characters

    def accept(self, obj):
        if not isinstance(obj, dict):
            return
        self.response_id = self.response_id or safe_id(obj.get("id"))
        usage = obj.get("usage")
        if isinstance(usage, dict) and (
            "prompt_tokens" in usage or "completion_tokens" in usage
        ):
            self.prompt, self.completion, _ = usage_from_response(obj)
            self.exact = True
        choices = obj.get("choices")
        if not isinstance(choices, list):
            return
        for choice in choices:
            if not isinstance(choice, dict):
                continue
            delta = choice.get("delta")
            if isinstance(delta, dict):
                self.output_characters += sum(
                    len(delta[k])
                    for k in ["content", "reasoning_content"]
                    if isinstance(delta.get(k), str)
                )
            if isinstance(choice.get("text"), str):
                self.output_characters += len(choice["text"])

    def feed(self, chunk):
        if not self.streaming:
            if len(self.body) + len(chunk) <= 2 * 1024 * 1024:
                self.body.extend(chunk)
            return
        data = self.pending + chunk
        lines = data.split(b"\n")
        self.pending = lines.pop()[-65536:]
        for line in lines:
            if line.startswith(b"data:"):
                try:
                    self.accept(json.loads(line[5:].strip()))
                except (ValueError, UnicodeDecodeError):
                    pass

    def result(self):
        if not self.streaming and self.body:
            try:
                self.accept(json.loads(self.body))
            except (ValueError, UnicodeDecodeError):
                pass
        if not self.exact:
            return (
                math.ceil(self.input_characters / 2),
                math.ceil(self.output_characters / 2),
                False,
            )
        return self.prompt, self.completion, True

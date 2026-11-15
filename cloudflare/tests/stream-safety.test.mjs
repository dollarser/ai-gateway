import { test } from "node:test";
import assert from "node:assert/strict";
import { proxyLuna } from "../src/luna.mjs";
import {
  providerEventError,
  providerFailure,
} from "../src/provider-errors.mjs";
import { lunaCost } from "../src/budgets.mjs";
function store() {
  return {
    writes: [],
    async first() {
      return { user_id: 1, path: "/v1/chat/completions" };
    },
    async run(...a) {
      this.writes.push(a);
      return { meta: { changes: 1 } };
    },
  };
}
const payload = {
  model: "gpt-6-luna",
  messages: [{ role: "user", content: "hi" }],
  stream: true,
};
const req = () =>
  new Request("https://worker/internal/openai/chat-completions", {
    headers: { "X-Gateway-Lease": "lease" },
  });
test("Premature SSE EOF and explicit provider failures reject the stream and retain reservation", async () => {
  for (const data of [
    'data: {"choices":[]}\n\n',
    'data: {"error":{"code":"server_error"}}\n\n',
  ]) {
    const db = store();
    const r = await proxyLuna(
      req(),
      { OPENAI_API_KEY: "key" },
      db,
      null,
      payload,
      false,
      async () => new Response(data),
    );
    assert.match(await r.text(), /provider_stream_interrupted/);
    assert.equal(db.writes.length, 1);
  }
});
test("Successful SSE requires final usage and completion; cancelled read aborts provider", async () => {
  const db = store();
  const r = await proxyLuna(
    req(),
    { OPENAI_API_KEY: "key" },
    db,
    null,
    payload,
    false,
    async () =>
      new Response(
        'data: {"id":"chat","usage":{"prompt_tokens":20,"completion_tokens":5}}\n\ndata: [DONE]\n\n',
      ),
  );
  assert.match(await r.text(), /DONE/);
  assert.equal(db.writes.length, 2);
  assert.equal(db.writes[1][1], 25);
  let cancelled = false,
    signal;
  const other = store();
  const s = await proxyLuna(
    req(),
    { OPENAI_API_KEY: "key" },
    other,
    null,
    payload,
    false,
    async (url, options) => {
      signal = options.signal;
      return new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode('data: {"choices":[]}\n\n'));
          },
          cancel() {
            cancelled = true;
          },
        }),
      );
    },
  );
  const reader = s.body.getReader();
  await reader.read();
  await reader.cancel();
  assert.ok(signal.aborted);
  assert.ok(cancelled);
  assert.equal(other.writes.length, 1);
});
test("Provider errors separate region, authentication, billing, throttling and parameters without raw message", async () => {
  for (const [code, status, expected, retry] of [
    [
      "unsupported_country_region_territory",
      403,
      "provider_region_restricted",
      false,
    ],
    ["invalid_api_key", 401, "provider_auth_failed", false],
    ["insufficient_quota", 429, "provider_credit_exhausted", false],
    ["rate_limit_exceeded", 429, "provider_rate_limited", true],
    ["unsupported_value", 400, "provider_invalid_request", false],
  ]) {
    const e = await providerFailure(
      Response.json(
        {
          error: { code, message: "SECRET PROMPT", param: "reasoning_effort" },
        },
        { status },
      ),
      "luna",
    );
    assert.equal(e.code, expected);
    assert.equal(e.retryable, retry);
    assert.ok(!e.message.includes("SECRET"));
  }
  assert.equal(providerEventError({}, 503).retryable, true);
});
test("Luna costs use input, cached input, cache writes and output prices separately", () => {
  assert.equal(
    lunaCost({ input: 1000000, output: 0, cached: 0, writes: 0 }),
    100000000,
  );
  assert.equal(
    lunaCost({
      input: 1000000,
      output: 1000000,
      cached: 500000,
      writes: 100000,
    }),
    557500000,
  );
});

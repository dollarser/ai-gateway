import test from "node:test";
import assert from "node:assert/strict";
import { openaiRoute } from "../src/openai-route.mjs";
test("OpenAI transport preserves direct route and forwards HTTP and realtime only to fixed origin", async () => {
  let seen;
  const transport = async (...args) => {
    seen = args;
    return new Response("ok");
  };
  const options = {
    method: "POST",
    headers: { Authorization: "Bearer provider-key" },
    body: "payload",
  };
  await openaiRoute(
    {},
    "a".repeat(48),
    "request",
    transport,
  )("https://api.openai.com/v1/responses", options);
  assert.equal(seen[0], "https://api.openai.com/v1/responses");
  assert.equal(seen[1], options);
  const relay = openaiRoute(
    { OPENAI_TRANSPORT: "local", INTERNAL_SECRET: "private" },
    "a".repeat(48),
    "request",
    transport,
  );
  for (const path of [
    "chat/completions",
    "responses",
    "audio/transcriptions",
    "realtime?model=gpt-realtime-2.1-mini",
  ]) {
    await relay("https://api.openai.com/v1/" + path, options);
    assert.equal(seen[0], "https://api.hilex.me/__openai/v1/" + path);
    assert.equal(seen[1].headers.get("X-Edge-Secret"), "private");
    assert.equal(seen[1].headers.get("X-Edge-Lease"), "a".repeat(48));
    assert.equal(seen[1].headers.get("Authorization"), "Bearer provider-key");
    assert.equal(seen[1].body, "payload");
    assert.equal(seen[1].redirect, "manual");
  }
  await assert.rejects(relay("https://evil.test/v1/responses", options));
  await assert.rejects(relay("https://api.openai.com/v1/files", options));
  assert.throws(() => openaiRoute({ OPENAI_TRANSPORT: "typo" }));
  assert.throws(() => openaiRoute({ OPENAI_TRANSPORT: "local" }));
});
test("Relay transport uncertainty must retain the Worker reservation instead of treating it as provider rejection", async () => {
  const route = openaiRoute(
    { OPENAI_TRANSPORT: "local", INTERNAL_SECRET: "private" },
    "a".repeat(48),
    "request",
    async () =>
      new Response("error", {
        status: 502,
        headers: { "X-OpenAI-Relay-Failure": "upstream_unknown" },
      }),
  );
  await assert.rejects(
    route("https://api.openai.com/v1/responses", {}),
    /outcome unknown/,
  );
});

test("Local provider diagnostics preserve provider IDs and do not sample Worker egress", async () => {
  const { providerTransport } = await import("../src/provider-diagnostics.mjs");
  const trace = { request_id: "request", ingress_colo: "NRT" };
  const response = new Response("denied", {
    status: 403,
    headers: {
      "x-openai-request-id": "req_provider",
      "x-request-id": "relay-request",
      "x-openai-cf-ray": "provider-ray",
      "cf-ray": "tunnel-ray",
    },
  });
  const transport = providerTransport(
    {},
    "a".repeat(48),
    trace,
    {
      waitUntil() {
        throw new Error("Worker egress is unrelated to local egress");
      },
    },
    async () => response,
    { OPENAI_TRANSPORT: "local", INTERNAL_SECRET: "private" },
  );
  assert.equal(
    await transport("https://api.openai.com/v1/responses", {}),
    response,
  );
  assert.equal(trace.upstream_request_id, "req_provider");
  assert.equal(trace.upstream_cf_ray, "provider-ray");
  assert.equal(trace.upstream_attempted, 1);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  referenceIP,
  controlledObservation,
} from "../src/network-observations.mjs";
test("Probe fallback records failure stage and safe error without copying the exception message", async () => {
  let calls = 0;
  const r = await referenceIP(async () => {
    if (calls++ === 0) throw new TypeError("PRIVATE URL / token");
    return Response.json({ ip: "203.0.113.3" });
  });
  assert.equal(r.target, "api.ipify.org");
  assert.equal(r.status, "observed_reference");
  assert.equal(r.attempts[0].stage, "connect");
  assert.equal(r.attempts[0].error, "fetch_type_error");
  assert.ok(!JSON.stringify(r).includes("PRIVATE"));
  for (const [response, expected] of [
    [new Response("{bad"), "invalid_json"],
    [Response.json({ ip: "bad" }), "invalid_ip"],
    [new Response("x".repeat(300)), "body_too_large"],
  ]) {
    const result = await referenceIP(async () => response.clone());
    assert.equal(result.error, expected);
    assert.equal(result.attempts.length, 2);
  }
});
test("Controlled probe sends a signature rather than any upstream or client credentials", async () => {
  const env = {
    INTERNAL_SECRET: "test-internal-signing-key",
    API_HOST: "api.hilex.me",
  };
  const result = await controlledObservation(env, async (url, options) => {
    assert.equal(url, "https://api.hilex.me/__diagnostics/network");
    assert.deepEqual(Object.keys(options.headers).sort(), [
      "X-Diagnostic-Nonce",
      "X-Diagnostic-Signature",
      "X-Diagnostic-Time",
    ]);
    assert.ok(!JSON.stringify(options).includes(env.INTERNAL_SECRET));
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(env.INTERNAL_SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const sig = Uint8Array.from(
      options.headers["X-Diagnostic-Signature"].match(/../g),
      (s) => parseInt(s, 16),
    );
    assert.ok(
      await crypto.subtle.verify(
        "HMAC",
        key,
        sig,
        new TextEncoder().encode(
          "diag-v1\n" +
            options.headers["X-Diagnostic-Time"] +
            "\n" +
            options.headers["X-Diagnostic-Nonce"] +
            "\nGET\n/__diagnostics/network",
        ),
      ),
    );
    return Response.json({
      schema: "network-reference-v1",
      scope: "same_zone_tunnel",
      observes_worker_tcp_source: false,
      headers: {
        "cf-ipcountry": "JP",
        authorization: "PRIVATE_SENTINEL",
        "x-custom": "PRIVATE_SENTINEL",
      },
      sensitive_headers_present: { authorization: false, cookie: false },
    });
  });
  assert.equal(result.status, "observed_metadata");
  assert.equal(result.headers["cf-ipcountry"], "JP");
  assert.ok(!JSON.stringify(result).includes("PRIVATE_SENTINEL"));
});

test("Reference probes reject redirects instead of following arbitrary locations", async () => {
  let calls = 0;
  const result = await referenceIP(async (url, options) => {
    calls++;
    assert.ok(url.startsWith("https://api"));
    assert.equal(options.redirect, "manual");
    return Response.redirect("https://unrelated.example.test", 302);
  });
  assert.equal(calls, 2);
  assert.equal(result.status, "http_error");
  assert.equal(result.http_status, 302);
});

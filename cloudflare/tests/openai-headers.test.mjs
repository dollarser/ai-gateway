import test from "node:test";
import assert from "node:assert/strict";
import { openaiHeaders } from "../src/openai-headers.mjs";
test("OpenAI headers remove client attribution regardless of case and keep protocol headers", () => {
  for (const extra of [
    { "Content-Type": "application/json" },
    { Upgrade: "websocket" },
    {},
  ]) {
    const headers = openaiHeaders("server-key", {
      ...extra,
      "cf-connecting-ip": "192.0.2.1",
      "X-Forwarded-For": "192.0.2.2",
      "TRUE-CLIENT-IP": "192.0.2.3",
      Forwarded: "for=192.0.2.4",
      "X-Real-IP": "192.0.2.5",
      "CF-IPCountry": "HK",
      "CF-Ray": "test",
      Authorization: "Bearer client-key",
    });
    assert.equal(headers.get("Authorization"), "Bearer server-key");
    for (const key of [
      "cf-connecting-ip",
      "x-forwarded-for",
      "true-client-ip",
      "forwarded",
      "x-real-ip",
      "cf-ipcountry",
      "cf-ray",
    ])
      assert.equal(headers.get(key), null);
    for (const [key, value] of Object.entries(extra))
      assert.equal(headers.get(key), value);
    if (!extra["Content-Type"]) assert.equal(headers.get("Content-Type"), null);
  }
});

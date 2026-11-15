import { test } from "node:test";
import assert from "node:assert/strict";
import {
  probeEgress,
  validIP,
  ingressDiagnostics,
  providerTransport,
} from "../src/provider-diagnostics.mjs";
test("Probe validates IPv4/IPv6 and is explicitly a separate reference connection", async () => {
  for (const ip of ["203.0.113.9", "2001:db8::1"]) {
    const writes = [];
    await probeEgress(
      { run: async (...a) => writes.push(a) },
      "lease",
      async (url, options) => {
        assert.equal(url, "https://api64.ipify.org?format=json");
        assert.deepEqual(options.headers, { Accept: "application/json" });
        assert.equal(options.redirect, "error");
        return Response.json({ ip });
      },
    );
    assert.equal(writes.length, 1);
    const [sql, value, at, target, status, lease] = writes[0];
    assert.equal(value, ip);
    assert.ok(at > 0);
    assert.equal(target, "api64.ipify.org");
    assert.equal(status, "observed_reference");
    assert.equal(lease, "lease");
    assert.ok(!sql.includes("ended IS NULL"));
  }
  for (const value of ["001.2.3.4", "999.1.1.1", "not an IP", "::gg", null, ""])
    assert.equal(validIP(value), false);
});
test("Bad probe responses and timeouts cannot mask original provider failure", async () => {
  for (const transport of [
    async () => Response.json({ ip: "bad" }),
    async () => new Response("x".repeat(257)),
    async () => {
      throw new DOMException("timeout", "TimeoutError");
    },
    async () => new Response("error", { status: 500 }),
  ]) {
    const writes = [];
    await probeEgress(
      { run: async (...a) => writes.push(a) },
      "lease",
      transport,
    );
    assert.equal(writes[0][1], null);
    assert.notEqual(writes[0][4], "observed_reference");
  }
  const trace = {},
    jobs = [];
  const r = await providerTransport(
    {
      run: async () => {
        throw new Error("DB unavailable");
      },
    },
    "lease",
    trace,
    { waitUntil: (p) => jobs.push(p) },
    async (url) =>
      url.includes("ipify")
        ? Response.json({ ip: "203.0.113.1" })
        : new Response("", {
            status: 403,
            headers: { "x-request-id": "req_test", "cf-ray": "abc-NRT" },
          }),
  )("https://api.openai.com/v1/responses", {});
  assert.equal(r.status, 403);
  await Promise.all(jobs);
  assert.equal(trace.upstream_request_id, "req_test");
  assert.equal(trace.upstream_cf_ray, "abc-NRT");
});
test("Successful provider calls do not trigger probes; ingress location is separately named", async () => {
  const jobs = [],
    trace = {};
  await providerTransport(
    null,
    null,
    trace,
    { waitUntil: (p) => jobs.push(p) },
    async () => new Response("ok"),
  )("https://api.openai.com", {});
  assert.equal(jobs.length, 0);
  assert.deepEqual(
    ingressDiagnostics({
      cf: { colo: "NRT", country: "JP" },
      headers: new Headers({ "cf-ray": "abc-NRT" }),
    }),
    { ingress_colo: "NRT", client_country: "JP", ingress_ray: "abc-NRT" },
  );
});

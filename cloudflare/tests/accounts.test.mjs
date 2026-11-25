import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { Miniflare } from "miniflare";
import { proxySpeech } from "../src/audio.mjs";
import { edgeAPI } from "../src/edge.mjs";
import { Store } from "../src/store.mjs";
import { passwordHash, digest } from "../src/crypto.mjs";
const registrationEnv = {
  CAPTCHA_ENABLED: "false",
  EMAIL_VERIFICATION_ENABLED: "true",
  EMAIL_CODE_SECRET: "test-only-secret".repeat(4),
  REGISTRATION_SMTP: JSON.stringify({
    smtp_host: "smtp.qiye.aliyun.com",
    smtp_port: 465,
    smtp_secure: true,
    smtp_username: "sender@example.com",
    smtp_password: "fake",
    from_email: "sender@example.com",
  }),
};
let mf, db, admin;
const costFailures = [];
let costCalls = 0;
let openaiMode = "json",
  providerCalls = 0;
let originCalls = 0,
  lastProviderPayload,
  lastAudioName;
async function provider(request) {
  if (new URL(request.url).hostname.endsWith("ipify.org")) {
    assert.equal(request.headers.get("Authorization"), null);
    return Response.json({ ip: "203.0.113.12" });
  }
  if (new URL(request.url).pathname === "/__diagnostics/network") {
    assert.equal(request.headers.get("Authorization"), null);
    assert.equal(request.headers.get("Cookie"), null);
    assert.match(
      request.headers.get("X-Diagnostic-Signature"),
      /^[a-f0-9]{64}$/,
    );
    return Response.json({
      schema: "network-reference-v1",
      scope: "same_zone_tunnel",
      observes_worker_tcp_source: false,
      headers: {
        "cf-ipcountry": "JP",
        "cf-ray": "abc-NRT",
        "cf-worker": "hilex.me",
      },
      sensitive_headers_present: {
        authorization: false,
        cookie: false,
        "x-api-key": false,
        "x-client-id": false,
      },
    });
  }
  if (new URL(request.url).hostname === "api.hilex.me") {
    originCalls++;
    assert.equal(request.headers.get("X-Edge-Secret"), secret);
    assert.equal(request.headers.get("Authorization"), null);
    assert.equal(request.headers.get("Cookie"), null);
    assert.match(request.headers.get("X-Edge-Lease"), /^[a-f0-9]{48}$/);
    if (new URL(request.url).pathname === "/__codec/decode")
      return new Response(testWav(1000), {
        headers: { "Content-Type": "audio/wav" },
      });
    return Response.json({ text: "local" });
  }
  assert.equal(new URL(request.url).hostname, "api.openai.com");
  for (const name of [
    "CF-Connecting-IP",
    "X-Forwarded-For",
    "True-Client-IP",
    "Forwarded",
    "X-Real-IP",
    "CF-IPCountry",
    "CF-Ray",
  ])
    assert.equal(request.headers.get(name), null);
  const costUrl = new URL(request.url);
  if (costUrl.pathname === "/v1/organization/costs") {
    costCalls++;
    assert.equal(request.method, "GET");
    assert.equal(
      request.headers.get("Authorization"),
      "Bearer test-admin-cost-key",
    );
    assert.equal(request.headers.get("Cookie"), null);
    if (costFailures.length)
      return Response.json({}, { status: costFailures.shift() });
    const first = !costUrl.searchParams.has("page");
    const start = Number(costUrl.searchParams.get("start_time"));
    return Response.json({
      data: [
        {
          start_time: start + (first ? 0 : 86400),
          results: first
            ? [
                { amount: { value: 1, currency: "usd" } },
                { amount: { value: 2, currency: "usd" } },
              ]
            : [
                { amount: { value: -0.5, currency: "usd" } },
                { amount: { value: 10, currency: "eur" } },
              ],
        },
      ],
      has_more: first,
      next_page: first ? "costs-page-2" : null,
    });
  }
  assert.equal(request.headers.get("Authorization"), "Bearer test-openai-key");
  if (new URL(request.url).pathname === "/v1/audio/transcriptions") {
    const form = await request.formData();
    assert.equal(form.get("model"), "gpt-transcribe");
    lastAudioName = form.get("file").name;
    providerCalls++;
    if (openaiMode === "reject")
      return new Response("rejected", { status: 400 });
    if (form.get("stream") === "true")
      return new Response(
        'data: {"type":"transcript.text.done","text":"hello"}\n\n',
        { headers: { "Content-Type": "text/event-stream" } },
      );
    return Response.json({ text: "hello", languages: [{ code: "en" }] });
  }
  const p = await request.json();
  lastProviderPayload = p;
  if (new URL(request.url).pathname === "/v1/embeddings") {
    providerCalls++;
    if (openaiMode === "reject")
      return new Response("private failure", { status: 401 });
    if (openaiMode === "unknown") return new Response("invalid JSON");
    const input =
      typeof p.input === "string" || p.input.every?.(Number.isInteger)
        ? [p.input]
        : p.input;
    return Response.json({
      object: "list",
      model: p.model,
      data: input.map((_, index) => ({
        object: "embedding",
        index,
        embedding:
          p.encoding_format === "base64"
            ? "AAAAAA=="
            : Array(p.dimensions ?? 1536).fill(0.125),
      })),
      usage: { prompt_tokens: 1, total_tokens: 1 },
    });
  }
  assert.ok(/^gpt-6(?:\.[12])?-(?:luna|sol|astra|terra)$/.test(p.model));
  assert.equal(p.service_tier, "default");
  assert.equal(p.store, false);
  assert.equal(p.max_tokens, undefined);
  providerCalls++;
  if (openaiMode === "reject")
    return new Response("private upstream error", { status: 401 });
  if (openaiMode === "parameter-error")
    return Response.json(
      {
        error: {
          code: "unsupported_value",
          param: "reasoning_effort",
          message: "Unsupported reasoning effort.",
          type: "invalid_request_error",
        },
      },
      { status: 400, headers: { "x-request-id": "req_tools_test" } },
    );
  if (openaiMode === "unknown") return new Response("invalid-json");
  const usage = {
    prompt_tokens: 100,
    completion_tokens: 20,
    prompt_tokens_details: { cached_tokens: 40 },
  };
  if (p.tools?.some((tool) => tool.type === "web_search")) {
    assert.equal(p.model, "gpt-6-luna");
    assert.equal(p.max_tool_calls, 1);
    assert.equal(new URL(request.url).pathname, "/v1/responses");
    const searched = {
      id: "resp-web-search",
      status: "completed",
      output: [
        { type: "web_search_call", id: "ws_fixture", status: "completed" },
        {
          type: "message",
          content: [
            {
              type: "output_text",
              text: "Fixture",
              annotations: [
                { type: "url_citation", url: "https://example.net" },
              ],
            },
          ],
        },
      ],
      usage: { input_tokens: 100, output_tokens: 20 },
      ...(openaiMode !== "no-search-meter" && {
        tool_usage: { web_search: { num_requests: 1 } },
      }),
    };
    return p.stream
      ? new Response(
          "data: " +
            JSON.stringify({ type: "response.completed", response: searched }) +
            "\n\n",
          {
            headers: { "Content-Type": "text/event-stream" },
          },
        )
      : Response.json(searched);
  }
  if (p.stream) {
    const responseMode = new URL(request.url).pathname === "/v1/responses";
    const event = responseMode
      ? {
          type: "response.completed",
          response: {
            id: "resp-test",
            usage: {
              input_tokens: 100,
              output_tokens: 20,
              input_tokens_details: { cached_tokens: 40 },
            },
          },
        }
      : { id: "chat-test", choices: [], usage };
    const value =
      openaiMode === "truncated"
        ? 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'
        : "data: " + JSON.stringify(event) + "\n\ndata: [DONE]\n\n";
    return new Response(value, {
      headers: { "Content-Type": "text/event-stream" },
    });
  }
  return Response.json({
    id: "chat-test",
    choices: [{ message: { role: "assistant", content: "hello" } }],
    usage,
  });
}
const secret = "test-internal-secret-".repeat(3);
// Historical tests name fixtures for readability; all real HTTP logins use
// the new email-only contract. These aliases exist only in this test harness.
async function fixtureEmail(name) {
  if (name.includes("@")) return name.trim().toLowerCase();
  const row = await db
    .prepare(
      "SELECT id,email FROM users WHERE display_name=? ORDER BY id LIMIT 1",
    )
    .bind(name.trim().toLowerCase())
    .first();
  if (!row) return "missing-fixture@example.net";
  if (row.email) return row.email;
  const email = "fixture-" + row.id + "@example.net";
  await db
    .prepare("UPDATE users SET email=? WHERE id=?")
    .bind(email, row.id)
    .run();
  return email;
}
async function fixtureLogin(store, name, password, ip) {
  return store.login(await fixtureEmail(name), password, ip);
}
async function call(path, body, options = {}) {
  if (
    (path === "/auth/login" || path === "/auth/password") &&
    body?.display_name !== undefined
  ) {
    const { display_name, ...rest } = body;
    body = { ...rest, email: await fixtureEmail(display_name) };
  }

  const {
    method = body === undefined ? "GET" : "POST",
    access,
    cookie,
    csrf,
    headers = {},
  } = options;
  const r = await mf.dispatchFetch("https://accounts.test" + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(access ? { Authorization: "Bearer " + access } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(csrf ? { "X-CSRF-Token": csrf } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, headers: r.headers, body: await r.json() };
}
const internal = (path, body) =>
  call("/internal/" + path, body, { access: secret });
before(async () => {
  mf = new Miniflare({
    modules: true,
    scriptPath: ".test-build/worker.js",
    compatibilityDate: "2026-07-01",
    d1Databases: ["DB"],
    bindings: {
      ...registrationEnv,
      INTERNAL_SECRET: secret,
      OPENAI_API_KEY: "test-openai-key",
      OPENAI_ADMIN_KEY: "test-admin-cost-key",
      INFERENCE_CLIENT_IDS: JSON.stringify(["test-client-id"]),
      ACCOUNT_ORIGIN: "https://accounts.test",
    },
    outboundService: provider,
    serviceBindings: {
      ASSETS: async () => new Response("<html>portal</html>"),
    },
  });
  db = await mf.getD1Database("DB");
  for (const file of (await readdir("migrations"))
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    let schema = await readFile("migrations/" + file, "utf8");
    const [ddl, ...triggers] = schema.split(/(?=CREATE TRIGGER)/);
    for (const s of [
      ...ddl
        .replace(/^--.*$/gm, "")
        .split(";")
        .filter((s) => s.trim()),
      ...triggers,
    ])
      await db.prepare(s).run();
  }
  await db
    .prepare(
      "INSERT INTO users(display_name,password,role,services,rpm,daily_requests,concurrency,must_change,created) VALUES(?,?,?,?,?,?,?,?,?)",
    )
    .bind(
      "admin",
      await passwordHash("admin-password"),
      "admin",
      '["qwen","asr","tts"]',
      0,
      0,
      8,
      0,
      Date.now() / 1000,
    )
    .run();
  const result = await call("/auth/login", {
    display_name: "admin",
    password: "admin-password",
  });
  assert.equal(result.status, 200);
  admin = result.body.access_token;
  const initial = await call("/admin/models", undefined, { access: admin });
  assert.equal(initial.status, 200);
  assert.equal(initial.body.models.length, 14);
  assert.deepEqual(
    initial.body.models
      .filter((model) => model.enabled)
      .map((model) => model.id),
    ["gpt-6-luna"],
  );
  // Existing inference fixtures opt in explicitly; production starts closed.
  const ids = [
    "gpt-6-luna",
    "Qwen3.8-27B",
    "text-embedding-3-small",
    "Qwen/Qwen3-Embedding-0.6B",
    "gpt-transcribe",
    "funasr",
    "gpt-realtime-2.1-mini",
    "cosyvoice",
  ];
  await db
    .prepare("UPDATE settings SET value=? WHERE name='new_account_model_ids'")
    .bind(JSON.stringify(ids))
    .run();
});
after(async () => {
  await mf?.dispose();
});
test("registration, login, cookie CSRF and key ownership", async () => {
  const email = "person@example.com";
  let r = await call("/auth/register", {
    email,
    password: "long-password",
    role: "admin",
  });
  assert.equal(r.status, 422);
  r = await call("/auth/register", { email, password: "long-password" });
  assert.equal(r.status, 422);
  const { requestRegistrationCode } = await import("../src/registration.mjs");
  let code;
  await requestRegistrationCode(
    new Store(db),
    registrationEnv,
    email,
    "first-registration-ip",
    async (_config, _email, value) => {
      code = value;
    },
  );
  r = await call("/auth/register", { email, password: "long-password", code });
  assert.equal(r.status, 201);
  assert.ok(r.body.user.email_verified_at);
  assert.equal(
    (
      await new Store(db).first(
        "SELECT code_hash FROM registration_codes WHERE email_hash=?",
        await digest(email),
      )
    ).code_hash,
    "",
  );
  assert.equal(
    (await call("/auth/registration-info")).body.email_verification,
    true,
  );
  assert.equal(
    (await call("/auth/registration-code", { email: "bad\r\n@example.com" }))
      .status,
    422,
  );
  assert.equal(r.body.user.role, "user");
  assert.equal(r.body.user.must_change, 0);
  const login = await call("/auth/login", {
    display_name: email,
    password: "long-password",
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  assert.match(
    login.headers.get("set-cookie"),
    /Secure; HttpOnly; SameSite=Strict/,
  );
  assert.equal((await call("/account/me", undefined, { cookie })).status, 200);
  assert.equal(
    (
      await call(
        "/account/password",
        { current_password: "long-password", new_password: "new-password" },
        { cookie },
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await call("/account/keys", undefined, {
        access: login.body.access_token,
      })
    ).status,
    403,
  );
  assert.equal(
    (await call("/account/me", undefined, { access: "sk-acct-invalid" }))
      .status,
    401,
  );
  const refresh = await call("/auth/refresh", {
    refresh_token: login.body.refresh_token,
  });
  assert.equal(refresh.status, 200);
  assert.equal(
    (await call("/auth/refresh", { refresh_token: login.body.refresh_token }))
      .status,
    401,
  );
  assert.equal(
    (
      await call("/account/me", undefined, {
        access: refresh.body.access_token,
      })
    ).status,
    401,
  );
});
test("internal endpoints reject missing credentials and tampered bodies", async () => {
  assert.equal(
    (
      await call("/internal/acquire", {
        raw: "x",
        service: "asr",
        path: "/v1/audio/transcriptions",
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await internal("acquire", {
        raw: "x",
        service: "asr",
        path: "/",
        sql: "select 1",
      })
    ).status,
    422,
  );
  assert.equal(
    (await internal("sql", { query: "select * from users" })).status,
    404,
  );
});
test("atomic concurrency, persistent usage, idempotent finish and key revocation", async () => {
  const created = await call(
    "/admin/users",
    { display_name: "quota-user", concurrency: 1, rpm: 0, daily_requests: 0 },
    { access: admin },
  );
  assert.equal(created.status, 200);
  const uid = created.body.user.id;
  // New admin-created accounts must change password before using inference.
  let k = await call(
    "/admin/keys/" + uid,
    { name: "test", services: ["asr"], days: 1 },
    { access: admin },
  );
  assert.equal(k.status, 200);
  assert.equal(
    (
      await internal("acquire", {
        raw: k.body.key,
        service: "asr",
        path: "/v1/audio/transcriptions",
      })
    ).status,
    403,
  );
  const login = await call("/auth/login", {
    display_name: "quota-user",
    password: created.body.temporary_password,
  });
  assert.equal(
    (
      await call(
        "/account/password",
        {
          current_password: created.body.temporary_password,
          new_password: "new-password",
        },
        { access: login.body.access_token },
      )
    ).status,
    200,
  );
  const args = {
    raw: k.body.key,
    service: "asr",
    path: "/v1/audio/transcriptions",
  };
  const results = await Promise.all([
    internal("acquire", args),
    internal("acquire", args),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 429]);
  const lease = results.find((r) => r.status === 200).body.lease;
  assert.equal(
    (
      await internal("finish", {
        lease,
        status: 200,
        size: 42,
        prompt_tokens: 3,
      })
    ).status,
    200,
  );
  await internal("finish", { lease, status: 500, size: 999 });
  const usage = await call("/admin/usage?user_id=" + uid, undefined, {
    access: admin,
  });
  assert.equal(usage.body.requests[0].response_bytes, 42);
  assert.equal(usage.body.requests[0].status, 200);
  assert.equal(
    (
      await call("/admin/keys/" + k.body.id, undefined, {
        method: "DELETE",
        access: admin,
      })
    ).status,
    200,
  );
  assert.equal((await internal("acquire", args)).status, 401);
});
test("last admin is protected and account fields cannot change roles", async () => {
  const me = await call("/account/me", undefined, { access: admin });
  const uid = me.body.user.id;
  assert.equal(
    (
      await call(
        "/admin/users/" + uid,
        { enabled: false },
        { method: "PATCH", access: admin },
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await call(
        "/admin/users/" + uid,
        { role: "admin" },
        { method: "PATCH", access: admin },
      )
    ).status,
    422,
  );
});
test("legacy Python password encoding matches Worker verification", async () => {
  // Python hashlib.scrypt(password=b"test-password", salt=bytes.fromhex("00"*16), n=16384,r=8,p=1).
  const encoded = await passwordHash("test-password", "0".repeat(32));
  const expected = await readFile("tests/python-password.txt", "utf8");
  assert.equal(encoded, expected.trim());
});
test("parallel refresh reuse revokes the token family atomically", async () => {
  const login = await call(
    "/auth/login",
    { display_name: "admin", password: "admin-password" },
    { headers: { "CF-Connecting-IP": "192.0.2.50" } },
  );
  const results = await Promise.all([
    call("/auth/refresh", { refresh_token: login.body.refresh_token }),
    call("/auth/refresh", { refresh_token: login.body.refresh_token }),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 401]);
  assert.equal(
    (
      await call("/account/me", undefined, {
        access: results.find((r) => r.status === 200).body.access_token,
      })
    ).status,
    401,
  );
});
test("daily quota is shared across keys and zero RPM remains unlimited", async () => {
  const created = await call(
    "/admin/users",
    { display_name: "daily-user", concurrency: 4, rpm: 0, daily_requests: 1 },
    { access: admin },
  );
  assert.equal(created.status, 200);
  const uid = created.body.user.id;
  const login = await call(
    "/auth/login",
    { display_name: "daily-user", password: created.body.temporary_password },
    { headers: { "CF-Connecting-IP": "192.0.2.51" } },
  );
  await call(
    "/account/password",
    {
      current_password: created.body.temporary_password,
      new_password: "long-password",
    },
    { access: login.body.access_token },
  );
  const a = await call(
    "/admin/keys/" + uid,
    { name: "a", services: ["asr"] },
    { access: admin },
  );
  const b = await call(
    "/admin/keys/" + uid,
    { name: "b", services: ["asr"] },
    { access: admin },
  );
  const first = await internal("acquire", {
    raw: a.body.key,
    service: "asr",
    path: "/v1/audio/transcriptions",
  });
  assert.equal(first.status, 200);
  await internal("finish", { lease: first.body.lease, status: 200 });
  assert.equal(
    (
      await internal("acquire", {
        raw: b.body.key,
        service: "asr",
        path: "/v1/audio/transcriptions",
      })
    ).status,
    429,
  );
});

test("invalid account services and key expiry cannot corrupt stored permissions", async () => {
  const me = await call("/account/me", undefined, { access: admin });
  const uid = me.body.user.id;
  const before = (await db.prepare("SELECT count(*) AS n FROM users").first())
    .n;
  for (const value of [null, false, [], "asr"]) {
    const result = await call(
      "/admin/users",
      { display_name: "invalid-services", services: value },
      { access: admin },
    );
    assert.equal(result.status, 422);
  }
  assert.equal(
    (await db.prepare("SELECT count(*) AS n FROM users").first()).n,
    before,
  );
  assert.equal(
    (
      await call(
        "/admin/users/" + uid,
        { services: null },
        { method: "PATCH", access: admin },
      )
    ).status,
    422,
  );
  assert.equal(
    (
      await call(
        "/account/keys",
        { name: "invalid", services: ["asr"], days: null },
        { access: admin },
      )
    ).status,
    422,
  );
  const after = await call("/account/me", undefined, { access: admin });
  assert.deepEqual(after.body.user.services, me.body.user.services);
});

async function lunaUser(name, monthly = 10000000) {
  const uid = (
    await db
      .prepare(
        "INSERT INTO users(display_name,password,role,services,rpm,daily_requests,concurrency,must_change,created,luna_monthly_tokens) VALUES(?,?,?,?,?,?,?,?,?,?) RETURNING id",
      )
      .bind(
        name,
        "unused",
        "user",
        '["qwen"]',
        0,
        0,
        8,
        0,
        Date.now() / 1000,
        monthly,
      )
      .first()
  ).id;
  const key = "sk-acct-" + name;
  await db
    .prepare(
      "INSERT INTO keys(user_id,name,hash,prefix,services,expires,created) VALUES(?,?,?,?,?,?,?)",
    )
    .bind(
      uid,
      name,
      await digest(key),
      "test-prefix",
      '["qwen"]',
      Date.now() / 1000 + 86400,
      Date.now() / 1000,
    )
    .run();
  return { uid, key };
}
async function lunaLease(key, path = "/v1/chat/completions") {
  const r = await internal("acquire", { raw: key, service: "qwen", path });
  assert.equal(r.status, 200);
  return r.body.lease;
}
function lunaCall(lease, payload = {}, responses = false) {
  return call(
    "/internal/openai/" + (responses ? "responses" : "chat-completions"),
    {
      model: "gpt-6-luna",
      ...(responses
        ? { input: "hi" }
        : { messages: [{ role: "user", content: "hi" }] }),
      ...payload,
    },
    { access: secret, headers: { "X-Gateway-Lease": lease } },
  );
}
test("Luna uses provider usage, shares account budget, refuses lease replay and never leaks upstream errors", async () => {
  const { uid, key } = await lunaUser("luna-json");
  const lease = await lunaLease(key);
  assert.equal(
    (await internal("luna-models", { lease })).body.data[0].id,
    "gpt-6-luna",
  );
  openaiMode = "json";
  let r = await lunaCall(lease);
  assert.equal(r.status, 200);
  const row = await db
    .prepare("SELECT * FROM luna_usage WHERE lease=?")
    .bind(lease)
    .first();
  assert.equal(row.charged_tokens, 120);
  assert.equal(row.settled, 1);
  assert.equal((await lunaCall(lease)).status, 409);
  assert.equal(
    (
      await db
        .prepare("SELECT luna_monthly_tokens FROM users WHERE id=?")
        .bind(uid)
        .first()
    ).luna_monthly_tokens,
    10000000,
  );
  openaiMode = "reject";
  const rejected = await lunaLease(key);
  r = await lunaCall(rejected);
  assert.equal(r.status, 502);
  assert.doesNotMatch(
    JSON.stringify(r.body),
    /private upstream|test-openai-key/,
  );
  assert.equal(
    (
      await db
        .prepare("SELECT charged_tokens FROM luna_usage WHERE lease=?")
        .bind(rejected)
        .first()
    ).charged_tokens,
    0,
  );
  openaiMode = "json";
});
test("Luna reservations are atomic across keys and access tokens, zero disables, prior months do not spend this month", async () => {
  const { uid, key } = await lunaUser("luna-budget", 6000);
  openaiMode = "unknown";
  const secondKey = "sk-acct-luna-second-key";
  await db
    .prepare(
      "INSERT INTO keys(user_id,name,hash,prefix,services,expires,created) VALUES(?,?,?,?,?,?,?)",
    )
    .bind(
      uid,
      "second",
      await digest(secondKey),
      "test-prefix",
      '["qwen"]',
      Date.now() / 1000 + 86400,
      Date.now() / 1000,
    )
    .run();
  const family = "luna-test-family",
    access = "ai-at-luna-budget-test";
  await db
    .prepare("INSERT INTO auth_families VALUES(?,?,?,0)")
    .bind(family, uid, Date.now() / 1000 + 86400)
    .run();
  await db
    .prepare("INSERT INTO access_tokens VALUES(?,?,?)")
    .bind(await digest(access), family, Date.now() / 1000 + 86400)
    .run();
  const a = await lunaLease(secondKey),
    b = await lunaLease(access);
  const results = await Promise.all([
    lunaCall(a, { max_completion_tokens: 1 }),
    lunaCall(b, { max_completion_tokens: 1 }),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [429, 502]);
  await db
    .prepare("UPDATE luna_usage SET month='2000-01' WHERE user_id=?")
    .bind(uid)
    .run();
  assert.equal(
    (await lunaCall(await lunaLease(key), { max_completion_tokens: 1 })).status,
    502,
  );
  await db
    .prepare("UPDATE users SET luna_monthly_tokens=0 WHERE id=?")
    .bind(uid)
    .run();
  assert.equal(
    (await lunaCall(await lunaLease(key), { max_completion_tokens: 1 })).status,
    429,
  );
  openaiMode = "json";
});
test("Luna blocks bypass fields, invalid image input and wrong service leases before calling provider", async () => {
  const { key } = await lunaUser("luna-validation");
  const lease = await lunaLease(key),
    before = providerCalls;
  for (const p of [
    { model: "gpt-unknown" },
    { n: 20 },
    { service_tier: "priority" },
    { max_completion_tokens: 0 },
    { tools: [{ type: "web_search" }] },
    {
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: { url: "file:///tmp/img" },
            },
          ],
        },
      ],
    },
  ])
    assert.ok([400, 422].includes((await lunaCall(lease, p)).status));
  assert.equal((await lunaCall("nonexistent")).status, 403);
  const wrong = await lunaLease(key, "/v1/models");
  assert.equal((await lunaCall(wrong)).status, 403);
  assert.equal(providerCalls, before);
  // Chat tool-call IDs link client-side function results, not stored provider state.
  const valid = await lunaCall(lease, {
    reasoning_effort: "none",
    messages: [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_client",
            type: "function",
            function: { name: "weather", arguments: "{}" },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_client", content: "sunny" },
    ],
  });
  assert.equal(valid.status, 200);
});
test("Luna streams settle authoritative usage for Chat and Responses; truncated streams retain budget", async () => {
  const { key } = await lunaUser("luna-stream");
  for (const responses of [false, true]) {
    const lease = await lunaLease(
      key,
      responses ? "/v1/responses" : "/v1/chat/completions",
    );
    const r = await mf.dispatchFetch(
      "https://accounts.test/internal/openai/" +
        (responses ? "responses" : "chat-completions"),
      {
        method: "POST",
        headers: {
          Authorization: "Bearer " + secret,
          "Content-Type": "application/json",
          "X-Gateway-Lease": lease,
        },
        body: JSON.stringify({
          model: "gpt-6-luna",
          ...(responses
            ? { input: "hi" }
            : { messages: [{ role: "user", content: "hi" }] }),
          stream: true,
        }),
      },
    );
    assert.equal(r.status, 200);
    assert.match(await r.text(), /data:/);
    assert.equal(
      (
        await db
          .prepare(
            "SELECT charged_tokens,settled FROM luna_usage WHERE lease=?",
          )
          .bind(lease)
          .first()
      ).charged_tokens,
      120,
    );
  }
  openaiMode = "truncated";
  const lease = await lunaLease(key);
  const r = await mf.dispatchFetch(
    "https://accounts.test/internal/openai/chat-completions",
    {
      method: "POST",
      headers: { Authorization: "Bearer " + secret, "X-Gateway-Lease": lease },
      body: JSON.stringify({
        model: "gpt-6-luna",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }),
    },
  );
  assert.match(await r.text(), /provider_stream_interrupted/);
  const row = await db
    .prepare("SELECT * FROM luna_usage WHERE lease=?")
    .bind(lease)
    .first();
  assert.equal(row.settled, 0);
  assert.equal(row.charged_tokens, row.reserved_tokens);
  openaiMode = "json";
});
test("Luna budgets can only be changed by admins and new account defaults are applied", async () => {
  const me = await call("/account/me", undefined, { access: admin });
  assert.equal(
    (
      await call(
        "/admin/users/" + me.body.user.id,
        { luna_monthly_tokens: -1 },
        { method: "PATCH", access: admin },
      )
    ).status,
    422,
  );
  assert.equal(
    (
      await call(
        "/admin/luna-defaults",
        { monthly_tokens: 2500000 },
        { method: "PATCH", access: admin },
      )
    ).status,
    200,
  );
  const r = await call(
    "/admin/users",
    { display_name: "luna-default" },
    { access: admin },
  );
  assert.equal(r.body.user.luna_monthly_tokens, 2500000);
  assert.equal(
    (
      await call(
        "/admin/users/" + r.body.user.id,
        { luna_monthly_tokens: 250000 },
        { method: "PATCH", access: admin },
      )
    ).body.luna_monthly_tokens,
    250000,
  );
  const balance = await call("/account/luna-usage", undefined, {
    access: admin,
  });
  assert.equal(balance.status, 200);
  assert.equal(balance.body.monthly_tokens, 10000000);
});

function testWav(milliseconds = 1000) {
  const pcm = new Uint8Array(milliseconds * 32),
    wav = new Uint8Array(44 + pcm.length),
    view = new DataView(wav.buffer);
  for (const [at, text] of [
    [0, "RIFF"],
    [8, "WAVE"],
    [12, "fmt "],
    [36, "data"],
  ])
    wav.set(new TextEncoder().encode(text), at);
  view.setUint32(4, wav.length - 8, true);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true);
  view.setUint32(28, 32000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  view.setUint32(40, pcm.length, true);
  return wav;
}
async function audioUser(name, kind) {
  const r = await lunaUser(name);
  await db
    .prepare("UPDATE users SET services=? WHERE id=?")
    .bind(JSON.stringify(["qwen", kind]), r.uid)
    .run();
  await db
    .prepare("UPDATE keys SET services=? WHERE user_id=?")
    .bind(JSON.stringify(["qwen", kind]), r.uid)
    .run();
  return r;
}
async function audioLease(key, kind) {
  const r = await internal("acquire", {
    raw: key,
    service: kind,
    path: kind === "asr" ? "/v1/audio/transcriptions" : "/v1/audio/speech",
    metadata: {
      client_ip: "203.0.113.9",
      user_agent: "test-client",
      client_version: "1.2.3",
      device_id: "device-test",
    },
  });
  assert.equal(r.status, 200);
  return r.body.lease;
}
async function asrCall(lease, ms = 1000, extra = {}) {
  const form = new FormData();
  form.set("model", "gpt-transcribe");
  form.set("file", new Blob([testWav(ms)], { type: "audio/wav" }), "audio.wav");
  for (const [k, v] of Object.entries(extra)) form.set(k, v);
  const request = new Request(
    "https://accounts.test/internal/openai/transcriptions",
    { method: "POST", body: form },
  );
  return mf.dispatchFetch(request.url, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + secret,
      "X-Gateway-Lease": lease,
      "Content-Type": request.headers.get("Content-Type"),
    },
    body: await request.arrayBuffer(),
  });
}
test("audio ASR measures PCM duration, atomically shares daily allowance, rejects replay and rolls over by day", async () => {
  const { uid, key } = await audioUser("audio-asr", "asr");
  await db
    .prepare("UPDATE users SET openai_asr_daily_seconds=1 WHERE id=?")
    .bind(uid)
    .run();
  const a = await audioLease(key, "asr"),
    b = await audioLease(key, "asr"),
    before = providerCalls;
  const responses = await Promise.all([asrCall(a), asrCall(b)]);
  assert.deepEqual(responses.map((r) => r.status).sort(), [200, 429]);
  for (const r of responses) await r.text();
  assert.equal(providerCalls, before + 1);
  const rows = (
    await db
      .prepare("SELECT * FROM audio_usage WHERE user_id=?")
      .bind(uid)
      .all()
  ).results;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].charged_units, 1000);
  assert.equal(rows[0].settled, 1);
  assert.equal((await asrCall(rows[0].lease)).status, 409);
  await db
    .prepare("UPDATE audio_usage SET day='2000-01-01' WHERE user_id=?")
    .bind(uid)
    .run();
  assert.equal((await asrCall(await audioLease(key, "asr"))).status, 200);
});
test("ASR rejects malformed duration before provider use and streams final transcripts", async () => {
  const { key } = await audioUser("audio-asr-stream", "asr");
  const lease = await audioLease(key, "asr");
  assert.equal(
    (await asrCall(lease, 1000, { stream: "true", response_format: "text" }))
      .status,
    422,
  );
  const r = await asrCall(lease, 1000, { stream: "true" });
  assert.equal(r.status, 200);
  assert.match(await r.text(), /transcript.text.done/);
  assert.equal(
    (
      await db
        .prepare("SELECT settled FROM audio_usage WHERE lease=?")
        .bind(lease)
        .first()
    ).settled,
    1,
  );
});
class MockRealtime extends EventTarget {
  constructor(mode = "success") {
    super();
    this.mode = mode;
    this.messages = [];
  }
  event(data) {
    queueMicrotask(() =>
      this.dispatchEvent(
        new MessageEvent("message", { data: JSON.stringify(data) }),
      ),
    );
  }
  accept() {
    this.event({ type: "session.created" });
  }
  send(raw) {
    const b = JSON.parse(raw);
    this.messages.push(b);
    if (b.type === "session.update") {
      assert.deepEqual(b.session.tools, []);
      assert.equal(b.session.audio.output.format.rate, 24000);
      this.event({ type: "session.updated" });
    } else if (b.type === "response.create") {
      assert.equal(b.response.conversation, "none");
      if (this.mode === "reject") this.event({ type: "error" });
      else if (this.mode === "disconnect")
        queueMicrotask(() => this.dispatchEvent(new Event("close")));
      else {
        this.event({ type: "response.output_audio.delta", delta: "AAAAAA==" });
        if (this.mode === "hold") return;
        this.event({
          type: "response.done",
          response: { status: "completed", id: "resp-audio" },
        });
      }
    }
  }
  close() {
    this.closed = true;
  }
}
async function ttsCall(lease, input = "你好🙂", mode = "success") {
  const ws = new MockRealtime(mode);
  const req = new Request("https://accounts.test/internal/openai/speech", {
    method: "POST",
    headers: { "X-Gateway-Lease": lease },
    body: JSON.stringify({
      model: "gpt-realtime-2.1-mini",
      input,
      response_format: "pcm",
    }),
  });
  return proxySpeech(
    req,
    { OPENAI_API_KEY: "test-key" },
    new Store(db),
    async (url, options) => {
      assert.match(url, /gpt-realtime-2.1-mini/);
      assert.equal(new Headers(options.headers).get("Upgrade"), "websocket");
      return { webSocket: ws };
    },
  );
}
test("Realtime TTS uses Unicode characters, refunds explicit rejections, retains unknown submissions and enforces daily caps", async () => {
  const { uid, key } = await audioUser("audio-tts", "tts");
  await db
    .prepare("UPDATE users SET openai_tts_daily_characters=3 WHERE id=?")
    .bind(uid)
    .run();
  const lease = await audioLease(key, "tts");
  const r = await ttsCall(lease);
  assert.equal(r.status, 200);
  assert.equal((await r.arrayBuffer()).byteLength, 4);
  assert.equal(
    (
      await db
        .prepare("SELECT charged_units,settled FROM audio_usage WHERE lease=?")
        .bind(lease)
        .first()
    ).charged_units,
    3,
  );
  await assert.rejects(
    ttsCall(await audioLease(key, "tts"), "a"),
    (e) => e.status === 429,
  );
  await db
    .prepare("UPDATE users SET openai_tts_daily_characters=100 WHERE id=?")
    .bind(uid)
    .run();
  const rejected = await audioLease(key, "tts");
  await assert.rejects(ttsCall(rejected, "abc", "reject"));
  assert.equal(
    (
      await db
        .prepare("SELECT charged_units FROM audio_usage WHERE lease=?")
        .bind(rejected)
        .first()
    ).charged_units,
    0,
  );
  const unknown = await audioLease(key, "tts");
  await assert.rejects(ttsCall(unknown, "abc", "disconnect"));
  const row = await db
    .prepare("SELECT * FROM audio_usage WHERE lease=?")
    .bind(unknown)
    .first();
  assert.equal(row.charged_units, 3);
  assert.equal(row.settled, 0);
});
test("admin unified defaults, user overview, IP metadata and atomic bulk ban/unban", async () => {
  const defaults = await call("/admin/quota-defaults", undefined, {
    access: admin,
  });
  assert.equal(defaults.status, 200);
  assert.equal(defaults.body.openai_asr_daily_seconds, 1800);
  const patch = {
    ...defaults.body,
    luna_monthly_tokens: 10000000,
    openai_asr_daily_seconds: 2400,
    openai_tts_daily_characters: 600000,
  };
  assert.equal(
    (
      await call("/admin/quota-defaults", patch, {
        method: "PATCH",
        access: admin,
      })
    ).status,
    200,
  );
  const created = await call(
    "/admin/users",
    { display_name: "unified-defaults" },
    { access: admin },
  );
  assert.equal(created.body.user.openai_asr_daily_seconds, 2400);
  assert.equal(created.body.user.openai_tts_daily_characters, 600000);
  const overview = await call("/admin/overview?q=audio-asr", undefined, {
    access: admin,
  });
  assert.equal(overview.status, 200);
  assert.ok(overview.body.matching >= 1);
  const target = overview.body.users.find(
    (u) => u.display_name === "audio-asr",
  );
  assert.equal(target.last_request_ip, "203.0.113.9");
  assert.equal(target.password, undefined);
  const details = await call(
    "/admin/users/" + target.id + "/details",
    undefined,
    { access: admin },
  );
  assert.equal(details.status, 200);
  assert.equal(details.body.requests[0].client_version, "1.2.3");
  assert.equal(details.body.ips[0].client_ip, "203.0.113.9");
  const ids = [target.id, created.body.user.id];
  assert.equal(
    (
      await call(
        "/admin/users/bulk",
        { ids, patch: { enabled: false } },
        { access: admin },
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await db
        .prepare("SELECT enabled FROM users WHERE id=?")
        .bind(target.id)
        .first()
    ).enabled,
    0,
  );
  assert.equal(
    (
      await call(
        "/admin/users/bulk",
        { ids, patch: { enabled: true, openai_asr_daily_seconds: 1800 } },
        { access: admin },
      )
    ).status,
    200,
  );
  const me = await call("/account/me", undefined, { access: admin });
  assert.equal(
    (
      await call(
        "/admin/users/bulk",
        {
          ids: [created.body.user.id, me.body.user.id],
          patch: { enabled: false },
        },
        { access: admin },
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await db
        .prepare("SELECT enabled FROM users WHERE id=?")
        .bind(created.body.user.id)
        .first()
    ).enabled,
    1,
  );
  assert.equal(
    (
      await call(
        "/admin/users/bulk",
        { ids, patch: { role: "admin" } },
        { access: admin },
      )
    ).status,
    422,
  );
  assert.equal(
    (await call("/admin/overview?day=2026-02-30", undefined, { access: admin }))
      .status,
    422,
  );
});

test("voice-only keys discover only their permitted cloud models", async () => {
  const { uid, key } = await audioUser("catalog-asr-only", "asr");
  await db
    .prepare("UPDATE keys SET services='[\"asr\"]' WHERE user_id=?")
    .bind(uid)
    .run();
  const grant = await internal("acquire", {
    raw: key,
    service: "catalog",
    path: "/v1/models",
  });
  assert.equal(grant.status, 200);
  const catalog = await internal("openai-models", { lease: grant.body.lease });
  assert.equal(catalog.status, 200);
  assert.deepEqual(catalog.body.services, ["asr"]);
  assert.deepEqual(
    catalog.body.data.map((m) => m.id),
    ["gpt-transcribe"],
  );
});
test("diagnostics persist safe metadata and request ID lookup is admin-only", async () => {
  const { key } = await lunaUser("diagnostic-test");
  const lease = await lunaLease(key);
  await internal("finish", {
    lease,
    status: 422,
    trace: {
      request_id: "diagnostic-request",
      model: "gpt-wrong",
      provider: "local",
      protocol: "http",
      failure_stage: "validation",
      error_code: "invalid_audio_model",
      duration_ms: 12,
    },
  });
  const rows = await call(
    "/admin/requests?request_id=diagnostic-request",
    undefined,
    { access: admin },
  );
  assert.equal(rows.status, 200);
  assert.equal(rows.body[0].failure_stage, "validation");
  assert.equal(rows.body[0].duration_ms, 12);
  assert.equal(rows.body[0].model, "gpt-wrong");
  assert.equal(
    (await call("/admin/requests?request_id=diagnostic-request")).status,
    401,
  );
});
test("quota reconciliation is audited, compare-and-set protected, bounded and idempotent", async () => {
  const { uid, key } = await audioUser("quota-review", "tts");
  const lease = await audioLease(key, "tts");
  await assert.rejects(ttsCall(lease, "abc", "disconnect"));
  await internal("finish", { lease, status: 502 });
  const b = {
    id: "quota-review-operation",
    kind: "audio",
    lease,
    expected_units: 3,
    units: 1,
    reason: "verified provider test usage",
  };
  assert.equal(
    (await call("/admin/quota-adjustments", b, { access: admin })).status,
    409,
  );
  await db
    .prepare("UPDATE requests SET ended=unixepoch()-120 WHERE id=?")
    .bind(lease)
    .run();
  assert.equal(
    (await call("/admin/quota-adjustments", b, { access: admin })).status,
    200,
  );
  assert.equal(
    (await call("/admin/quota-adjustments", b, { access: admin })).body
      .replayed,
    true,
  );
  assert.equal(
    (
      await call(
        "/admin/quota-adjustments",
        { ...b, units: 0 },
        { access: admin },
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await call(
        "/admin/quota-adjustments",
        { ...b, id: "another-id" },
        { access: admin },
      )
    ).status,
    409,
  );
  const row = await db
    .prepare("SELECT charged_units,settled FROM audio_usage WHERE lease=?")
    .bind(lease)
    .first();
  assert.equal(row.charged_units, 1);
  assert.equal(row.settled, 1);
  const review = await call(
    "/admin/quota-review?state=settled&user_id=" + uid,
    undefined,
    { access: admin },
  );
  assert.equal(review.body[0].lease, lease);
  assert.equal(
    (
      await db
        .prepare("SELECT count(*) n FROM quota_adjustments WHERE lease=?")
        .bind(lease)
        .first()
    ).n,
    1,
  );
});
test("Realtime streaming emits PCM before settlement, and still settles the same character budget", async () => {
  const { key } = await audioUser("tts-stream", "tts");
  const lease = await audioLease(key, "tts");
  const req = new Request("https://accounts.test/internal/openai/speech", {
    method: "POST",
    headers: { "X-Gateway-Lease": lease },
    body: JSON.stringify({
      model: "gpt-realtime-2.1-mini",
      input: "你好🙂",
      response_format: "pcm",
      stream: true,
    }),
  });
  const jobs = [];
  const r = await proxySpeech(
    req,
    { OPENAI_API_KEY: "test-key" },
    new Store(db),
    async () => ({ webSocket: new MockRealtime() }),
    {
      waitUntil(p) {
        jobs.push(p);
      },
    },
  );
  assert.equal(r.status, 200);
  assert.equal((await r.arrayBuffer()).byteLength, 4);
  await Promise.all(jobs);
  const row = await db
    .prepare("SELECT charged_units,settled FROM audio_usage WHERE lease=?")
    .bind(lease)
    .first();
  assert.equal(row.charged_units, 3);
  assert.equal(row.settled, 1);
});

async function apiCall(path, key, payload, headers = {}) {
  const r = await mf.dispatchFetch("https://api.hilex.me" + path, {
    method: payload === undefined ? "GET" : "POST",
    headers: {
      Authorization: "Bearer " + key,
      "Content-Type": "application/json",
      ...headers,
    },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  return { status: r.status, headers: r.headers, body: await r.json() };
}
test("Cloud chat returns distinct 413 codes and records the validation cause", async () => {
  const { key } = await lunaUser("cloud-chat-request-limits");
  const path = "/v1/chat/completions";
  const image = {
    type: "image_url",
    image_url: { url: "https://example.com/image.png" },
  };
  const accepted = await apiCall(path, key, {
    model: "gpt-6-luna",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "x".repeat(90000) },
          ...Array.from({ length: 8 }, () => ({
            type: "image_url",
            image_url: {
              url: "data:image/png;base64," + "AAAA".repeat(140000),
            },
          })),
        ],
      },
    ],
  });
  assert.equal(accepted.status, 200);
  const examples = [
    ["request_body_too_large", "x".repeat(12 * 1024 * 1024)],
    ["too_many_images", Array.from({ length: 9 }, () => image)],
    ["input_estimate_too_large", "x".repeat(1050000)],
  ];
  for (const [code, content] of examples) {
    const result = await apiCall(path, key, {
      model: "gpt-6-luna",
      messages: [{ role: "user", content }],
    });
    assert.equal(result.status, 413);
    assert.equal(result.body.error.code, code);
    assert.equal(result.headers.get("X-Error-Code"), code);
    assert.equal(result.headers.get("X-Helix-Error-Code"), code);
    assert.deepEqual(Object.keys(result.body), ["error"]);
    assert.equal(result.body.error.type, "invalid_request_error");
    const row = await new Store(db).first(
      "SELECT error_code, upstream_attempted FROM requests WHERE request_id=?",
      result.headers.get("X-Request-ID"),
    );
    assert.equal(row?.error_code, code);
    assert.equal(row.upstream_attempted, 0);
  }
});
test("Unconfigured Anthropic Messages returns a native Anthropic error", async () => {
  const response = await apiCall("/v1/messages", "unused", {});
  assert.equal(response.status, 404);
  assert.deepEqual(response.body, {
    type: "error",
    error: {
      type: "not_found_error",
      message: "Anthropic Messages is not configured.",
    },
    request_id: response.headers.get("request-id"),
  });
  assert.equal(
    response.headers.get("X-Helix-Error-Code"),
    "anthropic_not_configured",
  );
});
test("Default model edits only affect new accounts; account grants cover local voice aliases", async () => {
  const { uid, key } = await lunaUser("public-model-switch");
  await db
    .prepare("UPDATE users SET services=? WHERE id=?")
    .bind('["qwen","asr","tts"]', uid)
    .run();
  await db
    .prepare("UPDATE keys SET services=? WHERE user_id=?")
    .bind('["qwen","asr","tts"]', uid)
    .run();
  const path = "/admin/models";
  const update = (id, enabled, access = admin) =>
    call(path, { id, enabled }, { method: "PATCH", access });
  assert.equal((await call(path)).status, 401);
  assert.equal((await update("gpt-6-luna", true, key)).status, 401);
  assert.equal((await update("unknown", true)).status, 422);
  try {
    assert.equal((await update("gpt-6-luna", false)).status, 200);
    assert.equal((await update("cosyvoice", false)).status, 200);
    const catalog = await apiCall("/v1/models?output_modalities=all", key);
    assert.ok(catalog.body.data.some(({ id }) => id === "gpt-6-luna"));
    const newborn = await lunaUser("new-after-model-default-edit");
    assert.ok(
      !(await apiCall("/v1/models", newborn.key)).body.data.some(
        ({ id }) => id === "gpt-6-luna",
      ),
    );
    const saved = await call(
      "/admin/users/" + uid,
      { allowed_model_ids: [] },
      { method: "PATCH", access: admin },
    );
    assert.equal(saved.status, 200);
    const before = { providerCalls, originCalls };
    const chat = await apiCall("/v1/chat/completions", key, {
      model: "gpt-6-luna",
      messages: [{ role: "user", content: "hi" }],
    });
    const speech = await apiCall("/v1/audio/speech", key, {
      model: "cosyvoice3",
      input: "hi",
    });
    const ws = await apiCall("/ws/tts", key, undefined, {
      Upgrade: "websocket",
    });
    for (const response of [chat, speech]) {
      assert.equal(response.status, 403);
      assert.equal(response.body.error.code, "model_not_allowed");
    }
    assert.equal(ws.status, 403);
    assert.equal(ws.body.error_code, "model_not_allowed");
    assert.deepEqual({ providerCalls, originCalls }, before);
    assert.equal((await update("gpt-6-luna", true)).status, 200);
    assert.deepEqual((await apiCall("/v1/models", key)).body.data, []);
  } finally {
    await update("gpt-6-luna", true);
    await update("cosyvoice", true);
  }
});

test("User allowlists bound to the account filter model discovery and account-token/API-Key inference", async () => {
  const a = await lunaUser("model-allowlist-a");
  const b = await lunaUser("model-allowlist-b");
  const store = new Store(db);
  const loginUser = await store.createUser(
    "model-allowlist-login",
    "test-password",
    {
      services: ["qwen"],
      must_change: 0,
    },
  );
  const login = await fixtureLogin(
    store,
    loginUser.display_name,
    "test-password",
    "test",
  );
  const set = (uid, ids, access = admin) =>
    call(
      "/admin/users/" + uid,
      { allowed_model_ids: ids },
      { method: "PATCH", access },
    );
  const astra = "gpt-6-astra",
    luna = "gpt-6-luna";
  const switchAstra = (enabled) =>
    call(
      "/admin/models",
      { id: astra, enabled },
      { method: "PATCH", access: admin },
    );
  await switchAstra(true);
  try {
    assert.equal(
      (await set(a.uid, [luna], login.body.access_token)).status,
      403,
    );
    assert.equal((await set(a.uid, ["unknown"])).status, 422);
    assert.equal((await set(a.uid, [luna, luna])).status, 422);
    assert.equal((await set(a.uid, [luna])).status, 200);
    assert.equal((await set(b.uid, [luna, astra])).status, 200);
    assert.equal((await set(loginUser.id, [luna])).status, 200);
    const client = { "X-Client-ID": "test-client-id" };
    const models = async (key, headers) =>
      (await apiCall("/v1/models", key, undefined, headers)).body.data.map(
        (m) => m.id,
      );
    assert.deepEqual(await models(a.key), [luna]);
    assert.deepEqual(await models(b.key), [luna, astra]);
    assert.deepEqual(await models(login.body.access_token, client), [luna]);
    const chat = (key, model, headers) =>
      apiCall(
        "/v1/chat/completions",
        key,
        { model, messages: [{ role: "user", content: "hi" }] },
        headers,
      );
    const before = providerCalls;
    assert.equal(
      (await chat(a.key, astra)).body.error.code,
      "model_not_allowed",
    );
    assert.equal(
      (await chat(login.body.access_token, astra, client)).body.error.code,
      "model_not_allowed",
    );
    assert.equal(providerCalls, before);
    assert.equal((await chat(b.key, astra)).status, 200);
    await switchAstra(false);
    assert.equal((await chat(b.key, astra)).status, 200);
    await set(a.uid, []);
    assert.deepEqual(await models(a.key), []);
    assert.equal((await set(a.uid, null)).status, 422);
    assert.deepEqual(await models(a.key), []);
  } finally {
    await switchAstra(false);
  }
});

test("Bulk model grants preserve other choices and reject incomplete account sets atomically", async () => {
  const a = await lunaUser("bulk-model-a");
  const b = await lunaUser("bulk-model-b");
  const store = new Store(db);
  const sol = "gpt-6.2-sol",
    luna = "gpt-6-luna";
  await store.run(
    "UPDATE users SET allowed_model_ids=? WHERE id=?",
    JSON.stringify([luna]),
    a.uid,
  );
  await store.run(
    "UPDATE users SET allowed_model_ids=? WHERE id=?",
    JSON.stringify([]),
    b.uid,
  );
  const bulk = (ids, patch) =>
    call("/admin/users/bulk", { ids, patch }, { access: admin });
  const ids = [a.uid, b.uid];
  assert.equal(
    (await bulk([...ids, 999999], { add_model_ids: [sol] })).status,
    404,
  );
  const grants = async (uid) =>
    JSON.parse(
      (await store.first("SELECT allowed_model_ids FROM users WHERE id=?", uid))
        .allowed_model_ids,
    );
  assert.deepEqual(await grants(a.uid), [luna]);
  assert.equal((await bulk(ids, { add_model_ids: [sol] })).status, 200);
  assert.deepEqual(new Set(await grants(a.uid)), new Set([luna, sol]));
  assert.deepEqual(await grants(b.uid), [sol]);
  assert.equal((await bulk(ids, { remove_model_ids: [sol] })).status, 200);
  assert.deepEqual(await grants(a.uid), [luna]);
  assert.deepEqual(await grants(b.uid), []);
});

test("Each new cloud language model is closed by default and can be independently routed and metered", async () => {
  const { uid, key } = await lunaUser("multi-cloud-text");
  const prices = {
    "gpt-6-sol": [2000, 10000],
    "gpt-6-astra": [10000, 50000],
    "gpt-6.1-sol": [2000, 10000],
    "gpt-6.1-terra": [1000, 5000],
    "gpt-6.2-sol": [2000, 10000],
    "gpt-6.2-astra": [8000, 40000],
  };
  const update = (ids) =>
    call(
      "/admin/users/" + uid,
      { allowed_model_ids: ids },
      { method: "PATCH", access: admin },
    );
  for (const [id, [input, output]] of Object.entries(prices)) {
    const payload = { model: id, messages: [{ role: "user", content: "hi" }] };
    const endpoint = "/v1/chat/completions";
    const blocked = await apiCall(endpoint, key, payload);
    assert.equal(blocked.body.error.code, "model_not_allowed");
    try {
      assert.equal((await update([id])).status, 200);
      const list = await apiCall("/v1/models", key);
      assert.ok(list.body.data.some((model) => model.id === id));
      const result = await apiCall(endpoint, key, payload);
      assert.equal(result.status, 200);
      assert.equal(lastProviderPayload.model, id);
      const charge = await db
        .prepare(
          "SELECT l.* FROM luna_usage l JOIN requests r ON r.id=l.lease WHERE l.user_id=? AND r.model=? ORDER BY l.rowid DESC LIMIT 1",
        )
        .bind(uid, id)
        .first();
      assert.ok(charge.settled);
      assert.equal(charge.model, id);
      assert.equal(
        charge.charged_cost_nanos,
        (charge.prompt_tokens -
          charge.cached_tokens -
          charge.cache_write_tokens) *
          input +
          charge.cached_tokens *
            (id.includes("6.1-") || id.includes("6.2-")
              ? input / 20
              : input / 10) +
          charge.cache_write_tokens * input * 1.25 +
          charge.completion_tokens * output,
      );
    } finally {
      await update([]);
    }
  }
});

test("Luna Responses web search preserves citations, meters billed calls and atomically enforces the user quota", async () => {
  const { uid, key } = await lunaUser("luna-web-search");
  const store = new Store(db);
  const edit = (limit) =>
    call(
      "/admin/users/" + uid,
      { web_search_daily_calls: limit },
      { method: "PATCH", access: admin },
    );
  assert.equal(
    (
      await store.first(
        "SELECT web_search_daily_calls FROM users WHERE id=?",
        uid,
      )
    ).web_search_daily_calls,
    30,
  );
  assert.equal((await edit(1)).status, 200);
  const search = {
    model: "gpt-6-luna",
    input: "search",
    tools: [{ type: "web_search" }],
    include: ["web_search_call.action.sources"],
    max_output_tokens: 128,
  };
  assert.equal(
    (await apiCall("/v1/responses", key, { ...search, max_tool_calls: 2 }))
      .status,
    422,
  );
  const calls = await Promise.all([
    apiCall("/v1/responses", key, search),
    apiCall("/v1/responses", key, search),
  ]);
  const ok = calls.find((result) => result.status === 200);
  assert.equal(
    ok.body.output[1].content[0].annotations[0].type,
    "url_citation",
  );
  const blocked = calls.find((result) => result.status === 429);
  assert.equal(blocked.body.error.code, "web_search_daily_limit");
  assert.ok(
    blocked.headers.get("X-Helix-Resets-At").endsWith("T16:00:00.000Z"),
  );
  const ledger = await store.first(
    "SELECT * FROM luna_usage WHERE user_id=?",
    uid,
  );
  assert.equal(ledger.web_search_calls, 1);
  assert.equal(ledger.charged_cost_nanos, 10020000);
  assert.ok(ledger.reserved_cost_nanos > 26064000);
  assert.equal(ledger.settled, 1);

  await edit(2);
  const stream = await mf.dispatchFetch("https://api.hilex.me/v1/responses", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + key,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ...search, stream: true }),
  });
  assert.equal(stream.status, 200);
  assert.match(await stream.text(), /url_citation/);
  const totals = await store.first(
    "SELECT sum(web_search_calls) calls,sum(settled) settled FROM luna_usage WHERE user_id=?",
    uid,
  );
  assert.deepEqual(totals, { calls: 2, settled: 2 });
  await edit(3);
  openaiMode = "no-search-meter";
  try {
    assert.equal((await apiCall("/v1/responses", key, search)).status, 200);
    const pending = await store.first(
      "SELECT * FROM luna_usage WHERE user_id=? AND settled=0",
      uid,
    );
    assert.equal(pending.web_search_calls, 1);
    assert.equal(pending.charged_cost_nanos, pending.reserved_cost_nanos);
    assert.equal(
      (await apiCall("/v1/responses", key, search)).body.error.code,
      "web_search_daily_limit",
    );
    const details = await call(
      "/admin/users/" + uid + "/details?view=summary",
      undefined,
      { access: admin },
    );
    assert.deepEqual(
      [
        details.body.web_search.used,
        details.body.web_search.reserved,
        details.body.web_search.remaining,
      ],
      [2, 1, 0],
    );
    await store.run(
      "UPDATE requests SET ended=? WHERE id=?",
      Date.now() / 1000 - 61,
      pending.lease,
    );
    const adjustment = {
      id: "web-search-adjustment",
      kind: "luna",
      lease: pending.lease,
      units: 0,
      expected_units: pending.charged_tokens,
      reason: "Confirmed no search or tokens billed",
      cost_nanos: 0,
      expected_cost_nanos: pending.charged_cost_nanos,
      web_search_calls: 0,
      expected_web_search_calls: 1,
    };
    assert.equal(
      (
        await call(
          "/admin/quota-adjustments",
          { ...adjustment, expected_web_search_calls: 0 },
          { access: admin },
        )
      ).status,
      409,
    );
    assert.equal(
      (await call("/admin/quota-adjustments", adjustment, { access: admin }))
        .status,
      200,
    );
    assert.equal(
      (await call("/admin/quota-adjustments", adjustment, { access: admin }))
        .body.replayed,
      true,
    );
    const after = await call(
      "/admin/users/" + uid + "/details?view=summary",
      undefined,
      { access: admin },
    );
    assert.deepEqual(
      [
        after.body.web_search.used,
        after.body.web_search.reserved,
        after.body.web_search.remaining,
      ],
      [2, 0, 1],
    );
  } finally {
    openaiMode = "json";
  }
});

test("Sampled inference logs phase timings and relay estimates without exposing private headers", async () => {
  const { key } = await lunaUser("sampled-timing");
  const original = globalThis.fetch,
    info = console.info;
  const records = [];
  console.info = (line) => records.push(JSON.parse(line));
  globalThis.fetch = async () =>
    Response.json(
      {
        id: "sample-response",
        usage: { prompt_tokens: 5, completion_tokens: 1 },
      },
      { headers: { "X-Edge-Upstream-Ms": "3" } },
    );
  try {
    const result = await edgeAPI(
      new Request("https://api.hilex.me/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + key,
          "Content-Type": "application/json",
          "CF-Connecting-IP": "203.0.113.10",
        },
        body: JSON.stringify({
          model: "gpt-6-luna",
          messages: [{ role: "user", content: "test" }],
        }),
      }),
      {
        DB: db,
        INTERNAL_SECRET: secret,
        OPENAI_API_KEY: "provider-test",
        OPENAI_TRANSPORT: "local",
        INFERENCE_TIMING_SAMPLE_RATE: "1",
      },
      { waitUntil() {} },
    );
    assert.equal(result.status, 200);
    assert.equal(result.headers.get("X-Edge-Upstream-Ms"), null);
    await result.json();
    const sample = records.find(
      (record) => record.event === "inference_timing",
    );
    assert.equal(sample.operation, "chat");
    for (const phase of [
      "auth_and_lease_ms",
      "reserve_ms",
      "provider_headers_ms",
      "relay_overhead_ms",
      "first_byte_ms",
      "settle_ms",
      "db_ops",
      "db_meta_ops",
    ]) {
      assert.ok(Number.isFinite(sample.details[phase]), phase);
    }
    assert.equal(sample.details.upstream_headers_ms, 3);
    assert.equal(sample.details.db_ops, 7);
  } finally {
    globalThis.fetch = original;
    console.info = info;
  }
});

test("edge API authenticates directly, discovers cloud models without origin and settles Luna once", async () => {
  const { uid, key } = await lunaUser("edge-luna");
  const origins = originCalls;
  const models = await apiCall("/v1/models", key);
  assert.equal(models.status, 200);
  assert.equal(models.headers.get("X-Inference-Execution"), "edge");
  assert.equal(models.body.data[0].id, "gpt-6-luna");
  assert.equal(originCalls, origins);
  const r = await apiCall("/v1/chat/completions", key, {
    model: "gpt-6-luna",
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(r.status, 200);
  assert.equal(originCalls, origins);
  const rows = (
    await db.prepare("SELECT * FROM requests WHERE user_id=?").bind(uid).all()
  ).results;
  assert.equal(rows.length, 1);
  assert.ok(rows.every((r) => r.ended));
  assert.equal(rows.find((r) => r.model === "gpt-6-luna").prompt_tokens, 100);
  assert.equal((await apiCall("/v1/models", "invalid")).status, 401);
  assert.equal(
    (
      await mf.dispatchFetch("https://api.hilex.me/__codec/decode", {
        method: "POST",
        body: "raw",
      })
    ).status,
    404,
  );
});
test("edge ASR WAV skips origin; compressed inputs use only the protected codec", async () => {
  const { key } = await audioUser("edge-asr", "asr");
  const initial = originCalls;
  async function run(bytes, name) {
    const form = new FormData();
    form.set("model", "gpt-transcribe");
    form.set("file", new Blob([bytes]), name);
    const req = new Request("https://api.hilex.me/v1/audio/transcriptions", {
      method: "POST",
      body: form,
    });
    const r = await mf.dispatchFetch(req.url, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + key,
        "Content-Type": req.headers.get("Content-Type"),
      },
      body: await req.arrayBuffer(),
    });
    assert.equal(r.status, 200, await r.clone().text());
    return r.json();
  }
  assert.equal((await run(testWav(1000), "audio.wav")).text, "hello");
  assert.equal(originCalls, initial);
  await run(new TextEncoder().encode("compressed fixture"), "audio.mp3");
  assert.equal(originCalls, initial + 1);
  const fixtures = JSON.parse(
    await readFile("tests/audio-fixtures.json", "utf8"),
  );
  for (const f of fixtures) {
    await run(new Uint8Array(Buffer.from(f.base64, "base64")), "wrong.wav");
    assert.equal(originCalls, initial + 1);
    assert.notEqual(lastAudioName, "audio.wav");
  }
});
test("edge forwards legacy local requests with server-only headers and prevents credential confusion", async () => {
  const { key } = await audioUser("edge-local", "tts");
  const r = await apiCall(
    "/v1/audio/speech",
    key,
    { input: "legacy" },
    {
      "X-Inference-Provider": "local",
      "X-Edge-Secret": "attacker",
      Cookie: "sensitive",
    },
  );
  assert.equal(r.status, 200);
  assert.equal(r.body.text, "local");
  assert.equal(
    (await apiCall("/v1/audio/speech", key, { model: "tts-1", input: "hi" }))
      .status,
    422,
  );
  assert.equal(
    (
      await apiCall("/v1/models", key, undefined, {
        "X-API-Key": "sk-acct-conflict",
      })
    ).status,
    401,
  );
});
test("edge TTS defaults to PCM, supports streaming, rejects other formats before provider calls", async () => {
  const { uid, key } = await audioUser("edge-tts", "tts");
  const original = globalThis.fetch;
  const jobs = [];
  let realtimeCalls = 0;
  globalThis.fetch = async (url, options) => {
    if (String(url).includes("/v1/realtime?")) {
      realtimeCalls++;
      return { webSocket: new MockRealtime() };
    }
    return provider(new Request(url, { ...options, duplex: "half" }));
  };
  try {
    const env = {
      DB: db,
      OPENAI_API_KEY: "test-openai-key",
      INTERNAL_SECRET: secret,
    };
    async function run(body) {
      const r = await edgeAPI(
        new Request("https://api.hilex.me/v1/audio/speech", {
          method: "POST",
          headers: {
            Authorization: "Bearer " + key,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "gpt-realtime-2.1-mini",
            input: "hi",
            ...body,
          }),
        }),
        env,
        {
          waitUntil(p) {
            jobs.push(p);
          },
        },
      );
      return r;
    }
    const before = originCalls;
    for (const payload of [
      {},
      { response_format: "pcm" },
      { response_format: "pcm", stream: true },
    ]) {
      const r = await run(payload);
      assert.equal(r.status, 200);
      assert.equal(r.headers.get("Content-Type"), "audio/pcm");
      assert.equal(r.headers.get("X-Audio-Sample-Rate"), "24000");
      assert.ok((await r.arrayBuffer()).byteLength > 0);
    }
    for (const fmt of ["mp3", "opus", "flac", "wav"])
      for (const stream of [false, true]) {
        const r = await run({ response_format: fmt, stream });
        assert.equal(r.status, 422);
        assert.equal((await r.json()).error.code, "unsupported_audio_format");
      }
    await Promise.all(jobs);
    assert.equal(originCalls, before);
    assert.equal(realtimeCalls, 3);
    assert.equal(
      (
        await db
          .prepare(
            "SELECT sum(charged_units) n,count(*) requests FROM audio_usage WHERE user_id=?",
          )
          .bind(uid)
          .first()
      ).n,
      6,
    );
    assert.equal(
      (
        await db
          .prepare("SELECT count(*) n FROM audio_usage WHERE user_id=?")
          .bind(uid)
          .first()
      ).n,
      3,
    );
    const models = await apiCall("/v1/models?output_modalities=all", key);
    const speech = models.body.data.find(
      (m) => m.id === "gpt-realtime-2.1-mini",
    );
    assert.deepEqual(speech.audio.response_formats, ["pcm"]);
  } finally {
    globalThis.fetch = original;
  }
});

test("Edge Luna tools normalize arguments and retain safe provider diagnostics with zero charge", async () => {
  const { uid, key } = await lunaUser("edge-tools");
  const payload = {
    model: "gpt-6-luna",
    messages: [{ role: "user", content: "lookup" }],
    reasoning_effort: "medium",
    tools: [
      {
        type: "function",
        function: {
          name: "lookup",
          parameters: { type: "object", properties: {} },
        },
      },
    ],
  };
  const ok = await apiCall("/v1/chat/completions", key, payload);
  assert.equal(ok.status, 200);
  assert.equal(lastProviderPayload.reasoning_effort, "none");
  assert.match(
    ok.headers.get("X-Inference-Compatibility"),
    /chat-tools-reasoning-none/,
  );
  openaiMode = "parameter-error";
  try {
    const r = await apiCall("/v1/chat/completions", key, payload);
    assert.equal(r.status, 400);
    assert.deepEqual(r.body, {
      error: {
        message: "Unsupported reasoning effort.",
        type: "invalid_request_error",
        param: "reasoning_effort",
        code: "unsupported_value",
      },
    });
    assert.equal(r.headers.get("X-OpenAI-Request-ID"), "req_tools_test");
    assert.equal(r.headers.get("X-Helix-Error-Code"), null);
    const row = await db
      .prepare(
        "SELECT r.*,l.charged_tokens,l.settled FROM requests r JOIN luna_usage l ON l.lease=r.id WHERE r.request_id=?",
      )
      .bind(r.headers.get("X-Request-ID"))
      .first();
    assert.equal(row.upstream_error_code, "unsupported_value");
    assert.equal(row.upstream_error_param, "reasoning_effort");
    assert.equal(row.upstream_request_id, "req_tools_test");
    assert.equal(row.failure_stage, "upstream_rejected");
    assert.equal(row.upstream_status, 400);
    assert.equal(row.charged_tokens, 0);
    assert.equal(row.settled, 1);
  } finally {
    openaiMode = "json";
  }
});

test("OpenAI 403 records reference probe and provider identifiers without changing refund", async () => {
  const { uid, key } = await lunaUser("edge-egress-diagnostics");
  const original = globalThis.fetch,
    jobs = [];
  globalThis.fetch = async (url, options) => {
    if (String(url).includes("api64.ipify.org")) {
      assert.deepEqual(options.headers, { Accept: "application/json" });
      return Response.json({ ip: "203.0.113.42" });
    }
    return Response.json(
      {
        error: {
          code: "unsupported_country_region_territory",
          type: "permission_error",
          message: "Unsupported country, region or territory",
          param: null,
        },
      },
      {
        status: 403,
        headers: { "x-request-id": "req_geo", "cf-ray": "abc-NRT" },
      },
    );
  };
  try {
    const request = new Request("https://api.hilex.me/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + key,
        "Content-Type": "application/json",
        "cf-ray": "def-NRT",
      },
      body: JSON.stringify({
        model: "gpt-6-luna",
        messages: [{ role: "user", content: "test" }],
      }),
    });
    Object.defineProperty(request, "cf", {
      value: { colo: "NRT", country: "JP" },
    });
    const r = await edgeAPI(
      request,
      { DB: db, OPENAI_API_KEY: "test-key" },
      { waitUntil: (p) => jobs.push(p) },
    );
    assert.equal(r.status, 403);
    const error = await r.json();
    await Promise.all(jobs);
    assert.equal(error.error.code, "unsupported_country_region_territory");
    assert.equal(error.egress_probe_ip, undefined);
    const row = await db
      .prepare(
        "SELECT r.*,l.charged_tokens,l.settled FROM requests r JOIN luna_usage l ON l.lease=r.id WHERE r.request_id=?",
      )
      .bind(r.headers.get("X-Request-ID"))
      .first();
    assert.equal(row.ingress_colo, "NRT");
    assert.equal(row.client_country, "JP");
    assert.equal(row.ingress_ray, "def-NRT");
    assert.equal(row.upstream_request_id, "req_geo");
    assert.equal(row.upstream_cf_ray, "abc-NRT");
    assert.equal(row.egress_probe_ip, "203.0.113.42");
    assert.equal(row.egress_probe_status, "observed_reference");
    assert.equal(row.egress_probe_target, "api64.ipify.org");
    assert.equal(row.charged_tokens, 0);
    assert.equal(row.settled, 1);
  } finally {
    globalThis.fetch = original;
  }
});

test("Organization costs are admin-only and aggregate paginated amounts by currency", async () => {
  const path = "/admin/openai-costs";
  assert.equal((await call(path)).status, 401);
  const { key } = await lunaUser("costs-auth");
  assert.equal((await call(path, undefined, { access: key })).status, 401);
  assert.equal(
    (await call(path + "?period=999d", undefined, { access: admin })).status,
    422,
  );
  const result = await call(path + "?period=7d", undefined, { access: admin });
  assert.equal(result.status, 200);
  assert.equal(result.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(
    result.body.days.map((day) => day.amounts),
    [{ usd: 3 }, { usd: -0.5, eur: 10 }],
  );
});

test("Organization costs retry one temporary failure without retrying invalid credentials", async () => {
  const query = () =>
    call("/admin/openai-costs?period=7d", undefined, { access: admin });
  const before = costCalls;
  try {
    costFailures.push(503);
    assert.equal((await query()).status, 200);
    assert.equal(costCalls - before, 3); // Temporary failure plus two successful pages.
    costFailures.push(502, 503);
    assert.equal((await query()).status, 502);
    assert.equal(costCalls - before, 5);
    costFailures.push(401);
    const denied = await query();
    assert.equal(denied.status, 502);
    assert.match(denied.body.detail, /凭据/);
    assert.equal(costCalls - before, 6);
  } finally {
    costFailures.length = 0;
  }
});

test("Global budget controls are admin-only, atomic across accounts, and zero prevents provider calls", async () => {
  const saved = await call("/admin/operations", undefined, { access: admin });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.limits.luna_monthly_usd, 200);
  assert.equal((await call("/admin/operations")).status, 401);
  const cloudPause = await call(
    "/admin/global-limits",
    { ...saved.body.limits, cloud_enabled: false },
    { method: "PATCH", access: admin },
  );
  assert.equal(cloudPause.status, 200);
  try {
    const { key } = await lunaUser("cloud-pause-discovery");
    const discovery = await apiCall("/v1/models?output_modalities=all", key);
    assert.equal(discovery.status, 200);
    assert.deepEqual(discovery.body.data, []);
    const models = await call("/admin/models", undefined, { access: admin });
    const luna = models.body.models.find((m) => m.id === "gpt-6-luna");
    assert.ok(luna.enabled && luna.cloud_paused);
  } finally {
    await call("/admin/global-limits", saved.body.limits, {
      method: "PATCH",
      access: admin,
    });
  }
  const limits = { ...saved.body.limits, luna_monthly_usd: 0 };
  try {
    assert.equal(
      (
        await call("/admin/global-limits", limits, {
          method: "PATCH",
          access: admin,
        })
      ).status,
      200,
    );
    const { key } = await lunaUser("global-zero"),
      before = providerCalls;
    const r = await apiCall("/v1/chat/completions", key, {
      model: "gpt-6-luna",
      messages: [{ role: "user", content: "hi" }],
    });
    assert.equal(r.status, 429);
    assert.equal(r.body.error.code, "global_budget_exhausted");
    assert.equal(r.headers.get("Retry-After"), null);
    assert.equal(providerCalls, before);
    await call(
      "/admin/global-limits",
      { ...limits, luna_monthly_usd: 0.01 },
      { method: "PATCH", access: admin },
    );
    const { key: k1, uid } = await lunaUser("global-race-one"),
      { key: k2, uid: uid2 } = await lunaUser("global-race-two");
    const leases = [await lunaLease(k1), await lunaLease(k2)];
    const insert = (lease, user) =>
      db
        .prepare(
          "INSERT INTO luna_usage(lease,user_id,month,reserved_tokens,charged_tokens,prompt_tokens,completion_tokens,reserved_cost_nanos,charged_cost_nanos) VALUES(?,?,?,100,100,50,50,9000000,9000000)",
        )
        .bind(lease, user, "2099-01")
        .run();
    const attempts = await Promise.allSettled([
      insert(leases[0], uid),
      insert(leases[1], uid2),
    ]);
    assert.equal(attempts.filter((r) => r.status === "fulfilled").length, 1);
    const first = attempts.findIndex((r) => r.status === "fulfilled");
    await db
      .prepare("DELETE FROM luna_usage WHERE lease=?")
      .bind(leases[first])
      .run();
    await assert.rejects(insert(leases[1 - first], first === 0 ? uid2 : uid));
    // Account deletion must not erase global spend. Synthetic test spend can be explicitly removed.
    await db
      .prepare("DELETE FROM luna_spend WHERE month=?")
      .bind("2099-01")
      .run();
  } finally {
    await call("/admin/global-limits", saved.body.limits, {
      method: "PATCH",
      access: admin,
    });
  }
});

test("Registration burst and account identity limits apply across IPs; open registration remains available", async () => {
  const store = new Store(db),
    ts = Date.now() / 1000;
  for (let n = 0; n < 10; n++)
    await store.rateLimit("identity-ip-" + n, "login", " victim@example.org ");
  await assert.rejects(
    store.rateLimit("new-identity-ip", "login", "VICTIM@example.org"),
    (e) => e.status === 429,
  );
  await db.prepare("DELETE FROM registration_attempts").run();
  const saved = JSON.parse(
    (
      await store.first(
        "SELECT value FROM settings WHERE name='registration_policy'",
      )
    ).value,
  );
  await store.run(
    "UPDATE settings SET value=? WHERE name='registration_policy'",
    JSON.stringify({ ...saved, global_minute: 2 }),
  );
  try {
    await store.rateLimit("register-one", "register", "one@example.org");
    await store.rateLimit("register-two", "register", "two@example.org");
    await assert.rejects(
      store.rateLimit("register-three", "register", "three@example.org"),
      (e) => e.status === 429,
    );
  } finally {
    await store.run(
      "UPDATE settings SET value=? WHERE name='registration_policy'",
      JSON.stringify(saved),
    );
    await db.prepare("DELETE FROM registration_attempts").run();
  }
});

test("Maintenance preserves live refresh replay evidence and financial ledgers while archiving old nonbillable requests", async () => {
  const { maintenance, monitor } = await import("../src/operations.mjs");
  const store = new Store(db);
  const { uid } = await lunaUser("retention-test");
  const old = Date.now() / 1000 - 100 * 86400;
  await store.run(
    "INSERT INTO requests(id,user_id,service,path,started,day,ended,status,response_bytes,client_ip) VALUES('old-archive',?,'qwen','/v1/models',?,'2026-01-01',?,200,12,'203.0.113.3')",
    uid,
    old,
    old + 1,
  );
  await maintenance(store);
  const historical = await call(
    "/admin/overview?day=2026-01-01&q=retention-test&summary=0",
    undefined,
    { access: admin },
  );
  assert.equal(historical.status, 200);
  assert.equal(historical.body.summary, undefined);
  assert.equal(historical.body.users.find((u) => u.id === uid).day_requests, 1);
  assert.equal(
    await store.first("SELECT * FROM requests WHERE id='old-archive'"),
    null,
  );
  assert.equal(
    (
      await store.first(
        "SELECT total,response_bytes FROM request_history WHERE user_id=?",
        uid,
      )
    ).total,
    1,
  );
  await maintenance(store);
  assert.equal(
    (
      await store.first(
        "SELECT total FROM request_history WHERE user_id=?",
        uid,
      )
    ).total,
    1,
  );
  await monitor(store);
  const ops = await call("/admin/operations", undefined, { access: admin });
  assert.equal(ops.status, 200);
  assert.ok(Array.isArray(ops.body.alerts));
});

test("Cancelling PCM output closes the upstream Realtime session and preserves submitted usage", async () => {
  const { key } = await audioUser("tts-cancel", "tts");
  const lease = await audioLease(key, "tts");
  const ws = new MockRealtime("hold"),
    jobs = [];
  const request = new Request("https://worker/internal/openai/speech", {
    method: "POST",
    headers: { "X-Gateway-Lease": lease },
    body: JSON.stringify({
      model: "gpt-realtime-2.1-mini",
      input: "cancel me",
      stream: true,
      response_format: "pcm",
    }),
  });
  const r = await proxySpeech(
    request,
    { OPENAI_API_KEY: "key" },
    new Store(db),
    async () => ({ webSocket: ws }),
    { waitUntil: (p) => jobs.push(p) },
  );
  const reader = r.body.getReader();
  assert.ok((await reader.read()).value.length);
  await reader.cancel();
  await Promise.all(jobs);
  assert.equal(ws.closed, true);
  const row = await db
    .prepare("SELECT settled,charged_units FROM audio_usage WHERE lease=?")
    .bind(lease)
    .first();
  assert.equal(row.settled, 0);
  assert.equal(row.charged_units, 9);
});

test("Retention keeps live used refresh tokens and old financial requests; cost reconciliation is audited", async () => {
  const { maintenance } = await import("../src/operations.mjs");
  const store = new Store(db),
    ts = Date.now() / 1000;
  const { uid, key } = await lunaUser("financial-retention");
  await store.run(
    "INSERT INTO auth_families(id,user_id,expires,revoked) VALUES('live-replay-family',?,?,0)",
    uid,
    ts + 3600,
  );
  await store.run(
    "INSERT INTO refresh_tokens(hash,family_id,expires,used) VALUES('retained-used','live-replay-family',?,1)",
    ts + 3600,
  );
  const lease = await lunaLease(key);
  await store.run(
    "INSERT INTO luna_usage(lease,user_id,month,reserved_tokens,charged_tokens,prompt_tokens,completion_tokens,reserved_cost_nanos,charged_cost_nanos) VALUES(?,?,?,1000,1000,500,500,1000000,1000000)",
    lease,
    uid,
    "2026-01",
  );
  await store.run(
    "UPDATE requests SET started=?,ended=?,status=504,client_ip='203.0.113.8' WHERE id=?",
    ts - 100 * 86400,
    ts - 100 * 86400 + 1,
    lease,
  );
  await maintenance(store);
  assert.ok(
    await store.first(
      "SELECT * FROM refresh_tokens WHERE hash='retained-used'",
    ),
  );
  assert.equal(
    (await store.first("SELECT client_ip FROM requests WHERE id=?", lease))
      .client_ip,
    null,
  );
  const b = {
    id: "cost-adjustment-id",
    kind: "luna",
    lease,
    expected_units: 1000,
    units: 0,
    reason: "Confirmed rejected request, zero provider usage",
    expected_cost_nanos: 1000000,
    cost_nanos: 0,
  };
  const adjusted = await call("/admin/quota-adjustments", b, { access: admin });
  assert.equal(adjusted.status, 200);
  assert.equal(
    (
      await store.first(
        "SELECT cost_nanos FROM luna_spend WHERE lease=?",
        lease,
      )
    ).cost_nanos,
    0,
  );
  assert.equal(
    (await call("/admin/quota-adjustments", b, { access: admin })).body
      .replayed,
    true,
  );
});

test("Old Worker inserts and in-flight settlements cannot bypass the new global cost ledger", async () => {
  const { uid, key } = await lunaUser("legacy-cost-compat");
  const lease = await lunaLease(key);
  const store = new Store(db);
  await store.run(
    "INSERT INTO luna_usage(lease,user_id,month,reserved_tokens,charged_tokens,prompt_tokens,completion_tokens) VALUES(?,?,?,1000,1000,500,500)",
    lease,
    uid,
    "2026-11",
  );
  assert.equal(
    (
      await store.first(
        "SELECT cost_nanos FROM luna_spend WHERE lease=?",
        lease,
      )
    ).cost_nanos,
    312500,
  );
  await store.run(
    "UPDATE luna_usage SET charged_tokens=120,settled=1,prompt_tokens=100,completion_tokens=20,cached_tokens=40 WHERE lease=?",
    lease,
  );
  assert.equal(
    (
      await store.first(
        "SELECT cost_nanos FROM luna_spend WHERE lease=?",
        lease,
      )
    ).cost_nanos,
    16400,
  );
  assert.equal(
    (
      await store.first(
        "SELECT charged_cost_nanos FROM luna_usage WHERE lease=?",
        lease,
      )
    ).charged_cost_nanos,
    16400,
  );
});

test("Optional global audio limits survive account usage deletion", async () => {
  const store = new Store(db),
    saved = JSON.parse(
      (
        await store.first(
          "SELECT value FROM settings WHERE name='global_limits'",
        )
      ).value,
    );
  const { uid, key } = await audioUser("global-audio-ledger", "tts");
  const leases = [await audioLease(key, "tts"), await audioLease(key, "tts")];
  const insert = (lease) =>
    store.run(
      "INSERT INTO audio_usage(lease,user_id,day,kind,reserved_units,charged_units) VALUES(?,?,'2099-01-01','tts',100,100)",
      lease,
      uid,
    );
  try {
    await store.run(
      "UPDATE settings SET value=? WHERE name='global_limits'",
      JSON.stringify({ ...saved, tts_daily_characters: 150 }),
    );
    await insert(leases[0]);
    await store.run("DELETE FROM audio_usage WHERE lease=?", leases[0]);
    await assert.rejects(insert(leases[1]), (e) =>
      String(e).includes("global_audio_budget_exhausted"),
    );
  } finally {
    await store.run(
      "UPDATE settings SET value=? WHERE name='global_limits'",
      JSON.stringify(saved),
    );
    await store.run("DELETE FROM audio_spend WHERE day='2099-01-01'");
  }
});

test("Network statistics retain successful and failed cohorts and bundles exclude customer identifiers", async () => {
  const store = new Store(db),
    { uid } = await lunaUser("network-stats"),
    ts = Date.now() / 1000;
  for (let n = 0; n < 4; n++)
    await store.run(
      "INSERT INTO requests(id,user_id,service,path,started,ended,day,status,provider,model,protocol,request_id,upstream_status,upstream_error_code,ingress_colo,client_country,client_ip,user_agent,release_sha,upstream_attempted,egress_probe_ip) VALUES(?,?,'qwen','/v1/chat/completions',?,?,'2026-11-16',?,'openai','network-fixture','http',?,?,?,?,?,'203.0.113.77','PRIVATE_USER_AGENT','test-release',1,'203.0.113.77')",
      "network-fixture-" + n,
      uid,
      ts - 10 + n,
      ts - 9 + n,
      n < 2 ? 200 : 502,
      "network-safe-" + n,
      n < 2 ? 200 : 403,
      n < 2 ? null : "unsupported_country_region_territory",
      n < 2 ? "NRT" : "LAX",
      n < 2 ? "JP" : "HK",
    );
  await store.run(
    "INSERT INTO network_observations(id,lease,created,trigger,result) VALUES('network-observation','network-fixture-2',?,'provider_403',?)",
    Math.floor(ts),
    JSON.stringify({
      reference: {
        ip: "203.0.113.77",
        target: "api.ipify.org",
        status: "observed_reference",
      },
      controlled: {
        headers: { "cf-connecting-ip": "203.0.113.77", "cf-ipcountry": "HK" },
      },
    }),
  );
  assert.equal((await call("/admin/network-stats")).status, 401);
  const response = await call(
    "/admin/network-stats?hours=1&model=network-fixture",
    undefined,
    { access: admin },
  );
  assert.equal(response.status, 200);
  assert.equal(response.body.summary.requests, 4);
  assert.equal(
    response.body.groups.find((r) => r.country === "JP").success_rate,
    1,
  );
  assert.equal(
    response.body.groups.find((r) => r.country === "HK").region_error_rate,
    1,
  );
  assert.equal(
    (await call("/admin/network-stats?hours=999", undefined, { access: admin }))
      .status,
    422,
  );
  const packet = await call(
    "/admin/diagnostic-bundle?request_id=network-safe-2",
    undefined,
    { access: admin },
  );
  assert.equal(packet.status, 200);
  const text = JSON.stringify(packet.body);
  for (const value of ["203.0.113.77", "PRIVATE_USER_AGENT", "network-stats"])
    assert.ok(!text.includes(value));
  assert.equal(packet.body.request.release_sha, "test-release");
  assert.equal(
    packet.body.observation.result.controlled.ip_headers_present[
      "cf-connecting-ip"
    ],
    true,
  );
  const normal = await store.createUser(
    "network-normal",
    "password-for-normal",
    { must_change: 0 },
  );
  const login = await fixtureLogin(
    store,
    "network-normal",
    "password-for-normal",
    "network-normal-ip",
  );
  assert.equal(
    (
      await call("/admin/network-stats", undefined, {
        access: login.body.access_token,
      })
    ).status,
    403,
  );
  const privateRoute = await mf.dispatchFetch(
    "https://api.hilex.me/__diagnostics/network",
  );
  assert.equal(privateRoute.status, 404);
  const probe = await call("/admin/network-probe", {}, { access: admin });
  assert.equal(probe.status, 200);
  assert.equal(
    probe.body.result.controlled.status,
    "observed_metadata",
    JSON.stringify(probe.body),
  );
  assert.equal(
    (await call("/admin/network-probe", {}, { access: admin })).status,
    429,
  );
});

test("Alert deliveries are deduplicated, signed, retried and expose only safe status", async () => {
  const { enqueueAlerts, deliverNotifications, notificationStatus } =
    await import("../src/notifications.mjs");
  const store = new Store(db),
    ts = Date.now() / 1000;
  await store.run("DELETE FROM alert_deliveries");
  await store.run("UPDATE operational_alerts SET state='resolved'");
  await store.run(
    "INSERT OR REPLACE INTO operational_alerts(kind,first_seen,last_seen,state,details,episode) VALUES('delivery_fixture',?,?,'open',?,1)",
    ts,
    ts,
    JSON.stringify({ count: 3, private: "PRIVATE_SENTINEL" }),
  );
  const env = {
    ALERT_WEBHOOK_URL: "https://alerts.example.test/ingest?token=PRIVATE_URL",
    ALERT_WEBHOOK_SECRET: "test-webhook-signing-secret",
  };
  await enqueueAlerts(store, env);
  await enqueueAlerts(store, env);
  assert.equal(
    (
      await store.first(
        "SELECT count(*) n FROM alert_deliveries WHERE kind='delivery_fixture'",
      )
    ).n,
    1,
  );
  let attempts = 0,
    deliveryId;
  const transport = async (url, options) => {
    attempts++;
    assert.equal(options.headers["Content-Type"], "application/json");
    assert.equal(options.redirect, "manual");
    assert.ok(options.headers["X-Alert-Signature"]);
    const body = JSON.parse(options.body);
    assert.ok(!options.body.includes("PRIVATE_SENTINEL"));
    assert.equal(body.details.count, 3);
    if (!deliveryId) deliveryId = options.headers["Idempotency-Key"];
    else assert.equal(options.headers["Idempotency-Key"], deliveryId);
    if (attempts === 1) throw new DOMException("PRIVATE_URL", "TimeoutError");
    return new Response(null, { status: 204 });
  };
  await deliverNotifications(store, env, transport);
  assert.equal(
    (
      await store.first(
        "SELECT error_code FROM alert_deliveries WHERE id=?",
        deliveryId,
      )
    ).error_code,
    "timeout",
  );
  await store.run(
    "UPDATE alert_deliveries SET next_attempt=0 WHERE id=?",
    deliveryId,
  );
  await Promise.all([
    deliverNotifications(store, env, transport),
    deliverNotifications(store, env, transport),
  ]);
  assert.equal(attempts, 2);
  const status = await notificationStatus(store, env);
  assert.equal(status.deliveries[0].status, "sent");
  assert.ok(!JSON.stringify(status).includes("PRIVATE_URL"));
  assert.equal(status.destination_host, "alerts.example.test");
  assert.equal(
    (await call("/admin/notifications/test", {}, { access: admin })).status,
    200,
  );
});

test("An incident notifies once across retention, recovery and concurrent cron runs", async () => {
  const { enqueueAlerts } = await import("../src/notifications.mjs");
  const { operationalAlert } = await import("../src/operations.mjs");
  const store = new Store(db),
    kind = "once_fixture";
  await operationalAlert(store, kind, { count: 1 });
  await Promise.all([enqueueAlerts(store, {}), enqueueAlerts(store, {})]);
  assert.equal(
    (
      await store.first(
        "SELECT count(*) n FROM alert_deliveries WHERE kind=?",
        kind,
      )
    ).n,
    1,
  );
  // Old notifications can expire; the incident marker survives their deletion.
  await store.run("DELETE FROM alert_deliveries WHERE kind=?", kind);
  await operationalAlert(store, kind, { count: 3 });
  await enqueueAlerts(store, {});
  assert.equal(
    (
      await store.first(
        "SELECT count(*) n FROM alert_deliveries WHERE kind=?",
        kind,
      )
    ).n,
    0,
  );
  await store.run(
    "UPDATE operational_alerts SET state='resolved' WHERE kind=?",
    kind,
  );
  await enqueueAlerts(store, {});
  assert.equal(
    (
      await store.first(
        "SELECT count(*) n FROM alert_deliveries WHERE kind=?",
        kind,
      )
    ).n,
    0,
  );
  await operationalAlert(store, kind, { count: 1 });
  await enqueueAlerts(store, {});
  assert.equal(
    (
      await store.first(
        "SELECT count(*) n FROM alert_deliveries WHERE kind=? AND episode=2",
        kind,
      )
    ).n,
    1,
  );
  await store.run("DELETE FROM alert_deliveries WHERE kind=?", kind);
  await store.run("DELETE FROM operational_alerts WHERE kind=?", kind);
});

test("Permanent webhook failures stop retries and acknowledgement expires after one hour", async () => {
  const { deliverNotifications } = await import("../src/notifications.mjs"),
    { operationalAlert } = await import("../src/operations.mjs");
  const store = new Store(db),
    ts = Date.now() / 1000;
  await store.run(
    "INSERT INTO alert_deliveries(id,kind,episode,event_state,created,payload) VALUES('permanent-delivery','permanent_fixture',1,'open',?,'{}')",
    ts,
  );
  let calls = 0;
  const env = { ALERT_WEBHOOK_URL: "https://alerts.example.test/hook" };
  const transport = async () => {
    calls++;
    return new Response(null, { status: 401 });
  };
  await deliverNotifications(store, env, transport);
  await deliverNotifications(store, env, transport);
  assert.equal(calls, 1);
  const row = await store.first(
    "SELECT attempts,error_code FROM alert_deliveries WHERE id='permanent-delivery'",
  );
  assert.equal(row.attempts, 3);
  assert.equal(row.error_code, "http_401");
  await operationalAlert(store, "acknowledgement_fixture", { count: 1 });
  assert.equal(
    (
      await call(
        "/admin/alerts/acknowledge",
        { kind: "acknowledgement_fixture" },
        { access: admin },
      )
    ).status,
    200,
  );
  await operationalAlert(store, "acknowledgement_fixture", { count: 2 });
  assert.equal(
    (
      await store.first(
        "SELECT state FROM operational_alerts WHERE kind='acknowledgement_fixture'",
      )
    ).state,
    "acknowledged",
  );
  await store.run(
    "UPDATE operational_alerts SET acknowledged_at=? WHERE kind='acknowledgement_fixture'",
    ts - 7200,
  );
  await operationalAlert(store, "acknowledgement_fixture", { count: 3 });
  assert.equal(
    (
      await store.first(
        "SELECT state FROM operational_alerts WHERE kind='acknowledgement_fixture'",
      )
    ).state,
    "open",
  );
});

test("Project inbox is the default destination without self HTTP calls and read state is per administrator", async () => {
  const { deliverNotifications, notificationStatus } =
      await import("../src/notifications.mjs"),
    store = new Store(db),
    ts = Date.now() / 1000;
  const status = await notificationStatus(store, {});
  assert.equal(status.configured, true);
  assert.equal(status.external_configured, false);
  assert.equal(
    status.destination_url,
    "https://accounts.hilex.me/admin#alerts",
  );
  await store.run(
    "INSERT INTO alert_deliveries(id,kind,episode,event_state,created,payload) VALUES('site-message-fixture','test',0,'open',?,?)",
    ts,
    JSON.stringify({
      kind: "test",
      details: { count: 1 },
      dashboard: "https://accounts.hilex.me/admin#alerts",
    }),
  );
  let posts = 0;
  await deliverNotifications(store, {}, async () => {
    posts++;
    throw new Error("No HTTP for internal destination");
  });
  assert.equal(posts, 0);
  const delivered = await store.first(
    "SELECT status,channel FROM alert_deliveries WHERE id='site-message-fixture'",
  );
  assert.equal(delivered.status, "sent");
  assert.equal(delivered.channel, "in_app");
  assert.equal((await call("/admin/notifications")).status, 401);
  const before = await call("/admin/notifications?state=unread", undefined, {
    access: admin,
  });
  assert.ok(before.body.items.some((n) => n.id === "site-message-fixture"));
  assert.equal(
    (
      await call(
        "/admin/notifications/read",
        { ids: ["site-message-fixture"] },
        { access: admin },
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await call(
        "/admin/notifications/read",
        { ids: ["site-message-fixture"] },
        { access: admin },
      )
    ).status,
    200,
  );
  const after = await call("/admin/notifications?state=unread", undefined, {
    access: admin,
  });
  assert.equal(after.body.unread, before.body.unread - 1);
  const other = await store.createUser(
    "inbox-admin-two",
    "inbox-test-password",
    { role: "admin", must_change: 0 },
  );
  const access = (
    await fixtureLogin(
      store,
      "inbox-admin-two",
      "inbox-test-password",
      "inbox-admin-ip",
    )
  ).body.access_token;
  const theirs = await call("/admin/notifications?state=unread", undefined, {
    access,
  });
  assert.ok(theirs.body.items.some((n) => n.id === "site-message-fixture"));
  const normal = (
    await fixtureLogin(
      store,
      "network-normal",
      "password-for-normal",
      "inbox-normal-ip",
    )
  ).body.access_token;
  assert.equal(
    (await call("/admin/notifications", undefined, { access: normal })).status,
    403,
  );
  assert.equal(
    (await call("/admin/notifications/read", { ids: [] }, { access: admin }))
      .status,
    422,
  );
});

test("Customer notices isolate recipients, synchronize reads and enforce draft lifecycle", async () => {
  const store = new Store(db),
    password = "customer-notice-password";
  const a = await store.createUser("notice-reader-a", password, {
      must_change: 0,
    }),
    b = await store.createUser("notice-reader-b", password, { must_change: 0 });
  const access = (
      await fixtureLogin(store, a.display_name, password, "notice-a-ip")
    ).body.access_token,
    other = (await fixtureLogin(store, b.display_name, password, "notice-b-ip"))
      .body.access_token;
  const draft = {
    title: "服务公告 <script>",
    body: "纯文本\n新功能已上线",
    audience: "all",
    priority: "important",
  };
  const create = await call("/admin/notices", draft, { access: admin });
  assert.equal(create.status, 200);
  const id = create.body.id;
  assert.equal((await call("/account/notices")).status, 401);
  assert.equal((await call("/admin/notices", draft, { access })).status, 403);
  assert.equal(
    (await call("/account/notices", undefined, { access })).body.total,
    0,
  );
  const edit = await call(
    "/admin/notices/" + id,
    { ...draft, title: "已更新", version: 1 },
    { access: admin, method: "PATCH" },
  );
  assert.equal(edit.body.version, 2);
  assert.equal(
    (
      await call(
        "/admin/notices/" + id,
        { ...draft, version: 1 },
        { access: admin, method: "PATCH" },
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await call(
        "/admin/notices/" + id + "/publish",
        { version: 1 },
        { access: admin },
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await call(
        "/admin/notices/" + id + "/publish",
        { version: 2 },
        { access: admin },
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await call(
        "/admin/notices/" + id,
        { ...draft, version: 3 },
        { access: admin, method: "PATCH" },
      )
    ).status,
    409,
  );
  let listed = (await call("/account/notices", undefined, { access })).body;
  assert.equal(listed.unread, 1);
  assert.equal(listed.poll_after_seconds, 86400);
  assert.equal(
    (await call("/account/notices/unread-count", undefined, { access })).body
      .poll_after_seconds,
    86400,
  );
  assert.equal(listed.items[0].title, "已更新");
  assert.equal(listed.items[0].body, draft.body);
  assert.equal(listed.items[0].user_ids, undefined);
  for (let i = 0; i < 2; i++)
    assert.equal(
      (await call("/account/notices/read", { ids: [id] }, { access })).status,
      200,
    );
  assert.equal(
    (await call("/account/notices/unread-count", undefined, { access })).body
      .unread,
    0,
  );
  assert.equal(
    (await call("/account/notices?state=unread", undefined, { access })).body
      .items.length,
    0,
  );
  assert.equal(
    (await call("/account/notices/unread-count", undefined, { access: other }))
      .body.unread,
    1,
  );
  // New accounts also see still-active all-account notices.
  const c = await store.createUser("notice-late-reader", password, {
      must_change: 0,
    }),
    late = (
      await fixtureLogin(store, c.display_name, password, "notice-late-ip")
    ).body.access_token;
  assert.equal(
    (await call("/account/notices", undefined, { access: late })).body.total,
    1,
  );
  const target = (
    await call(
      "/admin/notices",
      { ...draft, audience: "users", user_ids: [a.id] },
      { access: admin },
    )
  ).body.id;
  await call(
    "/admin/notices/" + target + "/publish",
    { version: 1 },
    { access: admin },
  );
  assert.equal(
    (await call("/account/notices", undefined, { access })).body.total,
    2,
  );
  assert.equal(
    (await call("/account/notices", undefined, { access: other })).body.total,
    1,
  );
  assert.equal(
    (await call("/account/notices/read", { ids: [target] }, { access: other }))
      .status,
    404,
  );
  const future = (
    await call(
      "/admin/notices",
      { ...draft, starts_at: Date.now() / 1000 + 3600 },
      { access: admin },
    )
  ).body.id;
  await call(
    "/admin/notices/" + future + "/publish",
    { version: 1 },
    { access: admin },
  );
  assert.equal(
    (await call("/account/notices/read", { ids: [future] }, { access })).status,
    404,
  );
  const expires = (
    await call(
      "/admin/notices",
      {
        ...draft,
        starts_at: Date.now() / 1000 - 100,
        expires_at: Date.now() / 1000 + 10,
      },
      { access: admin },
    )
  ).body.id;
  await call(
    "/admin/notices/" + expires + "/publish",
    { version: 1 },
    { access: admin },
  );
  await store.run(
    "UPDATE customer_notices SET expires_at=? WHERE id=?",
    Date.now() / 1000 - 1,
    expires,
  );
  assert.equal(
    (await call("/account/notices", undefined, { access })).body.total,
    2,
  );
  assert.equal(
    (await call("/account/notices/read", { ids: [expires] }, { access }))
      .status,
    404,
  );
  assert.equal(
    (
      await call(
        "/admin/notices/" + id + "/withdraw",
        { version: 3 },
        { access: admin },
      )
    ).status,
    200,
  );
  assert.equal(
    (await call("/account/notices", undefined, { access: other })).body.total,
    0,
  );
  assert.equal(
    (await call("/account/notices/read", { ids: [id] }, { access })).status,
    404,
  );
  assert.equal(
    (
      await call(
        "/admin/notices/" + id + "/publish",
        { version: 4 },
        { access: admin },
      )
    ).status,
    409,
  );
  for (const bad of [
    { ...draft, user_ids: [a.id] },
    { ...draft, audience: "users", user_ids: [] },
    { ...draft, audience: "users", user_ids: [9999999] },
    { ...draft, priority: "critical" },
    { ...draft, starts_at: 10, expires_at: 9 },
    { ...draft, body: "x".repeat(8001) },
  ])
    assert.equal(
      (await call("/admin/notices", bad, { access: admin })).status,
      422,
    );
  assert.equal(
    (await call("/account/notices?page=0", undefined, { access })).status,
    422,
  );
  assert.equal(
    (await call("/account/notices/read", { ids: [] }, { access })).status,
    422,
  );
  const long = await call(
    "/admin/notices",
    { ...draft, body: "通知".repeat(4000) },
    { access: admin },
  );
  assert.equal(long.status, 200);
  assert.ok(
    (
      await store.first(
        "SELECT count(*) n FROM audit WHERE action='publish_notice'",
      )
    ).n >= 3,
  );
  // Paging does not lose records with identical publication timestamps.
  for (let i = 0; i < 32; i++)
    await store.run(
      "INSERT INTO customer_notices(id,title,body,state,starts_at,created,updated,published_at) VALUES(?,?,?,'published',0,0,0,1)",
      i.toString(16).padStart(48, "0"),
      "page " + i,
      "text",
    );
  const first = (await call("/account/notices", undefined, { access: other }))
      .body,
    second = (
      await call("/account/notices?page=2", undefined, { access: other })
    ).body;
  assert.equal(first.items.length, 30);
  assert.equal(second.items.length, 2);
  assert.equal(
    new Set([...first.items, ...second.items].map((n) => n.id)).size,
    32,
  );
});

test("Email verification enforces expiry, attempts, resend cooldown and atomic one-time account creation", async () => {
  const {
    requestRegistrationCode,
    verifyRegistrationCode,
    codeHash,
    registrationEmail,
  } = await import("../src/registration.mjs");
  const store = new Store(db),
    env = {
      EMAIL_VERIFICATION_ENABLED: "true",
      EMAIL_CODE_SECRET: "test-only-secret".repeat(4),
      REGISTRATION_SMTP: JSON.stringify({
        smtp_host: "smtp.qiye.aliyun.com",
        smtp_port: 465,
        smtp_secure: true,
        smtp_username: "sender@example.com",
        smtp_password: "fake",
        from_email: "sender@example.com",
      }),
    };
  let captured;
  const send = async (c, email, code) => {
    captured = { email, code };
  };
  const email = "verify-code@example.net";
  assert.equal(registrationEmail(" Verify-Code@Example.Net "), email);
  for (const e of [
    "bad\r\n@example.net",
    "a..b@example.net",
    "a@-bad.example",
    "a@b",
    "<a>@example.net",
  ])
    assert.throws(() => registrationEmail(e));
  const response = await requestRegistrationCode(
    store,
    env,
    email,
    "email-code-ip",
    send,
  );
  assert.equal(response.expires_in, 600);
  assert.match(captured.code, /^\d{6}$/);
  const emailHash = await digest(email),
    row = await store.first(
      "SELECT * FROM registration_codes WHERE email_hash=?",
      emailHash,
    );
  assert.equal(row.state, "sent");
  assert.notEqual(row.code_hash, captured.code);
  assert.equal(
    row.code_hash,
    await codeHash(env, emailHash, row.id, captured.code),
  );
  await assert.rejects(
    requestRegistrationCode(store, env, email, "another-ip", send),
    { status: 429 },
  );
  await assert.rejects(verifyRegistrationCode(store, env, email, "bad"), {
    status: 422,
  });
  await assert.rejects(
    verifyRegistrationCode(
      store,
      env,
      email,
      captured.code === "000000" ? "000001" : "000000",
    ),
    { status: 400 },
  );
  const proof = await verifyRegistrationCode(store, env, email, captured.code);
  const results = await Promise.allSettled([
    store.createUser(email, "verification-password", {
      email,
      emailVerification: proof,
      must_change: 0,
    }),
    store.createUser(email, "verification-password", {
      email,
      emailVerification: proof,
      must_change: 0,
    }),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.ok(
    (
      await store.first(
        "SELECT email_verified_at FROM users WHERE email=?",
        email,
      )
    ).email_verified_at,
  );
  assert.equal(
    (
      await store.first(
        "SELECT state FROM registration_codes WHERE email_hash=?",
        emailHash,
      )
    ).state,
    "consumed",
  );
  await assert.rejects(
    verifyRegistrationCode(store, env, email, captured.code),
    { status: 400 },
  );
  const locked = "verify-lock@example.net";
  await requestRegistrationCode(store, env, locked, "email-lock-ip", send);
  const correct = captured.code;
  for (let i = 0; i < 5; i++)
    await assert.rejects(
      verifyRegistrationCode(
        store,
        env,
        locked,
        correct === "000000" ? "000001" : "000000",
      ),
      { status: 400 },
    );
  await assert.rejects(verifyRegistrationCode(store, env, locked, correct), {
    status: 400,
  });
  const expired = "verify-expired@example.net";
  await requestRegistrationCode(store, env, expired, "email-expired-ip", send);
  await store.run(
    "UPDATE registration_codes SET expires=0 WHERE email_hash=?",
    await digest(expired),
  );
  await assert.rejects(
    verifyRegistrationCode(store, env, expired, captured.code),
    { status: 400 },
  );
  await assert.rejects(
    requestRegistrationCode(
      store,
      env,
      "verify-sendfail@example.net",
      "email-fail-ip",
      async () => {
        throw new Error("private SMTP reply");
      },
    ),
    { status: 503 },
  );
  assert.equal(
    (
      await store.first(
        "SELECT state FROM registration_codes WHERE email_hash=?",
        await digest("verify-sendfail@example.net"),
      )
    ).state,
    "failed",
  );
  const previous = captured.code;
  await store.run(
    "UPDATE email_send_attempts SET ts=ts-61 WHERE email_hash=?",
    await digest(locked),
  );
  await requestRegistrationCode(store, env, locked, "email-lock-ip", send);
  assert.equal(
    (
      await store.first(
        "SELECT attempts FROM registration_codes WHERE email_hash=?",
        await digest(locked),
      )
    ).attempts,
    0,
  );
  const fresh = await verifyRegistrationCode(store, env, locked, captured.code);
  assert.ok(fresh.id);
  // A newer challenge prevents using an earlier verified proof after password hashing.
  await store.run(
    "UPDATE registration_codes SET id=? WHERE email_hash=?",
    "f".repeat(48),
    await digest(locked),
  );
  await assert.rejects(
    store.createUser(locked, "verification-password", {
      email: locked,
      emailVerification: fresh,
    }),
    { status: 400 },
  );
  const before = (
    await store.first("SELECT count(*) n FROM email_send_attempts")
  ).n;
  await assert.rejects(
    requestRegistrationCode(
      store,
      { ...env, REGISTRATION_SMTP: "" },
      "unavailable@example.net",
      "config-ip",
      send,
    ),
    { status: 503 },
  );
  assert.equal(
    (await store.first("SELECT count(*) n FROM email_send_attempts")).n,
    before,
  );
  // Existing accounts receive the same response but no new email.
  let sent = 0;
  await store.run(
    "UPDATE email_send_attempts SET ts=ts-61 WHERE email_hash=?",
    await digest("person@example.com"),
  );
  const known = await requestRegistrationCode(
    store,
    env,
    "person@example.com",
    "known-mail-ip",
    async () => {
      sent++;
    },
  );
  assert.equal(sent, 0);
  assert.deepEqual(known, response);
});

test("Legacy logins remind email binding; verified accounts skip reminders and binding proofs cannot cross users or purposes", async () => {
  const { requestRegistrationCode, verifyRegistrationCode, codeHash } =
    await import("../src/registration.mjs");
  const store = new Store(db),
    password = "binding-test-password",
    email = "legacy-bind@example.net";
  const a = await store.createUser(email, password, { email, must_change: 0 }),
    b = await store.createUser("binding-other-user", password, {
      must_change: 0,
    });
  const login = await call("/auth/login", {
    display_name: a.display_name,
    password,
  });
  assert.equal(login.body.user.email_binding_required, true);
  assert.equal(login.body.user.email, email);
  const access = login.body.access_token,
    other = (
      await fixtureLogin(store, b.display_name, password, "binding-other-ip")
    ).body.access_token;
  assert.equal(
    (await call("/account/me", undefined, { access })).body.user
      .email_binding_required,
    true,
  );
  assert.equal((await call("/account/email/code", { email })).status, 401);
  assert.equal(
    (await call("/account/email/bind", { email, code: "123456" })).status,
    401,
  );
  const cookie = login.headers.get("set-cookie").split(";")[0];
  assert.equal(
    (await call("/account/email/code", { email }, { cookie })).status,
    403,
  );
  assert.equal(
    (await call("/account/email/code", { email, role: "admin" }, { access }))
      .status,
    422,
  );
  const oldPolicy = (
    await store.first(
      "SELECT value FROM settings WHERE name='registration_policy'",
    )
  ).value;
  await store.run(
    "UPDATE settings SET value=? WHERE name='registration_policy'",
    JSON.stringify({
      ...JSON.parse(oldPolicy),
      global_minute: 1000,
      global_hourly: 1000,
      ip_hourly: 100,
      enabled: false,
    }),
  );
  try {
    let code;
    await requestRegistrationCode(
      store,
      registrationEnv,
      email,
      "binding-send-ip",
      async (_c, _e, value) => {
        code = value;
      },
      a,
    );
    const record = await store.first(
      "SELECT * FROM account_email_codes WHERE user_id=?",
      a.id,
    );
    assert.equal(record.state, "sent");
    assert.equal(
      record.code_hash,
      await codeHash(
        registrationEnv,
        "bind:" + a.id + ":" + (await digest(email)),
        record.id,
        code,
      ),
    );
    await assert.rejects(
      verifyRegistrationCode(store, registrationEnv, email, code, b),
      { status: 400 },
    );
    assert.equal(
      (await call("/account/email/bind", { email, code }, { access: other }))
        .status,
      409,
    );
    assert.equal(
      (await call("/auth/register", { email, password, code })).status,
      400,
    );
    const wrong = code === "000000" ? "000001" : "000000";
    assert.equal(
      (await call("/account/email/bind", { email, code: wrong }, { access }))
        .status,
      400,
    );
    const result = await call(
      "/account/email/bind",
      { email, code },
      { access },
    );
    assert.equal(result.status, 200);
    assert.equal(result.body.user.email_binding_required, false);
    assert.ok(result.body.user.email_verified_at);
    assert.equal(result.body.user.display_name, a.display_name);
    assert.equal(
      (
        await store.first(
          "SELECT state FROM account_email_codes WHERE user_id=?",
          a.id,
        )
      ).state,
      "consumed",
    );
    assert.equal(
      (await call("/account/me", undefined, { access })).body.user
        .email_binding_required,
      false,
    );
    assert.equal(
      (await call("/account/email/bind", { email, code }, { access })).status,
      409,
    );
    assert.equal(
      (await call("/account/email/code", { email }, { access })).status,
      409,
    );
    const again = await fixtureLogin(
      store,
      a.display_name,
      password,
      "binding-login-again",
    );
    assert.equal(again.body.user.email_binding_required, false);
    assert.equal(
      (await call("/account/email/code", { email }, { access: other })).status,
      409,
    );
    assert.equal(
      (await call("/account/email/bind", { email, code }, { access: other }))
        .status,
      409,
    );
    assert.ok(
      await store.first(
        "SELECT id FROM audit WHERE actor=? AND action='bind_email' AND target=?",
        a.id,
        String(a.id),
      ),
    );
    // A registration challenge never authorizes binding, even with the same email/code.
    const target = "binding-new@example.net",
      id = "b".repeat(48),
      emailHash = await digest(target),
      registrationCode = "654321",
      hash = await codeHash(registrationEnv, emailHash, id, registrationCode),
      ts = Date.now() / 1000;
    await store.run(
      "INSERT INTO registration_codes(email_hash,id,code_hash,created,expires,state) VALUES(?,?,?,?,?,'sent')",
      emailHash,
      id,
      hash,
      ts,
      ts + 600,
    );
    assert.equal(
      (
        await call(
          "/account/email/bind",
          { email: target, code: registrationCode },
          { access: other },
        )
      ).status,
      400,
    );
    const mandatory = await store.createUser("binding-must-change", password, {
      must_change: 1,
    });
    const mandatoryToken = (
      await fixtureLogin(
        store,
        mandatory.display_name,
        password,
        "binding-must-ip",
      )
    ).body.access_token;
    assert.equal(
      (
        await call(
          "/account/email/code",
          { email: "mandatory@example.net" },
          { access: mandatoryToken },
        )
      ).status,
      403,
    );
    // Independent valid challenges for one target may race, but only one account wins.
    const c = await store.createUser("binding-race-user", password, {
        must_change: 0,
      }),
      cToken = (
        await fixtureLogin(store, c.display_name, password, "binding-race-ip")
      ).body.access_token,
      raceEmail = "binding-race@example.net",
      raceHash = await digest(raceEmail);
    for (const u of [b, c]) {
      const challenge = "c".repeat(44) + String(u.id).padStart(4, "0");
      const proofHash = await codeHash(
        registrationEnv,
        "bind:" + u.id + ":" + raceHash,
        challenge,
        "123456",
      );
      await store.run(
        "INSERT INTO account_email_codes(user_id,email_hash,id,code_hash,created,expires,state) VALUES(?,?,?,?,?,?,'sent')",
        u.id,
        raceHash,
        challenge,
        proofHash,
        ts,
        ts + 600,
      );
    }
    const raced = await Promise.all([
      call(
        "/account/email/bind",
        { email: raceEmail, code: "123456" },
        { access: other },
      ),
      call(
        "/account/email/bind",
        { email: raceEmail, code: "123456" },
        { access: cToken },
      ),
    ]);
    assert.equal(raced.filter((r) => r.status === 200).length, 1);
    assert.equal(raced.filter((r) => r.status === 409).length, 1);
    assert.equal(
      (
        await store.first(
          "SELECT count(*) n FROM users WHERE lower(email)=? AND email_verified_at IS NOT NULL",
          raceEmail,
        )
      ).n,
      1,
    );
  } finally {
    await store.run(
      "UPDATE settings SET value=? WHERE name='registration_policy'",
      oldPolicy,
    );
  }
  // The existing account fixture was email-verified at registration, regardless of later password/session tests.
  assert.equal(
    (
      await store.first(
        "SELECT email_verified_at IS NOT NULL verified FROM users WHERE email=?",
        "person@example.com",
      )
    ).verified,
    1,
  );
});

test("Anonymous account checks reject without touching D1", async () => {
  const anonymous = new Miniflare({
    modules: true,
    scriptPath: ".test-build/worker.js",
    compatibilityDate: "2026-07-01",
    bindings: {
      ACCOUNT_ORIGIN: "https://accounts.test",
      RELEASE_SHA: "a".repeat(40),
    },
    serviceBindings: {
      ASSETS: async () =>
        new Response('<script src="/static/app.js"></script>'),
    },
  });
  try {
    const root = await anonymous.dispatchFetch("https://accounts.test/");
    assert.equal(root.headers.get("Cache-Control"), "no-store");
    assert.match(await root.text(), /static\/app\.js/);
    const asset = await anonymous.dispatchFetch(
      "https://accounts.test/static/app.js?v=" + "a".repeat(40),
    );
    assert.equal(asset.headers.get("Cache-Control"), "no-store");
    const stale = await anonymous.dispatchFetch(
      "https://accounts.test/static/app.js?v=old",
    );
    assert.equal(stale.headers.get("Cache-Control"), "no-store");
    // Deliberately omit DB: a database access would turn these into 503 responses.
    for (const path of [
      "/account/me",
      "/account/notices/unread-count",
      "/admin/notifications",
    ]) {
      const response = await anonymous.dispatchFetch(
        "https://accounts.test" + path,
      );
      assert.equal(response.status, 401);
    }
  } finally {
    await anonymous.dispose();
  }
});

test("Cloud catalog is read-only and immediately reflects key revocation and permission changes", async () => {
  const { uid, key } = await lunaUser("read-only-catalog");
  const store = new Store(db);
  await store.run(
    'UPDATE users SET services=\'["qwen","asr","tts"]\',daily_requests=1 WHERE id=?',
    uid,
  );
  await store.run(
    'UPDATE keys SET services=\'["qwen","asr","tts"]\' WHERE user_id=?',
    uid,
  );
  for (let i = 0; i < 3; i++)
    assert.equal(
      (await apiCall("/v1/models?output_modalities=all", key)).status,
      200,
    );
  assert.equal(
    (await store.first("SELECT count(*) n FROM requests WHERE user_id=?", uid))
      .n,
    0,
  );
  await store.run("UPDATE keys SET services='[\"asr\"]' WHERE user_id=?", uid);
  const restricted = await apiCall("/v1/models?output_modalities=all", key);
  assert.deepEqual(
    restricted.body.data.map((m) => m.id),
    ["gpt-transcribe", "funasr"],
  );
  await store.run("UPDATE users SET enabled=0 WHERE id=?", uid);
  assert.equal((await apiCall("/v1/models", key)).status, 403);
  await store.run("UPDATE users SET enabled=1 WHERE id=?", uid);
  await store.run("UPDATE keys SET revoked=1 WHERE user_id=?", uid);
  assert.equal((await apiCall("/v1/models", key)).status, 401);
  assert.equal(
    (await store.first("SELECT count(*) n FROM requests WHERE user_id=?", uid))
      .n,
    0,
  );
});

test("Global spend summary tables remain equal to ledger detail after quota, adjustment and cleanup tests", async () => {
  const store = new Store(db);
  const luna = await store.all(
    "SELECT month,sum(cost_nanos) cost,sum(CASE WHEN settled=0 THEN cost_nanos ELSE 0 END) reserved FROM luna_spend GROUP BY month",
  );
  for (const row of luna)
    assert.deepEqual(
      await store.first(
        "SELECT cost_nanos cost,reserved_cost_nanos reserved FROM luna_spend_totals WHERE month=?",
        row.month,
      ),
      { cost: row.cost, reserved: row.reserved },
    );
  const audio = await store.all(
    "SELECT day,kind,sum(units) used,sum(CASE WHEN settled=0 THEN units ELSE 0 END) reserved FROM audio_spend GROUP BY day,kind",
  );
  for (const row of audio)
    assert.deepEqual(
      await store.first(
        "SELECT units used,reserved_units reserved FROM audio_spend_totals WHERE day=? AND kind=?",
        row.day,
        row.kind,
      ),
      { used: row.used, reserved: row.reserved },
    );
});

test("Request completion is one atomic update and duplicate finish cannot rewrite metadata or counters", async () => {
  const store = new Store(db),
    { uid, key } = await lunaUser("atomic-request-finish");
  const lease = await store.acquire(key, "qwen", "/v1/chat/completions", {
    client_ip: "203.0.113.8",
    client_version: "fixture/1",
    device_id: "fixture-device",
  });
  assert.equal(
    (await store.first("SELECT client_version FROM requests WHERE id=?", lease))
      .client_version,
    "fixture/1",
  );
  const original = store.run.bind(store);
  let updates = 0;
  store.run = (q, ...args) => {
    if (q.startsWith("UPDATE requests")) updates++;
    return original(q, ...args);
  };
  await store.finish({
    lease,
    status: 200,
    size: 12,
    prompt_tokens: 7,
    completion_tokens: 3,
    trace: {
      model: "gpt-6-luna",
      provider: "openai",
      request_id: "atomic-finish-fixture",
      duration_ms: 10,
    },
  });
  assert.equal(updates, 1);
  await store.finish({
    lease,
    status: 500,
    prompt_tokens: 99,
    trace: { model: "wrong" },
  });
  const r = await store.first(
    "SELECT status,model,prompt_tokens,response_bytes FROM requests WHERE id=?",
    lease,
  );
  assert.deepEqual(r, {
    status: 200,
    model: "gpt-6-luna",
    prompt_tokens: 7,
    response_bytes: 12,
  });
});

test("Operational console alerts omit unchanged open episodes and log a resolved episode reopening", async () => {
  const { operationalAlert } = await import("../src/operations.mjs");
  const store = new Store(db),
    kind = "worker-log-episode-fixture",
    ts = Date.now() / 1000;
  await store.run(
    "INSERT INTO operational_alerts(kind,first_seen,last_seen,occurrences,details) VALUES(?,?,?,3,'{}')",
    kind,
    ts - 60,
    ts - 30,
  );
  const old = console.warn,
    logs = [];
  console.warn = (...parts) => logs.push(parts.join(" "));
  try {
    await operationalAlert(store, kind, { count: 2 });
    assert.equal(logs.length, 0);
    await store.run(
      "UPDATE operational_alerts SET state='resolved' WHERE kind=?",
      kind,
    );
    await operationalAlert(store, kind, { count: 3 });
    assert.equal(logs.length, 1);
    const event = JSON.parse(logs[0]);
    assert.equal(event.event, "operational_alert");
    assert.equal(event.episode, 2);
  } finally {
    console.warn = old;
  }
});

test("Vision works through both edge endpoints and settles actual usage", async () => {
  const { uid, key } = await lunaUser("edge-vision");
  const catalog = await apiCall("/v1/models", key);
  assert.deepEqual(catalog.body.data[0].architecture.input_modalities, [
    "text",
    "image",
  ]);
  for (const responses of [false, true]) {
    const image = responses
      ? {
          type: "input_image",
          image_url: "https://example.com/image.png",
          detail: "high",
        }
      : {
          type: "image_url",
          image_url: { url: "data:image/png;base64,AAAA", detail: "high" },
        };
    const input = [{ role: "user", content: [image] }];
    const r = await apiCall(
      responses ? "/v1/responses" : "/v1/chat/completions",
      key,
      {
        model: "gpt-6-luna",
        [responses ? "input" : "messages"]: input,
      },
    );
    assert.equal(r.status, 200);
    assert.deepEqual(
      lastProviderPayload[responses ? "input" : "messages"],
      input,
    );
  }
  const usage = await db
    .prepare(
      "SELECT reserved_tokens,charged_tokens,settled FROM luna_usage WHERE user_id=?",
    )
    .bind(uid)
    .all();
  assert.equal(usage.results.length, 2);
  for (const row of usage.results) {
    assert.ok(row.reserved_tokens > 100000);
    assert.equal(row.charged_tokens, 120);
    assert.equal(row.settled, 1);
  }
});

test("Audio 429 distinguishes shared account concurrency from daily quota and releases completed leases", async () => {
  const { uid, key } = await audioUser("audio-chat-concurrency", "tts");
  await db.prepare("UPDATE users SET concurrency=2 WHERE id=?").bind(uid).run();
  const leases = [await lunaLease(key), await lunaLease(key)];
  const before = providerCalls;
  const denied = await apiCall("/v1/audio/speech", key, {
    model: "gpt-realtime-2.1-mini",
    input: "hello",
  });
  assert.equal(denied.status, 429);
  assert.equal(denied.body.error.code, "account_concurrency_limited");
  assert.match(denied.body.error.message, /并发/);
  assert.equal(
    denied.headers.get("X-Error-Code"),
    "account_concurrency_limited",
  );
  assert.equal(denied.headers.get("Retry-After"), "1");
  assert.ok(denied.headers.get("X-Request-ID"));
  assert.equal(providerCalls, before);
  // Model discovery must remain usable even while the two inference slots are held.
  assert.equal((await apiCall("/v1/models", key)).status, 200);
  const store = new Store(db);
  await store.finish({ lease: leases[0], status: 200, size: 0 });
  const next = await audioLease(key, "tts");
  await store.finish({ lease: next, status: 499, size: 0 });
  await store.finish({ lease: leases[1], status: 200, size: 0 });
});

test("Cancelling a dialogue releases concurrency even when upstream cancellation stalls", async () => {
  const { uid, key } = await lunaUser("chat-cancel-lease");
  await db.prepare("UPDATE users SET concurrency=1 WHERE id=?").bind(uid).run();
  const original = globalThis.fetch,
    jobs = [];
  let upstreamCancelled = false,
    unblock;
  const blocked = new Promise((resolve) => {
    unblock = resolve;
  });
  globalThis.fetch = async () =>
    new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(
            new TextEncoder().encode(
              'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n',
            ),
          );
        },
        cancel() {
          upstreamCancelled = true;
          return blocked;
        },
      }),
      { headers: { "Content-Type": "text/event-stream" } },
    );
  try {
    const r = await edgeAPI(
      new Request("https://api.hilex.me/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + key,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-6-luna",
          messages: [{ role: "user", content: "hi" }],
          stream: true,
        }),
      }),
      { DB: db, OPENAI_API_KEY: "test", INTERNAL_SECRET: secret },
      {
        waitUntil(p) {
          jobs.push(p);
        },
      },
    );
    assert.equal(r.status, 200);
    const reader = r.body.getReader();
    await reader.read();
    const cancelled = reader.cancel();
    // The cancellation promise remains pending, but the lease must already finish.
    for (let i = 0; i < 30; i++) {
      const row = await db
        .prepare("SELECT ended,status FROM requests WHERE user_id=?")
        .bind(uid)
        .first();
      if (row.ended !== null) {
        assert.equal(row.status, 499);
        break;
      }
      if (i === 29) assert.fail("cancelled request still holds its slot");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(upstreamCancelled, true);
    const next = await lunaLease(key);
    await new Store(db).finish({ lease: next, status: 200, size: 0 });
    unblock();
    await cancelled;
    await Promise.all(jobs);
    const usage = await db
      .prepare("SELECT settled FROM luna_usage WHERE user_id=?")
      .bind(uid)
      .first();
    assert.equal(usage.settled, 0); // Unknown spend is not refunded when freeing a slot.
  } finally {
    unblock();
    globalThis.fetch = original;
  }
});

test("Completed JSON and SSE release slots before the client drains the response", async () => {
  for (const mode of ["json", "chat", "responses"]) {
    const { uid, key } = await lunaUser("backpressure-" + mode);
    await db
      .prepare("UPDATE users SET concurrency=1 WHERE id=?")
      .bind(uid)
      .run();
    const original = globalThis.fetch,
      jobs = [];
    globalThis.fetch = async (url, options) =>
      provider(new Request(url, { ...options, duplex: "half" }));
    try {
      const responses = mode === "responses";
      const r = await edgeAPI(
        new Request(
          "https://api.hilex.me/v1/" +
            (responses ? "responses" : "chat/completions"),
          {
            method: "POST",
            headers: {
              Authorization: "Bearer " + key,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model: "gpt-6-luna",
              stream: mode !== "json",
              ...(responses
                ? { input: "hi" }
                : { messages: [{ role: "user", content: "hi" }] }),
            }),
          },
        ),
        { DB: db, OPENAI_API_KEY: "test-openai-key", INTERNAL_SECRET: secret },
        {
          waitUntil(p) {
            jobs.push(p);
          },
        },
      );
      assert.equal(r.status, 200);
      // Deliberately do not drain this body. Its single queued chunk is complete.
      for (let i = 0; i < 30; i++) {
        const row = await db
          .prepare(
            "SELECT ended,status,prompt_tokens FROM requests WHERE user_id=?",
          )
          .bind(uid)
          .first();
        if (row.ended !== null) {
          assert.equal(row.status, 200);
          assert.equal(row.prompt_tokens, 100);
          break;
        }
        if (i === 29) assert.fail("completed response still holds concurrency");
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const next = await lunaLease(key);
      await new Store(db).finish({ lease: next, status: 200, size: 0 });
      await r.arrayBuffer();
      await Promise.all(jobs);
    } finally {
      globalThis.fetch = original;
    }
  }
});

test("Email password reset revokes all sessions, preserves keys by default and consumes its code atomically", async () => {
  const { requestPasswordReset, resetPassword } =
    await import("../src/password-reset.mjs");
  const store = new Store(db),
    env = { ...registrationEnv },
    jobs = [],
    deliveries = [];
  const ctx = {
    waitUntil(p) {
      jobs.push(p);
    },
  };
  const send = async (config, email, code, purpose) => {
    deliveries.push({ email, code, purpose });
  };
  const email = "reset-owner@example.net";
  const user = await store.createUser("reset-original-login", "before1", {
    email,
    must_change: 0,
    rpm: 0,
    daily_requests: 0,
    concurrency: 4,
  });
  await store.run(
    "UPDATE users SET email_verified_at=unixepoch() WHERE id=?",
    user.id,
  );
  const key = await store.createKey(user.id, user.id, {
    name: "keep",
    days: 1,
    services: ["qwen"],
  });
  const sessions = [
    await fixtureLogin(store, user.display_name, "before1", "reset-ip-1"),
    await fixtureLogin(store, user.display_name, "before1", "reset-ip-2"),
  ];
  const response = await requestPasswordReset(
    store,
    env,
    " RESET-OWNER@EXAMPLE.NET ",
    "reset-send-ip",
    send,
    ctx,
  );
  assert.equal(response.expires_in, 600);
  await Promise.all(jobs);
  assert.equal(deliveries[0].purpose, "password-reset");
  const code = deliveries[0].code;
  const proof = await store.first(
    "SELECT * FROM password_reset_codes WHERE user_id=?",
    user.id,
  );
  assert.notEqual(proof.code_hash, code);
  assert.equal(proof.state, "sent");
  await assert.rejects(
    resetPassword(
      store,
      env,
      { email, code, new_password: "short" },
      send,
      ctx,
    ),
    { status: 422 },
  );
  await assert.rejects(
    resetPassword(
      store,
      env,
      { email, code, new_password: "after12", revoke_api_keys: "false" },
      send,
      ctx,
    ),
    { status: 422 },
  );
  const changed = await resetPassword(
    store,
    env,
    { email, code, new_password: "after1" },
    send,
    ctx,
  );
  assert.equal(changed.api_keys_revoked, false);
  await Promise.all(jobs);
  for (const old of sessions) {
    await assert.rejects(store.session(old.cookie), { status: 401 });
    await assert.rejects(store.access(old.body.access_token), { status: 401 });
    await assert.rejects(store.refresh(old.body.refresh_token), {
      status: 401,
    });
  }
  await assert.rejects(
    fixtureLogin(store, user.display_name, "before1", "reset-new-ip"),
    {
      status: 401,
    },
  );
  assert.equal(
    (await fixtureLogin(store, user.display_name, "after1", "reset-new-ip"))
      .body.user.id,
    user.id,
  );
  const lease = await store.acquire(key.key, "qwen", "/v1/chat/completions");
  await store.finish({ lease, status: 200, size: 0 });
  assert.equal(
    (
      await store.first(
        "SELECT state,code_hash FROM password_reset_codes WHERE user_id=?",
        user.id,
      )
    ).code_hash,
    "",
  );
  await assert.rejects(
    resetPassword(
      store,
      env,
      { email, code, new_password: "other1", revoke_api_keys: true },
      send,
      ctx,
    ),
    { status: 400 },
  );
  assert.equal(
    (
      await store.first(
        "SELECT count(*) n FROM audit WHERE action='self_reset_password' AND target=?",
        String(user.id),
      )
    ).n,
    1,
  );
  assert.ok(
    deliveries.some(
      (d) => d.purpose === "password-changed" && d.code === "keys-retained",
    ),
  );
});

test("Password reset sending hides account existence, isolates code purpose, limits attempts and supports key revocation", async () => {
  const { requestPasswordReset, resetPassword } =
    await import("../src/password-reset.mjs");
  const { requestRegistrationCode } = await import("../src/registration.mjs");
  const store = new Store(db),
    env = { ...registrationEnv },
    jobs = [],
    deliveries = [],
    ctx = {
      waitUntil(p) {
        jobs.push(p);
      },
    };
  const send = async (config, email, code, purpose) => {
    deliveries.push({ email, code, purpose });
  };
  const owner = await store.createUser("reset-revoke", "before1", {
    email: "reset-revoke@example.net",
    must_change: 0,
  });
  await store.run(
    "UPDATE users SET email_verified_at=unixepoch() WHERE id=?",
    owner.id,
  );
  const unverified = await store.createUser("reset-unverified", "before1", {
    email: "reset-unverified@example.net",
    must_change: 0,
  });
  const disabled = await store.createUser("reset-disabled", "before1", {
    email: "reset-disabled@example.net",
    must_change: 0,
  });
  await store.run(
    "UPDATE users SET email_verified_at=unixepoch(),enabled=0 WHERE id=?",
    disabled.id,
  );
  const key = await store.createKey(owner.id, owner.id, {
    name: "revoke",
    days: 1,
    services: ["qwen"],
  });
  let response;
  for (const email of [
    owner.email,
    unverified.email,
    disabled.email,
    "reset-unknown@example.net",
  ]) {
    const r = await requestPasswordReset(
      store,
      env,
      email,
      "reset-enum-" + email,
      send,
      ctx,
    );
    if (response) assert.deepEqual(r, response);
    response = r;
  }
  await Promise.all(jobs);
  assert.equal(deliveries.length, 1);
  await assert.rejects(
    requestPasswordReset(store, env, owner.email, "reset-other-ip", send, ctx),
    { status: 429 },
  );
  const code = deliveries[0].code;
  for (let i = 0; i < 5; i++)
    await assert.rejects(
      resetPassword(
        store,
        env,
        {
          email: owner.email,
          code: code === "000000" ? "000001" : "000000",
          new_password: "after1",
        },
        send,
        ctx,
      ),
      { status: 400 },
    );
  await assert.rejects(
    resetPassword(
      store,
      env,
      { email: owner.email, code, new_password: "after1" },
      send,
      ctx,
    ),
    { status: 400 },
  );
  // Age the send reservation for a deliberate second challenge in this test.
  await store.run(
    "DELETE FROM email_send_attempts WHERE email_hash=?",
    await digest(owner.email),
  );
  await requestPasswordReset(
    store,
    env,
    owner.email,
    "reset-new-send",
    send,
    ctx,
  );
  await Promise.all(jobs);
  const next = deliveries.at(-1).code;
  const done = await resetPassword(
    store,
    env,
    {
      email: owner.email,
      code: next,
      new_password: "after1",
      revoke_api_keys: true,
    },
    send,
    ctx,
  );
  assert.equal(done.api_keys_revoked, true);
  await Promise.all(jobs);
  await assert.rejects(store.acquire(key.key, "qwen", "/v1/chat/completions"), {
    status: 401,
  });
  assert.ok(
    deliveries.some(
      (d) => d.purpose === "password-changed" && d.code === "keys-revoked",
    ),
  );
  // A binding/registration code does not authorize password reset.
  let registration;
  await requestRegistrationCode(
    store,
    env,
    "reset-isolation@example.net",
    "reset-register-ip",
    async (c, e, code) => {
      registration = code;
    },
  );
  await assert.rejects(
    resetPassword(
      store,
      env,
      {
        email: "reset-isolation@example.net",
        code: registration,
        new_password: "after1",
      },
      send,
      ctx,
    ),
    { status: 400 },
  );
});

test("Password reset expiry, SMTP failure, stale-password challenge and concurrent replay are safe", async () => {
  const { requestPasswordReset, resetPassword } =
    await import("../src/password-reset.mjs");
  const store = new Store(db),
    env = { ...registrationEnv },
    jobs = [],
    ctx = {
      waitUntil(p) {
        jobs.push(p);
      },
    };
  const owner = await store.createUser("reset-races", "before1", {
    email: "reset-races@example.net",
    must_change: 0,
  });
  await store.run(
    "UPDATE users SET email_verified_at=unixepoch() WHERE id=?",
    owner.id,
  );
  let code;
  async function issue(
    send = async (c, e, value) => {
      code = value;
    },
  ) {
    await store.run(
      "DELETE FROM email_send_attempts WHERE email_hash=?",
      await digest(owner.email),
    );
    await requestPasswordReset(
      store,
      env,
      owner.email,
      "reset-race-send",
      send,
      ctx,
    );
    await Promise.all(jobs);
  }
  const reset = (p = {}) =>
    resetPassword(
      store,
      env,
      { email: owner.email, code, new_password: "after1", ...p },
      async () => {},
      ctx,
    );
  await issue();
  await store.run(
    "UPDATE password_reset_codes SET expires=unixepoch()-1 WHERE user_id=?",
    owner.id,
  );
  await assert.rejects(reset(), { status: 400 });
  await issue(async () => {
    throw new Error("private SMTP details");
  });
  assert.equal(
    (
      await store.first(
        "SELECT state FROM password_reset_codes WHERE user_id=?",
        owner.id,
      )
    ).state,
    "failed",
  );
  await assert.rejects(reset(), { status: 400 });
  await issue();
  await store.changePassword(owner.id, "before1", "before2");
  await assert.rejects(reset(), { status: 400 });
  await issue();
  const r = await Promise.allSettled([
    reset({ new_password: "after1" }),
    reset({ new_password: "after2" }),
  ]);
  assert.equal(r.filter((x) => x.status === "fulfilled").length, 1);
  assert.equal(
    (
      await store.first(
        "SELECT count(*) n FROM audit WHERE action='self_reset_password' AND target=?",
        String(owner.id),
      )
    ).n,
    1,
  );
  await Promise.all(jobs);
});

test("Public password-reset endpoints validate input, origin and never accept registration codes", async () => {
  assert.equal(
    (await call("/auth/password-reset/code", { email: "bad" })).status,
    422,
  );
  assert.equal(
    (
      await call("/auth/password-reset/code", {
        email: "reset-endpoint@example.net",
        extra: 1,
      })
    ).status,
    422,
  );
  const requested = await call("/auth/password-reset/code", {
    email: "reset-endpoint@example.net",
  });
  assert.equal(requested.status, 200);
  assert.equal(requested.body.expires_in, 600);
  const failed = await call("/auth/password-reset", {
    email: "reset-endpoint@example.net",
    code: "000000",
    new_password: "after1",
  });
  assert.equal(failed.status, 400);
  assert.equal(failed.body.error_code, "password_reset_invalid");
  const denied = await mf.dispatchFetch(
    "https://accounts.test/auth/password-reset/code",
    {
      method: "POST",
      headers: {
        Origin: "https://evil.example",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email: "reset-origin@example.net" }),
    },
  );
  assert.equal(denied.status, 403);
});

test("Turnstile validation binds hostname/action and atomically rejects replay before sending mail", async () => {
  const { verifyCaptcha, captchaInfo } = await import("../src/captcha.mjs");
  const store = new Store(db),
    env = {
      CAPTCHA_ENABLED: "true",
      ACCOUNT_ORIGIN: "https://accounts.test",
      TURNSTILE_SITE_KEY: "public-test-site",
      TURNSTILE_SECRET_KEY: "private-test-secret",
    };
  assert.equal(captchaInfo(env).site_key, "public-test-site");
  assert.equal(captchaInfo(env).secret, undefined);
  const request = new Request(
    "https://accounts.test/auth/password-reset/code",
    { headers: { "CF-Connecting-IP": "192.0.2.82" } },
  );
  let calls = 0;
  const verify = async (url, options) => {
    calls++;
    assert.equal(
      url,
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
    );
    const b = JSON.parse(options.body);
    assert.equal(b.secret, env.TURNSTILE_SECRET_KEY);
    assert.equal(b.remoteip, "192.0.2.82");
    return Response.json({
      success: true,
      hostname: "accounts.test",
      action: "password_reset_code",
    });
  };
  for (const token of [undefined, "", "x".repeat(2049)])
    await assert.rejects(
      verifyCaptcha(request, env, store, token, "password_reset_code", verify),
      { status: 400, code: "captcha_required" },
    );
  const results = await Promise.allSettled(
    [1, 2].map(() =>
      verifyCaptcha(
        request,
        env,
        store,
        "captcha-once",
        "password_reset_code",
        verify,
      ),
    ),
  );
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(calls, 1);
  await assert.rejects(
    verifyCaptcha(
      request,
      env,
      store,
      "captcha-once",
      "password_reset_code",
      verify,
    ),
    { status: 400, code: "captcha_invalid" },
  );
  for (const [name, proof] of Object.entries({
    wrong_host: {
      success: true,
      hostname: "evil.example",
      action: "password_reset_code",
    },
    wrong_action: {
      success: true,
      hostname: "accounts.test",
      action: "registration_code",
    },
    failed: { success: false },
    forged: {
      success: "true",
      hostname: "accounts.test",
      action: "password_reset_code",
    },
  })) {
    await assert.rejects(
      verifyCaptcha(
        request,
        env,
        store,
        "captcha-" + name,
        "password_reset_code",
        async () => Response.json(proof),
      ),
      { status: 400, code: "captcha_invalid" },
    );
  }
  await assert.rejects(
    verifyCaptcha(
      request,
      env,
      store,
      "captcha-outage",
      "password_reset_code",
      async () => {
        throw new Error("private transport details");
      },
    ),
    { status: 503, code: "captcha_unavailable" },
  );
  await assert.rejects(
    verifyCaptcha(
      request,
      {},
      store,
      "captcha-no-config",
      "password_reset_code",
      verify,
    ),
    { status: 503, code: "captcha_unavailable" },
  );
  await verifyCaptcha(
    request,
    { CAPTCHA_ENABLED: "false" },
    store,
    undefined,
    "password_reset_code",
    verify,
  );
});

test("Turnstile external validation has an atomic per-IP request limit", async () => {
  const { verifyCaptcha } = await import("../src/captcha.mjs");
  const store = new Store(db);
  const env = {
    ACCOUNT_ORIGIN: "https://accounts.test",
    TURNSTILE_SITE_KEY: "public-test-site",
    TURNSTILE_SECRET_KEY: "private-test-secret",
  };
  const request = new Request("https://accounts.test/auth/registration-code", {
    headers: { "CF-Connecting-IP": "192.0.2.83" },
  });
  let calls = 0;
  const verify = async () => {
    calls++;
    return Response.json({ success: false });
  };
  for (let i = 0; i < 20; i++)
    await assert.rejects(
      verifyCaptcha(
        request,
        env,
        store,
        "captcha-rate-" + i,
        "registration_code",
        verify,
      ),
      { status: 400 },
    );
  await assert.rejects(
    verifyCaptcha(
      request,
      env,
      store,
      "captcha-rate-limit",
      "registration_code",
      verify,
    ),
    { status: 429, code: "captcha_rate_limited" },
  );
  assert.equal(calls, 20);
});

test("Public email code endpoints require a Turnstile proof and never expose the secret", async () => {
  const locked = new Miniflare({
    modules: true,
    scriptPath: ".test-build/worker.js",
    compatibilityDate: "2026-07-01",
    bindings: {
      ACCOUNT_ORIGIN: "https://accounts.test",
      CAPTCHA_ENABLED: "true",
      TURNSTILE_SITE_KEY: "public-test-site",
      TURNSTILE_SECRET_KEY: "private-test-secret",
    },
    serviceBindings: {
      ASSETS: async (request) => {
        assert.equal(new URL(request.url).pathname, "/captcha");
        return new Response("challenge page");
      },
    },
  });
  try {
    const info = await locked.dispatchFetch(
      "https://accounts.test/auth/captcha-info",
    );
    assert.equal(info.status, 200);
    const body = await info.text();
    assert.ok(body.includes("public-test-site"));
    assert.ok(!body.includes("private-test-secret"));
    for (const path of [
      "/auth/registration-code",
      "/auth/password-reset/code",
    ]) {
      const r = await locked.dispatchFetch("https://accounts.test" + path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "owner@example.net" }),
      });
      assert.equal(r.status, 400);
      assert.equal((await r.json()).error_code, "captcha_required");
    }
    const page = await locked.dispatchFetch(
      "https://accounts.test/auth/captcha?action=password_reset_code",
    );
    assert.equal(page.status, 200);
    assert.ok(
      page.headers
        .get("Content-Security-Policy")
        .includes("https://challenges.cloudflare.com"),
    );
  } finally {
    await locked.dispose();
  }
});

test("Small embeddings discovery, vector dimensions and model-specific pricing share atomic cloud quotas", async () => {
  const { uid, key } = await lunaUser("cloud-embedding");
  const models = await apiCall("/v1/models?output_modalities=embeddings", key);
  assert.deepEqual(
    models.body.data.map((x) => x.id),
    ["text-embedding-3-small"],
  );
  for (const extra of [
    {},
    { dimensions: 256 },
    { encoding_format: "base64" },
  ]) {
    const r = await apiCall("/v1/embeddings", key, {
      model: "text-embedding-3-small",
      input: ["hello", "world"],
      ...extra,
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.data.length, 2);
    if (extra.encoding_format !== "base64")
      assert.equal(r.body.data[0].embedding.length, extra.dimensions ?? 1536);
  }
  const rows = (
    await db.prepare("SELECT * FROM luna_usage WHERE user_id=?").bind(uid).all()
  ).results;
  assert.equal(rows.length, 3);
  for (const r of rows) {
    assert.equal(r.model, "text-embedding-3-small");
    assert.equal(r.settled, 1);
    assert.equal(r.charged_tokens, 1);
    assert.equal(r.charged_cost_nanos, 20);
    assert.equal(
      (
        await db
          .prepare("SELECT cost_nanos FROM luna_spend WHERE lease=?")
          .bind(r.lease)
          .first()
      ).cost_nanos,
      20,
    );
  }
  const { prepareEmbedding } = await import("../src/embeddings.mjs");
  for (const extra of [
    { model: "text-embedding-3-large" },
    { input: "" },
    { input: [] },
    { input: "x".repeat(8193) },
    { dimensions: 1537 },
    { stream: true },
  ])
    assert.throws(() =>
      prepareEmbedding({
        model: "text-embedding-3-small",
        input: "hello",
        ...extra,
      }),
    );
  const before = providerCalls;
  assert.equal(
    (
      await apiCall("/v1/embeddings", key, {
        model: "text-embedding-3-large",
        input: "hello",
      })
    ).status,
    422,
  );
  assert.equal(providerCalls, before);
  await db
    .prepare("UPDATE users SET luna_monthly_tokens=3 WHERE id=?")
    .bind(uid)
    .run();
  assert.equal(
    (
      await apiCall("/v1/embeddings", key, {
        model: "text-embedding-3-small",
        input: "hello",
      })
    ).status,
    429,
  );
  openaiMode = "reject";
  await db
    .prepare("UPDATE users SET luna_monthly_tokens=100000 WHERE id=?")
    .bind(uid)
    .run();
  assert.equal(
    (
      await apiCall("/v1/embeddings", key, {
        model: "text-embedding-3-small",
        input: "hello",
      })
    ).status,
    502,
  );
  openaiMode = "json";
  const r = await db
    .prepare(
      "SELECT charged_tokens FROM luna_usage WHERE user_id=? ORDER BY rowid DESC LIMIT 1",
    )
    .bind(uid)
    .first();
  assert.equal(r.charged_tokens, 0);
});

test("Local model discovery works on first call without inference leases or free concurrency", async () => {
  const { uid, key } = await lunaUser("local-first-catalog");
  const store = new Store(db);
  await db.prepare("UPDATE users SET concurrency=1 WHERE id=?").bind(uid).run();
  const lease = await lunaLease(key);
  const before = await db
    .prepare("SELECT count(*) n FROM requests WHERE user_id=?")
    .bind(uid)
    .first();
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url, options) => {
    calls++;
    assert.equal(new URL(url).searchParams.get("output_modalities"), "all");
    assert.equal(new Headers(options.headers).get("Authorization"), null);
    assert.ok(new Headers(options.headers).get("X-Edge-Secret"));
    return Response.json({
      data: [
        {
          id: "Qwen3.8-27B",
          architecture: {
            input_modalities: ["text"],
            output_modalities: ["text"],
          },
        },
        {
          id: "Qwen/Qwen3-Embedding-0.6B",
          architecture: { output_modalities: ["embeddings"] },
        },
      ],
    });
  };
  try {
    const r = await edgeAPI(
      new Request("https://api.hilex.me/v1/models?output_modalities=all", {
        headers: { Authorization: "Bearer " + key },
      }),
      {
        DB: db,
        OPENAI_API_KEY: "fake",
        INTERNAL_SECRET: secret,
        LOCAL_MODELS_ENABLED: "true",
      },
      { waitUntil() {} },
    );
    assert.equal(r.status, 200);
    const ids = (await r.json()).data.map((x) => x.id);
    assert.ok(ids.includes("Qwen3.8-27B"));
    assert.ok(ids.includes("text-embedding-3-small"));
    assert.equal(calls, 1);
    const after = await db
      .prepare("SELECT count(*) n FROM requests WHERE user_id=?")
      .bind(uid)
      .first();
    assert.equal(after.n, before.n);
  } finally {
    globalThis.fetch = original;
    await store.finish({ lease, status: 200, size: 0 });
  }
});

test("Original display_name and password can change password anonymously, revoke sessions and retain API keys", async () => {
  const store = new Store(db);
  const user = await store.createUser("credential-change", "before1", {
    must_change: 0,
    rpm: 0,
    daily_requests: 0,
  });
  const login = await fixtureLogin(
    store,
    user.display_name,
    "before1",
    "credential-initial",
  );
  const key = await store.createKey(user.id, user.id, {
    name: "retained",
    services: ["qwen"],
    days: 1,
  });
  const bad = await call("/auth/password", {
    display_name: user.display_name,
    current_password: "wrong",
    new_password: "after1",
  });
  assert.equal(bad.status, 401);
  const r = await call("/auth/password", {
    display_name: " CREDENTIAL-CHANGE ",
    current_password: "before1",
    new_password: "after1",
  });
  assert.equal(r.status, 200);
  assert.ok(r.headers.get("Set-Cookie").includes("Max-Age=0"));
  await assert.rejects(store.access(login.body.access_token), { status: 401 });
  await assert.rejects(store.refresh(login.body.refresh_token), {
    status: 401,
  });
  await assert.rejects(store.session(login.cookie), { status: 401 });
  await assert.rejects(
    fixtureLogin(store, user.display_name, "before1", "credential-old-login"),
    { status: 401 },
  );
  assert.equal(
    (
      await fixtureLogin(
        store,
        user.display_name,
        "after1",
        "credential-new-login",
      )
    ).body.user.id,
    user.id,
  );
  const lease = await store.acquire(key.key, "qwen", "/v1/chat/completions");
  await store.finish({ lease, status: 200, size: 0 });
  for (let i = 0; i < 10; i++)
    assert.equal(
      (
        await call(
          "/auth/password",
          {
            display_name: "credential-missing",
            current_password: "wrong",
            new_password: "after1",
          },
          { headers: { "CF-Connecting-IP": "credential-guess-ip" } },
        )
      ).status,
      401,
    );
  assert.equal(
    (
      await call(
        "/auth/password",
        {
          display_name: "credential-missing",
          current_password: "wrong",
          new_password: "after1",
        },
        { headers: { "CF-Connecting-IP": "credential-guess-ip" } },
      )
    ).status,
    429,
  );
});

test("Personal cloud summaries follow settlement, reconciliation, month moves and deletion without refunding global spend", async () => {
  const store = new Store(db);
  const { uid, key } = await lunaUser("personal-rollup");
  const lease = await lunaLease(key);
  await lunaCall(lease);
  await store.finish({ lease, status: 200, size: 0 });
  let t = await store.first(
    "SELECT * FROM luna_user_month_totals WHERE user_id=?",
    uid,
  );
  assert.equal(t.used_tokens, 120);
  assert.equal(t.reserved_tokens, 0);
  assert.equal(t.requests, 1);
  await store.run(
    "UPDATE luna_usage SET charged_tokens=150,settled=0 WHERE lease=?",
    lease,
  );
  t = await store.first(
    "SELECT * FROM luna_user_month_totals WHERE user_id=?",
    uid,
  );
  assert.equal(t.used_tokens, 150);
  assert.equal(t.reserved_tokens, 150);
  await store.run(
    "UPDATE luna_usage SET month='2000-01',prompt_tokens=130,completion_tokens=20 WHERE lease=?",
    lease,
  );
  const moved = await store.first(
    "SELECT * FROM luna_user_month_totals WHERE user_id=? AND month='2000-01'",
    uid,
  );
  assert.equal(moved.used_tokens, 150);
  assert.equal(moved.prompt_tokens, 130);
  const old = await store.first(
    "SELECT * FROM luna_user_month_totals WHERE user_id=? AND month<>'2000-01'",
    uid,
  );
  assert.equal(old.used_tokens, 0);
  assert.equal(old.requests, 0);
  const spend = await store.first(
    "SELECT cost_nanos FROM luna_spend WHERE lease=?",
    lease,
  );
  await store.run("DELETE FROM luna_usage WHERE lease=?", lease);
  t = await store.first(
    "SELECT * FROM luna_user_month_totals WHERE user_id=? AND month='2000-01'",
    uid,
  );
  assert.equal(t.used_tokens, 0);
  assert.equal(t.requests, 0);
  assert.equal(
    (
      await store.first(
        "SELECT cost_nanos FROM luna_spend WHERE lease=?",
        lease,
      )
    ).cost_nanos,
    spend.cost_nanos,
  );
});

test("Usage snapshot matches separate authenticated endpoints and rejects anonymous callers", async () => {
  const { key } = await lunaUser("usage-snapshot");
  assert.equal((await call("/account/usage-snapshot")).status, 401);
  const store = new Store(db);
  const user = await store.catalogUser(key); // use a real login for account-only endpoint
  await store.run(
    "UPDATE users SET password=? WHERE id=?",
    await passwordHash("snapshot-pass"),
    user.id,
  );
  const session = await fixtureLogin(
    store,
    user.display_name,
    "snapshot-pass",
    "snapshot-ip",
  );
  const access = session.body.access_token;
  const result = await call("/account/usage-snapshot", undefined, { access });
  assert.equal(result.status, 200);
  assert.deepEqual(
    result.body.usage,
    (await call("/account/usage", undefined, { access })).body,
  );
  assert.deepEqual(
    result.body.luna,
    (await call("/account/luna-usage", undefined, { access })).body,
  );
  assert.deepEqual(
    result.body.audio,
    (await call("/account/audio-usage", undefined, { access })).body,
  );
  const started = Date.now() / 1000 - 120;
  await store.db.batch(
    Array.from({ length: 22 }, (_, index) =>
      store.stmt(
        "INSERT INTO requests(id,user_id,service,path,started,day,ended,status,client_ip) VALUES(?,?,?,?,?,?,?,?,?)",
        "snapshot-" + String(index).padStart(2, "0"),
        user.id,
        "qwen",
        "/v1/chat/completions",
        started,
        "2026-11-24",
        started + 1,
        200,
        "203.0.113.5",
      ),
    ),
  );
  const first = (await call("/account/usage-snapshot", undefined, { access }))
    .body;
  assert.equal(first.usage.requests.length, 20);
  assert.ok(first.history_next);
  assert.ok(
    first.usage.requests.every(
      (row) => !("client_ip" in row) && !("id" in row),
    ),
  );
  const next = await call(
    "/account/usage-history?" +
      new URLSearchParams({ before: first.history_next }),
    undefined,
    { access },
  );
  assert.equal(next.status, 200);
  assert.equal(next.body.requests.length, 2);
  assert.equal(next.body.next, null);
  assert.equal(
    (await call("/account/usage-history?before=bad", undefined, { access }))
      .status,
    422,
  );
});

test("Cloud monthly lookups and empty privacy cleanup remain bounded with a large personal ledger", async () => {
  const store = new Store(db);
  const { uid } = await lunaUser("rollup-load");
  await store.run(
    "UPDATE users SET concurrency=10000,luna_monthly_tokens=1000000000 WHERE id=?",
    uid,
  );
  const ts = Date.now() / 1000,
    period = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  await store.run(
    "WITH RECURSIVE n(x) AS(SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<1000) INSERT INTO requests(id,user_id,service,path,started,day,client_ip) SELECT 'rollup-load-'||x,?,'qwen','/v1/chat/completions',?,?,'192.0.2.100' FROM n",
    uid,
    ts,
    period,
  );
  await store.run(
    "INSERT INTO luna_usage(lease,user_id,month,reserved_tokens,charged_tokens,prompt_tokens) SELECT id,user_id,?,1,1,1 FROM requests WHERE user_id=?",
    period.slice(0, 7),
    uid,
  );
  const old = await store
    .stmt(
      "SELECT sum(charged_tokens) n FROM luna_usage WHERE user_id=? AND month=?",
      uid,
      period.slice(0, 7),
    )
    .all();
  const current = await store
    .stmt(
      "SELECT used_tokens n FROM luna_user_month_totals WHERE user_id=? AND month=?",
      uid,
      period.slice(0, 7),
    )
    .all();
  assert.equal(current.results[0].n, 1000);
  assert.equal(old.results[0].n, 1000);
  assert.ok(old.meta.rows_read >= 1000);
  assert.ok(current.meta.rows_read <= 2);
  const privacy = await store.run(
    "UPDATE requests SET client_ip=NULL,user_agent=NULL,device_id=NULL WHERE id IN(SELECT id FROM requests WHERE started<? AND (client_ip IS NOT NULL OR user_agent IS NOT NULL OR device_id IS NOT NULL) LIMIT 1000)",
    ts - 30 * 86400,
  );
  assert.equal(privacy.meta.changes, 0);
  assert.ok(privacy.meta.rows_read < 50, JSON.stringify(privacy.meta));
  console.log(
    JSON.stringify({
      benchmark: "personal_cloud_query",
      ledger_rows: 1000,
      old_rows_read: old.meta.rows_read,
      new_rows_read: current.meta.rows_read,
      empty_privacy_rows_read: privacy.meta.rows_read,
    }),
  );
});

test("Concurrent cloud requests cannot overspend a one-token personal balance", async () => {
  const { uid, key } = await lunaUser("summary-concurrent-budget", 1);
  const replies = await Promise.all(
    [1, 2, 3, 4].map(() =>
      apiCall("/v1/embeddings", key, {
        model: "text-embedding-3-small",
        input: "x",
      }),
    ),
  );
  assert.deepEqual(replies.map((r) => r.status).sort(), [200, 429, 429, 429]);
  for (const r of replies.filter((r) => r.status === 429))
    assert.equal(r.body.error.code, "account_luna_budget_exhausted");
  const row = await db
    .prepare(
      "SELECT used_tokens,reserved_tokens,requests FROM luna_user_month_totals WHERE user_id=?",
    )
    .bind(uid)
    .first();
  assert.deepEqual(row, { used_tokens: 1, reserved_tokens: 0, requests: 1 });
});

test("Management HTML requires an administrator on every alias and cannot be cached", async () => {
  const login = await call("/auth/login", {
    display_name: "admin",
    password: "admin-password",
  });
  assert.equal(login.status, 200);
  const { uid } = await lunaUser("admin-page-ordinary");
  const store = new Store(db);
  const raw = "ai-at-admin-page-ordinary-token";
  await store.run(
    "INSERT INTO auth_families VALUES(?,?,?,0)",
    "page-family",
    uid,
    Date.now() / 1000 + 3600,
  );
  await store.run(
    "INSERT INTO access_tokens VALUES(?,?,?)",
    await digest(raw),
    "page-family",
    Date.now() / 1000 + 3600,
  );
  for (const path of [
    "/admin",
    "/admin/",
    "/admin/index.html",
    "/admin/users/" + uid,
  ]) {
    const anonymous = await mf.dispatchFetch("https://accounts.test" + path, {
      redirect: "manual",
    });
    assert.equal(anonymous.status, 302);
    assert.equal(
      anonymous.headers.get("Location"),
      path.startsWith("/admin/users/")
        ? "/?next=" + encodeURIComponent(path)
        : "/?next=admin",
    );
    assert.equal(anonymous.headers.get("Cache-Control"), "no-store");
    const denied = await mf.dispatchFetch("https://accounts.test" + path, {
      headers: { Authorization: "Bearer " + raw },
    });
    assert.equal(denied.status, 403);
    const allowed = await mf.dispatchFetch("https://accounts.test" + path, {
      headers: {
        Cookie: login.headers.get("set-cookie").split(";")[0],
        "If-None-Match": "cached",
      },
    });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.headers.get("Cache-Control"), "no-store");
    assert.match(await allowed.text(), /portal/);
  }
  await store.run("UPDATE users SET must_change=1 WHERE id=?", uid);
  await store.run("UPDATE users SET role='admin' WHERE id=?", uid);
  const mustChange = await mf.dispatchFetch("https://accounts.test/admin", {
    headers: { Authorization: "Bearer " + raw },
  });
  assert.equal(mustChange.status, 403);
});

test("Partial local catalog keeps embedding and its marker on cache hits without inference leases", async () => {
  const { uid, key } = await lunaUser("partial-embedding-catalog");
  const previousFetch = globalThis.fetch,
    previousCaches = globalThis.caches;
  let cached = null,
    calls = 0;
  const jobs = [];
  globalThis.caches = {
    default: {
      async match() {
        return cached?.clone();
      },
      async put(key, response) {
        cached = response.clone();
      },
    },
  };
  globalThis.fetch = async () => {
    calls++;
    return Response.json(
      {
        data: [
          {
            id: "Qwen/Qwen3-Embedding-0.6B",
            architecture: { output_modalities: ["embeddings"] },
          },
        ],
      },
      { headers: { "X-Model-Catalog-Partial": "local_unavailable" } },
    );
  };
  try {
    for (let i = 0; i < 2; i++) {
      const response = await edgeAPI(
        new Request(
          "https://api.hilex.me/v1/models?output_modalities=embeddings",
          { headers: { Authorization: "Bearer " + key } },
        ),
        { DB: db, INTERNAL_SECRET: secret, LOCAL_MODELS_ENABLED: "true" },
        {
          waitUntil(p) {
            jobs.push(p);
          },
        },
      );
      assert.equal(response.status, 200);
      assert.equal(
        response.headers.get("X-Model-Catalog-Partial"),
        "local_unavailable",
      );
      assert.ok(
        (await response.json()).data.some(
          (m) => m.id === "Qwen/Qwen3-Embedding-0.6B",
        ),
      );
      await Promise.all(jobs);
    }
    assert.equal(calls, 1);
    assert.equal(
      (
        await new Store(db).first(
          "SELECT count(*) n FROM requests WHERE user_id=?",
          uid,
        )
      ).n,
      0,
    );
  } finally {
    globalThis.fetch = previousFetch;
    if (previousCaches === undefined) delete globalThis.caches;
    else globalThis.caches = previousCaches;
  }
});

async function emailAccount(name, email) {
  const store = new Store(db),
    user = await store.createUser(name, "email-pass", {
      must_change: 0,
      email,
      rpm: 0,
      daily_requests: 0,
    });
  const login = await store.login(email, "email-pass", email + "-initial");
  return { store, user, access: login.body.access_token, login };
}
test("Email-only identity accepts duplicate Unicode display names and keeps account IDs distinct", async () => {
  const a = await emailAccount("共同名字", "canonical-a@example.net"),
    b = await emailAccount("共同名字", "canonical-b@example.net");
  assert.notEqual(a.user.id, b.user.id);
  assert.equal(a.user.display_name, b.user.display_name);
  for (const target of [a, b]) {
    const r = await call(
      "/auth/login",
      { email: target.user.email.toUpperCase(), password: "email-pass" },
      { headers: { "CF-Connecting-IP": target.user.email + "-second" } },
    );
    assert.equal(r.status, 200);
    assert.equal(r.body.user.id, target.user.id);
  }
  await assert.rejects(
    a.store.login("共同名字", "email-pass", "no-name-login"),
    (e) => e.status === 401,
  );
  const obsolete = await mf.dispatchFetch("https://accounts.test/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "共同名字", password: "email-pass" }),
  });
  assert.equal(obsolete.status, 422);
  await assert.rejects(
    a.store.createUser("第三人", "email-pass", {
      email: "CANONICAL-A@example.net",
    }),
    (e) => e.status === 409,
  );
  assert.ok(!Object.hasOwn(a.user, "username"));
});
test("Registration display_name is optional, repeatable and never becomes a login credential", async () => {
  // This scenario has its own synthetic mail budget.
  await new Store(db).run("DELETE FROM email_send_attempts");
  const { requestRegistrationCode } = await import("../src/registration.mjs");
  for (const [email, name] of [
    ["repeat-display-a@example.net", "相同昵称"],
    ["repeat-display-b@example.net", "相同昵称"],
    ["default-display@example.net", undefined],
  ]) {
    let code;
    await requestRegistrationCode(
      new Store(db),
      registrationEnv,
      email,
      email,
      async (_c, _e, value) => {
        code = value;
      },
    );
    const r = await call(
      "/auth/register",
      {
        email,
        password: "email-pass",
        code,
        ...(name ? { display_name: name } : {}),
      },
      { headers: { "CF-Connecting-IP": email } },
    );
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.user.display_name, name ?? "用户");
    assert.equal(r.body.user.email, email);
    assert.ok(r.body.user.email_verified_at);
  }
  for (const name of [" ", "x".repeat(81), "bad\u0000name"]) {
    const r = await call("/auth/register", {
      email: "bad-name@example.net",
      password: "email-pass",
      display_name: name,
      code: "123456",
    });
    assert.equal(r.status, 422);
  }
});
test("Changing display name preserves ID, tokens, keys, email and notice receipts", async () => {
  const { store, user, access, login } = await emailAccount(
    "改名前",
    "profile-owner@example.net",
  );
  const key = await store.createKey(user.id, user.id, {
    name: "same-account",
    services: ["qwen"],
    days: 1,
  });
  const id = "d".repeat(48),
    ts = Date.now() / 1000;
  await store.run(
    "INSERT INTO customer_notices(id,title,body,state,starts_at,created,updated,published_at) VALUES(?,?,?,'published',?,?,?,?)",
    id,
    "Synthetic identity notice",
    "Synthetic",
    ts - 1,
    ts,
    ts,
    ts,
  );
  await store.run(
    "INSERT INTO customer_notice_reads VALUES(?,?,?)",
    id,
    user.id,
    ts,
  );
  const response = await call(
    "/account/profile",
    { display_name: "改名后" },
    { method: "PATCH", access },
  );
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.user.id, user.id);
  assert.equal(response.body.user.email, user.email);
  assert.equal(
    (await call("/account/me", undefined, { access })).body.user.display_name,
    "改名后",
  );
  assert.equal((await store.catalogUser(key.key)).id, user.id);
  const refreshed = await store.refresh(login.body.refresh_token);
  assert.ok(refreshed.access_token);
  assert.equal((await store.access(refreshed.access_token)).id, user.id);
  assert.equal(
    (
      await store.first(
        "SELECT read_at FROM customer_notice_reads WHERE user_id=? AND notice_id=?",
        user.id,
        id,
      )
    ).read_at,
    ts,
  );
  assert.equal(
    (await store.login(user.email, "email-pass", "profile-owner-after")).body
      .user.id,
    user.id,
  );
  const next = await call(
    "/account/profile",
    { display_name: "再改一次" },
    { method: "PATCH", access },
  );
  assert.equal(next.status, 429);
  assert.equal(next.body.error_code, "display_name_change_limited");
  assert.equal(
    (
      await store.first(
        "SELECT count(*) n FROM audit WHERE actor=? AND action='change_display_name'",
        user.id,
      )
    ).n,
    1,
  );
});
test("Display name profile writes are account-authenticated, CSRF protected and race-safe", async () => {
  const a = await emailAccount("相同昵称", "profile-race-a@example.net"),
    b = await emailAccount("相同昵称", "profile-race-b@example.net");
  const body = { display_name: "公共昵称" };
  const key = await a.store.createKey(a.user.id, a.user.id, {
    name: "no-profile",
    services: ["qwen"],
    days: 1,
  });
  assert.equal(
    (await call("/account/profile", body, { method: "PATCH", access: key.key }))
      .status,
    401,
  );
  assert.equal(
    (
      await call(
        "/account/profile",
        { ...body, id: b.user.id },
        { method: "PATCH", access: a.access },
      )
    ).status,
    422,
  );
  const signed = await call(
    "/auth/login",
    { email: a.user.email, password: "email-pass" },
    { headers: { "CF-Connecting-IP": "profile-cookie" } },
  );
  assert.equal(
    (
      await call("/account/profile", body, {
        method: "PATCH",
        cookie: signed.headers.get("set-cookie").split(";")[0],
        csrf: "bad",
      })
    ).status,
    403,
  );
  const results = await Promise.all([
    call("/account/profile", body, {
      method: "PATCH",
      access: a.access,
      headers: { "CF-Connecting-IP": "profile-a-write" },
    }),
    call("/account/profile", body, {
      method: "PATCH",
      access: b.access,
      headers: { "CF-Connecting-IP": "profile-b-write" },
    }),
  ]);
  assert.deepEqual(
    results.map((r) => r.status),
    [200, 200],
  );
  const c = await emailAccount("并发改名", "profile-race-c@example.net");
  const race = await Promise.allSettled([
    c.store.changeDisplayName(c.user.id, "甲"),
    c.store.changeDisplayName(c.user.id, "乙"),
  ]);
  assert.equal(race.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(race.find((r) => r.status === "rejected").reason.status, 429);
});
test("Email password changes revoke sessions, and missing login emails are assigned only by admins without verification", async () => {
  const account = await emailAccount("邮箱改密", "email-password@example.net");
  const changed = await call(
    "/auth/password",
    {
      email: account.user.email,
      current_password: "email-pass",
      new_password: "new-email-pass",
    },
    { headers: { "CF-Connecting-IP": "email-password-ip" } },
  );
  assert.equal(changed.status, 200);
  assert.equal(
    (await call("/account/me", undefined, { access: account.access })).status,
    401,
  );
  assert.equal(
    (
      await account.store.login(
        account.user.email,
        "new-email-pass",
        "email-password-after",
      )
    ).body.user.id,
    account.user.id,
  );
  const currentAccess = (
    await account.store.login(
      account.user.email,
      "new-email-pass",
      "email-password-current",
    )
  ).body.access_token;
  const missing = await account.store.createUser(
    "无邮箱服务账号",
    "email-pass",
    { must_change: 0 },
  );
  assert.equal(
    (
      await call(
        "/admin/users/" + missing.id + "/login-email",
        { email: "legacy-login@example.net" },
        { method: "PUT", access: currentAccess },
      )
    ).status,
    403,
  );
  const assigned = await call(
    "/admin/users/" + missing.id + "/login-email",
    { email: "legacy-login@example.net" },
    { method: "PUT", access: admin },
  );
  assert.equal(assigned.status, 200);
  assert.equal(assigned.body.user.email_verified_at, null);
  assert.equal(assigned.body.user.id, missing.id);
  assert.equal(
    (
      await account.store.login(
        "legacy-login@example.net",
        "email-pass",
        "legacy-login-ip",
      )
    ).body.user.id,
    missing.id,
  );
  assert.equal(
    (
      await call(
        "/admin/users/" + missing.id + "/login-email",
        { email: "overwrite@example.net" },
        { method: "PUT", access: admin },
      )
    ).status,
    409,
  );
});

test("Schema maintenance blocks public requests before reading the database", async () => {
  const maintenance = new Miniflare({
    modules: true,
    scriptPath: ".test-build/worker.js",
    compatibilityDate: "2026-07-01",
    bindings: { ACCOUNT_MAINTENANCE: "true" },
  });
  try {
    for (const path of [
      "/auth/login",
      "/account/me",
      "/v1/models",
      "/admin",
      "/healthz",
    ]) {
      const response = await maintenance.dispatchFetch(
        "https://accounts.test" + path,
      );
      assert.equal(response.status, 503);
      assert.equal(response.headers.get("Retry-After"), "60");
      assert.equal((await response.json()).error_code, "maintenance");
    }
  } finally {
    await maintenance.dispose();
  }
});

async function emailChangeFixture(name) {
  const store = new Store(db);
  await store.run("DELETE FROM email_send_attempts");
  const user = await store.createUser(name, "change-pass", {
    email: name + "@example.net",
    must_change: 0,
    rpm: 0,
    daily_requests: 0,
  });
  await store.run(
    "UPDATE users SET email_verified_at=? WHERE id=?",
    Date.now() / 1000,
    user.id,
  );
  const current = await store.first("SELECT * FROM users WHERE id=?", user.id);
  const mails = [],
    jobs = [];
  const send = async (_config, email, code, purpose) => {
    mails.push({ email, code, purpose });
  };
  const ctx = {
    waitUntil(job) {
      jobs.push(job);
    },
  };
  const { requestEmailChange, confirmEmailChange } =
    await import("../src/email-change.mjs");
  return {
    store,
    user: current,
    mails,
    jobs,
    send,
    ctx,
    requestEmailChange,
    confirmEmailChange,
  };
}
test("Email change proves current password and new mailbox, preserves ID/keys/receipts and revokes every session", async () => {
  const f = await emailChangeFixture("email-change-main"),
    { store, user } = f;
  const oldLogin = await store.login(
    user.email,
    "change-pass",
    "email-change-main-login",
  );
  const key = await store.createKey(user.id, user.id, {
    name: "retained-email-change",
    services: ["qwen"],
    days: 1,
  });
  const notice = "c".repeat(48),
    ts = Date.now() / 1000;
  await store.run(
    "INSERT INTO customer_notices(id,title,body,state,starts_at,created,updated,published_at) VALUES(?,?,?,'published',?,?,?,?)",
    notice,
    "Synthetic change notice",
    "body",
    ts - 1,
    ts,
    ts,
    ts,
  );
  await store.run(
    "INSERT INTO customer_notice_reads VALUES(?,?,?)",
    notice,
    user.id,
    ts,
  );
  const newEmail = "email-change-main-new@example.net";
  const sent = await f.requestEmailChange(
    store,
    registrationEnv,
    user,
    { email: newEmail, current_password: "change-pass" },
    "email-change-main-ip",
    f.send,
  );
  assert.equal(sent.retry_after, 60);
  assert.equal(f.mails[0].purpose, "email-change");
  const result = await f.confirmEmailChange(
    store,
    registrationEnv,
    user,
    { email: newEmail, code: f.mails[0].code },
    f.send,
    f.ctx,
  );
  await Promise.all(f.jobs);
  assert.equal(result.api_keys_revoked, false);
  const updated = await store.first("SELECT * FROM users WHERE id=?", user.id);
  assert.equal(updated.email, newEmail);
  assert.equal(updated.id, user.id);
  assert.equal(updated.display_name, user.display_name);
  assert.ok(updated.email_verified_at);
  assert.equal((await store.catalogUser(key.key)).id, user.id);
  assert.equal(
    (
      await store.first(
        "SELECT read_at FROM customer_notice_reads WHERE notice_id=? AND user_id=?",
        notice,
        user.id,
      )
    ).read_at,
    ts,
  );
  await assert.rejects(
    store.access(oldLogin.body.access_token),
    (e) => e.status === 401,
  );
  await assert.rejects(
    store.refresh(oldLogin.body.refresh_token),
    (e) => e.status === 401,
  );
  await assert.rejects(
    store.login(user.email, "change-pass", "old-email-after"),
    (e) => e.status === 401,
  );
  assert.equal(
    (await store.login(newEmail, "change-pass", "new-email-after")).body.user
      .id,
    user.id,
  );
  assert.equal(f.mails[1].purpose, "email-changed");
  assert.equal(f.mails[1].email, user.email);
  assert.equal(f.mails[1].code, "");
  assert.equal(
    (
      await store.first(
        "SELECT count(*) n FROM audit WHERE actor=? AND action='change_email'",
        user.id,
      )
    ).n,
    1,
  );
  await assert.rejects(
    f.confirmEmailChange(
      store,
      registrationEnv,
      updated,
      { email: newEmail, code: f.mails[0].code },
      f.send,
      f.ctx,
    ),
    (e) => e.code === "email_change_invalid",
  );
});
test("Email change rejects bad passwords, unverified/initial-password accounts, occupied or unchanged destinations", async () => {
  const f = await emailChangeFixture("email-change-guards");
  await assert.rejects(
    f.requestEmailChange(
      f.store,
      registrationEnv,
      f.user,
      { email: "change-guard-new@example.net", current_password: "wrong" },
      "change-guard-ip",
      f.send,
    ),
    (e) => e.code === "current_password_invalid",
  );
  await assert.rejects(
    f.requestEmailChange(
      f.store,
      registrationEnv,
      f.user,
      { email: f.user.email, current_password: "change-pass" },
      "change-guard-ip",
      f.send,
    ),
    (e) => e.code === "email_unchanged",
  );
  await f.store.run(
    "UPDATE users SET email_verified_at=NULL WHERE id=?",
    f.user.id,
  );
  await assert.rejects(
    f.requestEmailChange(
      f.store,
      registrationEnv,
      f.user,
      {
        email: "change-guard-new@example.net",
        current_password: "change-pass",
      },
      "change-guard-ip",
      f.send,
    ),
    (e) => e.code === "email_verification_required",
  );
  await f.store.run(
    "UPDATE users SET email_verified_at=?,must_change=1 WHERE id=?",
    Date.now() / 1000,
    f.user.id,
  );
  await assert.rejects(
    f.requestEmailChange(
      f.store,
      registrationEnv,
      f.user,
      {
        email: "change-guard-new@example.net",
        current_password: "change-pass",
      },
      "change-guard-ip",
      f.send,
    ),
    (e) => e.code === "password_change_required",
  );
  assert.equal(f.mails.length, 0);
});
test("Email change proof is purpose/user/mailbox scoped and limited to five attempts and ten minutes", async () => {
  const f = await emailChangeFixture("email-change-proof");
  const target = "email-change-proof-new@example.net";
  await f.requestEmailChange(
    f.store,
    registrationEnv,
    f.user,
    { email: target, current_password: "change-pass" },
    "change-proof-ip",
    f.send,
  );
  const other = await f.store.createUser("other-change-user", "change-pass", {
    email: "other-change-user@example.net",
    must_change: 0,
  });
  await assert.rejects(
    f.confirmEmailChange(
      f.store,
      registrationEnv,
      other,
      { email: target, code: f.mails[0].code },
      f.send,
      f.ctx,
    ),
    (e) => e.code === "email_change_invalid",
  );
  await assert.rejects(
    f.confirmEmailChange(
      f.store,
      registrationEnv,
      f.user,
      { email: "different-target@example.net", code: f.mails[0].code },
      f.send,
      f.ctx,
    ),
    (e) => e.code === "email_change_invalid",
  );
  const bad = f.mails[0].code === "000000" ? "111111" : "000000";
  for (let i = 0; i < 5; i++)
    await assert.rejects(
      f.confirmEmailChange(
        f.store,
        registrationEnv,
        f.user,
        { email: target, code: bad },
        f.send,
        f.ctx,
      ),
      (e) => e.code === "email_change_invalid",
    );
  await assert.rejects(
    f.confirmEmailChange(
      f.store,
      registrationEnv,
      f.user,
      { email: target, code: f.mails[0].code },
      f.send,
      f.ctx,
    ),
    (e) => e.code === "email_change_invalid",
  );
  assert.equal(
    (await f.store.first("SELECT email FROM users WHERE id=?", f.user.id))
      .email,
    f.user.email,
  );
  const exp = await emailChangeFixture("email-change-expired");
  const expTarget = "email-change-expired-new@example.net";
  await exp.requestEmailChange(
    exp.store,
    registrationEnv,
    exp.user,
    { email: expTarget, current_password: "change-pass" },
    "change-exp-ip",
    exp.send,
  );
  await exp.store.run(
    "UPDATE email_change_challenges SET expires=0 WHERE user_id=?",
    exp.user.id,
  );
  await assert.rejects(
    exp.confirmEmailChange(
      exp.store,
      registrationEnv,
      exp.user,
      { email: expTarget, code: exp.mails[0].code },
      exp.send,
      exp.ctx,
    ),
    (e) => e.code === "email_change_invalid",
  );
});
test("Email change password-version and uniqueness guards roll back stale or racing confirmations", async () => {
  const f = await emailChangeFixture("email-change-password-version");
  const target = "email-change-version-new@example.net";
  await f.requestEmailChange(
    f.store,
    registrationEnv,
    f.user,
    { email: target, current_password: "change-pass" },
    "change-version-ip",
    f.send,
  );
  await f.store.changePassword(f.user.id, "change-pass", "changed-password");
  await assert.rejects(
    f.confirmEmailChange(
      f.store,
      registrationEnv,
      f.user,
      { email: target, code: f.mails[0].code },
      f.send,
      f.ctx,
    ),
    (e) => e.code === "email_change_invalid",
  );
  const conflict = await emailChangeFixture("email-change-conflict");
  const next = "email-change-conflict-new@example.net";
  await conflict.requestEmailChange(
    conflict.store,
    registrationEnv,
    conflict.user,
    { email: next, current_password: "change-pass" },
    "change-conflict-ip",
    conflict.send,
  );
  await conflict.store.createUser("Occupied", "other-pass", { email: next });
  await assert.rejects(
    conflict.confirmEmailChange(
      conflict.store,
      registrationEnv,
      conflict.user,
      { email: next, code: conflict.mails[0].code },
      conflict.send,
      conflict.ctx,
    ),
    (e) => e.code === "email_in_use",
  );
  assert.equal(
    (
      await conflict.store.first(
        "SELECT email FROM users WHERE id=?",
        conflict.user.id,
      )
    ).email,
    conflict.user.email,
  );
  assert.equal(
    (
      await conflict.store.first(
        "SELECT state FROM email_change_challenges WHERE user_id=?",
        conflict.user.id,
      )
    ).state,
    "sent",
  );
  const race = await emailChangeFixture("email-change-race");
  const final = "email-change-race-new@example.net";
  await race.requestEmailChange(
    race.store,
    registrationEnv,
    race.user,
    { email: final, current_password: "change-pass" },
    "change-race-ip",
    race.send,
  );
  const out = await Promise.allSettled(
    [1, 2].map(() =>
      race.confirmEmailChange(
        race.store,
        registrationEnv,
        race.user,
        { email: final, code: race.mails[0].code },
        race.send,
        race.ctx,
      ),
    ),
  );
  assert.equal(out.filter((r) => r.status === "fulfilled").length, 1);
  await Promise.all(race.jobs);
  assert.equal(
    (
      await race.store.first(
        "SELECT count(*) n FROM audit WHERE actor=? AND action='change_email'",
        race.user.id,
      )
    ).n,
    1,
  );
  assert.equal(
    race.mails.filter((m) => m.purpose === "email-changed").length,
    1,
  );
});
test("Email change mail failures consume send budget, clear proof and cannot alter the account", async () => {
  const f = await emailChangeFixture("email-change-failure");
  const target = "email-change-failure-new@example.net";
  await assert.rejects(
    f.requestEmailChange(
      f.store,
      registrationEnv,
      f.user,
      { email: target, current_password: "change-pass" },
      "change-fail-ip",
      async () => {
        throw new Error("private smtp details");
      },
    ),
    (e) =>
      e.code === "email_delivery_unavailable" && !e.message.includes("private"),
  );
  const proof = await f.store.first(
    "SELECT state,code_hash FROM email_change_challenges WHERE user_id=?",
    f.user.id,
  );
  assert.equal(proof.state, "failed");
  assert.equal(proof.code_hash, "");
  await assert.rejects(
    f.requestEmailChange(
      f.store,
      registrationEnv,
      f.user,
      { email: target, current_password: "change-pass" },
      "change-fail-ip",
      f.send,
    ),
    (e) => e.code === "email_rate_limited",
  );
  assert.equal(
    (await f.store.first("SELECT email FROM users WHERE id=?", f.user.id))
      .email,
    f.user.email,
  );
});
test("Email change routes reject API keys, wrong CSRF and unavailable current-password proof", async () => {
  const f = await emailChangeFixture("email-change-auth");
  const key = await f.store.createKey(f.user.id, f.user.id, {
    name: "not-account",
    services: ["qwen"],
    days: 1,
  });
  assert.equal(
    (
      await call(
        "/account/email/change/code",
        {
          email: "change-auth-new@example.net",
          current_password: "change-pass",
        },
        { access: key.key },
      )
    ).status,
    401,
  );
  const signed = await call(
    "/auth/login",
    { email: f.user.email, password: "change-pass" },
    { headers: { "CF-Connecting-IP": "change-auth-login" } },
  );
  assert.equal(
    (
      await call(
        "/account/email/change",
        { email: "change-auth-new@example.net", code: "123456" },
        {
          cookie: signed.headers.get("set-cookie").split(";")[0],
          csrf: "wrong",
        },
      )
    ).status,
    403,
  );
  const noPassword = await call(
    "/account/email/change/code",
    { email: "change-auth-new@example.net" },
    { access: signed.body.access_token },
  );
  assert.equal(noPassword.status, 422);
  const badPassword = await call(
    "/account/email/change/code",
    { email: "change-auth-new@example.net", current_password: "wrong" },
    {
      access: signed.body.access_token,
      headers: { "CF-Connecting-IP": "change-auth-password" },
    },
  );
  assert.equal(badPassword.status, 403);
});

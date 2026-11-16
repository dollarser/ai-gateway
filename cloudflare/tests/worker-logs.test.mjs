import { test } from "node:test";
import assert from "node:assert/strict";
import {
  schemaValidationHint,
  toolDiagnostic,
  writeWorkerLog,
  logInferenceFailure,
  accountPath,
} from "../src/worker-logs.mjs";
import { providerFailure } from "../src/provider-errors.mjs";
async function captured(fn) {
  const lines = [],
    old = console.error,
    warn = console.warn;
  console.error = (...v) => lines.push(v.join(" "));
  console.warn = (...v) => lines.push(v.join(" "));
  try {
    await fn(lines);
  } finally {
    console.error = old;
    console.warn = warn;
  }
}
test("Tool diagnostics retain structural failure details but omit content, enum/default/reference values and secrets", async () => {
  const secret = "sk-test-do-not-log",
    mail = "private@example.net";
  const tools = Array.from({ length: 27 }, () => ({
    type: "function",
    name: "unused",
  }));
  tools[26] = {
    type: "function",
    name: "search_tool",
    strict: false,
    description: secret,
    parameters: {
      type: "object",
      description: secret,
      properties: {
        query: {
          type: "string",
          default: secret,
          enum: [mail],
          examples: [secret],
          pattern: secret,
        },
        entries: { type: "array" },
        ref: { $ref: secret },
        [secret]: { type: "string" },
      },
      required: ["query"],
      additionalProperties: false,
    },
  };
  const diagnostic = toolDiagnostic({ tools }, "tools[26].parameters");
  assert.equal(diagnostic.index, 26);
  assert.equal(diagnostic.name, "search_tool");
  assert.ok(
    diagnostic.nodes.some(
      (n) =>
        n.path === "parameters.properties.entries" && n.has_items === false,
    ),
  );
  await captured((lines) => {
    writeWorkerLog("inference_failure", {
      request_id: "fixture",
      upstream_error_param: "tools[26].parameters",
      tool_diagnostic: diagnostic,
      authorization: secret,
      message: secret,
      body: mail,
    });
    assert.equal(lines.length, 1);
    assert.ok(!lines[0].includes(secret));
    assert.ok(!lines[0].includes(mail));
    assert.equal(JSON.parse(lines[0]).tool_diagnostic.index, 26);
  });
  const chat = {
    tools: [
      {
        type: "function",
        function: {
          name: "chat_tool",
          parameters: { type: "object" },
          strict: true,
        },
      },
    ],
  };
  assert.equal(
    toolDiagnostic(chat, "tools[0].function.parameters").strict,
    true,
  );
  assert.equal(toolDiagnostic(chat, "tools[99].parameters"), null);
});
test("Log events are bounded valid JSON and request failures are emitted only once", async () => {
  const properties = Object.fromEntries(
    Array.from({ length: 1000 }, (_, i) => [
      "field_" + i,
      {
        type: "object",
        properties: { nested: { type: "array", items: { type: "string" } } },
      },
    ]),
  );
  await captured((lines) => {
    const trace = {
      request_id: "fixture-id",
      path: "/v1/responses",
      model: "gpt-6-luna",
      error_code: "provider_invalid_request",
      upstream_status: 400,
    };
    const e = {
      upstream_status: 400,
      upstream_error_param: "tools[0].parameters",
      tool_diagnostic: toolDiagnostic(
        {
          tools: [
            {
              name: "large_tool",
              strict: true,
              parameters: { type: "object", properties },
            },
          ],
        },
        "tools[0].parameters",
      ),
    };
    logInferenceFailure(trace, e, 400);
    logInferenceFailure(trace, e, 400);
    assert.equal(lines.length, 1);
    assert.ok(new TextEncoder().encode(lines[0]).length <= 8192);
    assert.equal(JSON.parse(lines[0]).event, "inference_failure");
    logInferenceFailure({ request_id: "anonymous" }, null, 401);
    logInferenceFailure({ request_id: "quota" }, null, 429);
    logInferenceFailure({ request_id: "cancel" }, null, 499);
    assert.equal(lines.length, 1);
    logInferenceFailure(
      {
        request_id: "stream",
        error_code: "provider_stream_interrupted",
        failure_stage: "response_stream",
        upstream_status: 200,
      },
      null,
      502,
    );
    assert.equal(lines.length, 2);
  });
  assert.equal(accountPath("/account/email/user-secret"), " /account/*".trim());
  assert.equal(accountPath("/untrusted/private@example.net"), "/unknown");
});
test("Provider messages yield a fixed validation hint, never raw upstream text", async () => {
  const response = Response.json(
    {
      error: {
        code: "invalid_function_parameters",
        param: "tools[26].parameters",
        message:
          "Invalid schema for secret-tool private@example.net: array schema missing items. credential=sk-secret",
      },
    },
    { status: 400, headers: { "x-request-id": "req_fixture" } },
  );
  const error = await providerFailure(response, "luna");
  assert.equal(error.validation_hint, "array_items_missing_or_invalid");
  assert.equal(error.upstream_request_id, "req_fixture");
  assert.ok(!JSON.stringify(error).includes("private@example.net"));
  assert.ok(!JSON.stringify(error).includes("sk-secret"));
  assert.equal(
    schemaValidationHint("additionalProperties must be false"),
    "check_additional_properties",
  );
  assert.equal(schemaValidationHint(null), null);
});

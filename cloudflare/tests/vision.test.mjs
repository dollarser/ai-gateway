import { test } from "node:test";
import assert from "node:assert/strict";
import { lunaCost } from "../src/budgets.mjs";
import { preparePayload, lunaCatalogForUser } from "../src/luna.mjs";
const url = "https://example.com/image.png";
function payload(responses, parts) {
  return {
    model: "gpt-6-luna",
    [responses ? "input" : "messages"]: [{ role: "user", content: parts }],
  };
}
const part = (responses, u = url, detail = "auto") =>
  responses
    ? { type: "input_image", image_url: u, detail }
    : { type: "image_url", image_url: { url: u, detail } };
for (const responses of [false, true]) {
  test(`Vision ${responses ? "Responses" : "Chat"} passes images intact and reserves tokens separately`, () => {
    for (const detail of ["auto", "low", "high", "original"]) {
      for (const u of [url, "data:image/png;base64," + "AAAA".repeat(100000)]) {
        const p = payload(responses, [part(responses, u, detail)]);
        const r = preparePayload(p, responses);
        assert.deepEqual(
          r.payload[responses ? "input" : "messages"],
          p[responses ? "input" : "messages"],
        );
        assert.ok(r.inputBound > 100000 && r.inputBound < 110000);
        assert.equal(r.reservation, r.inputBound + r.max);
      }
    }
    const r = preparePayload(
      payload(responses, [part(responses), part(responses)]),
      responses,
    );
    assert.ok(r.inputBound > 200000 && r.inputBound < 210000);
    const eight = preparePayload(
      payload(
        responses,
        Array.from({ length: 8 }, () => part(responses)),
      ),
      responses,
    );
    assert.ok(eight.inputBound > 800000);
    assert.throws(
      () =>
        preparePayload(
          payload(
            responses,
            Array.from({ length: 9 }, () => part(responses)),
          ),
          responses,
        ),
      { status: 413, code: "too_many_images" },
    );
  });
  test(`Vision ${responses} rejects malformed images and unsupported sources`, () => {
    for (const u of [
      "http://example.com/a",
      "file:///a",
      "https://user:password@example.com/a",
      "data:image/svg+xml;base64,AAAA",
      "data:image/png;base64,",
      "data:image/png;base64,A===",
      "data:image/png;base64,A",
      "not a URL",
    ]) {
      assert.throws(() =>
        preparePayload(payload(responses, [part(responses, u)]), responses),
      );
    }
    assert.throws(() =>
      preparePayload(payload(responses, [part(!responses)]), responses),
    );
    assert.throws(() =>
      preparePayload(
        payload(responses, [part(responses, url, "invalid")]),
        responses,
      ),
    );
    const p = payload(responses, [part(responses)]);
    p[responses ? "input" : "messages"][0].role = "assistant";
    assert.throws(() => preparePayload(p, responses));
    assert.throws(() =>
      preparePayload(
        payload(responses, [{ type: "input_file", file_id: "file-hidden" }]),
        responses,
      ),
    );
    assert.throws(
      () =>
        preparePayload(
          payload(responses, [
            {
              type: responses ? "input_text" : "text",
              text: "x".repeat(1000000),
            },
            part(responses),
          ]),
          responses,
        ),
      { status: 413, code: "input_estimate_too_large" },
    );
  });
}
test("Luna catalog advertises image input and text output", () => {
  const model = lunaCatalogForUser(
    { luna_monthly_tokens: 1000000 },
    { OPENAI_API_KEY: "test" },
  ).data[0];
  assert.deepEqual(model.architecture.input_modalities, ["text", "image"]);
  assert.deepEqual(model.architecture.output_modalities, ["text"]);
});

test("Long context rates apply to the entire request above the threshold", () => {
  const usage = { input: 272000, output: 1000, cached: 1000, writes: 1000 };
  assert.equal(lunaCost(usage), 27000000 + 10000 + 125000 + 500000);
  assert.equal(
    lunaCost({ ...usage, input: 272001 }),
    (27000100 + 10000 + 125000) * 2 + 750000,
  );
});

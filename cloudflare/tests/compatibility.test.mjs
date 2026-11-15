import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { preparePayload } from "../src/luna.mjs";
import { compressedDuration } from "../src/audio-duration.mjs";
const tool = {
  type: "function",
  function: {
    name: "lookup",
    parameters: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    },
  },
};
const chat = {
  model: "gpt-6-luna",
  messages: [{ role: "user", content: "Look up Tokyo" }],
  tools: [tool],
};
test("Chat tools normalize reasoning and follow-up history", () => {
  for (const effort of [undefined, "medium", "high", "none"]) {
    const r = preparePayload(
      { ...chat, ...(effort ? { reasoning_effort: effort } : {}) },
      false,
    );
    assert.equal(r.payload.reasoning_effort, "none");
    assert.equal(r.payload.tools[0].function.strict, false);
    assert.equal(
      r.compatibility.includes("chat-tools-reasoning-none"),
      effort !== "none",
    );
  }
  const follow = preparePayload(
    {
      ...chat,
      tools: undefined,
      messages: [
        {
          role: "assistant",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "lookup", arguments: "{}" },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: "OK" },
      ],
    },
    false,
  );
  assert.equal(follow.payload.reasoning_effort, "none");
  assert.equal(
    preparePayload(
      { ...chat, tools: undefined, reasoning_effort: "high" },
      false,
    ).payload.reasoning_effort,
    "high",
  );
});
test("Function descriptors and forced tool choice normalize for both endpoints", () => {
  const flat = { type: "function", ...tool.function };
  const c = preparePayload(
    {
      ...chat,
      tools: [flat],
      tool_choice: { type: "function", name: "lookup" },
    },
    false,
  );
  assert.equal(c.payload.tool_choice.function.name, "lookup");
  assert.equal(c.payload.tools[0].function.name, "lookup");
  const r = preparePayload(
    {
      model: "gpt-6-luna",
      input: "Lookup",
      tools: [tool],
      tool_choice: { type: "function", function: { name: "lookup" } },
      reasoning: { effort: "low" },
    },
    true,
  );
  assert.equal(r.payload.reasoning.effort, "low");
  assert.equal(r.payload.tools[0].name, "lookup");
  assert.equal(r.payload.tools[0].function, undefined);
  assert.equal(r.payload.tool_choice.name, "lookup");
  assert.throws(
    () =>
      preparePayload(
        { ...chat, tool_choice: { type: "function", name: "missing" } },
        false,
      ),
    /tool_choice/,
  );
  assert.throws(
    () =>
      preparePayload(
        {
          ...chat,
          tools: [{ type: "function", function: { name: "bad name" } }],
        },
        false,
      ),
    /name/,
  );
});
const fixtures = JSON.parse(
  await readFile(new URL("./audio-fixtures.json", import.meta.url)),
);
for (const fixture of fixtures)
  test("Frame scan " + fixture.name + " is conservative", () => {
    const bytes = new Uint8Array(Buffer.from(fixture.base64, "base64"));
    const result = compressedDuration(bytes);
    assert.ok(result, fixture.name);
    assert.ok(
      result.milliseconds >= fixture.decoded_ms,
      JSON.stringify(result),
    );
    assert.ok(
      result.milliseconds <= fixture.decoded_ms + 100,
      JSON.stringify(result),
    );
    assert.equal(
      compressedDuration(bytes.slice(0, Math.floor(bytes.length / 2))),
      null,
    );
  });
test("Unsupported and damaged containers fall back", () => {
  for (const bytes of [
    new Uint8Array(),
    new TextEncoder().encode("duration=1"),
    new Uint8Array(4096),
  ])
    assert.equal(compressedDuration(bytes), null);
  const f = fixtures.find((f) => f.name === "m4a");
  const bytes = new Uint8Array(Buffer.from(f.base64, "base64"));
  const i = Buffer.from(bytes).indexOf("stsz");
  assert.ok(i > 0);
  new DataView(bytes.buffer).setUint32(i + 12, 1, false);
  assert.equal(compressedDuration(bytes), null);
});

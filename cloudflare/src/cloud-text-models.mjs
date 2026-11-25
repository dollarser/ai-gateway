// Standard short-context rates in USD nanos per token. Requests use 30-minute cache writes.
export const LUNA_MODEL = "gpt-6-luna";
export const CLOUD_TEXT_BODY_LIMIT = 12 * 1024 * 1024;
export const CLOUD_TEXT_CONTEXT_WINDOW = 1050000;
export const CLOUD_TEXT_MAX_IMAGES = 8;
export const LONG_CONTEXT_THRESHOLD = 272000;
export const CLOUD_TEXT_PATHS = ["/v1/chat/completions", "/v1/responses"];
function model(name, input, cached, write, output, reasoningNone = true) {
  return { name, reasoningNone, price: { input, cached, write, output } };
}
export const CLOUD_TEXT_MODELS = new Map([
  [LUNA_MODEL, model("GPT-6 Luna", 100, 10, 125, 500)],
  ["gpt-6-sol", model("GPT-6 Sol", 2000, 200, 2500, 10000)],
  ["gpt-6-astra", model("GPT-6 Astra", 10000, 1000, 12500, 50000, false)],
  ["gpt-6.1-sol", model("GPT-6.1 Sol", 2000, 100, 2500, 10000)],
  ["gpt-6.1-terra", model("GPT-6.1 Terra", 1000, 50, 1250, 5000)],
  ["gpt-6.2-sol", model("GPT-6.2 Sol", 2000, 100, 2500, 10000, false)],
  ["gpt-6.2-astra", model("GPT-6.2 Astra", 8000, 400, 10000, 40000, false)],
]);

import { ASR_MODEL, TTS_MODEL } from "./audio.mjs";
import { LUNA_MODEL } from "./luna.mjs";
import { EMBEDDING_MODELS } from "./embeddings.mjs";
import { Denied } from "./store.mjs";
import { now } from "./crypto.mjs";

export const LOCAL_ASR = "funasr";
export const LOCAL_TTS = "cosyvoice";
const prefix = "public_model:";
const definitions = [
  {
    id: LUNA_MODEL,
    name: "GPT-6 Luna",
    service: "qwen",
    provider: "openai",
    endpoints: ["/v1/chat/completions", "/v1/responses"],
  },
  {
    id: "Qwen3.8-27B",
    name: "Qwen3.8-27B",
    service: "qwen",
    provider: "local",
    endpoints: ["/v1/chat/completions", "/v1/completions"],
  },
  ...Object.keys(EMBEDDING_MODELS).map((id) => ({
    id,
    name: id,
    service: "qwen",
    provider: "openai",
    endpoints: ["/v1/embeddings"],
  })),
  {
    id: "Qwen/Qwen3-Embedding-0.6B",
    name: "Qwen3 Embedding 0.6B",
    service: "qwen",
    provider: "local",
    endpoints: ["/v1/embeddings"],
  },
  {
    id: ASR_MODEL,
    name: "OpenAI 语音识别",
    service: "asr",
    provider: "openai",
    endpoints: ["/v1/audio/transcriptions"],
  },
  {
    id: LOCAL_ASR,
    name: "Paraformer 语音识别",
    service: "asr",
    provider: "local",
    endpoints: ["/v1/audio/transcriptions", "/ws/asr"],
    aliases: ["paraformer"],
    input: ["audio"],
    output: ["transcription"],
  },
  {
    id: TTS_MODEL,
    name: "OpenAI 语音合成",
    service: "tts",
    provider: "openai",
    endpoints: ["/v1/audio/speech"],
  },
  {
    id: LOCAL_TTS,
    name: "CosyVoice 语音合成",
    service: "tts",
    provider: "local",
    endpoints: ["/v1/audio/speech", "/ws/tts"],
    aliases: ["cosyvoice3"],
    input: ["text"],
    output: ["audio", "speech"],
  },
];
const registry = new Map(definitions.map((model) => [model.id, model]));
const aliases = new Map(
  definitions.flatMap((m) => (m.aliases ?? []).map((id) => [id, m.id])),
);

export async function enabledModels(store) {
  const rows = await store.all(
    "SELECT name FROM settings WHERE name >= ? AND name < ? AND value='true'",
    prefix,
    "public_model;",
  );
  return new Set(rows.map(({ name }) => name.slice(prefix.length)));
}

export function localVoiceCatalog(permissions, enabled) {
  return definitions
    .filter(
      (m) => m.input && permissions.includes(m.service) && enabled.has(m.id),
    )
    .map((m) => ({
      id: m.id,
      name: m.name,
      object: "model",
      owned_by: "local",
      endpoints: m.endpoints,
      architecture: {
        input_modalities: m.input,
        output_modalities: m.output,
        modality: m.input.join("+") + "->" + m.output.join("+"),
      },
    }));
}

export async function requirePublicModel(store, requested, path) {
  const id = aliases.get(requested) ?? requested;
  const model = registry.get(id);
  if (!model || !model.endpoints.includes(path)) {
    const error = new Denied(422, "此接口不支持指定的模型");
    error.code = "unsupported_model";
    throw error;
  }
  const flag = await store.first(
    "SELECT value FROM settings WHERE name=?",
    prefix + id,
  );
  if (flag?.value !== "true") {
    const error = new Denied(403, "此模型尚未开放或已停用");
    error.code = "model_disabled";
    throw error;
  }
}

export async function adminModelRoute(request, store, user, readBody) {
  const { pathname } = new URL(request.url);
  if (pathname !== "/admin/models") return null;
  if (request.method === "GET") {
    const enabled = await enabledModels(store);
    return Response.json(
      {
        models: definitions.map((model) => ({
          ...model,
          enabled: enabled.has(model.id),
        })),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
  if (request.method !== "PATCH") throw new Denied(405, "方法不受支持");
  const update = await readBody(request);
  if (
    !update ||
    !registry.has(update.id) ||
    typeof update.enabled !== "boolean" ||
    Object.keys(update).some((key) => !["id", "enabled"].includes(key))
  )
    throw new Denied(422, "模型或开关值无效");

  await store.db.batch([
    store.stmt(
      "INSERT INTO settings(name,value) VALUES(?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value",
      prefix + update.id,
      String(update.enabled),
    ),
    store.stmt(
      "INSERT INTO audit(actor,action,target,ts) VALUES(?,?,?,?)",
      user.id,
      update.enabled ? "enable_public_model" : "disable_public_model",
      update.id,
      now(),
    ),
  ]);
  return Response.json(
    { id: update.id, enabled: update.enabled },
    { headers: { "Cache-Control": "no-store" } },
  );
}

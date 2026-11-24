import { ASR_MODEL, TTS_MODEL } from "./audio.mjs";
import {
  CLOUD_TEXT_MODELS,
  CLOUD_TEXT_PATHS,
  LUNA_MODEL,
} from "./cloud-text-models.mjs";
import { EMBEDDING_MODELS } from "./embeddings.mjs";
import { Denied } from "./store.mjs";
import { now } from "./crypto.mjs";

export const LOCAL_ASR = "funasr";
export const LOCAL_TTS = "cosyvoice";
const prefix = "public_model:";
const definitions = [
  ...[...CLOUD_TEXT_MODELS].map(([id, model]) => ({
    id,
    name: model.name,
    service: "qwen",
    provider: "openai",
    endpoints: CLOUD_TEXT_PATHS,
  })),
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

async function modelSwitches(store) {
  const rows = await store.all(
    "SELECT name,value FROM settings WHERE (name >= ? AND name < ?) OR name='global_limits'",
    prefix,
    "public_model;",
  );
  const enabled = new Set([LUNA_MODEL]);
  let cloudPaused = false;
  for (const { name, value } of rows) {
    if (name === "global_limits") {
      cloudPaused = JSON.parse(value).cloud_enabled === false;
      continue;
    }
    const id = name.slice(prefix.length);
    if (value === "true") enabled.add(id);
    else enabled.delete(id);
  }
  return { enabled, cloudPaused };
}

export async function discoverableModels(store) {
  const { enabled, cloudPaused } = await modelSwitches(store);
  if (cloudPaused)
    for (const id of enabled)
      if (registry.get(id)?.provider === "openai") enabled.delete(id);
  return enabled;
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

export function validateModelAllowlist(value) {
  if (value === null) return;
  if (
    !Array.isArray(value) ||
    value.length > registry.size ||
    new Set(value).size !== value.length ||
    value.some((id) => !registry.has(id))
  )
    throw new Denied(422, "模型白名单必须为有效的模型 ID 列表或 null");
}

export function filterUserModels(enabled, encoded) {
  if (encoded == null) return enabled;
  return new Set(JSON.parse(encoded).filter((id) => enabled.has(id)));
}

export async function requirePublicModel(store, requested, path, lease) {
  const id = aliases.get(requested) ?? requested;
  const model = registry.get(id);
  if (!model || !model.endpoints.includes(path)) {
    const error = new Denied(422, "此接口不支持指定的模型");
    error.code = "unsupported_model";
    throw error;
  }
  const flag = await store.first(
    "SELECT s.value, (u.allowed_model_ids IS NULL OR EXISTS(SELECT 1 FROM json_each(u.allowed_model_ids) WHERE value=?)) allowed FROM requests r JOIN users u ON u.id=r.user_id LEFT JOIN settings s ON s.name=? WHERE r.id=? AND r.path=? AND r.ended IS NULL AND u.enabled=1 AND u.must_change=0",
    id,
    prefix + id,
    lease,
    path,
  );
  if (!flag) throw new Denied(403, "推理请求凭证已失效");
  if (flag.value === null ? id !== LUNA_MODEL : flag.value !== "true") {
    const error = new Denied(403, "此模型尚未开放或已停用");
    error.code = "model_disabled";
    throw error;
  }
  if (!flag.allowed) {
    const error = new Denied(403, "该账号没有此模型的使用权限");
    error.code = "model_not_allowed";
    throw error;
  }
}

export async function adminModelRoute(request, store, user, readBody) {
  const { pathname } = new URL(request.url);
  if (pathname !== "/admin/models") return null;
  if (request.method === "GET") {
    const { enabled, cloudPaused } = await modelSwitches(store);
    return Response.json(
      {
        models: definitions.map((model) => ({
          ...model,
          enabled: enabled.has(model.id),
          ...(model.provider === "openai" && { cloud_paused: cloudPaused }),
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

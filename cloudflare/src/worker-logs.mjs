// Failure-only, bounded structural diagnostics. Never serialize requests, headers or raw errors.
const MAX_BYTES = 8192,
  encoder = new TextEncoder();
const identifier = (v, max = 128) =>
  typeof v === "string" &&
  v.length <= max &&
  /^[a-zA-Z0-9_.*:/\[\]-]+$/.test(v) &&
  !/(?:^|[^a-z])(?:sk-|ai-at-|ai-rt-|Bearer)/i.test(v)
    ? v
    : null;
const name = (v) =>
  typeof v === "string" &&
  /^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/.test(v) &&
  identifier(v, 64)
    ? v
    : null;
const shape = (v) =>
  v === null ? "null" : Array.isArray(v) ? "array" : typeof v;
const types = new Set([
  "object",
  "array",
  "string",
  "number",
  "integer",
  "boolean",
  "null",
]);
export function schemaValidationHint(message) {
  if (typeof message !== "string") return null;
  const text = message.slice(0, 16000);
  if (/additionalProperties/i.test(text)) return "check_additional_properties";
  if (
    /array[\s\S]*missing[\s\S]*items|items[\s\S]*(required|missing)/i.test(text)
  )
    return "array_items_missing_or_invalid";
  if (/required[\s\S]*(extra|unexpected)|extra[\s\S]*required/i.test(text))
    return "required_contains_unknown_property";
  if (/required/i.test(text)) return "check_required_properties";
  if (/\$ref|reference|definition/i.test(text))
    return "check_schema_references";
  if (/type[\s\S]*object|object[\s\S]*type/i.test(text))
    return "check_root_object_type";
  if (/strict/i.test(text)) return "check_strict_schema";
  if (/schema|parameters/i.test(text)) return "invalid_tool_schema";
  return null;
}
export function toolDiagnostic(payload, param) {
  const match =
    typeof param === "string" &&
    /^tools\[(\d{1,5})\](?:\.function)?(?:\.parameters(?:[.\[].*)?|\.strict)?$/.exec(
      param,
    );
  if (!match || !Array.isArray(payload?.tools)) return null;
  const index = Number(match[1]),
    tool = payload.tools[index];
  if (!tool) return null;
  const f = tool.function ?? tool,
    nodes = [];
  let truncated = false;
  function visit(schema, path, depth = 0) {
    if (nodes.length >= 20 || depth > 5) {
      truncated = true;
      return;
    }
    if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
      nodes.push({ path, schema_kind: shape(schema) });
      return;
    }
    const rawTypes = Array.isArray(schema.type)
      ? schema.type.slice(0, 8)
      : [schema.type];
    const node = {
      path,
      type: rawTypes.filter((t) => types.has(t)),
      has_ref: Object.hasOwn(schema, "$ref"),
    };
    nodes.push(node);
    if (Object.hasOwn(schema, "required")) {
      node.required_kind = shape(schema.required);
      if (Array.isArray(schema.required)) {
        node.required_count = schema.required.length;
        node.required = schema.required
          .slice(0, 12)
          .map((v) => name(v) ?? "[redacted]");
      }
    }
    if (Object.hasOwn(schema, "additionalProperties"))
      node.additional_properties =
        typeof schema.additionalProperties === "boolean"
          ? schema.additionalProperties
          : shape(schema.additionalProperties);
    if (Object.hasOwn(schema, "properties")) {
      node.properties_kind = shape(schema.properties);
      node.properties = [];
      if (
        schema.properties &&
        typeof schema.properties === "object" &&
        !Array.isArray(schema.properties)
      ) {
        let count = 0;
        for (const key in schema.properties) {
          if (!Object.hasOwn(schema.properties, key)) continue;
          if (count++ >= 12) {
            node.properties_truncated = true;
            break;
          }
          const label = name(key) ?? "[redacted]";
          node.properties.push(label);
          visit(
            schema.properties[key],
            path + ".properties." + label,
            depth + 1,
          );
        }
      }
    }
    if (schema.type === "array" || Object.hasOwn(schema, "items")) {
      node.has_items = Object.hasOwn(schema, "items");
      if (node.has_items) visit(schema.items, path + ".items", depth + 1);
    }
    for (const keyword of ["anyOf", "oneOf", "allOf"])
      if (Array.isArray(schema[keyword])) {
        node[keyword + "_count"] = schema[keyword].length;
        schema[keyword]
          .slice(0, 4)
          .forEach((branch, i) =>
            visit(branch, path + "." + keyword + "[" + i + "]", depth + 1),
          );
      }
    // description, enum values, defaults, examples, patterns and reference strings are intentionally omitted.
  }
  visit(f.parameters, "parameters");
  return {
    index,
    name: name(f.name),
    strict: typeof f.strict === "boolean" ? f.strict : null,
    tool_count: payload.tools.length,
    nodes,
    node_limit: 20,
    truncated,
  };
}
export function writeWorkerLog(event, fields = {}, level = "error") {
  const record = { schema: "ai-gateway-log-v1", event };
  for (const key of [
    "request_id",
    "upstream_request_id",
    "path",
    "model",
    "provider",
    "protocol",
    "error_code",
    "upstream_error_code",
    "upstream_error_param",
    "stage",
    "release_sha",
    "error_type",
    "validation_hint",
    "failure_category",
    "operation",
    "smtp_provider",
    "diagnostic_id",
    "kind",
  ]) {
    const value = identifier(fields[key], key === "path" ? 128 : 256);
    if (value !== null) record[key] = value;
  }
  for (const key of [
    "status",
    "upstream_status",
    "duration_ms",
    "episode",
    "occurrences",
  ])
    if (Number.isFinite(fields[key]) && fields[key] >= 0)
      record[key] = fields[key];
  if (fields.details && typeof fields.details === "object")
    record.details = Object.fromEntries(
      Object.entries(fields.details)
        .filter(([k, v]) => /^[a-z_]{1,32}$/.test(k) && Number.isFinite(v))
        .slice(0, 16),
    );
  if (fields.tool_diagnostic) record.tool_diagnostic = fields.tool_diagnostic;
  let text = JSON.stringify(record);
  while (
    encoder.encode(text).length > MAX_BYTES &&
    record.tool_diagnostic?.nodes?.length
  ) {
    record.tool_diagnostic.nodes.pop();
    record.tool_truncated = true;
    text = JSON.stringify(record);
  }
  if (encoder.encode(text).length > MAX_BYTES) {
    delete record.tool_diagnostic;
    record.tool_truncated = true;
    text = JSON.stringify(record);
  }
  console[level === "info" ? "info" : level === "warn" ? "warn" : "error"](
    text,
  );
  return record;
}
export function failureCategory(error) {
  const text =
    typeof error?.message === "string" ? error.message.slice(0, 2048) : "";
  if (/D1_|SQLITE_/i.test(text))
    return /timeout|busy|overload/i.test(text)
      ? "database_busy_or_timeout"
      : /constraint|unique|foreign key/i.test(text)
        ? "database_constraint"
        : "database_error";
  if (error?.name === "TimeoutError") return "timeout";
  if (error?.name === "AbortError") return "aborted";
  if (/network|fetch failed|connection|socket/i.test(text))
    return "network_error";
  return "internal_error";
}
export function logInferenceFailure(trace, error, status) {
  if (trace._failure_logged || status === 499) return;
  if (!Number.isInteger(error?.upstream_status) && status < 500) return;
  trace._failure_logged = true;
  return writeWorkerLog("inference_failure", {
    request_id: trace.request_id,
    path: trace.path,
    model: trace.model,
    provider: trace.provider,
    protocol: trace.protocol,
    release_sha: trace.release_sha,
    status,
    stage: trace.failure_stage,
    error_code: trace.error_code,
    upstream_status: error?.upstream_status ?? trace.upstream_status,
    upstream_request_id:
      error?.upstream_request_id ?? trace.upstream_request_id,
    upstream_error_code:
      error?.upstream_error_code ?? trace.upstream_error_code,
    upstream_error_param:
      error?.upstream_error_param ?? trace.upstream_error_param,
    validation_hint: error?.validation_hint,
    failure_category: Number.isInteger(error?.upstream_status)
      ? "provider_rejection"
      : trace.failure_stage === "response_stream"
        ? "stream_failure"
        : failureCategory(error),
    tool_diagnostic: error?.tool_diagnostic,
    duration_ms: trace.duration_ms,
    error_type: [
      "Error",
      "TypeError",
      "SyntaxError",
      "TimeoutError",
      "AbortError",
      "Denied",
    ].includes(error?.name)
      ? error.name
      : undefined,
  });
}
export function accountPath(path) {
  for (const prefix of ["/auth/", "/account/", "/admin/", "/internal/"])
    if (path.startsWith(prefix)) return prefix + "*";
  return "/unknown";
}

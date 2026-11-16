// Never forward client identity or proxy attribution to the provider.
export function openaiHeaders(apiKey, extra = {}) {
  const headers = new Headers(extra);
  for (const name of [
    "CF-Connecting-IP",
    "X-Forwarded-For",
    "True-Client-IP",
    "Forwarded",
    "X-Real-IP",
    "CF-IPCountry",
    "CF-Ray",
  ])
    headers.delete(name);
  headers.set("Authorization", "Bearer " + apiKey);
  return headers;
}

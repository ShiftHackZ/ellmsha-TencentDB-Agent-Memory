/** Immutable origin-model routing for a background generation job.
 * Contains only a scoped callback capability, never the provider API key.
 */
export interface GenerationLlmContext {
  base_url: string;
  model: string;
  callback_token: string;
}

export function parseGenerationLlmContext(
  value: unknown,
  env: NodeJS.ProcessEnv = process.env,
): Readonly<GenerationLlmContext> | undefined {
  if (value === undefined) {
    if (env.AION_LLM_REQUIRE_CONTEXT === "1") throw new Error("Originating agent model context is required for generation");
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("llm_context must be an object");
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some((key) => !["base_url", "model", "callback_token"].includes(key)) ||
    typeof v.base_url !== "string" || v.base_url.length > 2048 ||
    typeof v.model !== "string" || !v.model.trim() || v.model.length > 256 ||
    typeof v.callback_token !== "string" || v.callback_token.length < 16 || v.callback_token.length > 512 ||
    /[\r\n]/.test(v.callback_token)) throw new Error("Invalid llm_context fields");
  let url: URL;
  try { url = new URL(v.base_url); } catch { throw new Error("Invalid generation callback URL"); }
  const hosts = (env.AION_LLM_CALLBACK_ALLOWED_HOSTS ?? "host.docker.internal,localhost,127.0.0.1,[::1],aionui,aionui-core")
    .split(",").map((host) => host.trim().toLowerCase()).filter(Boolean);
  if (!["http:", "https:"].includes(url.protocol) || !hosts.includes(url.hostname.toLowerCase()) ||
    url.username || url.password || url.search || url.hash ||
    url.pathname.replace(/\/+$/, "") !== "/api/runtime/tencent/v1") {
    throw new Error("Generation callback must use an allowed host and /api/runtime/tencent/v1");
  }
  return Object.freeze({ base_url: v.base_url.replace(/\/+$/, ""), model: v.model.trim(), callback_token: v.callback_token });
}

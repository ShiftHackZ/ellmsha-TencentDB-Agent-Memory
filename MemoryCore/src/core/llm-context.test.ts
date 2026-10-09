import { describe, expect, it } from "vitest";
import { parseGenerationLlmContext } from "./llm-context.js";
const valid = { base_url: "http://host.docker.internal:59215/api/runtime/tencent/v1", model: "origin-model", callback_token: "synthetic-test-capability" };
describe("originating agent generation context", () => {
  it("allows standalone defaults only when origin context is not required", () => {
    expect(parseGenerationLlmContext(undefined, {})).toBeUndefined();
    expect(() => parseGenerationLlmContext(undefined, { AION_LLM_REQUIRE_CONTEXT: "1" })).toThrow("required");
  });
  it("copies and freezes the model snapshot independently of later selection changes", () => {
    const input = { ...valid };
    const result = parseGenerationLlmContext(input, {});
    input.model = "later-selection";
    expect(result?.model).toBe("origin-model");
    expect(Object.isFrozen(result)).toBe(true);
  });
  it.each([
    "https://untrusted.example/api/runtime/tencent/v1",
    "http://localhost/admin", "http://localhost/api/runtime/tencent/v1?redirect=1",
    "http://user:pass@localhost/api/runtime/tencent/v1", "file:///api/runtime/tencent/v1",
  ])("rejects unsupported callback destination %s", (base_url) => {
    expect(() => parseGenerationLlmContext({ ...valid, base_url }, {})).toThrow();
  });
  it("rejects credential-like extra fields and header injection", () => {
    expect(() => parseGenerationLlmContext({ ...valid, provider_api_key: "no" }, {})).toThrow();
    expect(() => parseGenerationLlmContext({ ...valid, callback_token: "invalid-token\r\nAuthorization: x" }, {})).toThrow();
  });
});

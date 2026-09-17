/**
 * Replacement for LiteLLM's model routing.
 *
 * Model strings keep LiteLLM's "<provider>/<model-id>" shape so existing configs and
 * CLI invocations carry over. Each provider package is imported lazily, so a run that
 * only uses Bedrock never loads the OpenAI SDK and vice versa.
 *
 *   bedrock/<id>            Amazon Bedrock. Credentials via the AWS default provider chain
 *                           (env vars, SSO profiles after `aws sso login`, IMDS, ...).
 *                           "bedrock/converse/<id>" is accepted and treated the same.
 *   anthropic/<id>          Anthropic API (ANTHROPIC_API_KEY)
 *   claude-*                Anthropic API, bare id (LiteLLM infers the provider)
 *   gpt-*, o1*, o3*, o4*    OpenAI API, bare id (OPENAI_API_KEY)
 *   openai/<id>             OpenAI-compatible endpoint at --api-base (LiteLLM semantics)
 *   ollama/<id>             Ollama's OpenAI-compatible endpoint at <api-base>/v1
 *   ollama_chat/<id>        same as ollama/
 *   openrouter/<id>         OpenRouter (OPENROUTER_API_KEY)
 */
import type { LanguageModel } from "ai";

export interface ResolvedModel {
  model: LanguageModel;
  provider: string;
  modelId: string;
}

export type ModelResolver = (modelString: string, apiBase: string) => Promise<ResolvedModel>;

export function parseModelString(modelString: string): { provider: string; modelId: string } {
  const slash = modelString.indexOf("/");
  if (slash > 0) {
    const provider = modelString.slice(0, slash);
    let modelId = modelString.slice(slash + 1);
    if (provider === "bedrock" && modelId.startsWith("converse/")) {
      modelId = modelId.slice("converse/".length);
    }
    return { provider, modelId };
  }
  if (/^claude-/.test(modelString)) return { provider: "anthropic", modelId: modelString };
  if (/^(gpt-|o1|o3|o4|chatgpt-)/.test(modelString)) return { provider: "openai", modelId: modelString };
  throw new Error(
    `Cannot infer provider for model "${modelString}". Use "<provider>/<model-id>", e.g. ` +
      `"bedrock/anthropic.claude-sonnet-4-5-20250929-v1:0" or "ollama/qwen2.5-coder:14b".`,
  );
}

export const resolveModel: ModelResolver = async (modelString, apiBase) => {
  const { provider, modelId } = parseModelString(modelString);

  switch (provider) {
    case "bedrock": {
      const { createAmazonBedrock } = await import("@ai-sdk/amazon-bedrock");
      const { fromNodeProviderChain } = await import("@aws-sdk/credential-providers");
      const bedrock = createAmazonBedrock({ credentialProvider: fromNodeProviderChain() });
      return { model: bedrock(modelId), provider, modelId };
    }
    case "anthropic": {
      const { createAnthropic } = await import("@ai-sdk/anthropic");
      return { model: createAnthropic()(modelId), provider, modelId };
    }
    case "openai": {
      // Bare "gpt-4o" -> OpenAI proper. "openai/<id>" -> OpenAI-compatible at api_base,
      // matching how cover-agent passed api_base to LiteLLM for "openai/" models.
      if (modelString.startsWith("openai/")) {
        const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
        const compat = createOpenAICompatible({
          name: "openai-compatible",
          baseURL: apiBase,
          ...(process.env["OPENAI_API_KEY"] ? { apiKey: process.env["OPENAI_API_KEY"] } : {}),
          includeUsage: true,
        });
        return { model: compat(modelId), provider: "openai-compatible", modelId };
      }
      const { createOpenAI } = await import("@ai-sdk/openai");
      return { model: createOpenAI()(modelId), provider, modelId };
    }
    case "ollama":
    case "ollama_chat": {
      const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
      const ollama = createOpenAICompatible({
        name: "ollama",
        baseURL: `${apiBase.replace(/\/+$/, "")}/v1`,
        includeUsage: true,
      });
      return { model: ollama(modelId), provider: "ollama", modelId };
    }
    case "openrouter": {
      const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
      const apiKey = process.env["OPENROUTER_API_KEY"];
      if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set");
      const openrouter = createOpenAICompatible({
        name: "openrouter",
        baseURL: "https://openrouter.ai/api/v1",
        apiKey,
        includeUsage: true,
      });
      return { model: openrouter(modelId), provider, modelId };
    }
    default:
      throw new Error(
        `Provider "${provider}" is not bundled in this port. Supported: bedrock, anthropic, openai, ` +
          `ollama, openrouter. Add an AI SDK provider in src/ai/modelRegistry.ts to extend.`,
      );
  }
};

import {
  type ChatRuntimeConfig,
  DEFAULT_PROVIDER,
  requireConfiguredProvider,
} from "@gemma-agent-pwa/contracts";
import {
  getLmStudioModelCatalog,
  listLmStudioModels,
  streamLmStudioChat,
} from "./lmstudio.js";

export type ProviderChatInput = Parameters<typeof streamLmStudioChat>[0];
export type ProviderChatResult = Awaited<ReturnType<typeof streamLmStudioChat>>;
export type ProviderModelCatalog = Awaited<
  ReturnType<typeof getLmStudioModelCatalog>
>;

interface ProviderAdapter {
  getModelCatalog: () => Promise<ProviderModelCatalog>;
  listModels: () => ReturnType<typeof listLmStudioModels>;
  streamChat: (input: ProviderChatInput) => Promise<ProviderChatResult>;
}

const configuredProviderAdapter: ProviderAdapter = {
  getModelCatalog: getLmStudioModelCatalog,
  listModels: listLmStudioModels,
  streamChat: streamLmStudioChat,
};

export async function streamProviderChat(
  input: ProviderChatInput
): Promise<ProviderChatResult> {
  return getConfiguredAdapter(input.config.provider).streamChat(input);
}

export async function listAvailableModels(
  provider: ChatRuntimeConfig["provider"] = DEFAULT_PROVIDER
) {
  return getConfiguredAdapter(provider).listModels();
}

export async function getProviderModelCatalog(
  provider: ChatRuntimeConfig["provider"] = DEFAULT_PROVIDER
): Promise<ProviderModelCatalog> {
  return getConfiguredAdapter(provider).getModelCatalog();
}

function getConfiguredAdapter(provider: ChatRuntimeConfig["provider"]) {
  requireConfiguredProvider(provider);
  return configuredProviderAdapter;
}

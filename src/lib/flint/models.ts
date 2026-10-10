// ─────────────────────────────────────────────────────────────
// Flint · Model Catalog — multi-provider registry with live
// pricing, context windows, input modes and thinking levels.
// Mirrors prime-agent's compiled catalog + user models.json
// merge behavior (user-defined entries win).
// ─────────────────────────────────────────────────────────────

export interface ProviderEntry {
  id: string
  name: string
  api: string // transport: anthropic-messages | openai-completions | openai-responses
  baseUrl?: string
  keyEnvVar?: string
  firstParty?: boolean
}

export interface ModelEntry {
  id: string
  provider: string
  name: string
  contextK: number // context window in thousands of tokens
  inputs: ('text' | 'image')[]
  thinking: boolean
  inPer1k: number // USD per 1k input tokens
  outPer1k: number // USD per 1k output tokens
  tags: string[]
}

export const THINKING_LEVELS = ['off', 'low', 'medium', 'high'] as const
export type ThinkingLevel = (typeof THINKING_LEVELS)[number]

/** Compiled provider registry (mirrors prime-agent's models_generated.rs). */
export const PROVIDERS: ProviderEntry[] = [
  { id: 'zai', name: 'Z.ai (GLM)', api: 'openai-completions', firstParty: true },
  { id: 'prime-inference', name: 'Prime Inference', api: 'openai-completions', baseUrl: 'https://api.pinference.ai/api/v1', keyEnvVar: 'PRIME_INFERENCE_API_KEY' },
  { id: 'anthropic', name: 'Anthropic', api: 'anthropic-messages', keyEnvVar: 'ANTHROPIC_API_KEY' },
  { id: 'openai', name: 'OpenAI', api: 'openai-responses', keyEnvVar: 'OPENAI_API_KEY' },
  { id: 'google', name: 'Google AI', api: 'openai-completions', keyEnvVar: 'GEMINI_API_KEY' },
  { id: 'deepseek', name: 'DeepSeek', api: 'openai-completions', keyEnvVar: 'DEEPSEEK_API_KEY' },
  { id: 'moonshotai', name: 'Moonshot Kimi', api: 'openai-completions', keyEnvVar: 'MOONSHOT_API_KEY' },
  { id: 'minimax', name: 'MiniMax', api: 'openai-completions', keyEnvVar: 'MINIMAX_API_KEY' },
  { id: 'xai', name: 'xAI Grok', api: 'openai-completions', keyEnvVar: 'XAI_API_KEY' },
  { id: 'mistral', name: 'Mistral', api: 'openai-completions', keyEnvVar: 'MISTRAL_API_KEY' },
  { id: 'groq', name: 'Groq', api: 'openai-completions', keyEnvVar: 'GROQ_API_KEY' },
  { id: 'cerebras', name: 'Cerebras', api: 'openai-completions', keyEnvVar: 'CEREBRAS_API_KEY' },
  { id: 'fireworks', name: 'Fireworks', api: 'openai-completions', keyEnvVar: 'FIREWORKS_API_KEY' },
  { id: 'openrouter', name: 'OpenRouter', api: 'openai-completions', keyEnvVar: 'OPENROUTER_API_KEY' },
  { id: 'huggingface', name: 'Hugging Face', api: 'openai-completions', keyEnvVar: 'HF_API_KEY' },
]

/** Compiled model catalog — new models ship without a client release. */
export const MODEL_CATALOG: ModelEntry[] = [
  // Z.ai GLM (first-party default — powers Flint)
  { id: 'glm-4.7', provider: 'zai', name: 'GLM-4.7', contextK: 128, inputs: ['text'], thinking: true, inPer1k: 0.0005, outPer1k: 0.002, tags: ['default', 'coding'] },
  { id: 'glm-4.7-flash', provider: 'zai', name: 'GLM-4.7 Flash', contextK: 128, inputs: ['text'], thinking: false, inPer1k: 0.0001, outPer1k: 0.0004, tags: ['fast', 'cheap', 'subagent'] },
  { id: 'glm-4.6v', provider: 'zai', name: 'GLM-4.6V', contextK: 64, inputs: ['text', 'image'], thinking: false, inPer1k: 0.0008, outPer1k: 0.002, tags: ['vision'] },
  // Prime Inference (hosted, OpenAI-compatible)
  { id: 'clef-1', provider: 'prime-inference', name: 'Clef (structured decisions)', contextK: 32, inputs: ['text'], thinking: false, inPer1k: 0.0002, outPer1k: 0.0004, tags: ['decision-api'] },
  // Anthropic
  { id: 'claude-opus-4', provider: 'anthropic', name: 'Claude Opus 4', contextK: 200, inputs: ['text', 'image'], thinking: true, inPer1k: 0.015, outPer1k: 0.075, tags: ['frontier'] },
  { id: 'claude-sonnet-4', provider: 'anthropic', name: 'Claude Sonnet 4', contextK: 200, inputs: ['text', 'image'], thinking: true, inPer1k: 0.003, outPer1k: 0.015, tags: ['balanced'] },
  { id: 'claude-haiku-4', provider: 'anthropic', name: 'Claude Haiku 4', contextK: 200, inputs: ['text', 'image'], thinking: false, inPer1k: 0.001, outPer1k: 0.005, tags: ['fast'] },
  // OpenAI
  { id: 'gpt-5', provider: 'openai', name: 'GPT-5', contextK: 200, inputs: ['text', 'image'], thinking: true, inPer1k: 0.005, outPer1k: 0.02, tags: ['frontier'] },
  { id: 'gpt-5-mini', provider: 'openai', name: 'GPT-5 mini', contextK: 200, inputs: ['text', 'image'], thinking: false, inPer1k: 0.0004, outPer1k: 0.0016, tags: ['cheap'] },
  { id: 'o4-mini', provider: 'openai', name: 'o4-mini', contextK: 200, inputs: ['text', 'image'], thinking: true, inPer1k: 0.0011, outPer1k: 0.0044, tags: ['reasoning'] },
  // Google
  { id: 'gemini-3-pro', provider: 'google', name: 'Gemini 3 Pro', contextK: 1000, inputs: ['text', 'image'], thinking: true, inPer1k: 0.00125, outPer1k: 0.01, tags: ['long-context'] },
  { id: 'gemini-3-flash', provider: 'google', name: 'Gemini 3 Flash', contextK: 1000, inputs: ['text', 'image'], thinking: false, inPer1k: 0.0001, outPer1k: 0.0004, tags: ['fast', 'cheap'] },
  // DeepSeek
  { id: 'deepseek-v4', provider: 'deepseek', name: 'DeepSeek V4', contextK: 128, inputs: ['text'], thinking: true, inPer1k: 0.00027, outPer1k: 0.0011, tags: ['coding', 'value'] },
  { id: 'deepseek-r2', provider: 'deepseek', name: 'DeepSeek R2', contextK: 128, inputs: ['text'], thinking: true, inPer1k: 0.00055, outPer1k: 0.0022, tags: ['reasoning'] },
  // Kimi
  { id: 'kimi-k3', provider: 'moonshotai', name: 'Kimi K3', contextK: 256, inputs: ['text'], thinking: true, inPer1k: 0.0006, outPer1k: 0.0025, tags: ['long-horizon'] },
  // MiniMax
  { id: 'minimax-m2.5', provider: 'minimax', name: 'MiniMax M2.5', contextK: 200, inputs: ['text'], thinking: true, inPer1k: 0.0003, outPer1k: 0.0012, tags: ['value'] },
  // xAI
  { id: 'grok-5', provider: 'xai', name: 'Grok 5', contextK: 256, inputs: ['text', 'image'], thinking: true, inPer1k: 0.003, outPer1k: 0.015, tags: ['frontier'] },
  // Mistral
  { id: 'mistral-large-3', provider: 'mistral', name: 'Mistral Large 3', contextK: 128, inputs: ['text'], thinking: false, inPer1k: 0.002, outPer1k: 0.006, tags: ['eu'] },
  // Groq (fast inference)
  { id: 'llama-4-scout-groq', provider: 'groq', name: 'Llama 4 Scout (Groq)', contextK: 128, inputs: ['text', 'image'], thinking: false, inPer1k: 0.00011, outPer1k: 0.00034, tags: ['fastest'] },
  // OpenRouter (gateway)
  { id: 'auto-router', provider: 'openrouter', name: 'Auto Router', contextK: 200, inputs: ['text', 'image'], thinking: false, inPer1k: 0.001, outPer1k: 0.003, tags: ['gateway'] },
]

const g = globalThis as unknown as { __flintUserModels?: Map<string, ModelEntry> }

/** User-defined models (models.json merge) — override built-ins by id. */
export function registerUserModel(entry: ModelEntry): void {
  const m = g.__flintUserModels ?? (g.__flintUserModels = new Map())
  m.set(entry.id, entry)
}

export function findModel(id: string): ModelEntry {
  const user = g.__flintUserModels?.get(id)
  if (user) return user
  return MODEL_CATALOG.find((m) => m.id === id) ?? MODEL_CATALOG[0]
}

export function listModels(): ModelEntry[] {
  const merged = new Map<string, ModelEntry>()
  for (const m of MODEL_CATALOG) merged.set(m.id, m)
  if (g.__flintUserModels) for (const [id, m] of g.__flintUserModels) merged.set(id, m)
  return [...merged.values()]
}

export function modelCost(modelId: string, tokensIn: number, tokensOut: number): number {
  const m = findModel(modelId)
  return (tokensIn / 1000) * m.inPer1k + (tokensOut / 1000) * m.outPer1k
}

export const DEFAULT_MODEL = 'glm-4.7'
export const DEFAULT_SUBAGENT_MODEL = 'glm-4.7-flash' // cheap fast subagents
export const DEFAULT_AUX_MODEL = 'glm-4.7-flash' // compaction/refine planner

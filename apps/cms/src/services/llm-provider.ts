/**
 * LLM Provider abstraction — POST-GA Task #1.
 *
 * Provides a unified interface to call OpenAI, Anthropic, Gemini, or Workers AI
 * for intent analysis in the AI Copilot. Each provider formats the
 * CORE_SKILLS as tool definitions in its native schema and returns
 * structured tool calls.
 *
 * Configuration:
 *   LLM_PROVIDER = 'openai' | 'anthropic' | 'claude' | 'gemini' | 'nvidia'
 *                | 'vertex' | 'workers-ai' | 'echo'
 *   LLM_MODEL          — optional provider-specific model override
 *   OPENAI_API_KEY       — required when LLM_PROVIDER = 'openai'
 *   ANTHROPIC_API_KEY    — required when LLM_PROVIDER = 'anthropic' or 'claude'
 *   GEMINI_API_KEY       — required when LLM_PROVIDER = 'gemini'
 *   NVIDIA_API_KEY       — required when LLM_PROVIDER = 'nvidia'
 *   VERTEX_ACCESS_TOKEN  — required when LLM_PROVIDER = 'vertex' (+ VERTEX_PROJECT_ID)
 *   WORKERS_AI_GATEWAY   — optional Workers AI gateway URL
 *
 * The `echo` provider is a no-LLM fallback that uses the legacy keyword
 * matcher (backward compat with the mock parser).
 */

import { CORE_SKILLS } from '@lumibase/ai-skills';
import type { AISkillDefinition } from '@lumibase/ai-skills';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface LLMResponse {
  content: string | null;
  toolCalls: LLMToolCall[];
}

export interface LLMProvider {
  chat(messages: LLMMessage[]): Promise<LLMResponse>;
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are the LumiBase AI Copilot — an assistant embedded in a headless CMS admin panel.
Your job is to help users manage their content, collections, and schema through natural language.

Rules:
- When the user asks you to perform an action, call the appropriate tool.
- If you cannot determine the action, respond with a helpful message asking for clarification.
- Never fabricate data. If you need information, use the list tools first.
- Be concise. Respond in the same language as the user.
- For dangerous operations (delete, schema changes), explain what will happen before calling the tool.`;

// ---------------------------------------------------------------------------
// Helpers — convert CORE_SKILLS to provider-specific tool schemas
// ---------------------------------------------------------------------------

interface OpenAITool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: AISkillDefinition['parameters'];
  };
}

function skillsToOpenAITools(): OpenAITool[] {
  return (Object.values(CORE_SKILLS) as AISkillDefinition[]).map((skill) => ({
    type: 'function' as const,
    function: {
      name: skill.name,
      description: skill.description,
      parameters: skill.parameters,
    },
  }));
}

interface AnthropicTool {
  name: string;
  description: string;
  input_schema: AISkillDefinition['parameters'];
}

function skillsToAnthropicTools(): AnthropicTool[] {
  return (Object.values(CORE_SKILLS) as AISkillDefinition[]).map((skill) => ({
    name: skill.name,
    description: skill.description,
    input_schema: skill.parameters,
  }));
}

interface GeminiFunctionDeclaration {
  name: string;
  description: string;
  parameters: AISkillDefinition['parameters'];
}

function skillsToGeminiFunctionDeclarations(): GeminiFunctionDeclaration[] {
  return (Object.values(CORE_SKILLS) as AISkillDefinition[]).map((skill) => ({
    name: skill.name,
    description: skill.description,
    parameters: skill.parameters,
  }));
}

function normalizeGeminiModel(model: string): string {
  return model.startsWith('models/') ? model.slice('models/'.length) : model;
}

/**
 * Shape of a Gemini `:generateContent` response — identical for the public
 * Generative Language API and for Vertex AI, which is why both providers can
 * share {@link parseGeminiResponse}.
 */
interface GeminiGenerateContentResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
        functionCall?: {
          name?: string;
          args?: Record<string, unknown>;
        };
      }>;
    };
  }>;
}

/**
 * Builds the `:generateContent` request body shared by the public Gemini API
 * and Vertex AI: system instruction, mapped turns, and CORE_SKILLS exposed as
 * function declarations with automatic function-calling.
 */
function buildGeminiRequestBody(messages: LLMMessage[]): Record<string, unknown> {
  const contents = messages.map((message) => ({
    role: message.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: message.content }],
  }));

  return {
    systemInstruction: {
      parts: [{ text: SYSTEM_PROMPT }],
    },
    contents,
    tools: [
      {
        functionDeclarations: skillsToGeminiFunctionDeclarations(),
      },
    ],
    toolConfig: {
      functionCallingConfig: {
        mode: 'AUTO',
      },
    },
    generationConfig: {
      maxOutputTokens: 1024,
    },
  };
}

/** Extracts text content and tool calls from a Gemini/Vertex response. */
function parseGeminiResponse(data: GeminiGenerateContentResponse): LLMResponse {
  const parts = data.candidates?.[0]?.content?.parts ?? [];
  const content =
    parts
      .map((part) => part.text)
      .filter((text): text is string => typeof text === 'string')
      .join('\n') || null;
  const toolCalls: LLMToolCall[] = parts
    .map((part) => part.functionCall)
    .filter((call): call is { name: string; args?: Record<string, unknown> } =>
      typeof call?.name === 'string',
    )
    .map((call) => ({
      name: call.name,
      arguments: call.args ?? {},
    }));

  return { content, toolCalls };
}

// ---------------------------------------------------------------------------
// OpenAI Provider
// ---------------------------------------------------------------------------

export class OpenAIProvider implements LLMProvider {
  protected readonly apiKey: string;
  protected readonly model: string;
  /** API root without a trailing slash. `/chat/completions` is appended per call. */
  protected readonly baseUrl: string;
  /** Human-readable provider name used in error messages. */
  protected readonly label: string;

  constructor(
    apiKey: string,
    model = 'gpt-4o-mini',
    baseUrl = 'https://api.openai.com/v1',
    label = 'OpenAI',
  ) {
    this.apiKey = apiKey;
    this.model = model;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.label = label;
  }

  async chat(messages: LLMMessage[]): Promise<LLMResponse> {
    const body = {
      model: this.model,
      messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...messages],
      tools: skillsToOpenAITools(),
      tool_choice: 'auto',
      max_tokens: 1024,
    };

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text().catch(() => 'Unknown error');
      throw new Error(`${this.label} API error ${res.status}: ${err}`);
    }

    const data = (await res.json()) as {
      choices: Array<{
        message: {
          content?: string | null;
          tool_calls?: Array<{
            function: { name: string; arguments: string };
          }>;
        };
      }>;
    };

    const choice = data.choices[0]?.message;
    const toolCalls: LLMToolCall[] =
      choice?.tool_calls?.map((tc) => ({
        name: tc.function.name,
        arguments: JSON.parse(tc.function.arguments) as Record<string, unknown>,
      })) ?? [];

    return {
      content: choice?.content ?? null,
      toolCalls,
    };
  }
}

// ---------------------------------------------------------------------------
// NVIDIA Provider
// ---------------------------------------------------------------------------

/**
 * NVIDIA hosted inference (build.nvidia.com / NVIDIA NIM). The endpoint is
 * OpenAI-compatible, so this reuses {@link OpenAIProvider} end-to-end and only
 * swaps the base URL, the default model, and the error label.
 *
 * Note: this calls NVIDIA's hosted API — it is billed by NVIDIA, not by AWS.
 * Self-hosting a NIM container on an AWS GPU instance also exposes the same
 * OpenAI-compatible surface; point `NVIDIA_BASE_URL` at that container instead.
 *
 * `[Inference]` The default model id is a commonly-available NIM model but the
 * live catalogue changes over time — override with `LLM_MODEL` as needed.
 */
export class NvidiaProvider extends OpenAIProvider {
  constructor(
    apiKey: string,
    model = 'meta/llama-3.1-8b-instruct',
    baseUrl = 'https://integrate.api.nvidia.com/v1',
  ) {
    super(apiKey, model, baseUrl, 'NVIDIA');
  }
}

// ---------------------------------------------------------------------------
// Anthropic Provider
// ---------------------------------------------------------------------------

export class AnthropicProvider implements LLMProvider {
  private readonly apiKey: string;
  private readonly model: string;

  constructor(apiKey: string, model = 'claude-sonnet-4-20250514') {
    this.apiKey = apiKey;
    this.model = model;
  }

  async chat(messages: LLMMessage[]): Promise<LLMResponse> {
    // Anthropic separates system from messages
    const userMessages = messages.map((m) => ({
      role: m.role === 'system' ? ('user' as const) : m.role,
      content: m.content,
    }));

    const body = {
      model: this.model,
      system: SYSTEM_PROMPT,
      messages: userMessages,
      tools: skillsToAnthropicTools(),
      max_tokens: 1024,
    };

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text().catch(() => 'Unknown error');
      throw new Error(`Anthropic API error ${res.status}: ${err}`);
    }

    const data = (await res.json()) as {
      content: Array<
        | { type: 'text'; text: string }
        | { type: 'tool_use'; name: string; input: Record<string, unknown> }
      >;
    };

    let content: string | null = null;
    const toolCalls: LLMToolCall[] = [];

    for (const block of data.content) {
      if (block.type === 'text') {
        content = block.text;
      } else if (block.type === 'tool_use') {
        toolCalls.push({ name: block.name, arguments: block.input });
      }
    }

    return { content, toolCalls };
  }
}

// ---------------------------------------------------------------------------
// Gemini Provider
// ---------------------------------------------------------------------------

export class GeminiProvider implements LLMProvider {
  private readonly apiKey: string;
  private readonly model: string;

  constructor(apiKey: string, model = 'gemini-3.5-flash') {
    this.apiKey = apiKey;
    this.model = normalizeGeminiModel(model);
  }

  async chat(messages: LLMMessage[]): Promise<LLMResponse> {
    const body = buildGeminiRequestBody(messages);

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': this.apiKey,
        },
        body: JSON.stringify(body),
      },
    );

    if (!res.ok) {
      const err = await res.text().catch(() => 'Unknown error');
      throw new Error(`Gemini API error ${res.status}: ${err}`);
    }

    const data = (await res.json()) as GeminiGenerateContentResponse;
    return parseGeminiResponse(data);
  }
}

// ---------------------------------------------------------------------------
// Vertex AI Provider (Google Cloud)
// ---------------------------------------------------------------------------

/**
 * Google Cloud Vertex AI. Serves the same Gemini models via the same
 * `:generateContent` contract as the public Gemini API, so this reuses
 * {@link buildGeminiRequestBody} and {@link parseGeminiResponse}; only the
 * endpoint and the auth scheme differ.
 *
 * Vertex is a Google Cloud service — it is billed against GCP, NOT AWS credit.
 *
 * Auth: Vertex uses OAuth 2.0 bearer tokens rather than a static API key. The
 * simplest path for evaluation is a short-lived access token
 * (`gcloud auth print-access-token`) supplied via `VERTEX_ACCESS_TOKEN`. Tokens
 * expire (~1h), so for long-running deployments mint one from a service account
 * and refresh it out-of-band. Requires `VERTEX_PROJECT_ID`; `VERTEX_LOCATION`
 * defaults to `us-central1`.
 */
export class VertexProvider implements LLMProvider {
  private readonly accessToken: string;
  private readonly projectId: string;
  private readonly location: string;
  private readonly model: string;

  constructor(opts: {
    accessToken: string;
    projectId: string;
    location?: string;
    model?: string;
  }) {
    this.accessToken = opts.accessToken;
    this.projectId = opts.projectId;
    this.location = opts.location || 'us-central1';
    this.model = normalizeGeminiModel(opts.model ?? 'gemini-3.5-flash');
  }

  async chat(messages: LLMMessage[]): Promise<LLMResponse> {
    const body = buildGeminiRequestBody(messages);

    const url =
      `https://${this.location}-aiplatform.googleapis.com/v1/projects/` +
      `${this.projectId}/locations/${this.location}/publishers/google/models/` +
      `${this.model}:generateContent`;

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.accessToken}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text().catch(() => 'Unknown error');
      throw new Error(`Vertex AI API error ${res.status}: ${err}`);
    }

    const data = (await res.json()) as GeminiGenerateContentResponse;
    return parseGeminiResponse(data);
  }
}

// ---------------------------------------------------------------------------
// Workers AI Provider
// ---------------------------------------------------------------------------

export class WorkersAIProvider implements LLMProvider {
  private readonly accountId: string;
  private readonly apiToken: string;
  private readonly model: string;
  private readonly gatewayUrl?: string;

  constructor(opts: {
    accountId: string;
    apiToken: string;
    model?: string;
    gatewayUrl?: string;
  }) {
    this.accountId = opts.accountId;
    this.apiToken = opts.apiToken;
    this.model = opts.model ?? '@cf/meta/llama-3.1-8b-instruct';
    this.gatewayUrl = opts.gatewayUrl;
  }

  async chat(messages: LLMMessage[]): Promise<LLMResponse> {
    const allMessages = [{ role: 'system' as const, content: SYSTEM_PROMPT }, ...messages];

    // Workers AI tool calling: pass tools in the request body
    const tools = skillsToOpenAITools(); // Workers AI uses OpenAI-compatible format

    const url =
      this.gatewayUrl ??
      `https://api.cloudflare.com/client/v4/accounts/${this.accountId}/ai/run/${this.model}`;

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiToken}`,
      },
      body: JSON.stringify({ messages: allMessages, tools }),
    });

    if (!res.ok) {
      const err = await res.text().catch(() => 'Unknown error');
      throw new Error(`Workers AI error ${res.status}: ${err}`);
    }

    const data = (await res.json()) as {
      result?: {
        response?: string;
        tool_calls?: Array<{
          name: string;
          arguments: Record<string, unknown> | string;
        }>;
      };
    };

    const toolCalls: LLMToolCall[] =
      data.result?.tool_calls?.map((tc) => ({
        name: tc.name,
        arguments:
          typeof tc.arguments === 'string'
            ? (JSON.parse(tc.arguments) as Record<string, unknown>)
            : tc.arguments,
      })) ?? [];

    return {
      content: data.result?.response ?? null,
      toolCalls,
    };
  }
}

// ---------------------------------------------------------------------------
// Echo Provider (backward-compat mock — keyword matching)
// ---------------------------------------------------------------------------

export class EchoProvider implements LLMProvider {
  async chat(messages: LLMMessage[]): Promise<LLMResponse> {
    const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user');
    if (!lastUserMsg) {
      return { content: 'No message received.', toolCalls: [] };
    }

    const lower = lastUserMsg.content.toLowerCase();

    // Simple keyword-based intent matching (legacy behavior)
    if (lower.includes('list collections') || lower.includes('show collections')) {
      return { content: null, toolCalls: [{ name: 'listCollections', arguments: {} }] };
    }

    if (lower.includes('create collection')) {
      const nameMatch = lastUserMsg.content.match(/create collection\s+["']?(\w+)["']?/i);
      return {
        content: null,
        toolCalls: [{ name: 'createCollection', arguments: { name: nameMatch?.[1] ?? 'untitled' } }],
      };
    }

    if (lower.includes('delete collection')) {
      const nameMatch = lastUserMsg.content.match(/delete collection\s+["']?(\w+)["']?/i);
      return {
        content: null,
        toolCalls: [{ name: 'deleteCollection', arguments: { name: nameMatch?.[1] ?? '' } }],
      };
    }

    if (lower.includes('list items') || lower.includes('show items')) {
      const collMatch = lastUserMsg.content.match(
        /(?:list|show) items\s+(?:in|from|of)\s+["']?(\w+)["']?/i,
      );
      return {
        content: null,
        toolCalls: [{ name: 'listItems', arguments: { collection: collMatch?.[1] ?? '' } }],
      };
    }

    if (lower.includes('create item')) {
      const collMatch = lastUserMsg.content.match(/create item\s+(?:in|for)\s+["']?(\w+)["']?/i);
      return {
        content: null,
        toolCalls: [{ name: 'createItem', arguments: { collection: collMatch?.[1] ?? '' } }],
      };
    }

    if (lower.includes('delete item')) {
      const idMatch = lastUserMsg.content.match(/delete item\s+["']?(\w+)["']?/i);
      return {
        content: null,
        toolCalls: [{ name: 'deleteItem', arguments: { id: idMatch?.[1] ?? '' } }],
      };
    }

    return {
      content: 'Could not determine action from your message.',
      toolCalls: [],
    };
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface LLMProviderEnv {
  LLM_PROVIDER?: string;
  LLM_MODEL?: string;
  OPENAI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  GEMINI_API_KEY?: string;
  NVIDIA_API_KEY?: string;
  /** Optional NVIDIA endpoint override (e.g. a self-hosted NIM container). */
  NVIDIA_BASE_URL?: string;
  /** OAuth 2.0 bearer for Vertex AI (e.g. `gcloud auth print-access-token`). */
  VERTEX_ACCESS_TOKEN?: string;
  /** Google Cloud project id that owns the Vertex AI models. */
  VERTEX_PROJECT_ID?: string;
  /** Vertex AI region. Defaults to `us-central1`. */
  VERTEX_LOCATION?: string;
  WORKERS_AI_ACCOUNT_ID?: string;
  WORKERS_AI_API_TOKEN?: string;
  WORKERS_AI_GATEWAY?: string;
}

/**
 * Creates the appropriate LLM provider based on environment config.
 * Falls back to `EchoProvider` when no provider is configured.
 */
export function createLLMProvider(env: LLMProviderEnv): LLMProvider {
  const provider = env.LLM_PROVIDER ?? 'echo';

  switch (provider) {
    case 'openai': {
      if (!env.OPENAI_API_KEY) {
        console.warn('[llm] OPENAI_API_KEY not set, falling back to echo provider');
        return new EchoProvider();
      }
      return new OpenAIProvider(env.OPENAI_API_KEY, env.LLM_MODEL);
    }

    case 'anthropic': {
      if (!env.ANTHROPIC_API_KEY) {
        console.warn('[llm] ANTHROPIC_API_KEY not set, falling back to echo provider');
        return new EchoProvider();
      }
      return new AnthropicProvider(env.ANTHROPIC_API_KEY, env.LLM_MODEL);
    }

    case 'claude': {
      if (!env.ANTHROPIC_API_KEY) {
        console.warn('[llm] ANTHROPIC_API_KEY not set, falling back to echo provider');
        return new EchoProvider();
      }
      return new AnthropicProvider(env.ANTHROPIC_API_KEY, env.LLM_MODEL);
    }

    case 'gemini': {
      if (!env.GEMINI_API_KEY) {
        console.warn('[llm] GEMINI_API_KEY not set, falling back to echo provider');
        return new EchoProvider();
      }
      return new GeminiProvider(env.GEMINI_API_KEY, env.LLM_MODEL);
    }

    case 'nvidia': {
      if (!env.NVIDIA_API_KEY) {
        console.warn('[llm] NVIDIA_API_KEY not set, falling back to echo provider');
        return new EchoProvider();
      }
      return new NvidiaProvider(
        env.NVIDIA_API_KEY,
        env.LLM_MODEL,
        env.NVIDIA_BASE_URL ?? undefined,
      );
    }

    case 'vertex': {
      if (!env.VERTEX_ACCESS_TOKEN || !env.VERTEX_PROJECT_ID) {
        console.warn(
          '[llm] VERTEX_ACCESS_TOKEN / VERTEX_PROJECT_ID not set, falling back to echo provider',
        );
        return new EchoProvider();
      }
      return new VertexProvider({
        accessToken: env.VERTEX_ACCESS_TOKEN,
        projectId: env.VERTEX_PROJECT_ID,
        location: env.VERTEX_LOCATION,
        model: env.LLM_MODEL,
      });
    }

    case 'workers-ai': {
      if (!env.WORKERS_AI_ACCOUNT_ID || !env.WORKERS_AI_API_TOKEN) {
        console.warn('[llm] Workers AI credentials not set, falling back to echo provider');
        return new EchoProvider();
      }
      return new WorkersAIProvider({
        accountId: env.WORKERS_AI_ACCOUNT_ID,
        apiToken: env.WORKERS_AI_API_TOKEN,
        model: env.LLM_MODEL,
        gatewayUrl: env.WORKERS_AI_GATEWAY,
      });
    }

    default:
      return new EchoProvider();
  }
}

// ---------------------------------------------------------------------------
// Configured provider resolution (no silent echo fallback)
// ---------------------------------------------------------------------------

const PROVIDER_DEFAULT_MODELS: Record<string, string> = {
  openai: 'gpt-4o-mini',
  anthropic: 'claude-sonnet-4-20250514',
  claude: 'claude-sonnet-4-20250514',
  gemini: 'gemini-3.5-flash',
  nvidia: 'meta/llama-3.1-8b-instruct',
  vertex: 'gemini-3.5-flash',
  'workers-ai': '@cf/meta/llama-3.1-8b-instruct',
};

export interface ConfiguredLLM {
  provider: LLMProvider;
  /** Provider name from LLM_PROVIDER (e.g. 'openai'). */
  name: string;
  /** Resolved model identifier, recorded in run metrics and provenance. */
  model: string;
}

/**
 * Resolves a real LLM provider from the environment, or `null` when none is
 * configured. Unlike `createLLMProvider`, this never falls back to the echo
 * provider — generation skills use it to fail loudly (LLM_NOT_CONFIGURED)
 * instead of silently returning stub output.
 */
export function createConfiguredLLMProvider(env: LLMProviderEnv): ConfiguredLLM | null {
  const name = env.LLM_PROVIDER;
  if (!name || name === 'echo') return null;

  const hasCredentials =
    (name === 'openai' && Boolean(env.OPENAI_API_KEY)) ||
    ((name === 'anthropic' || name === 'claude') && Boolean(env.ANTHROPIC_API_KEY)) ||
    (name === 'gemini' && Boolean(env.GEMINI_API_KEY)) ||
    (name === 'nvidia' && Boolean(env.NVIDIA_API_KEY)) ||
    (name === 'vertex' && Boolean(env.VERTEX_ACCESS_TOKEN) && Boolean(env.VERTEX_PROJECT_ID)) ||
    (name === 'workers-ai' && Boolean(env.WORKERS_AI_ACCOUNT_ID) && Boolean(env.WORKERS_AI_API_TOKEN));
  if (!hasCredentials) return null;

  return {
    provider: createLLMProvider(env),
    name,
    model: env.LLM_MODEL ?? PROVIDER_DEFAULT_MODELS[name] ?? 'default',
  };
}

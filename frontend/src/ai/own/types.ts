/** What the two wire formats of `ai/own/` (Anthropic, OpenAI-compatible) both offer. */

export interface ChatCall {
  system: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
}

/** One structured call: the prompt, its JSON schema, and `read`, which turns the raw JSON into the result or throws `invalid_output`. */
export interface JsonCall<T> {
  /** A short name for the schema (the OpenAI format requires one). */
  name: string;
  system: string;
  user: string;
  schema: object;
  read(raw: unknown): T;
}

/**
 * How a connection gets JSON: `schema` = the API constrains the answer to the schema (Anthropic
 * `output_config.format`, OpenAI `response_format: json_schema`); `prompt` = the schema is in the
 * prompt and the answer is parsed, for endpoints without schema support.
 */
export type JsonMode = 'schema' | 'prompt';

export interface ModelApi {
  chat(call: ChatCall, onDelta: (text: string) => void, signal: AbortSignal): Promise<{ text: string; model: string }>;
  json<T>(call: JsonCall<T>, signal: AbortSignal): Promise<{ value: T; mode: JsonMode; model: string }>;
  /** The endpoint's model ids (`GET …/models`). */
  models(signal?: AbortSignal): Promise<string[]>;
}

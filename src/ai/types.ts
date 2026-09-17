export interface Prompt {
  system: string;
  user: string;
}

export interface ModelResponse {
  content: string;
  promptTokens: number;
  completionTokens: number;
}

/**
 * Python's AICaller.call_model discovered the caller name by walking the stack
 * (utils.get_original_caller). Here the caller passes it explicitly. The names are the
 * snake_case method names of DefaultAgentCompletion so record files stay compatible.
 */
export interface ModelCaller {
  callModel(prompt: Prompt, callerName: string, options?: { stream?: boolean }): Promise<ModelResponse>;
}

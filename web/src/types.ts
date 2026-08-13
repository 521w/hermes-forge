export interface ToolCallMeta {
  name: string;
  arguments: string;
  result?: string;
  status?: "running" | "done" | "error";
}

export interface MessageMeta {
  plan?: string;
  verdict?: string;
  todos?: string[];
  todoState?: string[];
  toolCalls?: ToolCallMeta[];
}

export interface Message {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  mode?: "single" | "crew";
  meta?: MessageMeta;
  ts: number;
}

export interface SessionSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

export interface Session extends SessionSummary {
  messages: Message[];
}

export interface Settings {
  llmBaseUrl: string;
  llmModel: string;
  hasKey: boolean;
  defaultSystem: string;
  maxTokens: number;
  temperature: number;
}

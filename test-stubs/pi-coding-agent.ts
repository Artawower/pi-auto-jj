import { homedir } from "node:os";
import { join } from "node:path";

export function getAgentDir(): string {
  return join(homedir(), ".pi", "agent");
}

export function isToolCallEventType(toolName: string, event: unknown): boolean {
  return (event as { toolName?: string })?.toolName === toolName;
}

export type ExecResult = { stdout: string; exitCode: number };

export interface ExtensionContext {
  cwd: string;
  hasUI?: boolean;
  signal?: AbortSignal;
  ui?: {
    notify: (msg: string, kind?: "info" | "warning" | "error") => void;
    setStatus: (id: string, text: string) => void;
  };
}

export interface ExtensionAPI {
  on: (event: string, handler: (...args: any[]) => any) => void;
  exec?: (command: string, args: string[], options?: unknown) => Promise<ExecResult>;
}

export interface ToolCallEvent {
  toolName: string;
  toolCallId?: string;
  input: Record<string, unknown>;
}

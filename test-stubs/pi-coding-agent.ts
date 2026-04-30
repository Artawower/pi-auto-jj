import { homedir } from "node:os";
import { join } from "node:path";

export function getAgentDir(): string {
  return join(homedir(), ".pi", "agent");
}

export function isToolCallEventType(toolName: string, event: any): boolean {
  return event?.toolName === toolName;
}

export type ExecResult = { stdout: string; exitCode: number };
export type ExtensionAPI = any;
export type ToolCallEvent = any;

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@mariozechner/pi-coding-agent";

export interface JjAutoRevConfig {
  enabled: boolean;
  blockOnMismatch: boolean;
  autoDescribe: boolean;
  maxPromptLength: number;
}

const DEFAULT_CONFIG: JjAutoRevConfig = {
  enabled: true,
  blockOnMismatch: true,
  autoDescribe: true,
  maxPromptLength: 72,
};

function readConfigFile(filePath: string): Record<string, unknown> {
  if (!existsSync(filePath)) return {};
  try {
    return JSON.parse(readFileSync(filePath, "utf-8"));
  } catch (err) {
    console.error(`[pi-jj-auto] Failed to read config ${filePath}: ${err}`);
    return {};
  }
}

function validateConfig(raw: Record<string, unknown>): JjAutoRevConfig {
  return {
    enabled: raw.enabled === false ? false : true,
    blockOnMismatch: raw.blockOnMismatch === false ? false : true,
    autoDescribe: raw.autoDescribe === false ? false : true,
    maxPromptLength:
      typeof raw.maxPromptLength === "number" && raw.maxPromptLength > 0
        ? Math.min(raw.maxPromptLength, 500)
        : DEFAULT_CONFIG.maxPromptLength,
  };
}

export function loadConfig(cwd: string): JjAutoRevConfig {
  const globalPath = join(getAgentDir(), "pi-jj-auto.json");
  const projectPath = join(cwd, ".pi", "pi-jj-auto.json");

  const globalConfig = readConfigFile(globalPath);
  const projectConfig = readConfigFile(projectPath);

  const merged = { ...globalConfig, ...projectConfig };
  return validateConfig(merged);
}

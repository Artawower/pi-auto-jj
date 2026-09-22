import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@mariozechner/pi-coding-agent";

export interface Config {
  readonly enabled: boolean;
  readonly blockOnMismatch: boolean;
  readonly autoDescribe: boolean;
  readonly maxPromptLength: number;
}

const MAX_PROMPT_LENGTH = 500;

const DEFAULTS: Config = {
  enabled: true,
  blockOnMismatch: true,
  autoDescribe: true,
  maxPromptLength: 72,
};

export function loadConfig(cwd: string, agentDir?: string): Config {
  const globalDir = agentDir ?? getAgentDir();
  const global = readJsonFile(join(globalDir, "pi-jj-auto.json"));
  const project = readJsonFile(join(cwd, ".pi", "pi-jj-auto.json"));
  return parseConfig({ ...global, ...project });
}

function readJsonFile(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    console.error(`[pi-jj-auto] failed to parse config ${path}:`, err);
    return {};
  }
}

function parseConfig(raw: Record<string, unknown>): Config {
  return {
    enabled: raw.enabled !== false,
    blockOnMismatch: raw.blockOnMismatch !== false,
    autoDescribe: raw.autoDescribe !== false,
    maxPromptLength: parsePositiveInt(
      raw.maxPromptLength,
      DEFAULTS.maxPromptLength,
      MAX_PROMPT_LENGTH,
    ),
  };
}

export function parsePositiveInt(
  value: unknown,
  fallback: number,
  max: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const integer = Math.floor(value);
  if (integer <= 0) return fallback;
  return Math.min(integer, max);
}

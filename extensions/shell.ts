export type ShellCommandClassification =
  | { kind: "safe" }
  | { kind: "jj-readonly" }
  | { kind: "jj-resolution"; resolutionType: "desc" | "new" }
  | { kind: "guarded" };

const SAFE_READONLY_COMMANDS = new Set([
  "cat",
  "head",
  "tail",
  "grep",
  "egrep",
  "fgrep",
  "rg",
  "ag",
  "wc",
  "diff",
  "cmp",
  "file",
  "ls",
  "pwd",
  "dir",
  "cd",
  "echo",
  "printf",
  "true",
  "false",
  "test",
  "which",
  "where",
  "type",
  "printenv",
]);

const JJ_READONLY_SUBS = new Set([
  "log",
  "status",
  "st",
  "diff",
  "root",
  "show",
  "file",
  "cat",
]);

const GIT_READONLY_SUBS = new Set([
  "status",
  "log",
  "diff",
  "show",
  "branch",
  "rev-parse",
  "describe",
  "version",
]);

const FIND_MUTATING_FLAGS = new Set([
  "-delete",
  "-exec",
  "-execdir",
  "-ok",
  "-okdir",
]);

interface ParsedCommand {
  tokens: string[];
  hasFileRedirect: boolean;
}

function hasCommandSubstitution(cmd: string): boolean {
  let inSingle = false;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (ch === "'" && (i === 0 || cmd[i - 1] !== "\\")) {
      inSingle = !inSingle;
      continue;
    }
    if (!inSingle) {
      if (ch === "`") return true;
      if (ch === "$" && cmd[i + 1] === "(") return true;
    }
  }
  return false;
}

function parseSimpleCommand(cmd: string): ParsedCommand | null {
  if (hasCommandSubstitution(cmd)) return null;

  const tokens: string[] = [];
  let currentToken = "";
  let inQuote: "'" | '"' | null = null;
  let hasFileRedirect = false;

  let i = 0;
  while (i < cmd.length) {
    const ch = cmd[i];

    if (inQuote === "'") {
      if (ch === "'") {
        inQuote = null;
      } else {
        currentToken += ch;
      }
      i++;
      continue;
    }

    if (inQuote === '"') {
      if (ch === "\\" && i + 1 < cmd.length) {
        currentToken += cmd[i + 1];
        i += 2;
        continue;
      }
      if (ch === '"') {
        inQuote = null;
      } else {
        currentToken += ch;
      }
      i++;
      continue;
    }

    if (ch === "'") {
      inQuote = "'";
      i++;
      continue;
    }
    if (ch === '"') {
      inQuote = '"';
      i++;
      continue;
    }
    if (ch === "\\") {
      if (i + 1 < cmd.length) {
        currentToken += cmd[i + 1];
        i += 2;
      } else {
        i++;
      }
      continue;
    }

    if (
      ch === ";" ||
      ch === "\n" ||
      ch === "\r" ||
      ch === "|" ||
      ch === "(" ||
      ch === ")"
    ) {
      return null;
    }
    if (ch === "&") {
      if (cmd[i + 1] === "&") return null;
      if (cmd[i + 1] !== ">") return null;
    }

    let isRedirect = false;
    if (ch === ">") {
      isRedirect = true;
      if (/^\d+$/.test(currentToken)) {
        currentToken = "";
      }
    } else if (ch === "&" && cmd[i + 1] === ">") {
      isRedirect = true;
      i++;
    }

    if (isRedirect) {
      if (currentToken.length > 0) {
        tokens.push(currentToken);
        currentToken = "";
      }
      i++;
      if (cmd[i] === ">" || cmd[i] === "|") {
        i++;
      }
      while (i < cmd.length && (cmd[i] === " " || cmd[i] === "\t")) {
        i++;
      }
      let target = "";
      if (cmd[i] === "'") {
        i++;
        while (i < cmd.length && cmd[i] !== "'") {
          target += cmd[i];
          i++;
        }
        if (i < cmd.length) i++;
      } else if (cmd[i] === '"') {
        i++;
        while (i < cmd.length && cmd[i] !== '"') {
          target += cmd[i];
          i++;
        }
        if (i < cmd.length) i++;
      } else {
        if (cmd[i] === "&") {
          target += "&";
          i++;
        }
        while (i < cmd.length && !/[\s;&|<>()]/.test(cmd[i])) {
          target += cmd[i];
          i++;
        }
      }

      const isSafeTarget =
        target === "/dev/null" ||
        /^&\d+$/.test(target) ||
        target === "&-";

      if (!isSafeTarget) {
        hasFileRedirect = true;
      }
      continue;
    }

    if (ch === " " || ch === "\t") {
      if (currentToken.length > 0) {
        tokens.push(currentToken);
        currentToken = "";
      }
      i++;
      continue;
    }

    currentToken += ch;
    i++;
  }

  if (inQuote !== null) return null;
  if (currentToken.length > 0) {
    tokens.push(currentToken);
  }

  return { tokens, hasFileRedirect };
}

function parseResolution(
  tokens: string[],
): { resolutionType: "desc" | "new" } | null {
  if (tokens.length < 2) return null;
  const sub = tokens[1];
  if (sub !== "desc" && sub !== "describe" && sub !== "new") return null;

  for (const t of tokens.slice(2)) {
    if (
      t === "--help" ||
      t === "-h" ||
      t === "-r" ||
      t === "--revision" ||
      t.startsWith("-r=") ||
      t.startsWith("--revision=")
    ) {
      return null;
    }
  }

  const resolutionType = sub === "new" ? "new" : "desc";

  if (tokens.length === 4) {
    if (
      (tokens[2] === "-m" || tokens[2] === "--message") &&
      tokens[3].trim().length > 0
    ) {
      return { resolutionType };
    }
    return null;
  }

  if (tokens.length === 3) {
    const flag = tokens[2];
    if (flag.startsWith("-m=") && flag.slice(3).trim().length > 0) {
      return { resolutionType };
    }
    if (flag.startsWith("--message=") && flag.slice(10).trim().length > 0) {
      return { resolutionType };
    }
    return null;
  }

  return null;
}

function isReadonlyJj(tokens: string[]): boolean {
  if (tokens.length < 2) return false;
  const sub = tokens[1];
  if (!JJ_READONLY_SUBS.has(sub)) return false;

  for (const t of tokens.slice(2)) {
    if (t === "-i" || t === "--interactive") return false;
  }
  return true;
}

function isReadonlyGit(tokens: string[]): boolean {
  if (tokens.length < 2) return false;
  if (tokens[1] === "--version" || tokens[1] === "-v") return true;
  return GIT_READONLY_SUBS.has(tokens[1]);
}

function isSafeFind(tokens: string[]): boolean {
  return !tokens.slice(1).some((t) => FIND_MUTATING_FLAGS.has(t));
}

function isRuntimeVersion(exe: string, tokens: string[]): boolean {
  if (tokens.length !== 2) return false;
  const arg = tokens[1];
  if (["node", "npm", "npx", "pnpm", "yarn", "bun", "deno"].includes(exe)) {
    return arg === "-v" || arg === "--version";
  }
  if (["python", "python3", "cargo", "rustc"].includes(exe)) {
    return arg === "-v" || arg === "-V" || arg === "--version";
  }
  if (exe === "go") {
    return arg === "version";
  }
  return false;
}

export function classifyShellCommand(
  command: string,
): ShellCommandClassification {
  const trimmed = command.trim();
  if (!trimmed) return { kind: "safe" };

  const parsed = parseSimpleCommand(trimmed);
  if (!parsed || parsed.hasFileRedirect) {
    return { kind: "guarded" };
  }

  let words = parsed.tokens;
  while (words.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) {
    words = words.slice(1);
  }
  if (words.length === 0) return { kind: "safe" };

  let exe = words[0].split("/").pop() ?? "";
  if (["sudo", "nohup", "time", "exec"].includes(exe) && words.length > 1) {
    words = words.slice(1);
    exe = words[0].split("/").pop() ?? "";
  }

  if (exe === "jj") {
    const resolution = parseResolution(words);
    if (resolution) {
      return {
        kind: "jj-resolution",
        resolutionType: resolution.resolutionType,
      };
    }
    if (isReadonlyJj(words)) {
      return { kind: "jj-readonly" };
    }
    return { kind: "guarded" };
  }

  if (exe === "git") {
    return isReadonlyGit(words) ? { kind: "safe" } : { kind: "guarded" };
  }

  if (exe === "find") {
    return isSafeFind(words) ? { kind: "safe" } : { kind: "guarded" };
  }

  if (isRuntimeVersion(exe, words)) {
    return { kind: "safe" };
  }

  if (SAFE_READONLY_COMMANDS.has(exe)) {
    return { kind: "safe" };
  }

  return { kind: "guarded" };
}

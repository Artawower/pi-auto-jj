import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type ExecCallback = (err: Error | null, stdout: string, stderr: string) => void;

const jjResponses: Record<string, { stdout: string; exitCode: number }> = {};

function setJj(
  responses: Record<string, { stdout: string; exitCode: number }>,
) {
  Object.keys(jjResponses).forEach((k) => delete jjResponses[k]);
  Object.assign(jjResponses, responses);
}

vi.mock("node:child_process", () => ({
  execFile: (
    _cmd: string,
    args: string[],
    _opts: unknown,
    cb: ExecCallback,
  ) => {
    const key = (args as string[]).join(" ");
    const match = Object.entries(jjResponses).find(([p]) => key.includes(p));
    const { stdout = "", exitCode = 0 } = match?.[1] ?? {};
    if (exitCode !== 0) {
      cb(
        Object.assign(new Error(`exit ${exitCode}`), { code: exitCode }),
        stdout,
        "",
      );
    } else {
      cb(null, stdout, "");
    }
    return { kill: vi.fn() };
  },
}));

const CWD = "/fake/repo";

function makeCtx(overrides: Record<string, unknown> = {}) {
  return {
    cwd: CWD,
    hasUI: false,
    signal: undefined,
    ui: { notify: vi.fn(), setStatus: vi.fn() },
    ...overrides,
  };
}

function makePi() {
  const handlers: Record<string, Function> = {};
  return {
    on: vi.fn((event: string, fn: Function) => {
      handlers[event] = fn;
    }),
    exec: vi.fn(),
    fire: async (event: string, arg: unknown, ctx: unknown) =>
      handlers[event]?.(arg, ctx),
  };
}

function defaultJj(desc: string, diff: boolean) {
  setJj({
    root: { stdout: CWD, exitCode: 0 },
    log: { stdout: `abc123\n${desc}\n${diff ? "yes" : "no"}\n`, exitCode: 0 },
    diff: { stdout: diff ? "file.ts | 1 +\n" : "\n", exitCode: 0 },
  });
}

describe("isJjRepo", async () => {
  const { isJjRepo } = await import("./jj.js");

  it("returns true when jj root succeeds", async () => {
    setJj({ root: { stdout: CWD, exitCode: 0 } });
    expect(await isJjRepo(CWD)).toBe(true);
  });

  it("returns false when jj root fails", async () => {
    setJj({ root: { stdout: "", exitCode: 1 } });
    expect(await isJjRepo(CWD)).toBe(false);
  });
});

describe("getCurrentDescription", async () => {
  const { getCurrentDescription } = await import("./jj.js");

  it("returns trimmed description", async () => {
    setJj({ log: { stdout: "fix login\n", exitCode: 0 } });
    expect(await getCurrentDescription(CWD)).toBe("fix login");
  });

  it("returns empty string for empty revision", async () => {
    setJj({ log: { stdout: "\n", exitCode: 0 } });
    expect(await getCurrentDescription(CWD)).toBe("");
  });
});

describe("hasDiff", async () => {
  const { hasDiff } = await import("./jj.js");

  it("returns true when diff has output", async () => {
    setJj({ diff: { stdout: "file.ts | 3 +++\n", exitCode: 0 } });
    expect(await hasDiff(CWD)).toBe(true);
  });

  it("returns false when diff is empty", async () => {
    setJj({ diff: { stdout: "\n", exitCode: 0 } });
    expect(await hasDiff(CWD)).toBe(false);
  });
});

describe("getRevisionInfo", async () => {
  const { getRevisionInfo } = await import("./jj.js");

  it("parses all fields correctly", async () => {
    setJj({ log: { stdout: "abc123\nfix login\nyes\n", exitCode: 0 } });
    expect(await getRevisionInfo(CWD)).toEqual({
      changeId: "abc123",
      description: "fix login",
      hasDiff: true,
    });
  });

  it("handles empty description and no diff", async () => {
    setJj({ log: { stdout: "abc123\n\nno\n", exitCode: 0 } });
    expect(await getRevisionInfo(CWD)).toEqual({
      changeId: "abc123",
      description: "",
      hasDiff: false,
    });
  });
});

describe("loadConfig", async () => {
  const { loadConfig } = await import("./config.js");
  const tmp = join(tmpdir(), `pi-jj-auto-test-${process.pid}`);

  beforeEach(() => mkdirSync(join(tmp, ".pi"), { recursive: true }));
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("returns defaults when no config file exists", () => {
    expect(loadConfig(tmp)).toEqual({
      enabled: true,
      blockOnMismatch: true,
      autoDescribe: true,
      maxPromptLength: 72,
    });
  });

  it("project config overrides global", () => {
    writeFileSync(
      join(tmp, ".pi", "pi-jj-auto.json"),
      JSON.stringify({ enabled: false }),
    );
    expect(loadConfig(tmp).enabled).toBe(false);
  });

  it("invalid values fall back to defaults", () => {
    writeFileSync(
      join(tmp, ".pi", "pi-jj-auto.json"),
      JSON.stringify({ enabled: "yes", maxPromptLength: -5 }),
    );
    const cfg = loadConfig(tmp);
    expect(cfg.enabled).toBe(true);
    expect(cfg.maxPromptLength).toBe(72);
  });

  it("clamps maxPromptLength to 500", () => {
    writeFileSync(
      join(tmp, ".pi", "pi-jj-auto.json"),
      JSON.stringify({ maxPromptLength: 9999 }),
    );
    expect(loadConfig(tmp).maxPromptLength).toBe(500);
  });
});

describe("guard lifecycle", async () => {
  const { default: register } = (await import("./index.js")) as {
    default: (pi: unknown) => void;
  };

  async function boot(
    desc: string,
    diff: boolean,
    configOverrides: Record<string, unknown> = {},
  ) {
    defaultJj(desc, diff);
    const pi = makePi();
    register(pi);
    await pi.fire("session_start", {}, makeCtx());
    await pi.fire("before_agent_start", { prompt: "add dark mode" }, makeCtx());
    if (Object.keys(configOverrides).length) {
      const state = (pi as any)._state;
      if (state) Object.assign(state.config, configOverrides);
    }
    return pi;
  }

  async function write(
    pi: ReturnType<typeof makePi>,
    desc?: string,
    diff?: boolean,
  ) {
    if (desc !== undefined) defaultJj(desc, diff ?? false);
    return pi.fire("tool_call", { toolName: "write", input: {} }, makeCtx());
  }

  beforeEach(() => setJj({}));

  it("allows write on fresh revision (empty desc, no diff)", async () => {
    const pi = await boot("", false);
    expect(await write(pi)).toBeUndefined();
  });

  it("blocks write on stale WIP (empty desc, has diff)", async () => {
    const pi = await boot("", true);
    expect((await write(pi))?.block).toBe(true);
  });

  it("allows write on described revision with no diff", async () => {
    const pi = await boot("fix login", false);
    expect(await write(pi)).toBeUndefined();
  });

  it("blocks described revision with diff when blockOnMismatch=true (default)", async () => {
    defaultJj("fix login", true);
    const pi = makePi();
    register(pi);
    await pi.fire("session_start", {}, makeCtx());
    await pi.fire("before_agent_start", { prompt: "add dark mode" }, makeCtx());
    const result = await write(pi, "fix login", true);
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain("fix login");
  });

  it("notifies but allows described revision with diff when blockOnMismatch=false", async () => {
    const tmp = join(tmpdir(), `pi-jj-auto-blockmatch-${process.pid}`);
    mkdirSync(join(tmp, ".pi"), { recursive: true });
    writeFileSync(
      join(tmp, ".pi", "pi-jj-auto.json"),
      JSON.stringify({ blockOnMismatch: false }),
    );

    setJj({
      root: { stdout: tmp, exitCode: 0 },
      log: { stdout: `abc123\nfix login\nyes\n`, exitCode: 0 },
      diff: { stdout: "file.ts | 1 +\n", exitCode: 0 },
    });
    const pi = makePi();
    register(pi);
    await pi.fire("session_start", {}, { ...makeCtx(), cwd: tmp });
    await pi.fire("before_agent_start", { prompt: "add dark mode" }, makeCtx());
    const result = await pi.fire(
      "tool_call",
      { toolName: "write", input: {} },
      makeCtx(),
    );
    expect(result).toBeUndefined();

    rmSync(tmp, { recursive: true, force: true });
  });

  it("keeps blocking on retry without jj resolution", async () => {
    const pi = await boot("", true);
    expect((await write(pi))?.block).toBe(true);
    expect((await write(pi))?.block).toBe(true);
  });

  it("allows write after jj new clears the revision", async () => {
    const pi = await boot("", true);
    expect((await write(pi))?.block).toBe(true);
    expect(await write(pi, "", false)).toBeUndefined();
  });

  it("does not mark guard resolved when jj-resolution bash command runs", async () => {
    const pi = await boot("", true);
    await pi.fire(
      "tool_call",
      { toolName: "bash", input: { command: "jj new -m 'test'" } },
      makeCtx(),
    );
    expect((await write(pi))?.block).toBe(true);
  });

  it("fails closed on guard error when blockOnMismatch=true", async () => {
    defaultJj("", false);
    const pi = makePi();
    register(pi);
    await pi.fire("session_start", {}, makeCtx());
    await pi.fire("before_agent_start", { prompt: "x" }, makeCtx());
    setJj({ log: { stdout: "", exitCode: 1 } });
    const result = await pi.fire(
      "tool_call",
      { toolName: "write", input: {} },
      makeCtx(),
    );
    expect(result?.block).toBe(true);
  });

  it("classifies jj diff redirection as mutating — blocks stale WIP", async () => {
    const pi = await boot("", true);
    const result = await pi.fire(
      "tool_call",
      { toolName: "bash", input: { command: "jj diff > file.patch" } },
      makeCtx(),
    );
    expect(result?.block).toBe(true);
  });

  it("does not activate outside jj repo", async () => {
    setJj({ root: { stdout: "", exitCode: 1 } });
    const pi = makePi();
    register(pi);
    await pi.fire("session_start", {}, makeCtx());
    await pi.fire("before_agent_start", { prompt: "x" }, makeCtx());
    defaultJj("has desc", true);
    expect(await write(pi)).toBeUndefined();
  });
});

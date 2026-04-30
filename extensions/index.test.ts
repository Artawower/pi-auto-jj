import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ─── Helpers ───────────────────────────────────────────────────────────

/** Map jj sub-command keyword → fake result. */
function mockExec(
  responses: Record<string, { stdout: string; exitCode: number }>,
) {
  return vi.fn(async (_cmd: string, args: string[]) => {
    const key = args.join(" ");
    for (const [pattern, result] of Object.entries(responses)) {
      if (key.includes(pattern)) return result;
    }
    return { stdout: "", exitCode: 0 };
  });
}

function mockCtx(overrides = {}) {
  return {
    cwd: "/fake/repo",
    hasUI: false,
    signal: undefined,
    ui: { notify: vi.fn(), setStatus: vi.fn() },
    ...overrides,
  };
}

function createPi() {
  const handlers: Record<string, Function[]> = {};
  const pi = {
    on: vi.fn((event: string, fn: Function) => {
      (handlers[event] ??= []).push(fn);
    }),
    exec: vi.fn(),
    _fire: async (event: string, arg: any, ctx: any) =>
      handlers[event]?.[0]?.(arg, ctx),
    _handlers: handlers,
  };
  return pi;
}

// ─── isJjRepo ──────────────────────────────────────────────────────────

describe("isJjRepo", async () => {
  const { isJjRepo } = await import("./jj.js");

  it("true when jj root exits 0", async () =>
    expect(
      await isJjRepo(mockExec({ root: { stdout: "/repo", exitCode: 0 } })),
    ).toBe(true));

  it("false when jj root exits 1", async () =>
    expect(
      await isJjRepo(mockExec({ root: { stdout: "", exitCode: 1 } })),
    ).toBe(false));

  it("false on exception", async () =>
    expect(await isJjRepo(vi.fn().mockRejectedValue(new Error()))).toBe(false));
});

// ─── getCurrentDescription ─────────────────────────────────────────────

describe("getCurrentDescription", async () => {
  const { getCurrentDescription } = await import("./jj.js");

  it("returns trimmed description", async () =>
    expect(
      await getCurrentDescription(
        mockExec({ log: { stdout: "fix login\n", exitCode: 0 } }),
      ),
    ).toBe("fix login"));

  it("returns empty string for blank output", async () =>
    expect(
      await getCurrentDescription(
        mockExec({ log: { stdout: "\n", exitCode: 0 } }),
      ),
    ).toBe(""));
});

// ─── hasDiff ───────────────────────────────────────────────────────────

describe("hasDiff", async () => {
  const { hasDiff } = await import("./jj.js");

  it("true when diff --stat has output", async () =>
    expect(
      await hasDiff(
        mockExec({ diff: { stdout: "src/main.ts | 3 +++\n", exitCode: 0 } }),
      ),
    ).toBe(true));

  it("false when diff --stat is empty", async () =>
    expect(
      await hasDiff(mockExec({ diff: { stdout: "\n", exitCode: 0 } })),
    ).toBe(false));
});

// ─── loadConfig ────────────────────────────────────────────────────────

describe("loadConfig", async () => {
  const { loadConfig } = await import("./config.js");
  const tmp = join(tmpdir(), `pi-jj-auto-test-${process.pid}`);

  beforeEach(() => mkdirSync(join(tmp, ".pi"), { recursive: true }));
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("returns defaults when no config files exist", () =>
    expect(loadConfig(tmp)).toEqual({
      enabled: true,
      blockOnMismatch: true,
      autoDescribe: true,
      maxPromptLength: 72,
    }));

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

// ─── Guard lifecycle ───────────────────────────────────────────────────

describe("guard lifecycle", async () => {
  const { default: factory } = (await import("./index.js")) as {
    default: (pi: any) => void;
  };

  /**
   * Boot the extension: session_start (with jj root ok) + before_agent_start.
   * `desc` / `diff` control what getCurrentDescription / hasDiff return on tool_call.
   */
  async function boot(desc: string, diff: boolean) {
    const pi = createPi();
    factory(pi);

    // session_start — jj root succeeds
    pi.exec.mockResolvedValueOnce({ stdout: "/repo", exitCode: 0 });
    await pi._fire("session_start", {}, mockCtx({ cwd: "/fake/repo" }));

    await pi._fire(
      "before_agent_start",
      { prompt: "add dark mode" },
      mockCtx(),
    );

    // Prepare exec responses for tool_call: log → desc, diff → diff
    pi.exec.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args.includes("log")) return { stdout: desc + "\n", exitCode: 0 };
      if (args.includes("diff"))
        return { stdout: diff ? "file.ts | 1 +\n" : "\n", exitCode: 0 };
      return { stdout: "", exitCode: 0 };
    });

    return pi;
  }

  async function callWrite(pi: ReturnType<typeof createPi>) {
    return pi._fire("tool_call", { toolName: "write", input: {} }, mockCtx());
  }

  // ── Allow cases ──────────────────────────────────────────────────────

  it("allows edit: empty description, no diff (fresh revision)", async () => {
    const pi = await boot("", false);
    expect(await callWrite(pi)).toBeUndefined();
  });

  it("allows edit: empty description, has diff (WIP revision)", async () => {
    const pi = await boot("", true);
    expect(await callWrite(pi)).toBeUndefined();
  });

  it("allows edit: description exists, no diff (just created via jj new -m)", async () => {
    const pi = await boot("fix login bug", false);
    expect(await callWrite(pi)).toBeUndefined();
  });

  // ── Block cases ───────────────────────────────────────────────────────

  it("blocks edit: description exists AND diff exists (sealed revision)", async () => {
    const pi = await boot("fix login bug", true);
    const result = await callWrite(pi);
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain("fix login bug");
  });

  it("keeps blocking on retry — guard not bypassed", async () => {
    const pi = await boot("fix login bug", true);
    const r1 = await callWrite(pi);
    expect(r1?.block).toBe(true);
    const r2 = await callWrite(pi);
    expect(r2?.block).toBe(true);
  });

  it("allows after jj new: description clears (empty diff now)", async () => {
    const pi = await boot("fix login bug", true);
    expect((await callWrite(pi))?.block).toBe(true);

    // Simulate jj new — new revision: desc="" (empty), diff=false
    pi.exec.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args.includes("log")) return { stdout: "\n", exitCode: 0 };
      if (args.includes("diff")) return { stdout: "\n", exitCode: 0 };
      return { stdout: "", exitCode: 0 };
    });
    expect(await callWrite(pi)).toBeUndefined();
  });

  // ── Not active outside jj repo ─────────────────────────────────────

  it("does not activate outside jj repo", async () => {
    const pi = createPi();
    factory(pi);
    pi.exec.mockResolvedValueOnce({ stdout: "", exitCode: 1 }); // jj root fails
    await pi._fire("session_start", {}, mockCtx());
    await pi._fire("before_agent_start", { prompt: "x" }, mockCtx());
    pi.exec.mockResolvedValue({ stdout: "has desc\n", exitCode: 0 });
    expect(await callWrite(pi)).toBeUndefined();
  });

  // ── Auto-describe ─────────────────────────────────────────────────

  it("auto-describes on agent_end when empty description AND diff present", async () => {
    const pi = createPi();
    factory(pi);
    pi.exec.mockResolvedValueOnce({ stdout: "/repo", exitCode: 0 }); // session_start jj root
    await pi._fire("session_start", {}, mockCtx());
    await pi._fire(
      "before_agent_start",
      { prompt: "add dark mode" },
      mockCtx(),
    );

    const descSpy = vi.fn().mockResolvedValue({ stdout: "", exitCode: 0 });
    pi.exec.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args.includes("log")) return { stdout: "\n", exitCode: 0 }; // empty desc
      if (args.includes("diff"))
        return { stdout: "file.ts | 1 +\n", exitCode: 0 }; // has diff
      if (args.includes("desc")) {
        descSpy();
        return { stdout: "", exitCode: 0 };
      }
      return { stdout: "", exitCode: 0 };
    });

    await pi._fire("agent_end", {}, mockCtx());
    expect(descSpy).toHaveBeenCalledTimes(1);
  });

  it("does NOT auto-describe when diff is empty (no work done)", async () => {
    const pi = createPi();
    factory(pi);
    pi.exec.mockResolvedValueOnce({ stdout: "/repo", exitCode: 0 });
    await pi._fire("session_start", {}, mockCtx());
    await pi._fire("before_agent_start", { prompt: "explain code" }, mockCtx());

    const descSpy = vi.fn().mockResolvedValue({ stdout: "", exitCode: 0 });
    pi.exec.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args.includes("log")) return { stdout: "\n", exitCode: 0 }; // empty desc
      if (args.includes("diff")) return { stdout: "\n", exitCode: 0 }; // no diff
      if (args.includes("desc")) {
        descSpy();
        return { stdout: "", exitCode: 0 };
      }
      return { stdout: "", exitCode: 0 };
    });

    await pi._fire("agent_end", {}, mockCtx());
    expect(descSpy).not.toHaveBeenCalled();
  });
});

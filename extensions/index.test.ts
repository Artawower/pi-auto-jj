import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type ExecCallback = (err: Error | null, stdout: string, stderr: string) => void;

const jjResponses: Record<
	string,
	{ stdout: string; stderr?: string; exitCode: number }
> = {};

function setJj(
	responses: Record<
		string,
		{ stdout: string; stderr?: string; exitCode: number }
	>,
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
		const { stdout = "", stderr = "", exitCode = 0 } = match?.[1] ?? {};
		if (exitCode !== 0) {
			cb(
				Object.assign(new Error(`exit ${exitCode}`), { code: exitCode }),
				stdout,
				stderr,
			);
		} else {
			cb(null, stdout, stderr);
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

function defaultJj(desc: string, diff: boolean, changeId = "abc123") {
	setJj({
		root: { stdout: CWD, exitCode: 0 },
		log: {
			stdout: JSON.stringify({
				changeId,
				description: desc,
				hasDiff: diff,
			}),
			exitCode: 0,
		},
		diff: { stdout: diff ? "file.ts | 1 +\n" : "\n", exitCode: 0 },
		desc: { stdout: "", exitCode: 0 },
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

describe("describeRevision and jj error formatting", async () => {
	const { describeRevision } = await import("./jj.js");

	it("describes revision successfully", async () => {
		setJj({ desc: { stdout: "", exitCode: 0 } });
		await expect(
			describeRevision(CWD, "abc123", "feat: test"),
		).resolves.toBeUndefined();
	});

	it("includes stderr and error details on failure", async () => {
		setJj({
			desc: {
				stdout: "",
				stderr: "fatal: failed to set description",
				exitCode: 1,
			},
		});
		await expect(describeRevision(CWD, "abc123", "msg")).rejects.toThrow(
			"fatal: failed to set description",
		);
	});
});

describe("getRevisionInfo", async () => {
	const { getRevisionInfo } = await import("./jj.js");

	it("parses valid JSON fields correctly", async () => {
		setJj({
			log: {
				stdout: JSON.stringify({
					changeId: "abc123",
					description: "fix login",
					hasDiff: true,
				}),
				exitCode: 0,
			},
		});
		expect(await getRevisionInfo(CWD)).toEqual({
			changeId: "abc123",
			description: "fix login",
			hasDiff: true,
		});
	});

	it("handles multiline description with quotes and trailing newline from real jj", async () => {
		const rawJson = JSON.stringify({
			changeId: "xyz789\n",
			description:
				'feat: login\n\nDetailed "multiline" body\nwith backslash \\ and quotes\n',
			hasDiff: true,
		});
		setJj({ log: { stdout: rawJson, exitCode: 0 } });

		expect(await getRevisionInfo(CWD)).toEqual({
			changeId: "xyz789",
			description:
				'feat: login\n\nDetailed "multiline" body\nwith backslash \\ and quotes',
			hasDiff: true,
		});
	});

	it("handles empty description and no diff", async () => {
		setJj({
			log: {
				stdout: JSON.stringify({
					changeId: "abc123",
					description: "",
					hasDiff: false,
				}),
				exitCode: 0,
			},
		});
		expect(await getRevisionInfo(CWD)).toEqual({
			changeId: "abc123",
			description: "",
			hasDiff: false,
		});
	});

	it("throws descriptive error when JSON is invalid", async () => {
		setJj({ log: { stdout: "not a json", exitCode: 0 } });
		await expect(getRevisionInfo(CWD)).rejects.toThrow(
			"Failed to parse jj revision JSON",
		);
	});

	it("throws error when payload is missing required fields", async () => {
		setJj({
			log: {
				stdout: JSON.stringify({ changeId: "abc" }),
				exitCode: 0,
			},
		});
		await expect(getRevisionInfo(CWD)).rejects.toThrow(
			"Invalid jj revision info payload",
		);
	});

	it("rejects immediately with AbortError when signal is already aborted", async () => {
		const ac = new AbortController();
		ac.abort();
		await expect(getRevisionInfo(CWD, ac.signal)).rejects.toThrow(
			"The operation was aborted",
		);
	});
});

describe("config parsing and loadConfig", async () => {
	const { loadConfig, parsePositiveInt } = await import("./config.js");
	const tmp = join(tmpdir(), `pi-jj-auto-test-${process.pid}`);
	const fakeAgentDir = join(tmpdir(), `pi-jj-auto-global-${process.pid}`);

	beforeEach(() => {
		mkdirSync(join(tmp, ".pi"), { recursive: true });
		mkdirSync(fakeAgentDir, { recursive: true });
	});
	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
		rmSync(fakeAgentDir, { recursive: true, force: true });
	});

	it("returns defaults when no config file exists", () => {
		expect(loadConfig(tmp, fakeAgentDir)).toEqual({
			enabled: true,
			blockOnMismatch: true,
			autoDescribe: true,
			maxPromptLength: 72,
		});
	});

	it("loads global config isolated from real home directory", () => {
		writeFileSync(
			join(fakeAgentDir, "pi-jj-auto.json"),
			JSON.stringify({ autoDescribe: false, maxPromptLength: 120 }),
		);
		const cfg = loadConfig(tmp, fakeAgentDir);
		expect(cfg.autoDescribe).toBe(false);
		expect(cfg.maxPromptLength).toBe(120);
	});

	it("project config overrides global config", () => {
		writeFileSync(
			join(fakeAgentDir, "pi-jj-auto.json"),
			JSON.stringify({ enabled: true, maxPromptLength: 100 }),
		);
		writeFileSync(
			join(tmp, ".pi", "pi-jj-auto.json"),
			JSON.stringify({ enabled: false, maxPromptLength: 80 }),
		);
		const cfg = loadConfig(tmp, fakeAgentDir);
		expect(cfg.enabled).toBe(false);
		expect(cfg.maxPromptLength).toBe(80);
	});

	describe("parsePositiveInt numeric edges", () => {
		it("rejects non-numbers and non-finite numbers", () => {
			expect(parsePositiveInt("100", 72, 500)).toBe(72);
			expect(parsePositiveInt(NaN, 72, 500)).toBe(72);
			expect(parsePositiveInt(Infinity, 72, 500)).toBe(72);
			expect(parsePositiveInt(-Infinity, 72, 500)).toBe(72);
			expect(parsePositiveInt(null, 72, 500)).toBe(72);
			expect(parsePositiveInt(undefined, 72, 500)).toBe(72);
		});

		it("rejects negative numbers and zero", () => {
			expect(parsePositiveInt(0, 72, 500)).toBe(72);
			expect(parsePositiveInt(-10, 72, 500)).toBe(72);
		});

		it("normalizes fractional numbers to integers", () => {
			expect(parsePositiveInt(72.8, 50, 500)).toBe(72);
			expect(parsePositiveInt(100.2, 50, 500)).toBe(100);
			// 0.5 floors to 0 which is <= 0, so falls back
			expect(parsePositiveInt(0.5, 72, 500)).toBe(72);
		});

		it("clamps to max", () => {
			expect(parsePositiveInt(9999, 72, 500)).toBe(500);
		});
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
		changeId?: string,
	) {
		if (desc !== undefined) defaultJj(desc, diff ?? false, changeId ?? "abc123");
		return pi.fire("tool_call", { toolName: "write", input: {} }, makeCtx());
	}

	beforeEach(() => setJj({}));

	it("injects skill content on first agent start", async () => {
		defaultJj("", false);
		const pi = makePi();
		register(pi);
		await pi.fire("session_start", {}, makeCtx());

		const result = await pi.fire(
			"before_agent_start",
			{ prompt: "x", systemPrompt: "base" },
			makeCtx(),
		);
		expect(result?.systemPrompt).toContain("pi-jj-auto");
	});

	it("re-injects skill per-turn on subsequent agent starts", async () => {
		defaultJj("", false);
		const pi = makePi();
		register(pi);
		await pi.fire("session_start", {}, makeCtx());

		const turn1 = await pi.fire(
			"before_agent_start",
			{ prompt: "turn 1", systemPrompt: "base" },
			makeCtx(),
		);
		expect(turn1?.systemPrompt).toContain("pi-jj-auto");

		const turn2 = await pi.fire(
			"before_agent_start",
			{ prompt: "turn 2", systemPrompt: "base" },
			makeCtx(),
		);
		expect(turn2?.systemPrompt).toContain("pi-jj-auto");
	});

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
			log: {
				stdout: JSON.stringify({
					changeId: "abc123",
					description: "fix login",
					hasDiff: true,
				}),
				exitCode: 0,
			},
			diff: { stdout: "file.ts | 1 +\n", exitCode: 0 },
		});
		const pi = makePi();
		register(pi);
		const ctx = makeCtx({ cwd: tmp });
		await pi.fire("session_start", {}, ctx);
		await pi.fire("before_agent_start", { prompt: "add dark mode" }, ctx);
		const result = await pi.fire(
			"tool_call",
			{ toolName: "write", input: {} },
			ctx,
		);
		expect(result).toBeUndefined();

		rmSync(tmp, { recursive: true, force: true });
	});

	it("keeps blocking on retry without jj resolution", async () => {
		const pi = await boot("", true);
		expect((await write(pi))?.block).toBe(true);
		expect((await write(pi))?.block).toBe(true);
	});

	it("same-task flow: allows write after successful jj desc resolution", async () => {
		const pi = await boot("fix login", true);
		// First write attempt is blocked
		const blocked = await write(pi);
		expect(blocked?.block).toBe(true);

		// Model runs jj desc -m "fix login"
		const resolutionCall = await pi.fire(
			"tool_call",
			{
				toolCallId: "call_123",
				toolName: "bash",
				input: { command: 'jj desc -m "fix login"' },
			},
			makeCtx(),
		);
		expect(resolutionCall).toBeUndefined();

		// Tool execution succeeds
		await pi.fire(
			"tool_result",
			{
				toolCallId: "call_123",
				toolName: "bash",
				isError: false,
				details: { exitCode: 0 },
			},
			makeCtx(),
		);

		// Retry write on the same revision is now allowed!
		const retry = await write(pi);
		expect(retry).toBeUndefined();
	});

	it("same-task flow: keeps blocking if jj desc resolution failed", async () => {
		const pi = await boot("fix login", true);
		// First write attempt blocked
		expect((await write(pi))?.block).toBe(true);

		// Model runs jj desc but it fails
		await pi.fire(
			"tool_call",
			{
				toolCallId: "call_fail",
				toolName: "bash",
				input: { command: 'jj desc -m "fix login"' },
			},
			makeCtx(),
		);
		await pi.fire(
			"tool_result",
			{
				toolCallId: "call_fail",
				toolName: "bash",
				isError: true,
				details: { exitCode: 1 },
			},
			makeCtx(),
		);

		// Retry write remains blocked
		const retry = await write(pi);
		expect(retry?.block).toBe(true);
	});

	it("allows write after jj new resolution", async () => {
		const pi = await boot("", true);
		expect((await write(pi))?.block).toBe(true);

		await pi.fire(
			"tool_call",
			{
				toolCallId: "call_new",
				toolName: "bash",
				input: { command: "jj new -m 'new task'" },
			},
			makeCtx(),
		);
		await pi.fire(
			"tool_result",
			{
				toolCallId: "call_new",
				toolName: "bash",
				isError: false,
				details: { exitCode: 0 },
			},
			makeCtx(),
		);

		// jj new created a new clean revision
		expect(await write(pi, "new task", false, "new_rev_123")).toBeUndefined();
	});

	it("compound command bypass prevention: blocks jj status && npm install", async () => {
		const pi = await boot("", true);
		const result = await pi.fire(
			"tool_call",
			{
				toolName: "bash",
				input: { command: "jj status && npm install" },
			},
			makeCtx(),
		);
		expect(result?.block).toBe(true);
	});

	it("compound command bypass prevention: blocks jj desc ; python rm.py", async () => {
		const pi = await boot("", true);
		const result = await pi.fire(
			"tool_call",
			{
				toolName: "bash",
				input: { command: 'jj desc -m "ok"; python rm.py' },
			},
			makeCtx(),
		);
		expect(result?.block).toBe(true);
	});

	it("false positive prevention: does not block grep 'rm' file.txt", async () => {
		const pi = await boot("fix login", true);
		const result = await pi.fire(
			"tool_call",
			{
				toolName: "bash",
				input: { command: "grep 'rm' file.txt" },
			},
			makeCtx(),
		);
		expect(result).toBeUndefined();
	});

	it("false positive prevention: does not block echo 'rm -rf'", async () => {
		const pi = await boot("fix login", true);
		const result = await pi.fire(
			"tool_call",
			{
				toolName: "bash",
				input: { command: 'echo "rm -rf"' },
			},
			makeCtx(),
		);
		expect(result).toBeUndefined();
	});

	it("false positive prevention: python -c with > is not treated as file redirect", async () => {
		const pi = await boot("", false);
		const result = await pi.fire(
			"tool_call",
			{
				toolName: "bash",
				input: { command: 'python -c "if x > 1: pass"' },
			},
			makeCtx(),
		);
		// On a clean revision, a non-redirect guarded/unknown command passes
		expect(result).toBeUndefined();
	});

	it("handles jj desc with && in quotes as simple jj-resolution", async () => {
		const pi = await boot("fix login", true);
		const result = await pi.fire(
			"tool_call",
			{
				toolName: "bash",
				input: { command: 'jj desc -m "feat: add && update"' },
			},
			makeCtx(),
		);
		// Should be recognized as jj-resolution, not compound
		expect(result).toBeUndefined();
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

	it("does not classify fd-redirect (2>&1) as mutating", async () => {
		const pi = await boot("fix login", true);
		const result = await pi.fire(
			"tool_call",
			{ toolName: "bash", input: { command: "cat file.txt 2>&1" } },
			makeCtx(),
		);
		expect(result).toBeUndefined();
	});

	it("does not classify stderr redirect to /dev/null as mutating", async () => {
		const pi = await boot("fix login", true);
		const result = await pi.fire(
			"tool_call",
			{
				toolName: "bash",
				input: {
					command: "cat /tmp/project/README.md 2>/dev/null",
				},
			},
			makeCtx(),
		);
		expect(result).toBeUndefined();
	});

	it("does not classify git diff stderr redirect to /dev/null as mutating", async () => {
		const pi = await boot("fix login", true);
		const result = await pi.fire(
			"tool_call",
			{
				toolName: "bash",
				input: {
					command: "git diff HEAD --name-only 2>/dev/null",
				},
			},
			makeCtx(),
		);
		expect(result).toBeUndefined();
	});

	it("classifies stderr redirect to a real file as mutating", async () => {
		const pi = await boot("", true);
		const result = await pi.fire(
			"tool_call",
			{ toolName: "bash", input: { command: "cmd 2>error.log" } },
			makeCtx(),
		);
		expect(result?.block).toBe(true);
	});

	it("does not classify 'node --version' as mutating", async () => {
		const pi = await boot("", true);
		const result = await pi.fire(
			"tool_call",
			{ toolName: "bash", input: { command: "node --version" } },
			makeCtx(),
		);
		expect(result).toBeUndefined();
	});

	it("classifies '> output.txt' at start of command as mutating", async () => {
		const pi = await boot("", true);
		const result = await pi.fire(
			"tool_call",
			{ toolName: "bash", input: { command: "> output.txt" } },
			makeCtx(),
		);
		expect(result?.block).toBe(true);
	});

	describe("agent_settled autoDescribe", () => {
		it("calls describeRevision when autoDescribe=true, clean baseline, mutating tool succeeded, and final has diff", async () => {
			defaultJj("", false);
			const pi = makePi();
			register(pi);
			const ctx = makeCtx({ hasUI: true });
			await pi.fire("session_start", {}, ctx);
			await pi.fire(
				"before_agent_start",
				{ prompt: "feat: add dark mode support\n\nSecond line" },
				ctx,
			);

			await pi.fire(
				"tool_call",
				{ toolCallId: "call_w1", toolName: "write", input: { path: "a.ts" } },
				ctx,
			);
			await pi.fire(
				"tool_result",
				{ toolCallId: "call_w1", toolName: "write", isError: false },
				ctx,
			);

			defaultJj("", true);

			await pi.fire("agent_settled", {}, ctx);
			expect(ctx.ui.notify).toHaveBeenCalledWith(
				'pi-jj-auto: described revision as "feat: add dark mode support"',
				"info",
			);
		});

		it("notifies warning when autoDescribe=false, clean baseline, mutated in turn, and final has diff", async () => {
			const pi = makePi();
			register(pi);
			const ctx = makeCtx({ hasUI: true });

			const tmp = join(tmpdir(), `pi-jj-auto-nodesc-${process.pid}`);
			mkdirSync(join(tmp, ".pi"), { recursive: true });
			writeFileSync(
				join(tmp, ".pi", "pi-jj-auto.json"),
				JSON.stringify({ autoDescribe: false }),
			);

			setJj({
				root: { stdout: tmp, exitCode: 0 },
				log: {
					stdout: JSON.stringify({
						changeId: "abc123",
						description: "",
						hasDiff: false,
					}),
					exitCode: 0,
				},
			});

			const customCtx = makeCtx({ cwd: tmp, hasUI: true });
			await pi.fire("session_start", {}, customCtx);
			await pi.fire("before_agent_start", { prompt: "my task" }, customCtx);

			await pi.fire(
				"tool_call",
				{ toolCallId: "call_w2", toolName: "write", input: { path: "a.ts" } },
				customCtx,
			);
			await pi.fire(
				"tool_result",
				{ toolCallId: "call_w2", toolName: "write", isError: false },
				customCtx,
			);

			setJj({
				root: { stdout: tmp, exitCode: 0 },
				log: {
					stdout: JSON.stringify({
						changeId: "abc123",
						description: "",
						hasDiff: true,
					}),
					exitCode: 0,
				},
			});

			await pi.fire("agent_settled", {}, customCtx);
			expect(customCtx.ui.notify).toHaveBeenCalledWith(
				expect.stringContaining("revision has changes but no description"),
				"warning",
			);

			rmSync(tmp, { recursive: true, force: true });
		});

		it("silently skips autoDescribe when signal is aborted", async () => {
			defaultJj("", true);
			const pi = makePi();
			register(pi);
			const ctx = makeCtx({
				hasUI: true,
				signal: { aborted: true } as AbortSignal,
			});
			await pi.fire("session_start", {}, ctx);
			await pi.fire("before_agent_start", { prompt: "my task" }, ctx);

			await pi.fire("agent_settled", {}, ctx);
			expect(ctx.ui.notify).not.toHaveBeenCalled();
		});

		it("handles agent_end directly and does not duplicate when agent_settled follows", async () => {
			defaultJj("", false);
			const pi = makePi();
			register(pi);
			const ctx = makeCtx({ hasUI: true });
			await pi.fire("session_start", {}, ctx);
			await pi.fire(
				"before_agent_start",
				{ prompt: "feat: auto describe on agent_end" },
				ctx,
			);

			await pi.fire(
				"tool_call",
				{ toolCallId: "call_w3", toolName: "write", input: { path: "a.ts" } },
				ctx,
			);
			await pi.fire(
				"tool_result",
				{ toolCallId: "call_w3", toolName: "write", isError: false },
				ctx,
			);

			defaultJj("", true);

			await pi.fire("agent_end", {}, ctx);
			expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
			expect(ctx.ui.notify).toHaveBeenCalledWith(
				'pi-jj-auto: described revision as "feat: auto describe on agent_end"',
				"info",
			);

			await pi.fire("agent_settled", {}, ctx);
			expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
		});

		it("silently skips autoDescribe on agent_end when signal is aborted", async () => {
			defaultJj("", true);
			const pi = makePi();
			register(pi);
			const ctx = makeCtx({
				hasUI: true,
				signal: { aborted: true } as AbortSignal,
			});
			await pi.fire("session_start", {}, ctx);
			await pi.fire("before_agent_start", { prompt: "my task" }, ctx);

			await pi.fire("agent_end", {}, ctx);
			expect(ctx.ui.notify).not.toHaveBeenCalled();
		});

		it("injects skill on every turn and avoids duplicating if systemPrompt already has it", async () => {
			defaultJj("", false);
			const pi = makePi();
			register(pi);
			const ctx = makeCtx();
			await pi.fire("session_start", {}, ctx);

			const turn1 = await pi.fire(
				"before_agent_start",
				{ prompt: "turn 1", systemPrompt: "base prompt" },
				ctx,
			);
			expect(turn1?.systemPrompt).toContain("base prompt");
			expect(turn1?.systemPrompt).toContain("pi-jj-auto");

			// Turn 2 with fresh systemPrompt gets injected again
			const turn2 = await pi.fire(
				"before_agent_start",
				{ prompt: "turn 2", systemPrompt: "base prompt 2" },
				ctx,
			);
			expect(turn2?.systemPrompt).toContain("base prompt 2");
			expect(turn2?.systemPrompt).toContain("pi-jj-auto");

			// Turn 3 where systemPrompt already has it does not append again
			const turn3 = await pi.fire(
				"before_agent_start",
				{ prompt: "turn 3", systemPrompt: turn2.systemPrompt },
				ctx,
			);
			expect(turn3).toBeUndefined();
		});
	});
});

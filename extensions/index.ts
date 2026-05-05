import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type {
	ExtensionAPI,
	ToolCallEvent,
} from "@mariozechner/pi-coding-agent";
import { loadConfig, type Config } from "./config.js";
import { isJjRepo, getRevisionInfo } from "./jj.js";

interface SessionState {
	readonly cwd: string;
	readonly config: Config;
	readonly skillContent: string;
	prompt: string;
	guardResolved: boolean;
	skillInjected: boolean;
}

type BashCommandKind = "jj-readonly" | "jj-resolution" | "mutating" | "safe";

const JJ_READONLY_RE = /\bjj\s+(?:log|status|st|diff|root|show|file|cat)\b/;
const JJ_RESOLUTION_RE = /\bjj\s+(?:new|desc|describe)\b/;
const MUTATING_SHELL_RE =
	/\b(?:chmod|chown|touch|mkdir|rm|rmdir|mv|cp|sed\s+-i|tee)\b/;
const GUARDED_TOOLS = new Set(["write", "edit"]);
const PROCESS = (
	globalThis as {
		process?: {
			env?: Record<string, string | undefined>;
			stderr?: { write: (message: string) => void };
		};
	}
).process;
const DEBUG_ENABLED = PROCESS?.env?.PI_JJ_AUTO_DEBUG === "1";

export default function register(pi: ExtensionAPI): void {
	let state: SessionState | null = null;

	pi.on("session_start", async (_event, ctx) => {
		const config = loadConfig(ctx.cwd);
		const repo = config.enabled ? await isJjRepo(ctx.cwd) : false;

		if (!config.enabled || !repo) {
			debugLog("inactive", { cwd: ctx.cwd, enabled: config.enabled, repo });
			state = null;
			return;
		}

		state = {
			cwd: ctx.cwd,
			config,
			skillContent: loadSkillContent(),
			prompt: "",
			guardResolved: false,
			skillInjected: false,
		};

		debugLog("active", {
			cwd: ctx.cwd,
			skillContentLength: state.skillContent.length,
		});
		if (ctx.hasUI) ctx.ui.setStatus("pi-jj-auto", "✓ active");
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (ctx.hasUI) ctx.ui.setStatus("pi-jj-auto", "");
		state = null;
	});

	pi.on("session_compact", async (_event, _ctx) => {
		if (state) state.skillInjected = false;
	});

	pi.on("before_agent_start", async (event, _ctx) => {
		if (!state) return;

		state.prompt = event.prompt;
		state.guardResolved = false;

		if (!state.skillInjected && state.skillContent) {
			state.skillInjected = true;
			debugLog("inject skill", { promptLength: event.prompt.length });
			return {
				systemPrompt: event.systemPrompt + "\n\n" + state.skillContent,
			};
		}

		debugLog("skip skill inject", {
			skillInjected: state.skillInjected,
			skillContentLength: state.skillContent.length,
		});
	});

	pi.on("tool_call", async (event: ToolCallEvent, ctx) => {
		if (!state || state.guardResolved) return;

		const bashKind = classifyBashCommand(event);
		debugLog("tool_call", {
			toolName: event.toolName,
			bashKind,
			command: firstLine(extractBashCommand(event), 120),
		});

		if (bashKind === "jj-readonly") return;

		if (bashKind === "jj-resolution") return;

		if (!GUARDED_TOOLS.has(event.toolName) && bashKind !== "mutating") return;

		try {
			const revision = await getRevisionInfo(state.cwd, ctx.signal);
			return applyGuard(
				revision,
				state,
				ctx.hasUI ? ctx.ui.notify.bind(ctx.ui) : undefined,
			);
		} catch (err) {
			console.error("[pi-jj-auto] guard check failed:", err);
			if (state.config.blockOnMismatch) {
				return {
					block: true,
					reason:
						"[pi-jj-auto] Could not read jj revision state. Retry after checking `jj status`.",
				};
			}
		}
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (!state || !state.config.autoDescribe || !ctx.hasUI) return;

		try {
			const info = await getRevisionInfo(state.cwd, ctx.signal);
			if (!info.description && info.hasDiff) {
				ctx.ui.notify(
					'pi-jj-auto: revision has changes but no description — run `jj describe -m "<summary>"`',
					"warning",
				);
			}
		} catch (err) {
			console.error("[pi-jj-auto] agent_end check failed:", err);
		}
	});
}

function applyGuard(
	revision: Awaited<ReturnType<typeof getRevisionInfo>>,
	state: SessionState,
	notify?: (msg: string, kind: "info" | "warning") => void,
): { block: true; reason: string } | undefined {
	if (!revision.description && !revision.hasDiff) {
		state.guardResolved = true;
		return undefined;
	}

	if (!revision.description && revision.hasDiff) {
		const task = firstLine(state.prompt, state.config.maxPromptLength);
		return {
			block: true,
			reason: [
				`[pi-jj-auto] Revision has uncommitted changes but no description.`,
				`Your task: "${task}"`,
				``,
				`Run ONE of these, then retry:`,
				`  Same work: jj describe -m "<short description>"`,
				`  New work:  jj new -m "<short description>"`,
			].join("\n"),
		};
	}

	if (revision.hasDiff) {
		if (state.config.blockOnMismatch) {
			const short = firstLine(revision.description, 60);
			const task = firstLine(state.prompt, state.config.maxPromptLength);
			return {
				block: true,
				reason: [
					`[pi-jj-auto] Revision "${short}" already has work.`,
					`Your task: "${task}"`,
					``,
					`Run ONE of these, then retry:`,
					`  New task:  jj new -m "${task}"`,
					`  Same task: jj describe -m "${short}"`,
				].join("\n"),
			};
		}

		notify?.(
			`pi-jj-auto: revision "${firstLine(revision.description, 60)}" has changes — consider jj new`,
			"info",
		);
		state.guardResolved = true;
		return undefined;
	}

	state.guardResolved = true;
	return undefined;
}

function classifyBashCommand(event: ToolCallEvent): BashCommandKind {
	if (event.toolName !== "bash") return "safe";

	const command = extractBashCommand(event);
	if (!command) return "safe";

	if (hasFileOutputRedirect(command)) return "mutating";
	if (MUTATING_SHELL_RE.test(command)) return "mutating";
	if (JJ_READONLY_RE.test(command)) return "jj-readonly";
	if (JJ_RESOLUTION_RE.test(command)) return "jj-resolution";

	return "safe";
}

function hasFileOutputRedirect(command: string): boolean {
	const outputRedirectRe =
		/(?:^|[^<])((?:\d*>>?)|(?:&>>?)|(?:>\|))\s*("[^"]*"|'[^']*'|[^\s;&|]+)/g;
	let match: RegExpExecArray | null;
	while ((match = outputRedirectRe.exec(command))) {
		const target = normalizeRedirectTarget(match[2] ?? "");
		if (!target) continue;
		if (target.startsWith("&")) continue; // fd redirect: 2>&1, >&2
		if (target.startsWith("(")) continue; // process substitution: >(cmd)
		if (target === "/dev/null") continue;
		return true;
	}
	return false;
}

function normalizeRedirectTarget(raw: string): string {
	const trimmed = raw.trim();
	if (
		(trimmed.startsWith('"') && trimmed.endsWith('"')) ||
		(trimmed.startsWith("'") && trimmed.endsWith("'"))
	) {
		return trimmed.slice(1, -1);
	}
	return trimmed;
}

function extractBashCommand(event: ToolCallEvent): string {
	const input = event.input as Record<string, unknown>;
	return String(input?.command ?? input?.cmd ?? input?.script ?? "").trim();
}

function firstLine(text: string, maxLength: number): string {
	const line = text.split("\n")[0]?.trim() ?? "";
	if (maxLength <= 0) return "";
	if (line.length <= maxLength) return line;
	return maxLength <= 3
		? line.slice(0, maxLength)
		: line.slice(0, maxLength - 3) + "...";
}

function loadSkillContent(): string {
	const dir = dirname(fileURLToPath(import.meta.url));
	const paths = [
		join(dir, "../skills/SKILL.md"),
		join(dir, "../../skills/SKILL.md"),
	];
	for (const p of paths) {
		if (existsSync(p)) {
			const content = readFileSync(p, "utf-8");
			return content.replace(/^---[\s\S]*?---\n/, "").trim();
		}
	}
	debugLog("skill content not found", { paths });
	return "";
}

function debugLog(message: string, details?: Record<string, unknown>): void {
	if (!DEBUG_ENABLED) return;
	const suffix = details ? ` ${JSON.stringify(details)}` : "";
	const line = `[pi-jj-auto] ${message}${suffix}\n`;
	if (PROCESS?.stderr) {
		PROCESS.stderr.write(line);
		return;
	}
	console.debug(line.trimEnd());
}

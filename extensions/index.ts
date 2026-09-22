import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type {
	ExtensionAPI,
	ToolCallEvent,
} from "@mariozechner/pi-coding-agent";
import { loadConfig, type Config } from "./config.js";
import {
	isJjRepo,
	getRevisionInfo,
	describeRevision,
	type RevisionInfo,
} from "./jj.js";
import { classifyShellCommand } from "./shell.js";

interface SessionState {
	readonly cwd: string;
	readonly config: Config;
	readonly skillContent: string;
	prompt: string;
	guardResolved: boolean;
	turnFinished?: boolean;
	baselineRevision?: RevisionInfo;
	mutatedInTurn?: boolean;
	blockedRevision?: { changeId: string; description: string };
	pendingResolutions: Map<
		string,
		{ kind: "desc" | "new"; targetChangeId: string }
	>;
	pendingMutations: Set<string>;
	successfulResolution?: { kind: "desc" | "new"; targetChangeId: string };
}

const GUARDED_TOOLS = new Set(["write", "edit"]);
const SHELL_TOOLS = new Set(["bash", "powershell"]);

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
			pendingResolutions: new Map(),
			pendingMutations: new Set(),
		};

		debugLog("active", {
			cwd: ctx.cwd,
			skillContentLength: state.skillContent.length,
		});
		if (ctx.hasUI) ctx.ui.setStatus("pi-jj-auto", "✓ active");
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (ctx.hasUI) ctx.ui.setStatus("pi-jj-auto", undefined);
		state = null;
	});

	pi.on("before_agent_start", async (event, _ctx) => {
		if (!state) return;

		state.prompt = event.prompt;
		state.guardResolved = false;
		state.turnFinished = false;
		state.mutatedInTurn = false;
		state.blockedRevision = undefined;
		state.pendingResolutions.clear();
		state.pendingMutations.clear();
		state.successfulResolution = undefined;

		try {
			state.baselineRevision = await getRevisionInfo(state.cwd);
		} catch {
			state.baselineRevision = undefined;
		}

		const currentSystemPrompt =
			typeof event.systemPrompt === "string" ? event.systemPrompt : "";
		if (
			state.skillContent &&
			!currentSystemPrompt.includes(state.skillContent)
		) {
			debugLog("inject skill", { promptLength: event.prompt.length });
			return {
				systemPrompt: currentSystemPrompt
					? currentSystemPrompt + "\n\n" + state.skillContent
					: state.skillContent,
			};
		}
	});

	pi.on("tool_call", async (event: ToolCallEvent, ctx) => {
		if (!state) return;
		const toolCallId = event.toolCallId ?? "";

		if (SHELL_TOOLS.has(event.toolName)) {
			const command = extractBashCommand(event);
			const classification = classifyShellCommand(command);

			if (
				classification.kind === "jj-readonly" ||
				classification.kind === "safe"
			) {
				return;
			}

			if (classification.kind === "jj-resolution") {
				state.pendingResolutions.set(toolCallId, {
					kind: classification.resolutionType,
					targetChangeId: state.blockedRevision?.changeId ?? "",
				});
				return;
			}
		} else if (!GUARDED_TOOLS.has(event.toolName)) {
			return;
		}

		if (state.guardResolved) {
			state.pendingMutations.add(toolCallId);
			return undefined;
		}

		try {
			const revision = await getRevisionInfo(state.cwd, ctx.signal);

			if (state.successfulResolution) {
				const res = state.successfulResolution;
				if (res.kind === "desc") {
					const matchesTarget =
						!res.targetChangeId || revision.changeId === res.targetChangeId;
					const descNonEmpty = revision.description.trim().length > 0;
					if (matchesTarget && descNonEmpty) {
						state.guardResolved = true;
						state.blockedRevision = undefined;
						state.successfulResolution = undefined;
						state.pendingMutations.add(toolCallId);
						return undefined;
					}
				} else if (res.kind === "new") {
					const changeIdChanged =
						!res.targetChangeId || revision.changeId !== res.targetChangeId;
					const noDiff = !revision.hasDiff;
					if (changeIdChanged && noDiff) {
						state.guardResolved = true;
						state.blockedRevision = undefined;
						state.successfulResolution = undefined;
						state.pendingMutations.add(toolCallId);
						return undefined;
					}
				}
			}

			const guardResult = applyGuard(
				revision,
				state,
				ctx.hasUI ? ctx.ui.notify.bind(ctx.ui) : undefined,
			);

			if (guardResult?.block) {
				state.blockedRevision = {
					changeId: revision.changeId,
					description: revision.description,
				};
				return guardResult;
			}

			state.pendingMutations.add(toolCallId);
			return undefined;
		} catch (err: unknown) {
			if (
				ctx.signal?.aborted ||
				(err instanceof Error &&
					(err.name === "AbortError" ||
						err.message.includes("ABORT_ERR") ||
						err.message.includes("aborted")))
			) {
				return;
			}
			const message =
				err instanceof Error ? (err.stack ?? err.message) : String(err);
			console.error(`[pi-jj-auto] guard check failed: ${message}`);
			if (state.config.blockOnMismatch) {
				return {
					block: true,
					reason:
						"[pi-jj-auto] Could not read jj revision state. Retry after checking `jj status`.",
				};
			}
		}
	});

	pi.on("tool_result", async (event: any, _ctx) => {
		if (!state) return;
		const toolCallId = event.toolCallId ?? "";

		const isError = Boolean(
			event.isError ||
				(event.details &&
					typeof event.details.exitCode === "number" &&
					event.details.exitCode !== 0),
		);

		if (state.pendingResolutions.has(toolCallId)) {
			const pending = state.pendingResolutions.get(toolCallId)!;
			state.pendingResolutions.delete(toolCallId);
			if (!isError) {
				state.successfulResolution = pending;
			}
		}

		if (state.pendingMutations.has(toolCallId)) {
			state.pendingMutations.delete(toolCallId);
			if (!isError) {
				state.mutatedInTurn = true;
			}
		}
	});

	const handleAgentFinish = async (ctx: {
		signal?: AbortSignal;
		hasUI?: boolean;
		ui?: { notify: (msg: string, kind: "info" | "warning") => void };
	}) => {
		if (!state || state.turnFinished || ctx.signal?.aborted) return;
		state.turnFinished = true;

		try {
			const finalRev = await getRevisionInfo(state.cwd, ctx.signal);
			const shouldAutoDescribe =
				state.baselineRevision !== undefined &&
				state.baselineRevision.changeId === finalRev.changeId &&
				!state.baselineRevision.description &&
				!state.baselineRevision.hasDiff &&
				state.mutatedInTurn &&
				finalRev.hasDiff &&
				!finalRev.description;

			if (shouldAutoDescribe) {
				if (state.config.autoDescribe) {
					const message = firstLine(state.prompt, state.config.maxPromptLength);
					if (message) {
						await describeRevision(
							state.cwd,
							finalRev.changeId,
							message,
							ctx.signal,
						);
						if (ctx.hasUI && ctx.ui) {
							ctx.ui.notify(
								`pi-jj-auto: described revision as "${message}"`,
								"info",
							);
						}
					}
				} else if (ctx.hasUI && ctx.ui) {
					ctx.ui.notify(
						'pi-jj-auto: revision has changes but no description — run `jj describe -m "<summary>"`',
						"warning",
					);
				}
			}
		} catch (err: unknown) {
			if (
				ctx.signal?.aborted ||
				(err instanceof Error &&
					(err.name === "AbortError" ||
						err.message.includes("ABORT_ERR") ||
						err.message.includes("aborted")))
			) {
				return;
			}
			const message =
				err instanceof Error ? (err.stack ?? err.message) : String(err);
			console.error(`[pi-jj-auto] auto-describe failed: ${message}`);
		}
	};

	pi.on("agent_end", async (_event, ctx) => {
		await handleAgentFinish(ctx);
	});

	pi.on("agent_settled", async (_event, ctx) => {
		await handleAgentFinish(ctx);
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
		join(dir, "../skills/pi-jj-auto/SKILL.md"),
		join(dir, "../../skills/pi-jj-auto/SKILL.md"),
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

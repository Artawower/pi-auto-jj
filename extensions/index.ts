/**
 * pi-jj-auto — Automatic jj revision management extension.
 *
 * Guard decision matrix (on first write/edit per agent run):
 *
 *   description  │  diff   │  action
 *   ─────────────┼─────────┼──────────────────────────────────────────
 *   empty        │  any    │  allow — fresh/WIP revision
 *   exists       │  empty  │  allow — just created via `jj new -m`
 *   exists       │  exists │  block — sealed revision, LLM decides
 */

import type {
  ExtensionAPI,
  ToolCallEvent,
} from "@mariozechner/pi-coding-agent";
import { isToolCallEventType } from "@mariozechner/pi-coding-agent";
import { loadConfig } from "./config.js";
import {
  isJjRepo,
  getCurrentDescription,
  hasDiff,
  describeRevision,
} from "./jj.js";

interface AgentRunState {
  prompt: string;
  /** true = guard passed, edits flow freely for the rest of this agent run */
  guardResolved: boolean;
  cwd: string;
  config: ReturnType<typeof loadConfig>;
}

export default function (pi: ExtensionAPI) {
  let state: AgentRunState | null = null;

  pi.on("session_start", async (_event, ctx) => {
    console.error(`[pi-jj-auto] session_start cwd=${ctx.cwd}`);
    const config = loadConfig(ctx.cwd);
    if (!config.enabled) {
      console.error("[pi-jj-auto] disabled by config");
      state = null;
      return;
    }

    const jjOk = await isJjRepo(pi.exec, ctx.cwd);
    console.error(`[pi-jj-auto] isJjRepo=${jjOk}`);
    if (!jjOk) {
      state = null;
      return;
    }

    state = { prompt: "", guardResolved: false, cwd: ctx.cwd, config };
    console.error("[pi-jj-auto] guard active");

    if (ctx.hasUI) ctx.ui.setStatus("pi-jj-auto", "✓ active");
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (ctx.hasUI) ctx.ui.setStatus("pi-jj-auto", "");
    state = null;
  });

  pi.on("before_agent_start", async (event, _ctx) => {
    if (!state) return;
    state.prompt = event.prompt;
    state.guardResolved = false;
  });

  pi.on("agent_end", async (_event, ctx) => {
    if (!state || !state.config.autoDescribe) return;

    try {
      const [description, diffPresent] = await Promise.all([
        getCurrentDescription(pi.exec, state.cwd, ctx.signal),
        hasDiff(pi.exec, state.cwd, ctx.signal),
      ]);

      if (description === "" && diffPresent && state.prompt) {
        const msg = truncatePrompt(state.prompt, state.config.maxPromptLength);
        await describeRevision(pi.exec, state.cwd, msg, ctx.signal);
        if (ctx.hasUI)
          ctx.ui.notify(`pi-jj-auto: described as "${msg}"`, "info");
      }
    } catch (err) {
      console.error("[pi-jj-auto] auto-describe failed:", err);
    }
  });

  pi.on("tool_call", async (event: ToolCallEvent, ctx) => {
    if (!state) return;
    if (state.guardResolved) return;

    const isWrite = isToolCallEventType("write", event);
    const isEdit = isToolCallEventType("edit", event);
    if (!isWrite && !isEdit) return;

    try {
      const description = await getCurrentDescription(
        pi.exec,
        state.cwd,
        ctx.signal,
      );

      if (description === "") {
        state.guardResolved = true;
        return;
      }

      const diffPresent = await hasDiff(pi.exec, state.cwd, ctx.signal);

      if (!diffPresent) {
        state.guardResolved = true;
        return;
      }

      if (!state.config.blockOnMismatch) {
        state.guardResolved = true;
        if (ctx.hasUI) {
          ctx.ui.notify(
            `pi-jj-auto: "${truncatePrompt(description, 60)}" has changes — consider jj new`,
            "info",
          );
        }
        return;
      }

      const shortDesc = truncatePrompt(description, 60);
      const taskHint = state.prompt
        ? truncatePrompt(state.prompt, 100)
        : "(current task)";

      return {
        block: true,
        reason:
          `[pi-jj-auto] Revision "${shortDesc}" already has work.\n` +
          `Your task: "${taskHint}"\n\n` +
          `Run ONE of these, then retry the edit:\n` +
          `  New task:  jj new -m "${taskHint}"\n` +
          `  Same task: jj desc -m "${shortDesc} + ${taskHint}"`,
      };
    } catch (err) {
      console.error("[pi-jj-auto] guard check failed:", err);
      state.guardResolved = true;
    }
  });
}

function truncatePrompt(prompt: string, maxLen: number): string {
  const firstLine = prompt.split("\n")[0] ?? prompt;
  return firstLine.length <= maxLen
    ? firstLine
    : firstLine.slice(0, maxLen - 3) + "...";
}

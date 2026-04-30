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
  isJjRepo: boolean;
  config: ReturnType<typeof loadConfig>;
}

export default function (pi: ExtensionAPI) {
  let state: AgentRunState | null = null;

  pi.on("session_start", async (_event, ctx) => {
    const config = loadConfig(ctx.cwd);
    if (!config.enabled) {
      state = null;
      return;
    }

    if (!(await isJjRepo(pi.exec))) {
      state = null;
      return;
    }

    state = { prompt: "", guardResolved: false, isJjRepo: true, config };

    if (ctx.hasUI) ctx.ui.setStatus("pi-jj-auto", "✓ active");
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (ctx.hasUI) ctx.ui.setStatus("pi-jj-auto", "");
    state = null;
  });

  pi.on("before_agent_start", async (event, _ctx) => {
    if (!state?.isJjRepo) return;
    state.prompt = event.prompt;
    state.guardResolved = false;
  });

  pi.on("agent_end", async (_event, ctx) => {
    if (!state?.isJjRepo || !state.config.autoDescribe) return;

    try {
      const [description, diffPresent] = await Promise.all([
        getCurrentDescription(pi.exec, ctx.signal),
        hasDiff(pi.exec, ctx.signal),
      ]);

      // Only describe if there is actual work and the description is still empty
      if (description === "" && diffPresent && state.prompt) {
        const msg = truncatePrompt(state.prompt, state.config.maxPromptLength);
        await describeRevision(pi.exec, msg, ctx.signal);
        if (ctx.hasUI)
          ctx.ui.notify(`pi-jj-auto: described as "${msg}"`, "info");
      }
    } catch (err) {
      console.error("[pi-jj-auto] auto-describe failed:", err);
    }
  });

  pi.on("tool_call", async (event: ToolCallEvent, ctx) => {
    if (!state?.isJjRepo) return;
    if (state.guardResolved) return;

    const isWrite = isToolCallEventType("write", event);
    const isEdit = isToolCallEventType("edit", event);
    if (!isWrite && !isEdit) return;

    try {
      const description = await getCurrentDescription(pi.exec, ctx.signal);

      // No description — fresh or WIP revision, allow freely
      if (description === "") {
        state.guardResolved = true;
        return;
      }

      const diffPresent = await hasDiff(pi.exec, ctx.signal);

      // Description exists but diff is empty — revision was just created via `jj new -m`
      // Allow: the LLM is about to start working in it
      if (!diffPresent) {
        state.guardResolved = true;
        return;
      }

      // Description exists AND diff exists — sealed revision with work
      // Block until LLM runs jj new / jj desc and description or diff changes
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
          `Decide before editing:\n` +
          `1. NEW task → jj new -m "<description>"\n` +
          `2. CONTINUES same work → jj desc -m "<updated description>"\n` +
          `Then retry the edit.`,
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

import type { ExecResult } from "@mariozechner/pi-coding-agent";

type Exec = (cmd: string, args: string[], opts?: any) => Promise<ExecResult>;

const DESC_TEMPLATE = 'if(description, description, "")';

export async function getCurrentDescription(
  exec: Exec,
  signal?: AbortSignal,
): Promise<string> {
  const { stdout } = await exec(
    "jj",
    ["log", "--no-graph", "-r", "@", "--template", DESC_TEMPLATE],
    { signal },
  );
  return stdout.trim();
}

/** Returns true if the current @ revision has any uncommitted file changes. */
export async function hasDiff(
  exec: Exec,
  signal?: AbortSignal,
): Promise<boolean> {
  const { stdout } = await exec("jj", ["diff", "--stat"], { signal });
  return stdout.trim().length > 0;
}

export async function describeRevision(
  exec: Exec,
  message: string,
  signal?: AbortSignal,
): Promise<ExecResult> {
  return exec("jj", ["desc", "-m", message], { signal });
}

export async function isJjRepo(exec: Exec): Promise<boolean> {
  try {
    const { exitCode } = await exec("jj", ["root"]);
    return exitCode === 0;
  } catch {
    return false;
  }
}

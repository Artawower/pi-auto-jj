import type { ExecResult } from "@mariozechner/pi-coding-agent";

type Exec = (cmd: string, args: string[], opts?: any) => Promise<ExecResult>;

const DESC_TEMPLATE = 'if(description, description, "")';

export async function getCurrentDescription(
  exec: Exec,
  cwd: string,
  signal?: AbortSignal,
): Promise<string> {
  const { stdout } = await exec(
    "jj",
    ["log", "--no-graph", "-r", "@", "--template", DESC_TEMPLATE],
    { signal, cwd },
  );
  return stdout.trim();
}

export async function hasDiff(
  exec: Exec,
  cwd: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const { stdout } = await exec("jj", ["diff", "--stat"], { signal, cwd });
  return stdout.trim().length > 0;
}

export async function describeRevision(
  exec: Exec,
  cwd: string,
  message: string,
  signal?: AbortSignal,
): Promise<ExecResult> {
  return exec("jj", ["desc", "-m", message], { signal, cwd });
}

export async function isJjRepo(exec: Exec, cwd: string): Promise<boolean> {
  try {
    const { exitCode } = await exec("jj", ["root"], { cwd });
    return exitCode === 0;
  } catch {
    return false;
  }
}

import { execFile } from "node:child_process";

export interface RevisionInfo {
  changeId: string;
  description: string;
  hasDiff: boolean;
}

export async function getRevisionInfo(
  cwd: string,
  signal?: AbortSignal,
): Promise<RevisionInfo> {
  const template =
    'change_id.short() ++ "\\n" ++ if(description, description, "") ++ "\\n" ++ if(diff.files(), "yes", "no")';

  const { stdout } = await jj(
    ["log", "--no-graph", "-r", "@", "--template", template],
    cwd,
    signal,
  );
  const [changeId = "", description = "", diffFlag = "no"] = stdout
    .trim()
    .split("\n");

  return {
    changeId: changeId.trim(),
    description: description.trim(),
    hasDiff: diffFlag.trim() === "yes",
  };
}

export async function getCurrentDescription(
  cwd: string,
  signal?: AbortSignal,
): Promise<string> {
  const { stdout } = await jj(
    [
      "log",
      "--no-graph",
      "-r",
      "@",
      "--template",
      'if(description, description, "")',
    ],
    cwd,
    signal,
  );
  return stdout.trim();
}

export async function hasDiff(
  cwd: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const { stdout } = await jj(["diff", "--stat"], cwd, signal);
  return stdout.trim().length > 0;
}

export async function describeRevision(
  cwd: string,
  message: string,
  signal?: AbortSignal,
): Promise<void> {
  await jj(["desc", "-m", message], cwd, signal);
}

export async function isJjRepo(cwd: string): Promise<boolean> {
  try {
    await jj(["root"], cwd);
    return true;
  } catch {
    return false;
  }
}

function jj(
  args: string[],
  cwd: string,
  signal?: AbortSignal,
): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "jj",
      args,
      { cwd, signal, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`jj ${args.join(" ")} failed: ${stderr}`));
        } else {
          resolve({ stdout: stdout ?? "" });
        }
      },
    );

    signal?.addEventListener("abort", () => child.kill(), { once: true });
  });
}

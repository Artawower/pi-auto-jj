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
    'concat("{\\"changeId\\":", change_id.short().escape_json(), ",\\"description\\":", description.escape_json(), ",\\"hasDiff\\":", if(diff.files(), "true", "false"), "}")';

  const { stdout } = await jj(
    ["log", "--no-graph", "-r", "@", "--template", template],
    cwd,
    signal,
  );

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch (err) {
    throw new Error(`Failed to parse jj revision JSON: ${stdout.trim()}`, {
      cause: err,
    });
  }

  if (
    !parsed ||
    typeof parsed !== "object" ||
    typeof (parsed as Record<string, unknown>).changeId !== "string" ||
    typeof (parsed as Record<string, unknown>).description !== "string" ||
    typeof (parsed as Record<string, unknown>).hasDiff !== "boolean"
  ) {
    throw new Error(`Invalid jj revision info payload: ${stdout.trim()}`);
  }

  const raw = parsed as {
    changeId: string;
    description: string;
    hasDiff: boolean;
  };

  return {
    changeId: raw.changeId.trim(),
    description: raw.description.trim(),
    hasDiff: raw.hasDiff,
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
  changeId: string,
  message: string,
  signal?: AbortSignal,
): Promise<void> {
  await jj(["desc", "-r", changeId, "-m", message], cwd, signal);
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
  if (signal?.aborted) {
    const abortErr = new Error("The operation was aborted");
    abortErr.name = "AbortError";
    return Promise.reject(abortErr);
  }

  return new Promise((resolve, reject) => {
    execFile(
      "jj",
      ["--no-pager", "--color=never", ...args],
      { cwd, signal, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const detail = (stderr ?? "").trim() || error.message;
          const err = new Error(`jj ${args.join(" ")} failed: ${detail}`, {
            cause: error,
          });
          if (
            error.name === "AbortError" ||
            (error as unknown as { code?: string }).code === "ABORT_ERR"
          ) {
            err.name = "AbortError";
          }
          reject(err);
        } else {
          resolve({ stdout: stdout ?? "" });
        }
      },
    );
  });
}

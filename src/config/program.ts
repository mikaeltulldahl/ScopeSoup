// Whether a program can be started, for what the levels need: the agent CLI from level 1.

import { statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

/** Whether a program can be started: a path that exists, or a bare name found on PATH (with PATHEXT on Windows). */
export function programFound(command: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): boolean {
  // One stat per candidate: with a long PATH and PATHEXT there are hundreds of them.
  const isFile = (path: string): boolean => {
    try {
      return statSync(path, { throwIfNoEntry: false })?.isFile() ?? false;
    } catch {
      return false;
    }
  };
  if (command.trim() === "") return false;
  if (isAbsolute(command) || /[\\/]/.test(command)) return isFile(command);
  const dirs = (env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean);
  const extensions = platform === "win32" ? ["", ...(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)] : [""];
  return dirs.some((dir) => extensions.some((ext) => isFile(join(dir, command + ext)) || (ext !== ext.toLowerCase() && isFile(join(dir, command + ext.toLowerCase())))));
}

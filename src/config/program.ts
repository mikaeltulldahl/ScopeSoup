// Whether a program can be started, for what the levels need: the agent CLI from level 1.

import { existsSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

/** Whether a program can be started: a path that exists, or a bare name found on PATH (with PATHEXT on Windows). */
export function programFound(command: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): boolean {
  const isFile = (path: string): boolean => {
    try {
      return existsSync(path) && statSync(path).isFile();
    } catch {
      return false;
    }
  };
  if (command.trim() === "") return false;
  if (isAbsolute(command) || /[\\/]/.test(command)) return isFile(command);
  const dirs = (env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean);
  const extensions = platform === "win32" ? ["", ...(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)] : [""];
  return dirs.some((dir) => extensions.some((ext) => isFile(join(dir, command + ext)) || isFile(join(dir, command + ext.toLowerCase()))));
}

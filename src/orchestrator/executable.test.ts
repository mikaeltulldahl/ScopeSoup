import assert from "node:assert/strict";
import { test } from "node:test";
import { ExecutableNotFound, resolveExecutable } from "./executable.ts";

function on(files: string[], env: NodeJS.ProcessEnv = { Path: "C:\\npm;C:\\Users\\me\\.local\\bin" }) {
  const set = new Set(files.map((file) => file.toLowerCase()));
  return { platform: "win32" as const, env, isFile: (path: string) => set.has(path.toLowerCase()) };
}

test("outside Windows the command is left to the operating system", () => {
  assert.equal(resolveExecutable("claude", { platform: "linux" }), "claude");
});

test("on Windows an .exe on PATH is found, whatever the case of Path", () => {
  assert.equal(resolveExecutable("claude", on(["C:\\Users\\me\\.local\\bin\\claude.exe"])), "C:\\Users\\me\\.local\\bin\\claude.exe");
});

test("an .exe wins over a shim, even when the shim's directory comes first", () => {
  const options = on(["C:\\npm\\claude.cmd", "C:\\npm\\claude", "C:\\Users\\me\\.local\\bin\\claude.exe"]);
  assert.equal(resolveExecutable("claude", options), "C:\\Users\\me\\.local\\bin\\claude.exe");
});

test("only a shim is an error that names the shim and what to set", () => {
  assert.throws(
    () => resolveExecutable("claude", on(["C:\\npm\\claude.cmd", "C:\\npm\\claude"])),
    (error) => error instanceof ExecutableNotFound && /C:\\npm\\claude\.cmd/.test(error.message) && /full path of the real \.exe/.test(error.message),
  );
});

test("nothing found is an error too", () => {
  assert.throws(() => resolveExecutable("claude", on([])), /Could not find claude on PATH/);
});

test("a full path is checked as given, with .exe added when it lacks one", () => {
  assert.equal(resolveExecutable("D:\\tools\\claude.exe", on(["D:\\tools\\claude.exe"])), "D:\\tools\\claude.exe");
  assert.equal(resolveExecutable("D:\\tools\\claude", on(["D:\\tools\\claude.exe"])), "D:\\tools\\claude.exe");
  assert.throws(() => resolveExecutable("D:\\tools\\claude.exe", on([])), /Could not find D:\\tools\\claude\.exe\./);
  assert.throws(() => resolveExecutable("D:\\tools\\claude", on(["D:\\tools\\claude.cmd"])), /shim/);
});

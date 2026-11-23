import assert from "node:assert/strict";
import { test } from "node:test";
import type { Git } from "./process.ts";
import { remoteMismatch, repositoryKey, sameRepository } from "./remote.ts";

test("https, ssh and git@ forms of one repository are the same, whatever the case and a trailing .git", () => {
  const forms = [
    "https://github.example/Owner/Name.git",
    "https://github.example/owner/name",
    "https://user@github.example/owner/name/",
    "git@github.example:Owner/Name.git",
    "ssh://git@github.example/owner/name.git",
    "ssh://git@github.example:2222/OWNER/name",
  ];
  for (const form of forms) assert.equal(repositoryKey(form), "github.example/owner/name", form);
  assert.ok(sameRepository(forms[0] as string, forms[3] as string));
});

test("another owner, name or host is another repository", () => {
  assert.equal(sameRepository("git@github.example:owner/name.git", "git@github.example:fork/name.git"), false);
  assert.equal(sameRepository("git@github.example:owner/name.git", "https://github.example/owner/name-mirror"), false);
  assert.equal(sameRepository("git@github.example:owner/name.git", "git@mirror.example:owner/name.git"), false);
});

test("local paths compare as paths, without case and with either slash", () => {
  assert.ok(sameRepository("C:\\Temp\\Project.git", "c:/temp/project"));
  assert.equal(sameRepository("/tmp/a/project.git", "/tmp/b/project.git"), false);
});

test("remoteMismatch names both addresses when they differ", async () => {
  const git: Git = async () => ({ code: 0, stdout: "git@github.example:fork/name.git\n", stderr: "" });
  assert.equal(await remoteMismatch(git, "/r", "origin", "https://github.example/fork/name"), null);
  const why = await remoteMismatch(git, "/r", "origin", "https://github.example/owner/name");
  assert.match(why ?? "", /git@github\.example:fork\/name\.git/);
  assert.match(why ?? "", /https:\/\/github\.example\/owner\/name/);
});

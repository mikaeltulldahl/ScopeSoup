// A role's MCP servers: read from the file, passed to each CLI, and allowed for the role (synthetic names only).

import assert from "node:assert/strict";
import { test } from "node:test";
import { validateConfig } from "../../../config/validate.ts";
import { copilotArgs } from "../copilot/command.ts";
import { copilotCommandsText } from "../copilot/index.ts";
import { buildCommand } from "./command.ts";
import { allowedCommandsText } from "./commands.ts";

const SERVER = { command: "npx", args: ["-y", "demo-mcp"], env: ["DEMO_TOKEN"] };

function config(roles: Record<string, unknown>) {
  const result = validateConfig({ project: "synthetic", machineName: "laptop-a", repoPath: "repo", roles }, "C:\synthetic");
  if (!result.ok) assert.fail(result.errors.join("\n"));
  return result.config;
}

function refused(roles: Record<string, unknown>): string {
  const result = validateConfig({ project: "synthetic", machineName: "laptop-a", repoPath: "repo", roles }, "C:\synthetic");
  assert.equal(result.ok, false);
  return result.ok ? "" : result.errors.join("\n");
}

test("a role's servers are read, and their tools count as allowed for that role only", () => {
  const c = config({ implement: { mcpServers: { demo: SERVER } } });
  assert.deepEqual(c.roles.implement.mcpServers, { demo: SERVER });
  assert.ok(c.roles.implement.allowedTools.includes("mcp__demo"));
  assert.equal(c.roles.review.mcpServers, undefined);
  assert.ok(!c.roles.review.allowedTools.some((tool) => tool.startsWith("mcp__")));
});

test("a server's env names variables; a value, an unknown key or a bad name is refused", () => {
  assert.match(refused({ implement: { mcpServers: { demo: { command: "x", env: { DEMO_TOKEN: "abc" } } } } }), /env must be a list of variable names/);
  assert.match(refused({ implement: { mcpServers: { demo: { command: "x", env: ["DEMO_TOKEN=abc"] } } } }), /env must be a list of variable names/);
  assert.match(refused({ implement: { mcpServers: { demo: { command: "x", url: "y" } } } }), /may hold only command, args, env/);
  assert.match(refused({ implement: { mcpServers: { "bad name": { command: "x" } } } }), /server name/);
  assert.match(refused({ implement: { mcpServers: { demo: {} } } }), /command must be/);
});

test("Claude gets the servers as --mcp-config with the variables by reference, and the tools in --allowedTools", () => {
  const c = config({ implement: { mcpServers: { demo: SERVER } } });
  const args = buildCommand(c, { role: "implement" }, "go").args;
  const json = JSON.parse(args[args.indexOf("--mcp-config") + 1] ?? "{}");
  assert.deepEqual(json, { mcpServers: { demo: { type: "stdio", command: "npx", args: ["-y", "demo-mcp"], env: { DEMO_TOKEN: "${DEMO_TOKEN}" } } } });
  assert.ok((args[args.indexOf("--allowedTools") + 1] ?? "").split(",").includes("mcp__demo"));
  assert.ok(!buildCommand(c, { role: "review" }, "go").args.includes("--mcp-config"));
});

test("Copilot gets --additional-mcp-config and an allow rule named for the server", () => {
  const c = config({ implement: { provider: "copilot", mcpServers: { demo: SERVER } } });
  const args = copilotArgs(c, "implement");
  const json = JSON.parse(args[args.indexOf("--additional-mcp-config") + 1] ?? "{}");
  assert.deepEqual(json, { mcpServers: { demo: { type: "local", command: "npx", args: ["-y", "demo-mcp"], tools: ["*"], env: { DEMO_TOKEN: "${DEMO_TOKEN}" } } } });
  assert.ok(args.includes("--allow-tool=demo"));
  assert.ok(!copilotArgs(config({ review: { provider: "copilot" } }), "review").includes("--additional-mcp-config"));
});

test("{{allowedCommands}} names the servers whose tools the role may use", () => {
  const tools = ["Read", "Bash(git *)", "mcp__demo"];
  for (const text of [allowedCommandsText(tools), copilotCommandsText(tools)]) assert.match(text, /You may also use every tool of the MCP server `demo`\./);
  assert.doesNotMatch(allowedCommandsText(["Read"]), /MCP/);
});

test("a role's effort reaches the command as --effort; none, none; a bad level is refused", () => {
  const c = config({ implement: { effort: "high" } });
  const args = buildCommand(c, { role: "implement" }, "p").args;
  assert.equal(args[args.indexOf("--effort") + 1], "high");
  assert.ok(!buildCommand(c, { role: "review" }, "p").args.includes("--effort"));
  assert.match(refused({ implement: { effort: "extreme" } }), /effort must be one of low, medium, high, xhigh, max/);
});

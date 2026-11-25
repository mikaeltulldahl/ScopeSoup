// What every provider shares about a role's MCP servers: the sentence in the prompt. The servers' tools are the `mcp__<server>`
// entries the configuration adds to `allowedTools`. No provider's CLI is named here.

import { MCP_TOOL_PREFIX } from "../../config/types.ts";

/** The sentence for a role's MCP servers (`mcp__<server>` entries of its `allowedTools`): their tools may be used. Empty for none. */
export function mcpText(allowedTools: readonly string[]): string {
  const servers = allowedTools.map((tool) => tool.trim()).filter((tool) => tool.startsWith(MCP_TOOL_PREFIX)).map((tool) => `\`${tool.slice(MCP_TOOL_PREFIX.length)}\``);
  return servers.length === 0 ? "" : ` You may also use every tool of the MCP server${servers.length > 1 ? "s" : ""} ${servers.join(", ")}.`;
}

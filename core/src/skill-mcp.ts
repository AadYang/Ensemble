// Claude SDK MCP factory for the skill_invoke + skill_list tools. Same shape
// as peer-mcp.ts / help-mcp.ts. Stateless — the closure just captures the
// active workspace path so project-source skills can resolve.

import { z } from "zod";
import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import { loadSkills, findSkill, formatSkillBody } from "./skills/index.js";

export const SKILL_MCP_SERVER_NAME = "agentorch-skill";
export const SKILL_INVOKE_TOOL_NAME = `mcp__${SKILL_MCP_SERVER_NAME}__skill_invoke`;
export const SKILL_LIST_TOOL_NAME = `mcp__${SKILL_MCP_SERVER_NAME}__skill_list`;

export interface SkillRuntimeContext {
  workspace?: string;
  runtimeKind: string;
}

export function makeSkillMcpServer(ctx: SkillRuntimeContext): McpSdkServerConfigWithInstance {
  const workspaces = ctx.workspace ? [ctx.workspace] : [];

  const skillList = tool(
    "skill_list",
    [
      "List the skills currently available to this agent. Each entry includes",
      "name, description (when to use), source (project / ensemble / claude-user /",
      "codex-user), and any advisory tool restrictions.",
      "",
      "Skills may auto-activate based on the user's message (you'll see them in",
      "your system prompt under ACTIVE SKILLS). Call skill_invoke <name> to",
      "load a specific skill body when auto-activation missed.",
    ].join("\n"),
    {},
    async () => {
      const list = loadSkills(workspaces);
      if (list.length === 0) {
        return {
          content: [
            { type: "text" as const, text: "No skills loaded. Add SKILL.md files to <ensemble dataDir>/skills/, ~/.claude/skills/, or ~/.codex/skills/." },
          ],
        };
      }
      const lines = list.map(
        (s) => `${s.name} [${s.source}] — ${s.description}` + (s.tools ? `  (recommended tools: ${s.tools.join(", ")})` : ""),
      );
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    },
  );

  const skillInvoke = tool(
    "skill_invoke",
    [
      "Load a specific skill's instructions into your context. Use this when",
      "auto-activation did not surface the skill you need, or when the user",
      "asks for a skill by name.",
      "",
      "Returns the full skill body. Treat its instructions as part of your",
      "system prompt for the rest of this turn.",
    ].join("\n"),
    {
      name: z.string().min(1).describe("Skill name (slug from SKILL.md frontmatter)."),
    },
    async ({ name }) => {
      const skill = findSkill(name, workspaces);
      if (!skill) {
        const all = loadSkills(workspaces).map((s) => s.name).join(", ") || "(none)";
        return {
          content: [
            { type: "text" as const, text: `No skill named "${name}". Available: ${all}` },
          ],
        };
      }
      return {
        content: [{ type: "text" as const, text: formatSkillBody(skill, ctx.runtimeKind) }],
      };
    },
  );

  return createSdkMcpServer({
    name: SKILL_MCP_SERVER_NAME,
    version: "0.1.0",
    tools: [skillList, skillInvoke],
  });
}

// Claude SDK MCP factory for the skill_invoke + skill_list tools. Same shape
// as peer-mcp.ts / help-mcp.ts. Stateless: the closure just captures the
// active workspace path so project-source skills can resolve.

import { z } from "zod";
import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import { loadSkills, formatSkillListForTool, skillInvokeToolResult } from "./skills/index.js";

/** A tool failure the model can act on: the code is machine-readable, the
 *  message is human-readable, and both travel in the same JSON so an isError
 *  result never looks like a skill body. */
function skillErrorPayload(fields: Record<string, unknown>): string {
  return JSON.stringify(fields);
}

export const SKILL_MCP_SERVER_NAME = "agentorch-skill";
export const SKILL_INVOKE_TOOL_NAME = `mcp__${SKILL_MCP_SERVER_NAME}__skill_invoke`;
export const SKILL_LIST_TOOL_NAME = `mcp__${SKILL_MCP_SERVER_NAME}__skill_list`;

export interface SkillRuntimeContext {
  workspace?: string;
  runtimeKind: string;
  /** The turn's skill-section budget (see skillsBudgetFor). A tool call happens
   *  mid-turn, so the exact remainder is not knowable here; the plan's budget is
   *  the conservative upper bound the read is bounded by, and going over it is a
   *  structured SKILL_BUDGET_EXCEEDED instead of an unbounded body in a context
   *  that has no room for it. `null` = no budget was established. */
  tokenBudget?: number | null;
  /** Injected token measurer, so the tool path counts with the same tokenizer
   *  the turn's budget did. */
  measure?: (text: string) => number | null;
}

export function makeSkillMcpServer(ctx: SkillRuntimeContext): McpSdkServerConfigWithInstance {
  const workspaces = ctx.workspace ? [ctx.workspace] : [];

  const skillList = tool(
    "skill_list",
    [
      "List the skills currently available to this agent. Each entry includes",
      "name, description (when to use), source (project / ensemble / claude-user /",
      "codex-user / system), and any advisory tool restrictions.",
      "",
      "Skills may auto-activate based on the user's message (you'll see them in",
      "your system prompt under ACTIVE SKILLS). Call skill_invoke <name> to",
      "load a specific skill body when auto-activation missed.",
    ].join("\n"),
    {},
    async () => {
      if (loadSkills(workspaces).length === 0) {
        // isError, not a success-shaped sentence: "no skills" is a finding the
        // model must not read as a list of zero-or-more usable skills.
        return {
          content: [
            {
              type: "text" as const,
              text: skillErrorPayload({
                code: "SKILL_NOT_FOUND",
                message:
                  "No skills loaded. Add SKILL.md files to <ensemble dataDir>/skills/, ~/.claude/skills/, or ~/.codex/skills/.",
                available: [],
              }),
            },
          ],
          isError: true,
        };
      }
      return { content: [{ type: "text" as const, text: formatSkillListForTool(workspaces) }] };
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
      const res = skillInvokeToolResult(name, {
        runtimeKind: ctx.runtimeKind,
        workspaces,
        tokenBudget: ctx.tokenBudget ?? null,
        ...(ctx.measure ? { measure: ctx.measure } : {}),
      });
      if (!res.ok) {
        return {
          content: [
            {
              type: "text" as const,
              text: skillErrorPayload({
                code: res.code,
                name: res.name,
                message: res.message,
                available: res.available,
                // A size refusal carries its arithmetic: the model can tell the
                // user how big the skill is and how much room there was,
                // instead of reporting "it did not load" with no number.
                ...(res.tokenCost === undefined ? {} : { tokenCost: res.tokenCost }),
                ...(res.availableBudget === undefined ? {} : { availableBudget: res.availableBudget }),
              }),
            },
          ],
          isError: true,
        };
      }
      return { content: [{ type: "text" as const, text: res.text }] };
    },
  );

  return createSdkMcpServer({
    name: SKILL_MCP_SERVER_NAME,
    version: "0.1.0",
    tools: [skillList, skillInvoke],
  });
}

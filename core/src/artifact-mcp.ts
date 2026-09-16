// The Claude-side surface for the artifact tools.
//
// The paging contract, the error codes and the rendering all live in
// `artifacts.ts` (pure, no SDK), because the OpenAI and Codex surfaces render
// through the same functions. This file only wraps them as an in-process MCP
// server, and is deliberately thin so there is nothing here that could disagree
// with the other two runtimes.
//
// Failures carry `isError: true`. A model told "ARTIFACT_NOT_FOUND" retries or
// reports; a model handed a sentence that looks like content invents.
//
// Retention is PERMANENT (see db.ts): artifacts are append-only, there is no
// delete, TTL or purge, and an artifact outlives the agent that produced it. So
// a handle is worth keeping and an old one is still worth re-reading — this
// surface only ever needs to read, and there is deliberately no write tool
// beside these two.

import { z } from "zod";
import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import {
  ARTIFACT_DEFAULT_MAX_HITS,
  ARTIFACT_DEFAULT_PAGE_BYTES,
  ARTIFACT_DEFAULT_SNIPPET_BYTES,
  ARTIFACT_MAX_PAGE_BYTES,
  ARTIFACT_READ_DESCRIPTION,
  ARTIFACT_SEARCH_DESCRIPTION,
  renderArtifactRead,
  renderArtifactSearch,
  type ArtifactReadResult,
  type ArtifactSearchResult,
} from "./artifacts.js";

export const ARTIFACT_MCP_SERVER_NAME = "agentorch-artifact";
export const ARTIFACT_READ_TOOL_NAME = `mcp__${ARTIFACT_MCP_SERVER_NAME}__artifact_read`;
export const ARTIFACT_SEARCH_TOOL_NAME = `mcp__${ARTIFACT_MCP_SERVER_NAME}__artifact_search`;
/** Short names, as the OpenAI and Codex runtimes see them. */
export const ARTIFACT_READ_TOOL_SHORT = "artifact_read";
export const ARTIFACT_SEARCH_TOOL_SHORT = "artifact_search";

export interface ArtifactReadArgs {
  id: string;
  cursor?: string;
  pageBytes?: number;
}

export interface ArtifactSearchArgs {
  id: string;
  query: string;
  cursor?: string;
  caseSensitive?: boolean;
  maxHits?: number;
  snippetBytes?: number;
}

export interface ArtifactToolHandlers {
  read: (args: ArtifactReadArgs) => ArtifactReadResult;
  search: (args: ArtifactSearchArgs) => ArtifactSearchResult;
}

export const ARTIFACT_READ_SCHEMA = z.object({
  id: z.string().min(1).describe("Artifact id, as printed in the result that stored it."),
  cursor: z
    .string()
    .optional()
    .describe("Opaque byte cursor from a previous artifact_read/artifact_search for the SAME artifact."),
  pageBytes: z
    .number()
    .int()
    .optional()
    .describe(`Bytes to return (default ${ARTIFACT_DEFAULT_PAGE_BYTES}, max ${ARTIFACT_MAX_PAGE_BYTES}). Snapped to a UTF-8 boundary.`),
});

export const ARTIFACT_SEARCH_SCHEMA = z.object({
  id: z.string().min(1).describe("Artifact id, as printed in the result that stored it."),
  query: z.string().min(1).describe("Literal string to find (not a regex)."),
  cursor: z.string().optional().describe("Resume the scan from a previous artifact_search's nextCursor."),
  caseSensitive: z.boolean().optional().describe("Default false."),
  maxHits: z
    .number()
    .int()
    .optional()
    .describe(`Maximum hits per call (default ${ARTIFACT_DEFAULT_MAX_HITS}, max 200).`),
  snippetBytes: z
    .number()
    .int()
    .optional()
    .describe(`Bytes of context around each hit (default ${ARTIFACT_DEFAULT_SNIPPET_BYTES}).`),
});

/** Build a per-call MCP server. Each query() invocation gets its own instance,
 *  like the peer and skill servers, so a turn can never read through another
 *  turn's handlers. */
export function makeArtifactMcpServer(handlers: ArtifactToolHandlers): McpSdkServerConfigWithInstance {
  const readTool = tool(
    ARTIFACT_READ_TOOL_SHORT,
    ARTIFACT_READ_DESCRIPTION,
    ARTIFACT_READ_SCHEMA.shape,
    async (args) => {
      const result = handlers.read(args);
      return {
        content: [{ type: "text" as const, text: renderArtifactRead(result) }],
        ...(result.ok ? {} : { isError: true }),
      };
    },
  );
  const searchTool = tool(
    ARTIFACT_SEARCH_TOOL_SHORT,
    ARTIFACT_SEARCH_DESCRIPTION,
    ARTIFACT_SEARCH_SCHEMA.shape,
    async (args) => {
      const result = handlers.search(args);
      return {
        content: [{ type: "text" as const, text: renderArtifactSearch(result) }],
        ...(result.ok ? {} : { isError: true }),
      };
    },
  );
  return createSdkMcpServer({
    name: ARTIFACT_MCP_SERVER_NAME,
    version: "1.0.0",
    tools: [readTool, searchTool],
  });
}

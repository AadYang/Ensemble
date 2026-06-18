import { describe, it, expect } from "vitest";
import { formatEnsembleHelp, buildEnsemblePrimer, HELP_TOPIC_NAMES } from "../help/index.js";
import { HELP_TOPICS } from "../help/topics.js";

describe("formatEnsembleHelp", () => {
  it("returns an index listing all topics when called with no arg", () => {
    const out = formatEnsembleHelp();
    for (const name of HELP_TOPIC_NAMES) {
      expect(out).toContain(name);
    }
  });

  it("returns the topic body when called with a known topic", () => {
    const out = formatEnsembleHelp("add_mcp_server");
    expect(out).toContain("[ensemble_help: add_mcp_server]");
    expect(out).toMatch(/MCP/);
    expect(out).toContain("transport");
  });

  it("is case-insensitive on topic names", () => {
    expect(formatEnsembleHelp("OVERVIEW")).toContain("[ensemble_help: overview]");
    expect(formatEnsembleHelp(" Sandbox ")).toContain("[ensemble_help: sandbox]");
  });

  it("returns an error notice (with topic list) for an unknown topic", () => {
    const out = formatEnsembleHelp("nope");
    expect(out).toContain('Unknown topic "nope"');
    for (const name of HELP_TOPIC_NAMES) {
      expect(out).toContain(name);
    }
  });

  it("HELP_TOPIC_NAMES matches the keys of HELP_TOPICS", () => {
    expect(HELP_TOPIC_NAMES).toEqual(Object.keys(HELP_TOPICS));
  });
});

describe("buildEnsemblePrimer", () => {
  it("includes a CRITICAL warning that Ensemble source is NOT on the machine", () => {
    const p = buildEnsemblePrimer();
    expect(p).toMatch(/CRITICAL/i);
    expect(p).toMatch(/source code is NOT on this user's machine/i);
  });

  it("advertises ensemble_help and lists all topics", () => {
    const p = buildEnsemblePrimer();
    expect(p).toContain("ensemble_help");
    for (const name of HELP_TOPIC_NAMES) {
      expect(p).toContain(name);
    }
  });

  it("mentions slash commands users have access to", () => {
    const p = buildEnsemblePrimer();
    for (const cmd of ["/clear", "/compact", "/model", "/provider", "/cost", "/status", "/mcp"]) {
      expect(p).toContain(cmd);
    }
  });

  it("mentions peer_send, peer_query, and conversation_search", () => {
    const p = buildEnsemblePrimer();
    expect(p).toContain("peer_send");
    expect(p).toContain("peer_query");
    expect(p).toContain("conversation_search");
  });

  it("documents conversation_search in peer_messaging help", () => {
    const out = formatEnsembleHelp("peer_messaging");
    expect(out).toContain("conversation_search");
    expect(out).toContain("read-only DB query");
    expect(out).toContain("scope=self");
  });
});

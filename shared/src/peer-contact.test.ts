import { describe, expect, it } from "vitest";
import { peerContactAllowed, samePeerCircle, type PeerContactIdentity } from "./peer-contact.js";

const id = (partial: Partial<PeerContactIdentity> & Pick<PeerContactIdentity, "id">): PeerContactIdentity => ({
  spawnedBy: null,
  teamId: null,
  ...partial,
});

describe("samePeerCircle", () => {
  it("keeps two teammates together and rejects another team", () => {
    const a = id({ id: "a", teamId: "t1" });
    const b = id({ id: "b", teamId: "t1" });
    const c = id({ id: "c", teamId: "t2" });
    expect(samePeerCircle(a, b)).toBe(true);
    expect(samePeerCircle(a, c)).toBe(false);
  });

  it("lets ungrouped agents reach only other ungrouped agents", () => {
    const lone = id({ id: "lone" });
    const otherLone = id({ id: "other" });
    const teamed = id({ id: "teamed", teamId: "t1" });
    expect(samePeerCircle(lone, otherLone)).toBe(true);
    expect(samePeerCircle(lone, teamed)).toBe(false);
    expect(samePeerCircle(teamed, lone)).toBe(false);
  });
});

describe("peerContactAllowed", () => {
  it("refuses a same-named agent on another team", () => {
    const from = id({ id: "mgr-a", teamId: "t1" });
    const outsider = id({ id: "eng-b", teamId: "t2" });
    expect(peerContactAllowed(from, outsider)).toBe(false);
  });

  it("allows ordinary teammates", () => {
    const from = id({ id: "mgr", teamId: "t1" });
    const mate = id({ id: "eng", teamId: "t1" });
    expect(peerContactAllowed(from, mate)).toBe(true);
  });

  it("still keeps a subagent private to its spawner inside the team", () => {
    const parent = id({ id: "parent", teamId: "t1" });
    const child = id({ id: "child", teamId: "t1", spawnedBy: "parent" });
    const sibling = id({ id: "sib", teamId: "t1" });
    expect(peerContactAllowed(parent, child)).toBe(true);
    expect(peerContactAllowed(child, parent)).toBe(true);
    expect(peerContactAllowed(sibling, child)).toBe(false);
    expect(peerContactAllowed(child, sibling)).toBe(false);
  });
});

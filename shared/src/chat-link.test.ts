import { describe, expect, it } from "vitest";
import { parseChatLink } from "./chat-link.js";

describe("parseChatLink", () => {
  it("opens https URLs in the system browser", () => {
    expect(parseChatLink("https://github.com/jumpoAi/bondings-app/issues/47#issuecomment-1")).toEqual({
      kind: "url",
      href: "https://github.com/jumpoAi/bondings-app/issues/47#issuecomment-1",
    });
  });

  it("opens Codex / VS Code /D:/ file links, including HTML and :line suffixes", () => {
    expect(
      parseChatLink("/D:/WorkSpace/bondings-app/dev/docs/蓝牙文档介绍/蓝牙交互协议规范与多尺寸兼容策略.html"),
    ).toEqual({
      kind: "path",
      path: "D:/WorkSpace/bondings-app/dev/docs/蓝牙文档介绍/蓝牙交互协议规范与多尺寸兼容策略.html",
    });
    expect(
      parseChatLink("/D:/WorkSpace/bondings-app/lib/screens/home/network_settings/views/network_settings_view.dart:96"),
    ).toEqual({
      kind: "path",
      path: "D:/WorkSpace/bondings-app/lib/screens/home/network_settings/views/network_settings_view.dart",
    });
  });

  it("opens Windows paths and file:// URLs", () => {
    expect(parseChatLink("D:\\WorkSpace\\bondings-app\\readme.md")).toEqual({
      kind: "path",
      path: "D:\\WorkSpace\\bondings-app\\readme.md",
    });
    expect(parseChatLink("file:///D:/WorkSpace/a.html")).toEqual({
      kind: "path",
      path: "D:/WorkSpace/a.html",
    });
    expect(parseChatLink("/Users/me/docs/plan.html")).toEqual({
      kind: "path",
      path: "/Users/me/docs/plan.html",
    });
  });

  it("rejects javascript and other non-openable schemes", () => {
    expect(parseChatLink("javascript:alert(1)")).toBeNull();
    expect(parseChatLink("data:text/html,hi")).toBeNull();
    expect(parseChatLink("/agents/foo")).toBeNull();
    expect(parseChatLink("")).toBeNull();
  });
});

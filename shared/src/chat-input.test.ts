import { describe, expect, it } from "vitest";
import { measureChatInputHeight } from "./chat-input";

describe("measureChatInputHeight", () => {
  it("uses line-height plus vertical padding and border for empty input", () => {
    expect(
      measureChatInputHeight({
        value: "",
        measuredHeight: 64,
        lineHeight: 20,
        verticalBoxChrome: 10,
        maxRows: 6,
      }),
    ).toEqual({ height: 30, overflowY: "hidden" });
  });

  it("uses measured border-box height for non-empty multiline input", () => {
    expect(
      measureChatInputHeight({
        value: "one\ntwo\nthree",
        measuredHeight: 70,
        lineHeight: 20,
        verticalBoxChrome: 10,
        maxRows: 6,
      }),
    ).toEqual({ height: 70, overflowY: "hidden" });
  });

  it("caps non-empty input at max rows and enables scrolling", () => {
    expect(
      measureChatInputHeight({
        value: "many lines",
        measuredHeight: 200,
        lineHeight: 20,
        verticalBoxChrome: 10,
        maxRows: 6,
      }),
    ).toEqual({ height: 130, overflowY: "auto" });
  });
});

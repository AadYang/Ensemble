import { describe, expect, it } from "vitest";
import { measureChatInputHeight } from "./chat-input";

describe("measureChatInputHeight", () => {
  it("uses single-line height for empty input even when scrollHeight is larger", () => {
    expect(
      measureChatInputHeight({
        value: "",
        scrollHeight: 64,
        lineHeight: 20,
        verticalChrome: 10,
        maxRows: 6,
      }),
    ).toEqual({ height: 30, overflowY: "hidden" });
  });

  it("uses measured scrollHeight for non-empty multiline input", () => {
    expect(
      measureChatInputHeight({
        value: "one\ntwo\nthree",
        scrollHeight: 70,
        lineHeight: 20,
        verticalChrome: 10,
        maxRows: 6,
      }),
    ).toEqual({ height: 70, overflowY: "hidden" });
  });

  it("caps non-empty input at max rows and enables scrolling", () => {
    expect(
      measureChatInputHeight({
        value: "many lines",
        scrollHeight: 200,
        lineHeight: 20,
        verticalChrome: 10,
        maxRows: 6,
      }),
    ).toEqual({ height: 130, overflowY: "auto" });
  });
});

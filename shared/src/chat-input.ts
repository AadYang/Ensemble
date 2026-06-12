export interface ChatInputHeightInput {
  value: string;
  measuredHeight: number;
  lineHeight: number;
  /** Vertical padding + border in CSS pixels. */
  verticalBoxChrome: number;
  maxRows: number;
}

export interface ChatInputHeightResult {
  height: number;
  overflowY: "auto" | "hidden";
}

export function measureChatInputHeight(input: ChatInputHeightInput): ChatInputHeightResult {
  const lineHeight = Number.isFinite(input.lineHeight) && input.lineHeight > 0 ? input.lineHeight : 20;
  const verticalBoxChrome =
    Number.isFinite(input.verticalBoxChrome) && input.verticalBoxChrome >= 0 ? input.verticalBoxChrome : 0;
  const maxRows = Number.isFinite(input.maxRows) && input.maxRows > 0 ? Math.floor(input.maxRows) : 1;
  const singleLineHeight = lineHeight + verticalBoxChrome;
  const maxHeight = lineHeight * maxRows + verticalBoxChrome;
  if (input.value.length === 0) {
    return { height: Math.min(singleLineHeight, maxHeight), overflowY: "hidden" };
  }

  const contentHeight = Number.isFinite(input.measuredHeight) && input.measuredHeight > 0
    ? input.measuredHeight
    : singleLineHeight;
  return {
    height: Math.min(contentHeight, maxHeight),
    overflowY: contentHeight > maxHeight ? "auto" : "hidden",
  };
}

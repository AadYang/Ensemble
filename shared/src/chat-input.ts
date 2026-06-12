export interface ChatInputHeightInput {
  value: string;
  scrollHeight: number;
  lineHeight: number;
  verticalChrome: number;
  maxRows: number;
}

export interface ChatInputHeightResult {
  height: number;
  overflowY: "auto" | "hidden";
}

export function measureChatInputHeight(input: ChatInputHeightInput): ChatInputHeightResult {
  const lineHeight = Number.isFinite(input.lineHeight) && input.lineHeight > 0 ? input.lineHeight : 20;
  const verticalChrome = Number.isFinite(input.verticalChrome) && input.verticalChrome >= 0 ? input.verticalChrome : 0;
  const maxRows = Number.isFinite(input.maxRows) && input.maxRows > 0 ? Math.floor(input.maxRows) : 1;
  const singleLineHeight = lineHeight + verticalChrome;
  const maxHeight = lineHeight * maxRows + verticalChrome;
  if (input.value.length === 0) {
    return { height: Math.min(singleLineHeight, maxHeight), overflowY: "hidden" };
  }

  const contentHeight = Number.isFinite(input.scrollHeight) && input.scrollHeight > 0
    ? input.scrollHeight
    : singleLineHeight;
  return {
    height: Math.min(contentHeight, maxHeight),
    overflowY: contentHeight > maxHeight ? "auto" : "hidden",
  };
}

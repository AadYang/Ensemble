import type { PlatformKey } from "@agentorch/shared";

export function currentPlatformKey(): PlatformKey {
  const platform =
    process.platform === "darwin"
      ? "macos"
      : process.platform === "win32"
        ? "windows"
        : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  return `${platform}-${arch}` as PlatformKey;
}

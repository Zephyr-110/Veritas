import { writeFileSync } from "fs";

export function touchSandboxActiveSignal(nowMs = Date.now()): {
  touched: boolean;
  lastActiveTs?: number;
} {
  const activeFile = process.env.SANDBOX_ACTIVE_FILE?.trim();
  if (!activeFile) return { touched: false };
  const lastActiveTs = Math.floor(nowMs / 1000);
  try {
    writeFileSync(activeFile, JSON.stringify({ lastActiveTs }));
    return { touched: true, lastActiveTs };
  } catch {
    // best-effort signal for optional on-demand scheduler
    return { touched: false };
  }
}

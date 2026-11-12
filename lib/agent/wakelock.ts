// Keeping the machine awake while a run is in progress.

import { spawn } from "node:child_process";
import { sleep } from "./model";

export function spawnWakeLock() {
  try {
    if (process.platform === "darwin") {
      return spawn("caffeinate", ["-i"], { stdio: "ignore" });
    }
    if (process.platform === "win32") {
      // Calls SetThreadExecutionState(ES_CONTINUOUS|ES_SYSTEM_REQUIRED) every 30s.
      // When the process is killed the OS automatically clears the requirement.
      const ps = `Add-Type -Name K -Namespace W -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);'; while($true){[W.K]::SetThreadExecutionState(0x80000003); Start-Sleep 30}`;
      return spawn("powershell", ["-NonInteractive", "-Command", ps], { stdio: "ignore" });
    }
    if (process.platform === "linux") {
      return spawn(
        "systemd-inhibit",
        ["--what=sleep:idle", "--who=qpilot", "--why=Running test", "--mode=block", "sleep", "infinity"],
        { stdio: "ignore" },
      );
    }
  } catch {
    // wake lock is best-effort — ignore if unavailable
  }
  return null;
}

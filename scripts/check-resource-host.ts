/** A real owned child, idle rather than CPU/GPU stress. The package owns policy only. */
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createDiagnosticResourceBudget } from "@absolutejs/diagnostics/run";
const rows = [];
for (const mode of ["deadline", "resident"] as const) {
  if (mode === "resident" && !existsSync("/proc/self/status")) {
    rows.push({ mode, skipped: "Linux RSS evidence unavailable" });
    continue;
  }
  const child = Bun.spawn([process.execPath, "-e", "setTimeout(()=>{},5000)"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  const budget = createDiagnosticResourceBudget({
    maxElapsedMs: mode === "deadline" ? 250 : 2000,
    ...(mode === "resident" ? { maxResidentBytes: 1 } : {}),
  });
  let observation = budget.snapshot();
  const hard = setTimeout(() => child.kill("SIGKILL"), 3000);
  try {
    while (!observation.exhausted) {
      await Bun.sleep(10);
      let residentBytes: number | undefined;
      if (mode === "resident") {
        try {
          const match = readFileSync(`/proc/${child.pid}/status`, "utf8").match(
            /^VmRSS:\s+(\d+) kB/m,
          );
          if (match) residentBytes = Number(match[1]) * 1024;
        } catch {}
      }
      observation = budget.observe({ residentBytes });
    }
    child.kill("SIGKILL");
    const exitCode = await child.exited;
    if (
      exitCode === 0 ||
      observation.reason !==
        (mode === "deadline" ? "elapsed-budget" : "resident-budget")
    )
      throw Error("Owned child budget decision disagreed");
    rows.push({ mode, exitCode, observation });
  } finally {
    clearTimeout(hard);
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
  }
}
mkdirSync(".diagnostics", { recursive: true });
writeFileSync(
  ".diagnostics/resource-host.json",
  JSON.stringify({ passed: true, rows }, null, 2) + "\n",
);
console.log(JSON.stringify({ passed: true, rows }));

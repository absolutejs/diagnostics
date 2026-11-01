import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
const bundle = await Bun.build({
  entrypoints: ["dist/run.js"],
  target: "browser",
  format: "esm",
  minify: true,
});
if (!bundle.success) throw Error(String(bundle.logs));
const api = await bundle.outputs[0]!.text();
const worker = `import {createDiagnosticResourceBudget} from '/api.js';
const timer=createDiagnosticResourceBudget({maxElapsedMs:1});
setTimeout(()=>{
 const deadline=timer.observe({residentBytes:10});
 let now=0;const sampled=createDiagnosticResourceBudget({maxElapsedMs:100,maxResidentBytes:16,now:()=>now});
 const missing=sampled.observe();const boundary=sampled.observe({residentBytes:16});const exhausted=sampled.observe({residentBytes:17});now=1;const latched=sampled.observe({residentBytes:0});
 self.postMessage({deadline,missing,boundary,exhausted,latched,frozen:Object.isFrozen(latched)});
},10);`;
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: (r) => {
    const path = new URL(r.url).pathname;
    return path === "/api.js" || path === "/worker.js"
      ? new Response(path === "/api.js" ? api : worker, {
          headers: { "content-type": "text/javascript" },
        })
      : new Response("<!doctype html><title>Resource policy probe</title>");
  },
});
let browser;
try {
  browser = await chromium.launch({
    headless: true,
    args: ["--disable-gpu"],
    ...(process.env.DIAGNOSTIC_CHROMIUM_PATH
      ? { executablePath: process.env.DIAGNOSTIC_CHROMIUM_PATH }
      : {}),
  });
  const page = await browser.newPage(),
    errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`http://127.0.0.1:${server.port}`);
  const result: any = await page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const w = new Worker("/worker.js", { type: "module" });
        const timeout = setTimeout(() => {
          w.terminate();
          reject(Error("Resource worker deadline"));
        }, 5000);
        w.onmessage = (e) => {
          clearTimeout(timeout);
          w.terminate();
          resolve(e.data);
        };
        w.onerror = (e) => {
          clearTimeout(timeout);
          w.terminate();
          reject(Error(e.message));
        };
      }),
  );
  if (
    errors.length ||
    result.deadline.reason !== "elapsed-budget" ||
    result.deadline.elapsedMs < 1 ||
    result.missing.residentSamples !== 0 ||
    "peakResidentBytes" in result.missing ||
    result.boundary.exhausted ||
    result.exhausted.reason !== "resident-budget" ||
    result.latched.reason !== "resident-budget" ||
    result.latched.peakResidentBytes !== 17 ||
    !result.frozen
  )
    throw Error(JSON.stringify({ errors, result }));
  mkdirSync(".diagnostics", { recursive: true });
  writeFileSync(
    ".diagnostics/resource-browser.json",
    JSON.stringify(
      {
        passed: true,
        gpu: false,
        scope:
          "Synthetic memory observations; no browser resident-memory measurement",
        browserVersion: browser.version(),
        result,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    "Built run resource policy passed in a GPU-disabled browser worker",
  );
} finally {
  await browser?.close();
  await server.stop(true);
}

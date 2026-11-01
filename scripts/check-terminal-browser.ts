import { chromium } from "playwright";
import { writeFileSync, mkdirSync } from "node:fs";
const bundle = await Bun.build({
  entrypoints: ["dist/worker.js"],
  target: "browser",
  format: "esm",
  minify: true,
});
if (!bundle.success) throw Error(String(bundle.logs));
const api = await bundle.outputs[0]!.text();
const source = `import {createWorkerDiagnosticReporter} from '/api.js';
const reporter=createWorkerDiagnosticReporter({jobId:'crash-probe',maxMessages:8,maxMessageBytes:128,maxTotalBytes:256,terminalReserveBytes:64,send:f=>self.postMessage(f)});
self.onmessage=e=>{if(e.data==='start'){
 for(let i=0;i<100;i++)reporter.emit('progress',{payload:'界'.repeat(20),step:i});
 reporter.emitTerminal('terminal',{steps:42,password:'hidden'});
 self.postMessage({reporter:reporter.snapshot()});
}else if(e.data==='ack')throw Error('intentional-worker-failure');};`;
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: (r) => {
    const p = new URL(r.url).pathname;
    return p === "/api.js" || p === "/worker.js"
      ? new Response(p === "/api.js" ? api : source, {
          headers: { "content-type": "text/javascript" },
        })
      : new Response("<!doctype html><title>Worker checkpoint probe</title>");
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
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.port}`);
  const result = await page.evaluate(async () => {
    const { createWorkerDiagnosticReceiver } = await import("/api.js");
    return await new Promise((resolve, reject) => {
      const records: any[] = [];
      let reporter: unknown;
      const worker = new Worker("/worker.js", { type: "module" });
      const timeout = setTimeout(() => {
        worker.terminate();
        reject(Error("worker timeout"));
      }, 10000);
      const receiver = createWorkerDiagnosticReceiver({
        jobId: "crash-probe",
        maxMessages: 8,
        maxMessageBytes: 128,
        maxTotalBytes: 256,
        onRecord: (r: any) => {
          records.push(r);
          if (r.event === "terminal") worker.postMessage("ack");
        },
      });
      worker.onmessage = (e) => {
        if (e.data.reporter) reporter = e.data.reporter;
        else receiver.receive(e.data);
      };
      worker.onerror = (e) => {
        e.preventDefault();
        clearTimeout(timeout);
        worker.terminate();
        receiver.close();
        resolve({
          error: e.message,
          records,
          reporter,
          receiver: receiver.snapshot(),
        });
      };
      worker.postMessage("start");
    });
  });
  const r = result as any;
  if (
    !r.error.includes("intentional-worker-failure") ||
    r.records.length !== 3 ||
    r.records.at(-1).event !== "terminal" ||
    r.records.at(-1).fields.steps !== 42 ||
    r.records.at(-1).fields.password !== "[REDACTED]" ||
    r.receiver.receivedBytes > 256 ||
    r.receiver.missingSequences !== 5 ||
    r.reporter.terminalSent !== true ||
    r.reporter.closed !== true ||
    r.receiver.errors !== 0
  )
    throw Error(JSON.stringify(r));
  mkdirSync("research/worker-terminal-2026-11-01", { recursive: true });
  writeFileSync(
    "research/worker-terminal-2026-11-01/browser-result.json",
    JSON.stringify(
      {
        gpu: false,
        browserVersion: browser.version(),
        executablePath:
          process.env.DIAGNOSTIC_CHROMIUM_PATH ?? "playwright-default",
        ...r,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    "Host retained a reserved redacted terminal checkpoint after progress saturation and before acknowledged worker failure",
  );
} finally {
  await browser?.close();
  await server.stop(true);
}

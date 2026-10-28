import {chromium} from 'playwright';
import {writeFileSync} from 'node:fs';
const bundle=await Bun.build({entrypoints:['dist/worker.js'],target:'browser',format:'esm',minify:true});
if(!bundle.success)throw Error(String(bundle.logs));
const api=await bundle.outputs[0]!.text();
const source=`import {createWorkerDiagnosticReporter} from '/api.js';
const reporter=createWorkerDiagnosticReporter({jobId:'crash-probe',send:f=>self.postMessage(f)});
self.onmessage=e=>{if(e.data==='start')reporter.emit('physics.checkpoint',{steps:42,password:'hidden'});else if(e.data==='ack')throw Error('intentional-worker-failure');};`;
const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:r=>{const p=new URL(r.url).pathname;return p==='/api.js'||p==='/worker.js'?new Response(p==='/api.js'?api:source,{headers:{'content-type':'text/javascript'}}):new Response('<!doctype html><title>Worker checkpoint probe</title>');}});
let browser;
try{
 browser=await chromium.launch({headless:true,args:['--disable-gpu']});
 const page=await browser.newPage();await page.goto(`http://127.0.0.1:${server.port}`);
 const result=await page.evaluate(async()=>{
  const {createWorkerDiagnosticReceiver}=await import('/api.js');
  return await new Promise((resolve,reject)=>{
   const records:unknown[]=[];const worker=new Worker('/worker.js',{type:'module'});
   const timeout=setTimeout(()=>{worker.terminate();reject(Error('worker timeout'));},10000);
   const receiver=createWorkerDiagnosticReceiver({jobId:'crash-probe',onRecord:(r:unknown)=>{records.push(r);worker.postMessage('ack');}});
   worker.onmessage=e=>receiver.receive(e.data);
   worker.onerror=e=>{e.preventDefault();clearTimeout(timeout);worker.terminate();receiver.close();resolve({error:e.message,records,receiver:receiver.snapshot()});};
   worker.postMessage('start');
  });
 });
 const r=result as any;
 if(!r.error.includes('intentional-worker-failure')||r.records.length!==1||r.records[0].fields.steps!==42||r.records[0].fields.password!=='[REDACTED]'||r.receiver.errors!==0)throw Error(JSON.stringify(r));
 writeFileSync('research/worker-channel-2026-10-28/browser-result.json',JSON.stringify({gpu:false,...r},null,2)+'\n');
 console.log('Host retained a redacted checkpoint before an acknowledged worker exception');
}finally{await browser?.close();await server.stop(true);}

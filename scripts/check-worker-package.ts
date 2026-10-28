import {strict as assert} from 'node:assert';
import {createWorkerDiagnosticReporter,createWorkerDiagnosticReceiver} from '@absolutejs/diagnostics/worker';
let count=0;
const receiver=createWorkerDiagnosticReceiver({jobId:'consumer',onRecord:r=>{assert.equal(r.fields.password,'[REDACTED]'); count++;}});
const reporter=createWorkerDiagnosticReporter({jobId:'consumer',send:f=>{assert.equal(receiver.receive(f),'accepted');}});
assert.equal(reporter.emit('checkpoint',{password:'hidden'}),true);
assert.equal(count,1);
receiver.close();assert.equal(receiver.snapshot().closed,true);
console.log('Published worker subpath redacts and delivers a bounded owned record');

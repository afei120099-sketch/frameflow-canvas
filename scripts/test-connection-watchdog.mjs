import assert from "node:assert/strict";
import { connectionWatchdog } from "../lib/connection-watchdog.ts";
let scheduled, ready = false, attempts = 0, cleanups = 0, generationCalls = 0;
const settle = async () => { for (let n = 0; n < 8; n++) await Promise.resolve(); };
const watchdog = connectionWatchdog({
  ready: () => ready,
  connect: async () => {
    attempts++;
    if (attempts === 1) throw Error("server offline");
    if (attempts === 2) return null;
    ready = true;
    return () => { cleanups++; ready = false; };
  },
  schedule: fn => { scheduled = fn; return 1; },
  unschedule: () => { scheduled = undefined; },
});
await settle();
assert.equal(attempts, 1);
scheduled(); await settle();
assert.equal(attempts, 2);
scheduled(); await settle();
assert.equal(ready, true);
assert.equal(attempts, 3);
await watchdog.check(); await settle();
assert.equal(attempts, 3, "healthy bridge must not be installed twice");
ready = false;
await watchdog.check(); await settle();
assert.equal(attempts, 4, "missing interface must be restored");
assert.equal(cleanups, 1);
watchdog.stop();
assert.equal(cleanups, 2);
await watchdog.check();
assert.equal(attempts, 4);
assert.equal(generationCalls, 0);

let finish, installedAfterStop = 0;
const pending = connectionWatchdog({
  ready: () => false,
  connect: () => new Promise(resolve => { finish = () => resolve(() => installedAfterStop++); }),
  schedule: () => { throw Error("disposed watchdog must not schedule"); },
});
pending.stop(); finish(); await settle();
assert.equal(installedAfterStop, 1, "late async installation must be cleaned up");
let unblock, concurrent = 0;
const flight = connectionWatchdog({
  ready: () => false,
  connect: () => { concurrent++; return new Promise(resolve => { unblock = () => resolve(null); }); },
  schedule: () => 1, unschedule: () => {},
});
await flight.check(); await flight.check();
assert.equal(concurrent, 1, "online/focus/timer cannot create concurrent installs");
flight.stop(); unblock(); await settle();
console.log("PASS: offline retry, eventual connect, missing API recovery, no duplicate/concurrent installs, cleanup and no generation commands");

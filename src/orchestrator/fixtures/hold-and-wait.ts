// Test helper: takes a keep-awake hold, reports the holder's pid, then waits to be killed.

import { startWindowsHold } from "../keepAwake.ts";

const hold = startWindowsHold();
hold.ready.then(
  () => process.stdout.write(`holder ${hold.pid}\n`),
  (error: Error) => process.stdout.write(`failed ${error.message}\n`),
);
setInterval(() => undefined, 1000);

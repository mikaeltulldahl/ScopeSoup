// `pnpm item <verb>`: file, claim, hand back, release and list items. See src/items/cli.ts.

import { createInterface } from "node:readline/promises";
import { runItemCli } from "./items/cli.ts";

process.exitCode = await runItemCli(process.argv.slice(2), {
  env: process.env,
  // pnpm runs scripts from the package folder and keeps where it was started in INIT_CWD: relative paths and the git checkout are the caller's.
  cwd: process.env.INIT_CWD ?? process.cwd(),
  out: (line) => console.log(line),
  err: (line) => console.error(line),
  // A question (the step on GitHub after an import) is only asked when a person is at the terminal.
  ...(process.stdin.isTTY && process.stdout.isTTY
    ? {
        ask: async (question: string) => {
          const terminal = createInterface({ input: process.stdin, output: process.stdout });
          try {
            return await terminal.question(question);
          } finally {
            terminal.close();
          }
        },
      }
    : {}),
});

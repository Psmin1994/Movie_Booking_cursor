import { spawn } from "node:child_process";
import process from "node:process";

const child = spawn(
  "pnpm",
  ["--filter", "@movie-booking/database-prisma", ...process.argv.slice(2)],
  {
    stdio: "inherit",
    env: process.env,
    shell: process.platform === "win32",
  },
);

child.on("error", (error) => {
  console.error(error);
  process.exit(1);
});

child.on("exit", (code) => {
  process.exit(code ?? 1);
});

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));

const env = {
  ...process.env,
  JEVONIAN_CONFIG: join(homedir(), ".config", "jevonian", "config.json"),
  JEVONIAN_DATA_DIR: join(homedir(), ".local", "share", "jevonian"),
  JEVONIAN_CREDENTIALS: join(homedir(), ".config", "jevonian", "credentials.json"),
  JEVONIAN_NO_OPEN: "1",
};

const cliPath = join(__dirname, "..", "jevonian", "dist", "cli.mjs");
const cwd = join(__dirname, "..", "jevonian");

console.log(`[jevonian-opencode] Starting OpenCode Gateway on Port 8787...`);
console.log(`[jevonian-opencode] Config: ${env.JEVONIAN_CONFIG}`);

const child = spawn(process.execPath, [cliPath, "serve"], {
  cwd,
  env,
  stdio: "inherit",
});

child.on("exit", (code) => process.exit(code ?? 0));

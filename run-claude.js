import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));

const env = {
  ...process.env,
  JEVONIAN_CONFIG: join(homedir(), ".config", "jevonian-claude", "config.json"),
  JEVONIAN_DATA_DIR: join(homedir(), ".local", "share", "jevonian-claude"),
  JEVONIAN_CREDENTIALS: join(homedir(), ".config", "jevonian-claude", "credentials.json"),
  JEVONIAN_NO_OPEN: "1"
};

const child = spawn(process.execPath, [join(__dirname, "..", "jevonian", "dist", "cli.mjs"), "serve"], {
  cwd: join(__dirname, "..", "jevonian"),
  env,
  stdio: "inherit"
});

child.on("exit", (code) => process.exit(code ?? 0));

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Locate Jevonian installation directory
const candidateJevonianDirs = [
  join(__dirname, "jevonian_fresh"),
  process.env.JEVONIAN_DIR,
  join(__dirname, "..", "jevonian"),
  join(__dirname, "jevonian"),
  "D:/learn/jevonian",
].filter(Boolean);

let jevonianDir = candidateJevonianDirs.find((dir) => existsSync(join(dir, "dist", "cli.mjs")));

if (!jevonianDir) {
  console.error("=================================================================");
  console.error("[ERROR] Jevonian installation (dist/cli.mjs) could not be found!");
  console.error("Please make sure you have cloned and built Jevonian:");
  console.error("  git clone https://github.com/xinyao27/jevonian.git ../jevonian");
  console.error("  cd ../jevonian");
  console.error("  git apply <path-to>/patch-jevonian.diff");
  console.error("  pnpm install");
  console.error("  pnpm build");
  console.error("Or set the JEVONIAN_DIR environment variable to your jevonian path.");
  console.error("=================================================================");
  process.exit(1);
}

const env = {
  ...process.env,
  JEVONIAN_CONFIG: join(homedir(), ".config", "jevonian", "config.json"),
  JEVONIAN_DATA_DIR: join(homedir(), ".local", "share", "jevonian"),
  JEVONIAN_CREDENTIALS: join(homedir(), ".config", "jevonian", "credentials.json"),
  JEVONIAN_NO_OPEN: "1",
};

console.log(`[jevonian-opencode] Starting OpenCode Gateway on Port 8787...`);
console.log(`[jevonian-opencode] Jevonian Dir: ${jevonianDir}`);
console.log(`[jevonian-opencode] Config:       ${env.JEVONIAN_CONFIG}`);

const child = spawn(process.execPath, [join(jevonianDir, "dist", "cli.mjs"), "serve"], {
  cwd: jevonianDir,
  env,
  stdio: "inherit",
});

child.on("exit", (code) => process.exit(code ?? 0));

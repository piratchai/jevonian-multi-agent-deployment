import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { existsSync, readFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Resolve TypeSafe API key from environment, local file, or parent folders
let typesafeApiKey = process.env.TYPESAFE_API_KEY;
if (!typesafeApiKey) {
  const candidateKeyFiles = [
    join(__dirname, "typesafe-api.txt"),
    join(__dirname, "credential", "typesafe-api.txt"),
    join(__dirname, "..", "credential", "typesafe-api.txt"),
    "D:/work/sourcecode/workflow_hbt/credential/typesafe-api.txt",
  ];
  for (const candidate of candidateKeyFiles) {
    if (existsSync(candidate)) {
      try {
        typesafeApiKey = readFileSync(candidate, "utf8").trim();
        if (typesafeApiKey) break;
      } catch {}
    }
  }
}

// Locate Jevonian installation directory
const candidateJevonianDirs = [
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
  ...(typesafeApiKey ? { TYPESAFE_API_KEY: typesafeApiKey } : {}),
  JEVONIAN_CONFIG: join(homedir(), ".config", "jevonian-claude", "config.json"),
  JEVONIAN_DATA_DIR: join(homedir(), ".local", "share", "jevonian-claude"),
  JEVONIAN_CREDENTIALS: join(homedir(), ".config", "jevonian-claude", "credentials.json"),
  JEVONIAN_NO_OPEN: "1",
};

console.log(`[jevonian-claude] Starting Claude Code Gateway on Port 8790...`);
console.log(`[jevonian-claude] Jevonian Dir: ${jevonianDir}`);
console.log(`[jevonian-claude] Config:       ${env.JEVONIAN_CONFIG}`);
if (typesafeApiKey) {
  console.log(`[jevonian-claude] TypeSafe Brain: Enabled (API key loaded)`);
} else {
  console.log(`[jevonian-claude] Warning: TYPESAFE_API_KEY not found. Conversational turns (e.g. "Hi") will fallback to heuristic routing.`);
}

const child = spawn(process.execPath, [join(jevonianDir, "dist", "cli.mjs"), "serve"], {
  cwd: jevonianDir,
  env,
  stdio: "inherit",
});

child.on("exit", (code) => process.exit(code ?? 0));

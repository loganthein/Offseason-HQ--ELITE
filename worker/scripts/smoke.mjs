// Pre-deploy smoke test for the Worker. Run from inside worker/:
//
//   node scripts/smoke.mjs
//
// Catches the class of bug that `node --check` cannot: --check only parses
// syntax, so a `const` referenced before its declaration (a temporal dead
// zone ReferenceError) passes the check and then throws while the module is
// LOADING — taking down every request, web chat and Slack alike, rather
// than failing one call. That exact bug shipped once: SYSTEM_PROMPT
// interpolates ${MFL_SEASON}, which was declared 120 lines further down.
//
// Importing the module is what proves it: a load-time throw fails here
// instead of in production.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(here, "..", "src", "index.js");

const env = {
  ALLOWED_ORIGIN: "https://elitefantasyhq.com",
  ANTHROPIC_API_KEY: "smoke-test-not-a-real-key",
  DB: null,
};

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  ok  " : "FAIL  "}${label}${detail ? " — " + detail : ""}`);
  if (!ok) failures++;
};

// 1. The module must load. This is the whole point of the file.
let worker;
try {
  worker = (await import(entry)).default;
  check("module loads", true);
} catch (e) {
  check("module loads", false, `${e.constructor.name}: ${e.message}`);
  console.error("\nThe Worker would crash on every request if deployed. Not safe to deploy.");
  process.exit(1);
}

check("exports a fetch handler", typeof worker?.fetch === "function");

// 2. Routes that need no network should answer.
const call = (method, url, headers = {}) =>
  worker.fetch(new Request(url, { method, headers: { Origin: env.ALLOWED_ORIGIN, ...headers } }), env, { waitUntil() {} });

const preflight = await call("OPTIONS", "https://w/api/chat");
check("CORS preflight answers 200", preflight.status === 200, `got ${preflight.status}`);
check("preflight allows the site origin",
  preflight.headers.get("access-control-allow-origin") === env.ALLOWED_ORIGIN,
  preflight.headers.get("access-control-allow-origin") || "none");

const missing = await call("GET", "https://w/definitely-not-a-route");
check("unknown route 404s", missing.status === 404, `got ${missing.status}`);

// 3. Guard the specific footgun: anything interpolated into the prompt or
// tool definitions must be declared above them.
const src = await readFile(entry, "utf8");
const declLine = (name) => src.split("\n").findIndex((l) => new RegExp(`^const ${name}\\b`).test(l));
const promptLine = src.split("\n").findIndex((l) => l.startsWith("const SYSTEM_PROMPT"));
for (const name of ["MFL_SEASON", "MFL_HOST", "MFL_LEAGUE_ID", "MFL_LIVE_TYPES"]) {
  const d = declLine(name);
  if (d === -1) continue;
  check(`${name} declared before SYSTEM_PROMPT`, d < promptLine, `line ${d + 1} vs prompt at ${promptLine + 1}`);
}

console.log(failures ? `\n${failures} check(s) failed — do not deploy.` : "\nAll checks passed. Safe to deploy.");
process.exit(failures ? 1 : 0);

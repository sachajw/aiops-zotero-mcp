// Bundle src/ into addon/content and package build/aiops-zotero-mcp-<version>.xpi.
// Run with `mise run build`. Version comes from package.json; nothing else varies.
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const stage = join(root, "build", "addon");
const xpi = join(root, "build", `aiops-zotero-mcp-${version}.xpi`);

rmSync(join(root, "build"), { recursive: true, force: true });
mkdirSync(join(stage, "content"), { recursive: true });

await build({
  entryPoints: [join(root, "src", "index.ts")],
  bundle: true,
  format: "iife",
  globalName: "AiopsZoteroMcp",
  target: "firefox128",
  outfile: join(stage, "content", "aiops-zotero-mcp.js"),
  legalComments: "inline",
  logLevel: "warning",
});

for (const f of ["bootstrap.js", "prefs.js"]) cpSync(join(root, "addon", f), join(stage, f));
const manifest = readFileSync(join(root, "addon", "manifest.json"), "utf8").replace("__VERSION__", version);
writeFileSync(join(stage, "manifest.json"), manifest);

// Zotero requires update_url in the manifest; this is the file it points at (commit it on release).
const { applications } = JSON.parse(manifest);
const updates = {
  addons: {
    [applications.zotero.id]: {
      updates: [
        {
          version,
          update_link: `https://github.com/sachajw/aiops-zotero-mcp/releases/download/v${version}/aiops-zotero-mcp-${version}.xpi`,
          applications: { zotero: { strict_min_version: applications.zotero.strict_min_version } },
        },
      ],
    },
  },
};
writeFileSync(join(root, "build", "updates.json"), JSON.stringify(updates, null, 2) + "\n");

// -X: no extra file attributes, so the same input gives the same archive.
execFileSync("zip", ["-q", "-r", "-X", xpi, "."], { cwd: stage });
console.log(`built ${xpi.replace(root, "")}`);

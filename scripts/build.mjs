// Bundle src/ into addon/content and package build/aiops-zotero-mcp-<version>.xpi.
// Run with `mise run build`. Version comes from package.json; nothing else varies.
import { build } from "esbuild";
import { zipSync } from "fflate";
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

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

// Zip with fflate (a declared dependency), not the system `zip` tool. Paths are sorted and every
// entry gets the same fixed timestamp, so the same input always gives the same archive.
function files(dir) {
  return readdirSync(dir).sort().flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}
const entries = Object.fromEntries(
  files(stage).map((path) => [relative(stage, path).split(sep).join("/"), readFileSync(path)]),
);
writeFileSync(xpi, zipSync(entries, { level: 9, mtime: new Date("1980-01-02T00:00:00Z") }));
console.log(`built ${xpi.replace(root, "")}`);

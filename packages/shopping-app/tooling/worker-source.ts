import { createHash } from "node:crypto";

export type TWorkerSource = { source: string; version: string; assets: string[] };

// The worker precaches the shell (the scope URL itself, never "index.html": that is what a launch from
// the icon requests) plus every emitted file. Its own file and source maps stay out. The version is a
// hash of the list AND of the shell's text, because the shell can change while every hashed asset keeps
// its name.
export function workerSource(template: string, base: string, files: readonly string[], shell: string): TWorkerSource {
  const assets = [base];
  const sorted = [...new Set(files)].sort();
  for (let i = 0; i < sorted.length; i++) {
    const f = sorted[i]!;
    if (f === "sw.js" || f === "index.html" || f.endsWith(".map")) continue;
    assets.push(base + f);
  }
  const version = createHash("sha256").update(assets.join("\n")).update("\n").update(shell).digest("hex").slice(0, 12);
  if (!template.includes('"__SW_VERSION__"') || !template.includes('"__SW_ASSETS__"') || !template.includes('"__SW_SCOPE__"'))
    throw new Error("worker template lost a placeholder");
  const source = template
    .replace('"__SW_VERSION__"', JSON.stringify(version))
    .replace('"__SW_ASSETS__"', JSON.stringify(assets))
    .replace('"__SW_SCOPE__"', JSON.stringify(base));
  return { source, version, assets };
}

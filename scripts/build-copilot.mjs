import { build } from "esbuild";
import { copyFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const output = new URL("dist/copilot/garmin-fitness/", root);
await mkdir(output, { recursive: true });
for (const [entry, filename] of [
  ["src/presentation/capture.ts", "reports.mjs"],
  ["src/copilot/runtime.ts", "runtime.mjs"],
]) {
  await build({
    absWorkingDir: fileURLToPath(root),
    entryPoints: [fileURLToPath(new URL(entry, root))],
    outfile: fileURLToPath(new URL(filename, output)),
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    minify: true,
    legalComments: "inline",
  });
}
await copyFile(new URL("integrations/copilot/extension.mjs", root), new URL("extension.mjs", output));
await copyFile(new URL("dist/ui/canvas.html", root), new URL("dashboard.html", output));

import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const template = await readFile(new URL("src/ui/dashboard.html", root), "utf8");
const styles = await readFile(new URL("src/ui/styles.css", root), "utf8");
for (const placeholder of ["<!-- DASHBOARD_STYLES -->", "<!-- DASHBOARD_SCRIPT -->"]) {
  if (template.split(placeholder).length !== 2) {
    throw new Error(`Expected exactly one ${placeholder} in dashboard template`);
  }
}
await mkdir(new URL("dist/ui/", root), { recursive: true });
for (const [entry, output] of [["app.ts", "dashboard.html"], ["canvas.ts", "canvas.html"]]) {
  const bundle = await build({
    absWorkingDir: fileURLToPath(root),
    entryPoints: [fileURLToPath(new URL(`src/ui/${entry}`, root))],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    target: "es2022",
    minify: true,
    legalComments: "inline",
  });
  const html = template
    .replace("<!-- DASHBOARD_STYLES -->", () => `<style>${styles}</style>`)
    .replace("<!-- DASHBOARD_SCRIPT -->", () =>
      `<script>${bundle.outputFiles[0].text.replace(/<\/script/gi, "<\\/script")}</script>`);
  await writeFile(new URL(`dist/ui/${output}`, root), html);
}

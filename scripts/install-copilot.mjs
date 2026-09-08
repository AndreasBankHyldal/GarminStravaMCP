import { copyFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const destination = join(process.env.COPILOT_HOME || join(homedir(), ".copilot"), "extensions", "garmin-fitness");
const source = new URL("../dist/copilot/garmin-fitness/", import.meta.url);
await mkdir(destination, { recursive: true });
// Only replace our generated assets; never modify user configuration or artifacts.
for (const file of ["dashboard.html", "reports.mjs", "runtime.mjs", "extension.mjs"]) {
  await copyFile(new URL(file, source), join(destination, file));
}
console.error(`Installed Garmin fitness canvas at ${destination}. Reload Copilot extensions or restart the app to enable it in other sessions.`);

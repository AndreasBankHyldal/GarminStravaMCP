import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { snapshotSchema, type Snapshot } from "../presentation/capture.js";
export { createGarminEventObserver } from "./events.js";

export function createReportStore(directory: string) {
  const pathFor = (id: string) => {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      throw new Error("Invalid Garmin report ID.");
    }
    return join(directory, `${id}.json`);
  };
  return {
    async save(toolName: string, result: Snapshot["result"]): Promise<Snapshot> {
      const snapshot = snapshotSchema.parse({
        id: randomUUID(), toolName, capturedAt: new Date().toISOString(), result,
      });
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const destination = pathFor(snapshot.id);
      const temporary = `${destination}.tmp`;
      await writeFile(temporary, JSON.stringify(snapshot), { mode: 0o600, flag: "wx" });
      await rename(temporary, destination);
      return snapshot;
    },
    async read(id: string): Promise<Snapshot> {
      const snapshot = snapshotSchema.parse(JSON.parse(await readFile(pathFor(id), "utf8")));
      if (snapshot.id !== id) throw new Error("Saved Garmin report ID does not match the requested report.");
      return snapshot;
    },
    async remove(id: string): Promise<void> {
      await unlink(pathFor(id));
    },
    async list(): Promise<Snapshot[]> {
      let filenames: string[];
      try {
        filenames = await readdir(directory);
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
        throw error;
      }
      const snapshots: Snapshot[] = [];
      for (const filename of filenames) {
        if (!/^[0-9a-f-]{36}\.json$/i.test(filename)) continue;
        snapshots.push(await this.read(filename.slice(0, -5)));
      }
      return snapshots.sort((a, b) => b.capturedAt.localeCompare(a.capturedAt));
    },
  };
}

export async function startReportServer(html: string, readSnapshot: () => Promise<Snapshot>) {
  const token = randomBytes(32).toString("hex");
  let origin = "";
  const sockets = new Set<import("node:net").Socket>();
  const server = createServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'none'; base-uri 'none'; form-action 'none'");
    if (request.headers.host !== origin.slice("http://".length)) {
      response.writeHead(403).end("Forbidden host");
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { Allow: "GET, HEAD" }).end("Read-only dashboard");
      return;
    }
    if (request.url === `/${token}/`) {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(request.method === "HEAD" ? undefined : html);
      return;
    }
    if (request.url !== `/${token}/state`) {
      response.writeHead(404).end("Not found");
      return;
    }
    if (request.headers.origin && request.headers.origin !== origin) {
      response.writeHead(403).end("Forbidden origin");
      return;
    }
    response.setHeader("Content-Type", "application/json");
    try {
      const snapshot = await readSnapshot();
      response.end(request.method === "HEAD" ? undefined : JSON.stringify(snapshot));
    } catch (error) {
      console.error("Cannot read saved Garmin dashboard:", error instanceof Error ? error.message : String(error));
      response.writeHead(500).end(JSON.stringify({ error: "The saved Garmin report is unavailable or invalid. Run the Garmin tool again." }));
    }
  });
  server.on("connection", socket => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Garmin dashboard did not bind to a loopback port.");
  origin = `http://127.0.0.1:${address.port}`;
  let closed: Promise<void> | undefined;
  return {
    url: `${origin}/${token}/`,
    close() {
      if (!closed) {
        closed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        for (const socket of sockets) socket.destroy();
      }
      return closed;
    },
  };
}

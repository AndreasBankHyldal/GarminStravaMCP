import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  FailedAuthLimiter,
  assertValidAuthToken,
  bearerTokenMatches,
  isAllowedHost,
  isAllowedOrigin,
} from "./security.js";

export const MCP_PATH = "/mcp";
export const HEALTH_PATH = "/healthz";
const MAX_BODY_BYTES = 4 * 1024 * 1024;

export interface HttpHandlerOptions {
  authToken: string;
  /** Public hostnames (without port) accepted in Host/Origin besides loopback. */
  allowedHosts: string[];
  /** Use the first X-Forwarded-For entry as the client address (behind Caddy). */
  trustProxy?: boolean;
  createMcpServer: () => McpServer;
  limiter?: FailedAuthLimiter;
}

export interface StartHttpServerOptions extends HttpHandlerOptions {
  host: string;
  port: number;
}

export interface RunningHttpServer {
  server: http.Server;
  url: string;
  close(): Promise<void>;
}

class BodyTooLargeError extends Error {}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (res.headersSent) return;
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

function sendJsonRpcError(res: ServerResponse, status: number, message: string, headers: Record<string, string> = {}): void {
  sendJson(res, status, { jsonrpc: "2.0", error: { code: -32000, message }, id: null }, headers);
}

function clientKey(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = req.headers["x-forwarded-for"];
    const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? "unknown";
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new BodyTooLargeError("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

async function handleMcpPost(req: IncomingMessage, res: ServerResponse, createMcpServer: () => McpServer): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      sendJsonRpcError(res, 413, "Request body too large");
    } else {
      sendJson(res, 400, { jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null });
    }
    return;
  }

  // Stateless mode: a fresh server and transport per request; the Garmin client and
  // database stay shared module singletons.
  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

export function createHttpRequestHandler(options: HttpHandlerOptions) {
  const authToken = assertValidAuthToken(options.authToken);
  const allowedHosts = options.allowedHosts.map((host) => host.toLowerCase());
  const limiter = options.limiter ?? new FailedAuthLimiter();
  const trustProxy = options.trustProxy ?? false;

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const pathname = new URL(req.url ?? "/", "http://localhost").pathname;

      if (pathname === HEALTH_PATH) {
        if (req.method === "GET" || req.method === "HEAD") {
          sendJson(res, 200, { status: "ok" });
        } else {
          sendJson(res, 405, { error: "Method not allowed" }, { allow: "GET, HEAD" });
        }
        return;
      }

      if (pathname !== MCP_PATH) {
        sendJson(res, 404, { error: "Not found" });
        return;
      }

      if (!isAllowedHost(req.headers.host, allowedHosts)) {
        sendJsonRpcError(res, 403, "Host not allowed");
        return;
      }
      if (!isAllowedOrigin(req.headers.origin, allowedHosts)) {
        sendJsonRpcError(res, 403, "Origin not allowed");
        return;
      }

      const key = clientKey(req, trustProxy);
      if (limiter.isBlocked(key)) {
        sendJsonRpcError(res, 429, "Too many failed authentication attempts", { "retry-after": "900" });
        return;
      }
      if (!bearerTokenMatches(req.headers.authorization, authToken)) {
        limiter.recordFailure(key);
        if (!res.headersSent) {
          res.writeHead(401, { "www-authenticate": 'Bearer realm="garmin-mcp"' });
          res.end();
        }
        return;
      }
      limiter.reset(key);

      if (req.method === "POST") {
        await handleMcpPost(req, res, options.createMcpServer);
        return;
      }
      // Stateless server: no standalone SSE stream (GET) or sessions to delete.
      sendJsonRpcError(res, 405, "Method not allowed", { allow: "POST" });
    } catch (err) {
      console.error("HTTP request failed:", err);
      sendJsonRpcError(res, 500, "Internal server error");
    }
  };
}

export async function startHttpServer(options: StartHttpServerOptions): Promise<RunningHttpServer> {
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) {
    throw new Error("MCP_PORT must be an integer between 0 and 65535.");
  }
  const handler = createHttpRequestHandler(options);
  const server = http.createServer((req, res) => void handler(req, res));

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  const host = address.family === "IPv6" ? `[${address.address}]` : address.address;
  return {
    server,
    url: `http://${host}:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections?.();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

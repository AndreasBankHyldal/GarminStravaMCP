import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { config } from "./config.js";
import { createServer } from "./server.js";
import { startHttpServer } from "./http/server.js";

// Redirect console.log to stderr so libraries can't pollute stdout
console.log = console.error;

async function runHttp(): Promise<void> {
  if (config.women.toolsEnabled || config.garmin.womenHealthEnabled) {
    console.error(
      "\n⚠️  WARNING: women's-health tools are exposed over HTTP (MCP_HTTP_ALLOW_WOMEN_TOOLS=true). " +
      "They handle special-category health data; make sure this endpoint is private.\n"
    );
  } else if (config.women.requested) {
    console.error(
      "Women's-health tools are disabled in HTTP mode. " +
      "Set MCP_HTTP_ALLOW_WOMEN_TOOLS=true to expose them over the network."
    );
  }

  const running = await startHttpServer({
    host: config.http.host,
    port: config.http.port,
    authToken: config.http.authToken,
    allowedHosts: config.http.allowedHosts,
    trustProxy: config.http.trustProxy,
    createMcpServer: createServer,
  });
  console.error(`Garmin Connect MCP server listening on ${running.url}/mcp`);

  const shutdown = (signal: string) => {
    console.error(`Received ${signal}, shutting down.`);
    running.close().finally(() => process.exit(0));
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
}

async function runStdio(): Promise<void> {
  const server = createServer();
  await server.connect(new StdioServerTransport());
  console.error("Garmin Connect MCP server running on stdio");
}

try {
  await (config.transport === "http" ? runHttp() : runStdio());
} catch (err: any) {
  console.error(`Failed to start MCP server: ${err?.message ?? err}`);
  process.exit(1);
}

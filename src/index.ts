import { startServer } from "./server.js";

startServer().catch((err) => {
  console.error("Fatal error starting MCP server:", err);
  process.exit(1);
});

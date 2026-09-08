import { readFile } from "node:fs/promises";
import { registerAppResource, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { DASHBOARD_URI, REPORT_META_KEY, reportSchema, type Report } from "./model.js";

export const reportToolMeta = { ui: { resourceUri: DASHBOARD_URI } };
const resourceMeta = {
  ui: {
    prefersBorder: false,
    csp: { connectDomains: [], resourceDomains: [], frameDomains: [] },
  },
};

export function reportResult(data: object, report: Report): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    // UI-only data keeps the original model-facing JSON contract unchanged.
    _meta: { [REPORT_META_KEY]: reportSchema.parse(report) },
  };
}

export function registerReportResource(server: McpServer): void {
  const htmlPath = new URL("../../dist/ui/dashboard.html", import.meta.url);
  registerAppResource(
    server,
    "Garmin fitness dashboard",
    DASHBOARD_URI,
    {
      description: "Interactive run, trend, heart-rate zone, and training dashboards.",
      _meta: resourceMeta,
    },
    async () => ({
      contents: [{
        uri: DASHBOARD_URI,
        mimeType: RESOURCE_MIME_TYPE,
        text: await readFile(htmlPath, "utf8"),
        _meta: resourceMeta,
      }],
    })
  );
}

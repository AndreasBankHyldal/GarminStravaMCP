import { identifyReportTool, type ReportTool } from "../presentation/capture.js";

interface ToolCompletion {
  toolCallId: string;
  success: boolean;
  result?: {
    contents?: { type: string; text?: string }[];
    detailedContent?: string;
    content: string;
  };
}

export function createGarminEventObserver(callbacks: {
  onReport: (toolName: ReportTool, text: string) => Promise<void>;
  onFailure: (message: string) => Promise<void>;
}) {
  const pending = new Map<string, ReportTool>();
  return {
    start(data: { toolCallId: string; toolName: string }): void {
      const toolName = identifyReportTool(data.toolName);
      if (toolName) pending.set(data.toolCallId, toolName);
    },
    async complete(data: ToolCompletion): Promise<void> {
      const toolName = pending.get(data.toolCallId);
      if (!toolName) return;
      pending.delete(data.toolCallId);
      if (!data.success) {
        await callbacks.onFailure("Garmin request failed; no new dashboard was created. Existing panels are older, timestamped snapshots.");
        return;
      }
      const result = data.result;
      const textBlocks = result?.contents?.filter(block => block.type === "text");
      const text = textBlocks?.length === 1 ? textBlocks[0].text : result?.detailedContent ?? result?.content;
      if (typeof text !== "string") {
        await callbacks.onFailure("Garmin returned no readable report text; no dashboard was created.");
        return;
      }
      await callbacks.onReport(toolName, text);
    },
    clear(): void {
      pending.clear();
    },
  };
}

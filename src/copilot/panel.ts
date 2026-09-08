export const FITNESS_PANEL_ID = "fitness-dashboard";

interface OpenPanel {
  canvasId: string;
  extensionId: string;
  instanceId: string;
}

export function createFitnessPanel(options: {
  canvasId: string;
  extensionId: string;
  selectReport: (reportId: string) => Promise<void>;
  listOpen: () => Promise<{ openCanvases: OpenPanel[] }>;
  close: (input: { instanceId: string }) => Promise<unknown>;
  open: (input: {
    canvasId: string;
    extensionId: string;
    instanceId: string;
    input: { selected: true };
  }) => Promise<unknown>;
}) {
  let queue: Promise<unknown> = Promise.resolve();
  return {
    show(reportId: string): Promise<void> {
      const present = async () => {
        await options.selectReport(reportId);
        const { openCanvases } = await options.listOpen();
        for (const panel of openCanvases) {
          if (panel.canvasId === options.canvasId && panel.extensionId === options.extensionId && panel.instanceId !== FITNESS_PANEL_ID) {
            await options.close({ instanceId: panel.instanceId });
          }
        }
        // The saved selection changes, not the panel identity or its open input.
        await options.open({
          canvasId: options.canvasId,
          extensionId: options.extensionId,
          instanceId: FITNESS_PANEL_ID,
          input: { selected: true },
        });
      };
      const operation = queue.then(present, present);
      queue = operation;
      return operation;
    },
  };
}

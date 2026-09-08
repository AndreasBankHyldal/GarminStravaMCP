import { z } from "zod";

export const REPORT_META_KEY = "garmin/report";
export const DASHBOARD_URI = "ui://garmin/fitness-report.html";

export const colorSchema = z.enum(["blue", "green", "amber", "orange", "red", "purple"]);
const metricSchema = z.object({
  label: z.string(),
  value: z.string(),
  detail: z.string().optional(),
  color: colorSchema.default("blue"),
});
const pointSchema = z.object({
  label: z.string(),
  value: z.number().finite().nullable(),
  low: z.number().finite().nullable().optional(),
  color: colorSchema.optional(),
});
const chartSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  kind: z.enum(["line", "bar", "range"]),
  unit: z.string(),
  format: z.enum(["number", "pace"]).default("number"),
  series: z.array(z.object({
    label: z.string(),
    color: colorSchema,
    points: z.array(pointSchema),
  })),
});

export const reportSchema = z.object({
  version: z.literal(1),
  title: z.string(),
  subtitle: z.string(),
  metrics: z.array(metricSchema),
  sections: z.array(z.object({
    id: z.string(),
    label: z.string(),
    metrics: z.array(metricSchema),
    charts: z.array(chartSchema),
    notes: z.array(z.string()),
  })),
});

export type Report = z.infer<typeof reportSchema>;
export type Metric = z.infer<typeof metricSchema>;
export type Chart = z.infer<typeof chartSchema>;
export type Point = z.infer<typeof pointSchema>;
export type Color = z.infer<typeof colorSchema>;

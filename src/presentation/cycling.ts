import type { CyclingEvent, CyclingFitness, CyclingTrends, PowerProfile, RideAnalysis } from "../cycling/schema.js";
import type { Chart, Color, Metric, Point, Report } from "./model.js";

const unavailable = "Unavailable";
const zoneColors: Color[] = ["blue", "green", "amber", "orange", "red", "purple", "purple"];

function metric(label: string, value: string | number | null | undefined, color: Color = "blue", detail?: string): Metric {
  return { label, value: value == null || (typeof value === "number" && !Number.isFinite(value)) ? unavailable : String(value), color, detail };
}

function chart(id: string, title: string, unit: string, points: Point[], color: Color = "blue", kind: Chart["kind"] = "bar", description = ""): Chart {
  return { id, title, description, kind, unit, format: "number", series: [{ label: title, color, points }] };
}

const minutes = (seconds: number) => Math.round(seconds / 6) / 10;

function formatSeconds(seconds: number): string {
  const h = Math.floor(seconds / 3600), m = Math.floor((seconds % 3600) / 60), s = Math.round(seconds % 60);
  return h ? `${h}h ${m}m ${s}s` : `${m}m ${s}s`;
}

export function rideReport(data: RideAnalysis): Report {
  const { activity, power } = data;
  const segments = data.segments.items;
  const segmentLabel = (item: typeof segments[number]) => data.segments.basis === "distance"
    ? `km ${item.start_km}-${item.end_km}${item.is_partial ? " (partial)" : ""}`
    : `min ${item.start_minute}${item.is_partial ? " (partial)" : ""}`;
  const segmentName = data.segments.basis === "distance" ? `${data.segments.segment_size} km` : `${data.segments.segment_size}-minute`;

  const overview: Chart[] = [];
  if (segments.length) {
    overview.push(chart("segment-speed", `Speed by ${segmentName} segment`, "km/h", segments.map(item => ({ label: segmentLabel(item), value: item.avg_speed_kmh })),
      "blue", "bar", "Average speed over recorded (non-paused) time. Terrain and wind dominate speed; compare power for effort."));
    if (power.available) {
      const segmentPower = chart("segment-power", `Power by ${segmentName} segment`, "W", [], "orange", "line", "Average power includes zeros while coasting; normalized power weights surges.");
      segmentPower.series = [
        { label: "Average power", color: "orange", points: segments.map(item => ({ label: segmentLabel(item), value: item.avg_power_w })) },
        { label: "Normalized power", color: "purple", points: segments.map(item => ({ label: segmentLabel(item), value: item.normalized_power_w })) },
      ];
      overview.push(segmentPower);
    }
    overview.push(
      chart("segment-hr", `Heart rate by ${segmentName} segment`, "bpm", segments.map(item => ({ label: segmentLabel(item), value: item.avg_heartrate })),
        "red", "line", "Time-weighted average of valid readings. Missing readings are gaps, not zero."),
      chart("segment-elevation", `Elevation gain by ${segmentName} segment`, "m", segments.map(item => ({ label: segmentLabel(item), value: item.elevation_gain_m })),
        "green", "bar", "Sample-estimated elevation gain from the recorded altitude stream."),
    );
  }
  const sections: Report["sections"] = [{
    id: "overview", label: "Overview", metrics: [], charts: overview,
    notes: [...data.data_quality.warnings, ...(segments.length ? [] : ["Segment charts are unavailable: Garmin did not provide a second-by-second recording."])],
  }];

  if (power.available) {
    const curve = chart("power-curve", "Best efforts (power curve)", "W", data.power_curve.map(point => ({ label: point.label, value: point.watts })),
      "orange", "line", "Highest average power for each duration within this ride.");
    const zoneChart = data.power_zones
      ? [chart("power-zones", "Time in power zones", "min", data.power_zones.map((zone, index) => ({
        label: `Z${zone.zone} ${zone.label} (${zone.min_w}-${zone.max_w ?? "+"} W)`, value: minutes(zone.seconds), color: zoneColors[index],
      })), "blue", "bar", `Coggan 7-zone model from FTP ${power.ftp_w} W (${power.ftp_source}).`)]
      : [];
    sections.push({
      id: "power", label: "Power",
      metrics: [
        metric("Intensity factor", power.intensity_factor, "amber", "NP / FTP"),
        metric("Variability index", power.variability_index, "purple", "NP / average"),
        metric("FTP", power.ftp_w, "orange", power.ftp_source === "unavailable" ? "not set" : `W · ${power.ftp_source}`),
        metric("Normalized W/kg", power.normalized_w_per_kg, "green", power.weight_kg ? `at ${power.weight_kg} kg` : "weight unknown"),
        metric("Work", power.work_kj, "blue", "kJ ≈ kcal burned"),
      ],
      charts: [...(data.power_curve.length ? [curve] : []), ...zoneChart],
      notes: [
        `Power coverage ${power.coverage_percent} %. Garmin reported: avg ${power.garmin_reported.avg_w ?? unavailable} W, NP ${power.garmin_reported.normalized_w ?? unavailable} W, TSS ${power.garmin_reported.tss ?? unavailable}.`,
        ...(power.ftp_w ? [] : ["Set FTP (Garmin Connect, ftp_watts, or get_cycling_power_profile) to unlock zones, IF and TSS."]),
      ],
    });
  }

  if (data.heart_rate_zones || data.efficiency || data.cadence) {
    const charts: Chart[] = [];
    if (data.heart_rate_zones) {
      charts.push(chart("hr-zones", "Time in heart-rate zones", "min", data.heart_rate_zones.zones.map((zone, index) => ({
        label: zone.zone === 0 ? `Below Z1 (<${(zone.max_bpm ?? 0) + 1} bpm)` : `Z${zone.zone} ${zone.label} (${zone.min_bpm}-${zone.max_bpm ?? "+"} bpm)`,
        value: minutes(zone.seconds), color: zone.zone === 0 ? "blue" : zoneColors[Math.max(0, index - 1)],
      })), "red", "bar", `Garmin ${data.heart_rate_zones.profile} heart-rate zone profile.`));
    }
    if (data.cadence) {
      charts.push(chart("cadence", "Cadence distribution (pedaling)", "%", data.cadence.distribution.map(bin => ({ label: bin.range, value: bin.percent })),
        "green", "bar", `Average pedaling cadence ${data.cadence.avg_pedaling_rpm} rpm; coasting ${data.cadence.coasting_percent ?? unavailable} % of rolling time.`));
    }
    sections.push({
      id: "heart-rate", label: "HR & cadence",
      metrics: data.efficiency ? [
        metric("Efficiency factor", data.efficiency.efficiency_factor, "green", "NP / avg HR"),
        metric("Pw:HR decoupling", data.efficiency.decoupling_percent, "amber", "% between halves"),
      ] : [],
      charts,
      notes: data.efficiency ? [data.efficiency.assessment] : ["Power:HR decoupling needs at least 20 minutes with 80 % power and heart-rate coverage in each half."],
    });
  }

  if (data.climbs.length) {
    sections.push({
      id: "climbs", label: `Climbs (${data.climbs.length})`, metrics: [],
      charts: [
        chart("climb-vam", "Climbing speed (VAM)", "m/h", data.climbs.map(climb => ({ label: `Climb ${climb.index} (km ${climb.start_km})`, value: climb.vam_m_per_h })),
          "green", "bar", "Vertical metres per hour on each detected climb."),
        ...(power.available ? [chart("climb-power", "Average power on climbs", "W", data.climbs.map(climb => ({ label: `Climb ${climb.index} (km ${climb.start_km})`, value: climb.avg_power_w })), "orange", "bar")] : []),
      ],
      notes: data.climbs.map(climb =>
        `Climb ${climb.index} (${climb.category}): km ${climb.start_km}-${climb.end_km}, ${(climb.length_m / 1000).toFixed(1)} km at ${climb.avg_grade_percent} % (max ${climb.max_grade_200m_percent} %), +${climb.elevation_gain_m} m in ${formatSeconds(climb.time_seconds)}, VAM ${climb.vam_m_per_h} m/h` +
        (climb.avg_power_w !== null ? `, ${climb.avg_power_w} W${climb.avg_w_per_kg !== null ? ` (${climb.avg_w_per_kg} W/kg)` : ""}` : "") +
        (climb.avg_heartrate !== null ? `, ${climb.avg_heartrate} bpm` : "")),
    });
  }

  if (data.laps.length) {
    const lapLabel = (lap: typeof data.laps[number]) => `Lap ${lap.lap}${lap.intensity ? ` - ${lap.intensity}` : ""} (${lap.distance_km} km)`;
    sections.push({
      id: "laps", label: "Laps", metrics: [],
      charts: [
        ...(data.laps.some(lap => lap.avg_power_w !== null) ? [chart("lap-power", "Average power by lap", "W", data.laps.map(lap => ({ label: lapLabel(lap), value: lap.avg_power_w })), "orange", "bar")] : []),
        chart("lap-speed", "Speed by lap", "km/h", data.laps.map(lap => ({ label: lapLabel(lap), value: lap.avg_speed_kmh })), "blue", "bar"),
      ],
      notes: ["Recorded watch/bike-computer laps, including any structured-workout steps."],
    });
  }

  sections[0].notes.push(...data.notes);
  return {
    version: 1,
    title: activity.name,
    subtitle: `${activity.date.human} · ${activity.type.replaceAll("_", " ")}${activity.indoor ? " (indoor)" : ""}`,
    metrics: [
      metric("Distance", activity.distance_km, "blue", "km"),
      metric("Moving time", activity.moving_time),
      metric("Average speed", activity.avg_speed_kmh, "green", "km/h"),
      metric("Elevation gain", activity.elevation_gain_m, "purple", "m"),
      metric("Average power", power.avg_w, "orange", "W"),
      metric("Normalized power", power.normalized_w, "orange", "W"),
      metric("TSS", power.tss, "amber", power.tss_source ?? undefined),
      metric("Average heart rate", activity.avg_heartrate, "red", "bpm"),
    ],
    sections,
  };
}

export function powerProfileReport(data: PowerProfile): Report {
  const curve = chart("profile-curve", "Best power by duration", "W", data.power_curve.map(point => ({ label: point.label, value: point.watts })),
    "orange", "line", `Best efforts across ${data.rides_with_power} ride(s) with power in the last ${data.period_days} days.`);
  const charts = [curve];
  if (data.weight_kg) {
    charts.push(chart("profile-wkg", "Best power-to-weight by duration", "W/kg", data.power_curve.map(point => ({ label: point.label, value: point.w_per_kg })),
      "green", "line", `Using ${data.weight_kg} kg.`));
  }
  if (data.power_zones) {
    charts.push(chart("profile-zones", "Power zones", "W", data.power_zones.map((zone, index) => ({
      label: `Z${zone.zone} ${zone.label}`, low: zone.min_w, value: zone.max_w ?? Math.round((data.ftp.selected_w ?? 0) * 2), color: zoneColors[index],
    })), "blue", "range", "Coggan 7-zone ranges in watts; Z7 is open-ended (drawn to 200 % FTP)."));
  }
  return {
    version: 1,
    title: "Cycling power profile",
    subtitle: `Last ${data.period_days} days · ${data.rides_analyzed} rides`,
    metrics: [
      metric("FTP", data.ftp.selected_w, "orange", data.ftp.selected_source === "unavailable" ? "unknown" : `W · ${data.ftp.selected_source.replaceAll("_", " ")}`),
      metric("FTP W/kg", data.ftp.w_per_kg, "green"),
      metric("Garmin FTP", data.ftp.garmin_w, "blue", "W"),
      metric("20-min estimate", data.ftp.estimated_w, "amber", "W"),
      metric("Rides with power", data.rides_with_power, "purple"),
    ],
    sections: [{
      id: "overview", label: "Overview", metrics: [], charts,
      notes: [...(data.ftp.estimate_basis ? [`Estimate basis: ${data.ftp.estimate_basis}.`] : []), ...data.notes],
    }],
  };
}

export function cyclingTrendsReport(data: CyclingTrends): Report {
  const weeks = data.weekly_breakdown;
  const point = (pick: (week: typeof weeks[number]) => number | null) => weeks.map(week => ({ label: week.week_of, value: pick(week) }));
  return {
    version: 1,
    title: "Cycling trends",
    subtitle: data.period,
    metrics: [
      metric("Rides", data.total_rides, "green"),
      metric("Distance", data.total_km, "blue", "km"),
      metric("Riding time", data.total_hours, "purple", "h"),
      metric("Elevation", data.total_elevation_m, "green", "m"),
      metric("Training stress", data.total_tss, "amber", "TSS"),
      metric("Volume trend", data.volume_trend, "purple"),
    ],
    sections: [{
      id: "overview", label: "Overview", metrics: [],
      charts: [
        chart("weekly-hours", "Weekly riding time", "h", point(week => week.moving_hours), "purple", "bar", "Moving time, including indoor rides."),
        chart("weekly-distance", "Weekly distance", "km", point(week => week.distance_km), "blue", "bar"),
        chart("weekly-tss", "Weekly training stress", "TSS", point(week => week.tss), "amber", "bar"),
        chart("weekly-elevation", "Weekly elevation gain", "m", point(week => week.elevation_m), "green", "bar"),
        chart("weekly-power", "Average power", "W", point(week => week.avg_power_w), "orange", "line", "Moving-time weighted across rides with power."),
        chart("weekly-speed", "Outdoor average speed", "km/h", point(week => week.outdoor_avg_speed_kmh), "blue", "line"),
      ],
      notes: data.notes,
    }],
  };
}

export function cyclingFitnessReport(data: CyclingFitness): Report {
  const days = data.model.daily;
  const load = chart("pmc", "Fitness and fatigue", "TSS/day", [], "blue", "line", "CTL (42-day) and ATL (7-day) exponentially weighted daily TSS. Showing the last 42 days.");
  load.series = [
    { label: "Fitness (CTL)", color: "blue", points: days.map(day => ({ label: day.date, value: day.ctl })) },
    { label: "Fatigue (ATL)", color: "orange", points: days.map(day => ({ label: day.date, value: day.atl })) },
  ];
  const current = data.model.current;
  return {
    version: 1,
    title: "Cycling fitness & form",
    subtitle: `${data.days}-day model · ${data.rides_analyzed} rides`,
    metrics: [
      metric("Fitness (CTL)", current.ctl),
      metric("Fatigue (ATL)", current.atl, "orange"),
      metric("Form (TSB)", current.tsb, "purple", current.form),
      metric("Ramp rate", current.ramp_rate_per_week, "amber", "CTL per week"),
      metric("FTP used", data.ftp_w, "orange", "W"),
    ],
    sections: [{
      id: "overview", label: "Overview", metrics: [],
      charts: [
        load,
        chart("tsb", "Form (TSB)", "TSS/day", days.map(day => ({ label: day.date, value: day.tsb, color: day.tsb < -30 ? "red" : day.tsb < -10 ? "orange" : day.tsb > 25 ? "purple" : "green" })),
          "purple", "bar", "TSB = CTL − ATL. Negative values mean recent load is above long-term load."),
        chart("daily-tss", "Daily training stress", "TSS", days.map(day => ({ label: day.date, value: day.tss })), "amber", "bar"),
      ],
      notes: [
        `TSS sources: ${data.tss_sources.garmin} Garmin, ${data.tss_sources.power} power, ${data.tss_sources.heart_rate} heart rate, ${data.tss_sources.duration_estimate} duration estimate.`,
        ...data.guidance,
      ],
    }],
  };
}

export function cyclingEventReport(data: CyclingEvent): Report {
  const t = data.targets;
  const phases = chart("event-phases", "Target power by phase", "W", [], "orange", "range", "Normalized-power targets; average power will be lower on variable courses.");
  phases.series = [{
    label: "Target band", color: "orange",
    points: data.pacing_phases.map(phase => ({ label: `${phase.phase} (${phase.portion})`, low: phase.target_low_w, value: phase.target_high_w })),
  }];
  const fueling = chart("event-fueling", "Hourly fueling targets", "per hour", [], "green", "range", "Personalise with your gut tolerance and sweat rate.");
  fueling.series = [{
    label: "Range", color: "green",
    points: [
      { label: "Carbohydrate (g)", low: data.fueling.carbs_g_per_hour_low, value: data.fueling.carbs_g_per_hour_high, color: "amber" },
      { label: "Fluid (100 ml)", low: data.fueling.fluid_ml_per_hour_low / 100, value: data.fueling.fluid_ml_per_hour_high / 100, color: "blue" },
      { label: "Sodium (100 mg)", low: data.fueling.sodium_mg_per_hour_low / 100, value: data.fueling.sodium_mg_per_hour_high / 100, color: "purple" },
    ],
  }];
  return {
    version: 1,
    title: `${data.event.distance_km} km ${data.event.type.replaceAll("_", " ")} strategy`,
    subtitle: data.duration.formatted ? `Expected ${data.duration.formatted} (${data.duration.source})` : data.duration.source,
    metrics: [
      metric("FTP", data.ftp.watts, "orange", data.ftp.source.replaceAll("_", " ")),
      metric("Target NP", t.normalized_power_low_w !== null ? `${t.normalized_power_low_w}-${t.normalized_power_high_w}` : null, "orange", "W"),
      metric("Intensity factor", `${t.intensity_factor_low}-${t.intensity_factor_high}`, "amber"),
      metric("Climb ceiling", t.climb_ceiling_w, "red", "W"),
      metric("HR ceiling", t.heart_rate_ceiling_bpm, "red", "bpm"),
      metric("Carbs", `${data.fueling.carbs_g_per_hour_low}-${data.fueling.carbs_g_per_hour_high}`, "green", "g/hour"),
    ],
    sections: [{
      id: "overview", label: "Overview", metrics: [],
      charts: [phases, fueling],
      notes: [t.rationale, ...data.pacing_phases.map(phase => `${phase.phase}: ${phase.guidance}`), ...data.fueling.plan, ...data.tips],
    }],
  };
}

import type { Chart, Point } from "../presentation/model.js";

interface Category {
  key: string;
  label: string;
}

interface ChartPoint {
  element: SVGGElement;
  category: number;
  series: number;
  key: string;
  x: number;
  y: number;
}

interface Domain {
  min: number;
  max: number;
}

const svgNamespace = "http://www.w3.org/2000/svg";
const numberFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
const compactFormat = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
const rangePageSize = 8;
const linePatterns = ["", "7 4", "2 4", "10 3 2 3"];

function html<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attributes: Record<string, string | number> = {},
  text?: string,
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(svgNamespace, tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  if (text !== undefined) node.textContent = text;
  return node;
}

function formatValue(value: number, chart: Chart, exact = false): string {
  if (chart.format === "pace") {
    const seconds = Math.round(Math.abs(value));
    return `${value < 0 ? "−" : ""}${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  }
  if (exact) return String(value);
  if (Math.abs(value) >= 10000) return compactFormat.format(value);
  if (value !== 0 && Math.abs(value) < 0.01) return value.toPrecision(2);
  return numberFormat.format(value);
}

function unitLabel(chart: Chart): string {
  return chart.format === "pace" ? "min/km" : chart.unit;
}

function valueWithUnit(value: number | null | undefined, chart: Chart, exact = false): string {
  if (value == null) return "Unavailable";
  return `${formatValue(value, chart, exact)}${unitLabel(chart) ? ` ${unitLabel(chart)}` : ""}`;
}

function plottable(point: Point | undefined, chart: Chart): point is Point & { value: number } {
  return point?.value != null && (chart.kind !== "range" || (point.low != null && point.low <= point.value));
}

function pointValue(point: Point | undefined, chart: Chart): string {
  if (chart.kind !== "range") return valueWithUnit(point?.value, chart, true);
  if (!plottable(point, chart) || point.low == null) {
    return `Unavailable range (lower: ${valueWithUnit(point?.low, chart, true)}; upper: ${valueWithUnit(point?.value, chart, true)})`;
  }
  return `${formatValue(point.low, chart, true)}–${valueWithUnit(point.value, chart, true)}${point.low === point.value ? " · single boundary" : ""}`;
}

function shortLabel(label: string, length: number): string {
  return label.length > length ? `${label.slice(0, length - 1)}…` : label;
}

function tickIndices(length: number, count: number): number[] {
  if (!length) return [];
  if (length <= count) return Array.from({ length }, (_, index) => index);
  return [...new Set(Array.from({ length: Math.max(2, count) }, (_, index) => Math.round(index * (length - 1) / (Math.max(2, count) - 1))))];
}

function domainFor(chart: Chart, points: Map<string, Point>[], visible: Set<number>): Domain | null {
  let min = Infinity;
  let max = -Infinity;
  for (const seriesIndex of visible) {
    for (const point of points[seriesIndex].values()) {
      if (!plottable(point, chart)) continue;
      min = Math.min(min, point.value, chart.kind === "range" ? point.low ?? point.value : point.value);
      max = Math.max(max, point.value);
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  if (chart.kind === "bar") {
    min = Math.min(0, min);
    max = Math.max(0, max);
  }
  const padding = (max - min || Math.abs(max) || 1) * 0.1;
  if (chart.kind === "bar") {
    if (min < 0) min -= padding;
    if (max > 0) max += padding;
    if (min === max) max += 1;
  } else {
    min -= padding;
    max += padding;
  }
  return { min, max };
}

function axisFor(domain: Domain, chart: Chart, target: number): Domain & { step: number } {
  const interval = (domain.max - domain.min) / target;
  const magnitude = 10 ** Math.floor(Math.log10(interval));
  const multiplier = [1, 2, 2.5, 5, 10].find(value => value >= interval / magnitude) ?? 10;
  const step = chart.format === "pace" && interval <= 600
    ? [1, 5, 10, 15, 30, 60, 120, 300, 600].find(value => value >= interval) ?? 600
    : multiplier * magnitude;
  return { min: Math.floor(domain.min / step) * step, max: Math.ceil(domain.max / step) * step, step };
}

function categoriesFor(chart: Chart): { categories: Category[]; points: Map<string, Point>[] } {
  const categories: Category[] = [];
  const known = new Set<string>();
  const points = chart.series.map(series => {
    const occurrences = new Map<string, number>();
    const values = new Map<string, Point>();
    for (const point of series.points) {
      const occurrence = occurrences.get(point.label) ?? 0;
      occurrences.set(point.label, occurrence + 1);
      const key = `${occurrence}:${point.label}`;
      values.set(key, point);
      if (!known.has(key)) {
        categories.push({ key, label: point.label });
        known.add(key);
      }
    }
    return values;
  });
  // Date categories from separate series must align even when readings are absent.
  if (categories.every(category => /^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(category.label))) {
    categories.sort((left, right) => left.label.localeCompare(right.label));
  }
  return { categories, points };
}

function dataTable(chart: Chart, categories: Category[], points: Map<string, Point>[]): HTMLDetailsElement {
  const details = html("details", "chart-data");
  details.append(html("summary", "", `View data table · ${categories.length} ${categories.length === 1 ? "category" : "categories"}`));
  if (!categories.length || !chart.series.length) {
    details.append(html("p", "empty-message", "No underlying chart readings were supplied."));
    return details;
  }
  const scroll = html("div", "table-scroll");
  scroll.tabIndex = 0;
  scroll.setAttribute("role", "region");
  scroll.setAttribute("aria-label", `${chart.title} data table, scrollable`);
  const table = html("table", "");
  table.append(html("caption", "", `${chart.title}. All series, including hidden series. ${chart.format === "pace" ? "Pace is minutes:seconds per kilometre; lower is faster. Exact source seconds are also included." : "Missing readings are unavailable, not zero."}`));
  const head = html("thead", "");
  const headings = html("tr", "");
  const columns = chart.kind === "range" ? ["Category", "Series", `Lower (${unitLabel(chart)})`, `Upper (${unitLabel(chart)})`] : ["Category", "Series", unitLabel(chart) || "Value"];
  if (chart.format === "pace") columns.push("Source (seconds/km)");
  for (const column of columns) {
    const th = html("th", "", column);
    th.scope = "col";
    headings.append(th);
  }
  head.append(headings);
  const body = html("tbody", "");
  for (const category of categories) {
    for (const [index, series] of chart.series.entries()) {
      const point = points[index].get(category.key);
      const row = html("tr", "");
      const label = html("th", "", category.label);
      label.scope = "row";
      row.append(label, html("td", "", series.label));
      if (chart.kind === "range") row.append(html("td", "", point?.low == null ? "Unavailable" : formatValue(point.low, chart, true)));
      row.append(html("td", "", point?.value == null ? "Unavailable" : formatValue(point.value, chart, true)));
      if (chart.format === "pace") {
        row.append(html("td", "", chart.kind === "range"
          ? `${point?.low ?? "Unavailable"}–${point?.value ?? "Unavailable"}`
          : String(point?.value ?? "Unavailable")));
      }
      body.append(row);
    }
  }
  table.append(head, body);
  scroll.append(table);
  details.append(scroll);
  return details;
}

export function createChart(chart: Chart, id: string): { element: HTMLElement; dispose: () => void } {
  const { categories, points } = categoriesFor(chart);
  const visible = new Set(chart.series.map((_, index) => index));
  const card = html("article", `chart-card chart-${chart.kind}`);
  if (categories.length > 24 || chart.series.length > 1) card.classList.add("chart-wide");
  card.dataset.chartId = chart.id;
  card.setAttribute("aria-labelledby", `${id}-title`);
  const header = html("header", "chart-header");
  const title = html("h3", "", chart.title);
  title.id = `${id}-title`;
  header.append(title, html("span", "unit-badge", unitLabel(chart) || "Values"));
  card.append(header);
  if (chart.description) card.append(html("p", "chart-description", chart.description));
  if (chart.format === "pace") card.append(html("p", "pace-hint", "Pace · minutes:seconds per kilometre · lower is faster"));
  const legend = html("div", "chart-legend");
  legend.setAttribute("role", "group");
  legend.setAttribute("aria-label", `${chart.title} series visibility`);
  const seriesButtons: HTMLButtonElement[] = [];
  for (const [index, series] of chart.series.entries()) {
    const button = html("button", "series-toggle");
    button.type = "button";
    button.dataset.color = series.color;
    button.dataset.seriesIndex = String(index);
    button.setAttribute("aria-pressed", "true");
    button.setAttribute("aria-label", `${series.label}, show in chart`);
    const swatch = html("span", `series-swatch pattern-${index % linePatterns.length}`);
    swatch.setAttribute("aria-hidden", "true");
    button.append(swatch, html("span", "series-label", series.label), html("span", "series-state", "Shown"));
    button.addEventListener("click", () => {
      if (visible.has(index)) visible.delete(index);
      else visible.add(index);
      button.setAttribute("aria-pressed", String(visible.has(index)));
      const state = button.querySelector(".series-state");
      if (state) state.textContent = visible.has(index) ? "Shown" : "Hidden";
      selectedKey = undefined;
      draw();
    });
    seriesButtons.push(button);
    legend.append(button);
  }
  if (chart.series.length > 1) card.append(legend);
  const viewport = html("div", "chart-viewport");
  viewport.id = `${id}-plot`;
  for (const button of seriesButtons) button.setAttribute("aria-controls", viewport.id);
  const detail = html("div", "point-details");
  detail.id = `${id}-details`;
  detail.setAttribute("role", "status");
  detail.setAttribute("aria-live", "polite");
  detail.setAttribute("aria-atomic", "true");
  const guidance = html("p", "chart-guidance", "Hover or tap the plot to inspect readings. Tab to a point, then use arrow keys; Home / End jump to the first / last point.");
  guidance.id = `${id}-guidance`;
  const pagination = html("div", "chart-pagination");
  const previous = html("button", "page-button", "← Previous");
  previous.type = "button";
  previous.setAttribute("aria-label", "Previous range categories");
  const next = html("button", "page-button", "Next →");
  next.type = "button";
  next.setAttribute("aria-label", "Next range categories");
  const pageLabel = html("span", "page-label");
  pageLabel.setAttribute("role", "status");
  let page = 0;
  let selectedKey: string | undefined;
  let width = 620;
  let disposed = false;
  previous.addEventListener("click", () => {
    page = Math.max(0, page - 1);
    selectedKey = undefined;
    draw();
  });
  next.addEventListener("click", () => {
    page = Math.min(Math.ceil(categories.length / rangePageSize) - 1, page + 1);
    selectedKey = undefined;
    draw();
  });
  pagination.append(previous, pageLabel, next);
  card.append(viewport, pagination, detail, guidance, dataTable(chart, categories, points));

  function resetDetails(message = "Select a reading to see its full label and value."): void {
    detail.replaceChildren(html("span", "point-detail-heading", "Explore the data"), html("span", "point-detail-hint", message));
  }

  function draw(): void {
    if (disposed) return;
    const active = document.activeElement;
    const focusKey = active instanceof Element && viewport.contains(active) ? active.getAttribute("data-point-key") : null;
    viewport.replaceChildren();
    pagination.hidden = chart.kind !== "range" || categories.length <= rangePageSize;
    detail.hidden = false;
    guidance.hidden = false;
    resetDetails();
    const seriesIndices = [...visible].sort((a, b) => a - b);
    const extent = domainFor(chart, points, visible);
    if (!categories.length || !seriesIndices.length || !extent) {
      const message = !seriesIndices.length && chart.series.length
        ? "All series are hidden. Choose a series above to show its readings."
        : "No recorded values are available for this chart. Missing readings have not been replaced with zero.";
      viewport.append(html("div", "chart-empty", message));
      detail.hidden = true;
      guidance.hidden = true;
      pagination.hidden = true;
      return;
    }
    const domain = axisFor(extent, chart, width < 400 ? 4 : 5);
    if (!Number.isFinite(domain.max - domain.min) || domain.max <= domain.min || !Number.isFinite(domain.step) || domain.step <= 0) {
      viewport.append(html("div", "chart-empty", "These values are outside the chart’s supported numeric scale. Open the data table for the exact readings."));
      detail.hidden = true;
      guidance.hidden = true;
      pagination.hidden = true;
      return;
    }

    const start = chart.kind === "range" ? page * rangePageSize : 0;
    const displayed = chart.kind === "range" ? categories.slice(start, start + rangePageSize) : categories;
    previous.disabled = page === 0;
    next.disabled = start + rangePageSize >= categories.length;
    pageLabel.textContent = `${start + 1}–${start + displayed.length} of ${categories.length}`;
    const hasMissing = displayed.some(category => seriesIndices.some(index => !plottable(points[index].get(category.key), chart)));
    const left = chart.kind === "range" ? Math.min(150, width * 0.32) : 60;
    const right = 20;
    const top = 20;
    const plotWidth = width - left - right;
    const plotHeight = chart.kind === "range" ? Math.max(90, displayed.length * 44) : width < 450 ? 184 : 222;
    const bottom = top + plotHeight;
    const height = bottom + (chart.kind !== "range" && hasMissing ? 66 : 48);
    const graph = svg("svg", {
      viewBox: `0 0 ${width} ${height}`,
      role: "group",
      "aria-labelledby": `${id}-svg-title`,
      "aria-describedby": `${id}-svg-description ${id}-guidance`,
      class: "chart-svg",
    });
    graph.append(
      svg("title", { id: `${id}-svg-title` }, `${chart.title} (${unitLabel(chart) || "values"})`),
      svg("desc", { id: `${id}-svg-description` }, `${chart.kind} chart. ${categories.length} categories. ${chart.format === "pace" ? "Lower pace is faster. " : ""}Missing readings are not zero. Full labels, units and exact values are in the data table.`),
    );
    const scale = (value: number): number => (value - domain.min) / (domain.max - domain.min);
    const y = (value: number): number => top + (1 - scale(value)) * plotHeight;
    const x = (value: number): number => left + scale(value) * plotWidth;
    const categoryX = (index: number): number => left + (index + 0.5) * plotWidth / displayed.length;
    const categoryY = (index: number): number => top + (index + 0.5) * plotHeight / displayed.length;
    const ticks = Math.round((domain.max - domain.min) / domain.step);
    for (let index = 0; index <= ticks; index++) {
      const tick = domain.min + domain.step * index;
      const value = Math.abs(tick) < domain.step / 10000 ? 0 : Number(tick.toPrecision(12));
      if (chart.kind === "range") {
        graph.append(svg("line", { x1: x(value), x2: x(value), y1: top, y2: bottom, class: "grid-line" }));
        graph.append(svg("text", { x: x(value), y: bottom + 25, "text-anchor": "middle", class: "axis-label" }, formatValue(value, chart)));
      } else {
        graph.append(svg("line", { x1: left, x2: width - right, y1: y(value), y2: y(value), class: "grid-line" }));
        graph.append(svg("text", { x: left - 10, y: y(value) + 4, "text-anchor": "end", class: "axis-label" }, formatValue(value, chart)));
      }
    }
    if (chart.kind !== "range" && domain.min <= 0 && domain.max >= 0) {
      graph.append(svg("line", { x1: left, x2: width - right, y1: y(0), y2: y(0), class: "zero-line" }));
    }
    if (chart.kind === "range") {
      for (const [index, category] of displayed.entries()) {
        const label = svg("text", { x: left - 12, y: categoryY(index) + 4, "text-anchor": "end", class: "axis-label category-label" }, shortLabel(category.label, width < 450 ? 12 : 21));
        label.append(svg("title", {}, category.label));
        graph.append(label);
      }
    } else {
      if (hasMissing) graph.append(svg("line", { x1: left, x2: width - right, y1: bottom + 15, y2: bottom + 15, class: "missing-track" }));
      const tickCount = Math.max(2, Math.floor(plotWidth / 105));
      for (const index of tickIndices(displayed.length, tickCount)) {
        const label = displayed[index].label;
        const shortened = shortLabel(label, width < 450 ? 12 : 18);
        const halfLabelWidth = shortened.length * 2.9;
        const tick = svg("text", {
          x: Math.min(width - right - halfLabelWidth, Math.max(left + halfLabelWidth, categoryX(index))),
          y: bottom + (hasMissing ? 42 : 26),
          "text-anchor": "middle",
          class: "axis-label category-label",
        }, shortened);
        tick.append(svg("title", {}, label));
        graph.append(tick);
      }
      if (hasMissing) graph.append(svg("text", { x: left, y: height - 5, class: "missing-label" }, "× Unavailable (not zero)"));
    }

    if (chart.kind === "line") {
      for (const seriesIndex of seriesIndices) {
        const series = chart.series[seriesIndex];
        let segment = "";
        let penDown = false;
        for (const [index, category] of displayed.entries()) {
          const point = points[seriesIndex].get(category.key);
          if (!plottable(point, chart)) {
            penDown = false;
            continue;
          }
          segment += `${penDown ? " L" : " M"}${categoryX(index)},${y(point.value)}`;
          penDown = true;
        }
        graph.append(svg("path", {
          d: segment,
          class: "series-line",
          "data-color": series.color,
          "stroke-dasharray": linePatterns[seriesIndex % linePatterns.length],
          "aria-hidden": "true",
        }));
      }
    }

    const rendered: ChartPoint[] = [];
    let selectedElement: SVGGElement | undefined;
    function select(record: ChartPoint): void {
      selectedKey = record.key;
      if (selectedElement) {
        selectedElement.removeAttribute("data-selected");
        selectedElement.setAttribute("tabindex", "-1");
      }
      selectedElement = record.element;
      record.element.dataset.selected = "true";
      record.element.setAttribute("tabindex", "0");
      const category = categories[record.category];
      const values = html("div", "point-detail-values");
      for (const seriesIndex of seriesIndices) {
        const row = html("span", "point-detail-value");
        row.dataset.color = points[seriesIndex].get(category.key)?.color ?? chart.series[seriesIndex].color;
        row.append(html("strong", "", `${chart.series[seriesIndex].label}: `), document.createTextNode(pointValue(points[seriesIndex].get(category.key), chart)));
        values.append(row);
      }
      detail.replaceChildren(html("span", "point-detail-heading", category.label), values);
    }
    for (const [categoryIndex, category] of displayed.entries()) {
      for (const [visibleIndex, seriesIndex] of seriesIndices.entries()) {
        const point = points[seriesIndex].get(category.key);
        const series = chart.series[seriesIndex];
        const valid = plottable(point, chart);
        const pointKey = `${seriesIndex}/${category.key}`;
        const group = svg("g", {
          class: `chart-point${valid ? "" : " unavailable-point"}`,
          tabindex: "-1",
          role: "img",
          "aria-label": `${category.label}. ${series.label}: ${pointValue(point, chart)}`,
          "data-point-key": pointKey,
          "data-color": point?.color ?? series.color,
          "data-value": point?.value ?? "unavailable",
        });
        group.append(svg("title", {}, `${category.label} · ${series.label}: ${pointValue(point, chart)}`));
        const slotWidth = plotWidth / displayed.length;
        const barWidth = Math.min(38, slotWidth * 0.7 / seriesIndices.length);
        let pointX = categoryX(categoryIndex);
        let pointY = valid ? y(point.value) : bottom + 15;
        if (chart.kind === "range") {
          const rowHeight = Math.min(24, plotHeight / displayed.length * 0.65 / seriesIndices.length);
          pointY = categoryY(categoryIndex) + (visibleIndex - (seriesIndices.length - 1) / 2) * rowHeight;
          if (valid && point.low != null) {
            const from = x(point.low);
            const to = x(point.value);
            pointX = (from + to) / 2;
            group.append(svg("rect", { x: from, y: pointY - rowHeight * 0.36, width: Math.max(0, to - from), height: rowHeight * 0.72, rx: 4, class: "range-mark" }));
            for (const boundary of new Set([from, to])) group.append(svg("line", { x1: boundary, x2: boundary, y1: pointY - rowHeight / 2, y2: pointY + rowHeight / 2, class: "range-boundary" }));
            group.append(svg("rect", { x: from - 7, y: pointY - rowHeight / 2 - 4, width: Math.max(14, to - from + 14), height: rowHeight + 8, class: "hit-area" }));
          } else {
            pointX = left + plotWidth / 2;
            group.append(svg("text", { x: pointX, y: pointY + 4, "text-anchor": "middle", class: "missing-value" }, "Unavailable"));
          }
        } else if (chart.kind === "bar") {
          pointX += (visibleIndex - (seriesIndices.length - 1) / 2) * barWidth;
          if (valid) {
            const zero = y(0);
            if (point.value === 0) {
              group.append(svg("line", { x1: pointX - barWidth * 0.42, x2: pointX + barWidth * 0.42, y1: zero, y2: zero, class: "zero-value" }));
            } else {
              group.append(svg("rect", { x: pointX - barWidth * 0.42, y: Math.min(zero, pointY), width: Math.max(0.75, barWidth * 0.84), height: Math.abs(zero - pointY), rx: Math.min(4, barWidth / 4), class: "bar-mark" }));
            }
            group.append(svg("rect", { x: pointX - Math.max(5, barWidth / 2), y: Math.min(zero, pointY) - 5, width: Math.max(10, barWidth), height: Math.max(10, Math.abs(zero - pointY) + 10), class: "hit-area" }));
          }
        }
        if (chart.kind !== "range") {
          if (valid && chart.kind === "line") {
            group.append(svg("circle", { cx: pointX, cy: pointY, r: displayed.length > 70 ? 2.5 : 3.5, class: "point-mark" }));
          } else if (!valid) {
            group.append(svg("path", { d: `M${pointX - 3},${pointY - 3}l6,6m-6,0l6,-6`, class: "missing-mark" }));
          }
          group.append(svg("circle", { cx: pointX, cy: pointY, r: 10, class: "hit-area" }));
        }
        group.append(svg("circle", { cx: pointX, cy: pointY, r: 7, class: "selection-ring" }));
        const record: ChartPoint = { element: group, category: start + categoryIndex, series: seriesIndex, key: pointKey, x: pointX, y: pointY };
        rendered.push(record);
        group.addEventListener("focus", () => select(record));
        group.addEventListener("pointerenter", () => select(record));
        group.addEventListener("click", () => select(record));
        group.addEventListener("keydown", (event) => {
          const currentIndex = rendered.indexOf(record);
          let target: ChartPoint | undefined;
          if (event.key === "Home") target = rendered[0];
          else if (event.key === "End") target = rendered[rendered.length - 1];
          else if (event.key === "ArrowLeft" || event.key === "ArrowUp") target = rendered[(currentIndex - 1 + rendered.length) % rendered.length];
          else if (event.key === "ArrowRight" || event.key === "ArrowDown") target = rendered[(currentIndex + 1) % rendered.length];
          else return;
          event.preventDefault();
          target?.element.focus();
        });
        graph.append(group);
      }
    }
    graph.addEventListener("pointermove", (event) => {
      const rect = graph.getBoundingClientRect();
      const px = (event.clientX - rect.left) * width / rect.width;
      const py = (event.clientY - rect.top) * height / rect.height;
      if (px < left || px > width - right || py < top || py > bottom + 20) return;
      const index = chart.kind === "range"
        ? Math.min(displayed.length - 1, Math.max(0, Math.floor((py - top) * displayed.length / plotHeight)))
        : Math.min(displayed.length - 1, Math.max(0, Math.floor((px - left) * displayed.length / plotWidth)));
      const candidates = rendered.filter(record => record.category === start + index);
      const nearest = candidates.reduce<ChartPoint | undefined>((best, point) => !best || Math.abs(point.y - py) < Math.abs(best.y - py) ? point : best, undefined);
      if (nearest && nearest.key !== selectedKey) select(nearest);
    });
    viewport.append(graph);
    const selection = rendered.find(record => record.key === selectedKey);
    if (selection) select(selection);
    else if (rendered[0]) {
      selectedElement = rendered[0].element;
      selectedElement.setAttribute("tabindex", "0");
    }
    if (focusKey) rendered.find(record => record.key === focusKey)?.element.focus();
  }

  draw();
  const observer = new ResizeObserver((entries) => {
    const measured = entries[0]?.contentRect.width;
    if (measured && measured >= 200 && Math.abs(measured - width) > 1) {
      width = Math.round(measured);
      draw();
    }
  });
  observer.observe(viewport);
  return { element: card, dispose: () => { disposed = true; observer.disconnect(); } };
}

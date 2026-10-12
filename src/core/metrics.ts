/**
 * Dependency-free metrics with Prometheus text exposition.
 *
 * `partial_responses_total` over `tool_calls_total` is the headline health metric:
 * when it climbs, Parliament is degrading and briefings are getting thinner —
 * visible before anyone complains.
 */
type Labels = Record<string, string>;

const counters = new Map<string, number>();
const histograms = new Map<string, number[]>();
const gauges = new Map<string, number>();

const BUCKETS = [50, 100, 250, 500, 1000, 2500, 5000, 10_000, 15_000, 30_000];

const keyOf = (name: string, labels: Labels = {}): string => {
  const parts = Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}="${String(v).replace(/"/g, '')}"`);
  return parts.length ? `${name}{${parts.join(',')}}` : name;
};

export const counter = (name: string, labels: Labels = {}, by = 1): void => {
  const k = keyOf(name, labels);
  counters.set(k, (counters.get(k) ?? 0) + by);
};

export const gauge = (name: string, value: number, labels: Labels = {}): void => {
  gauges.set(keyOf(name, labels), value);
};

export const observe = (name: string, ms: number, labels: Labels = {}): void => {
  const k = keyOf(name, labels);
  const arr = histograms.get(k) ?? [];
  arr.push(ms);
  // Bound memory; metrics are a signal, not an audit log.
  if (arr.length > 4096) arr.shift();
  histograms.set(k, arr);
};

export function renderPrometheus(): string {
  const lines: string[] = [];
  for (const [k, v] of counters) lines.push(`${k} ${v}`);
  for (const [k, v] of gauges) lines.push(`${k} ${v}`);
  for (const [k, values] of histograms) {
    const base = k.includes('{') ? k.slice(0, k.indexOf('{')) : k;
    const labelPart = k.includes('{') ? k.slice(k.indexOf('{') + 1, -1) : '';
    const sorted = [...values].sort((a, b) => a - b);
    for (const b of BUCKETS) {
      const n = sorted.filter((x) => x <= b).length;
      const l = [labelPart, `le="${b}"`].filter(Boolean).join(',');
      lines.push(`${base}_bucket{${l}} ${n}`);
    }
    const lInf = [labelPart, 'le="+Inf"'].filter(Boolean).join(',');
    lines.push(`${base}_bucket{${lInf}} ${sorted.length}`);
    lines.push(`${base}_sum${labelPart ? `{${labelPart}}` : ''} ${sorted.reduce((a, b) => a + b, 0)}`);
    lines.push(`${base}_count${labelPart ? `{${labelPart}}` : ''} ${sorted.length}`);
  }
  return `${lines.join('\n')}\n`;
}

/** Test-only. */
export function __resetMetrics(): void {
  counters.clear();
  histograms.clear();
  gauges.clear();
}

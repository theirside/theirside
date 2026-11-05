export function pct(x: number | null | undefined): string {
  if (x === null || x === undefined) return '–';
  const p = x * 100;
  if (p === 0) return '0%';
  if (p < 1) return `${p.toFixed(1)}%`;
  return `${Math.round(p)}%`;
}

export function ms(x: number | null | undefined): string {
  if (x === null || x === undefined) return '–';
  return x >= 1000 ? `${(x / 1000).toFixed(1)} s` : `${Math.round(x)} ms`;
}

export function num(x: number): string {
  return x >= 100 ? Math.round(x).toLocaleString() : String(Math.round(x * 10) / 10);
}

export function ago(iso: string | null): string {
  if (!iso) return '–';
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

export function when(iso: string | null): string {
  if (!iso) return '–';
  const d = new Date(iso);
  return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)} UTC`;
}

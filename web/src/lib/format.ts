export function fmtTime(totalSec: number | null): string {
  if (totalSec === null || !Number.isFinite(totalSec)) return "—:—";
  const s = Math.max(0, Math.floor(totalSec));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

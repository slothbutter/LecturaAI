/**
 * 초 단위 시간을 mm:ss 문자열로 변환한다.
 * 1시간 이상(또는 forceHours=true)이면 h:mm:ss 형식을 사용한다.
 * 잘못된 값(NaN, undefined 등)은 0초로 취급해 UI가 깨지지 않게 한다.
 */
export function formatTime(
  totalSec: number | null | undefined,
  forceHours = false,
): string {
  const safe =
    typeof totalSec === "number" && Number.isFinite(totalSec)
      ? Math.max(0, Math.floor(totalSec))
      : 0;

  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  const s = safe % 60;
  const pad = (n: number) => String(n).padStart(2, "0");

  if (h > 0 || forceHours) {
    return `${h}:${pad(m)}:${pad(s)}`;
  }
  return `${pad(m)}:${pad(s)}`;
}

/** "mm:ss ~ mm:ss" 형태의 구간 문자열 */
export function formatTimeRange(
  startSec: number | null | undefined,
  endSec: number | null | undefined,
  forceHours = false,
): string {
  return `${formatTime(startSec, forceHours)} ~ ${formatTime(endSec, forceHours)}`;
}

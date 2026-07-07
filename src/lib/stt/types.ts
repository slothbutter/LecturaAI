import type { TranscriptSegment } from "@/lib/schemas";

/** STT 결과 공통 형식 */
export interface SttResult {
  language: string | null;
  segments: TranscriptSegment[];
  fullText: string;
}

/** STT 제공자 공통 인터페이스 */
export interface SttProvider {
  name: string;
  transcribe(audioPath: string): Promise<SttResult>;
}

/** 재시도 대상 HTTP 상태 코드 (레이트리밋 + 서버 오류) */
function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * STT API 호출 공통 fetch 래퍼.
 * - 네트워크 오류 / 5xx / 429 에 한해 재시도 (기본 1회, 지수 backoff)
 * - HTTP 에러 시 응답 본문 일부를 포함한 에러 throw (요청 헤더/키는 절대 포함하지 않음)
 * - 성공 시 Response 그대로 반환
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  options?: { retries?: number; baseDelayMs?: number; label?: string },
): Promise<Response> {
  const retries = options?.retries ?? 1;
  const baseDelayMs = options?.baseDelayMs ?? 1000;
  const label = options?.label ?? "STT";

  let attempt = 0;
  while (true) {
    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (err) {
      // 네트워크 계층 오류 → 재시도 대상
      if (attempt < retries) {
        await sleep(baseDelayMs * 2 ** attempt);
        attempt += 1;
        continue;
      }
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`${label} 요청 중 네트워크 오류가 발생했습니다: ${message}`);
    }

    if (res.ok) {
      return res;
    }

    const bodySnippet = (await res.text().catch(() => "")).slice(0, 300);

    if (attempt < retries && isRetryableStatus(res.status)) {
      await sleep(baseDelayMs * 2 ** attempt);
      attempt += 1;
      continue;
    }

    throw new Error(
      `${label} API 오류 (HTTP ${res.status})${bodySnippet ? `: ${bodySnippet}` : ""}`,
    );
  }
}

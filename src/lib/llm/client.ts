import { z } from "zod";
import { env } from "@/lib/env";

/**
 * OpenAI 호환 /chat/completions 엔드포인트를 fetch 로 직접 호출해
 * JSON 응답을 Zod 스키마로 검증하여 반환하는 저수준 클라이언트.
 *
 * - SDK 미사용, fetch 만 사용
 * - AbortController 기반 타임아웃 (기본 180초)
 * - 지수 backoff 재시도 (1s → 2s → 4s ...)
 * - 재시도 대상: 네트워크 오류, 408/429/5xx, JSON.parse 실패, Zod 검증 실패
 *   (파싱/검증 실패 사유는 다음 시도의 user 메시지에 덧붙여 self-correction 유도)
 */

export interface ChatJsonOptions<T> {
  system: string;
  user: string;
  schema: z.ZodType<T>;
  maxRetries?: number;
  timeoutMs?: number;
}

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_TIMEOUT_MS = 180_000;
const BASE_BACKOFF_MS = 1_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 재시도해도 의미 없는(비일시적) API 오류 */
class NonRetryableError extends Error {}

/**
 * LLM 응답 텍스트에서 JSON 본문을 최대한 방어적으로 추출한다.
 * 1) ```json ... ``` / ``` ... ``` 코드펜스 제거
 * 2) 앞뒤 잡음 제거: 첫 '{' 부터 마지막 '}' 까지만 사용
 */
export function extractJsonText(content: string): string {
  let text = content.trim();

  // 코드펜스 제거 (```json ... ``` 또는 ``` ... ```)
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch && fenceMatch[1]) {
    text = fenceMatch[1].trim();
  } else {
    // 닫는 펜스가 잘려나간 경우 등: 여는 펜스만 제거
    text = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  }

  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) {
    throw new Error("응답에서 JSON 객체({ ... })를 찾을 수 없습니다.");
  }
  return text.slice(first, last + 1);
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: { content?: string | null };
  }>;
}

/** 한 번의 API 호출을 수행해 assistant content 문자열을 반환 */
async function requestChatCompletion(
  system: string,
  user: string,
  timeoutMs: number,
): Promise<string> {
  const url = `${env.LLM_BASE_URL.replace(/\/+$/, "")}/chat/completions`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const timeoutError = () =>
    new Error(
      `LLM 요청이 ${Math.round(timeoutMs / 1000)}초 안에 완료되지 않아 중단되었습니다.`,
    );

  // 타이머 해제는 본문 소비까지 끝난 뒤(함수 종료 시점) — 본문 읽기도 타임아웃 커버
  try {
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${env.LLM_API_KEY}`,
        },
        body: JSON.stringify({
          model: env.LLM_MODEL,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          response_format: { type: "json_object" },
          temperature: 0.2,
        }),
        signal: controller.signal,
      });
    } catch (err) {
      // 네트워크 오류 / 타임아웃(abort) — 재시도 대상
      if (err instanceof Error && err.name === "AbortError") {
        throw timeoutError();
      }
      throw err instanceof Error ? err : new Error(String(err));
    }

    if (!res.ok) {
      let detail = "";
      try {
        detail = (await res.text()).slice(0, 500);
      } catch {
        // 본문을 읽지 못해도(타임아웃 포함) 상태 코드만으로 처리
      }
      const message = `LLM API 오류 (HTTP ${res.status})${detail ? `: ${detail}` : ""}`;
      // 408(타임아웃), 429(rate limit), 5xx 만 재시도 대상
      if (res.status === 408 || res.status === 429 || res.status >= 500) {
        throw new Error(message);
      }
      throw new NonRetryableError(message);
    }

    let payload: ChatCompletionResponse;
    try {
      payload = (await res.json()) as ChatCompletionResponse;
    } catch (err) {
      // 본문 읽기 중 타임아웃(abort)도 여기로 들어온다
      if (err instanceof Error && err.name === "AbortError") {
        throw timeoutError();
      }
      throw new Error("LLM API 응답 본문이 유효한 JSON 이 아닙니다.");
    }

    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.length === 0) {
      throw new Error("LLM API 응답에 message.content 가 없습니다.");
    }
    return content;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * OpenAI 호환 chat completions 를 호출해 JSON 을 Zod 스키마로 검증하여 반환한다.
 * 모든 재시도가 소진되면 마지막 원인을 포함해 throw 한다.
 */
export async function chatJson<T>(opts: ChatJsonOptions<T>): Promise<T> {
  const { system, schema } = opts;
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  if (!env.LLM_API_KEY) {
    throw new Error(
      "LLM API 키가 설정되지 않았습니다. .env 파일에 OPENAI_API_KEY(또는 LLM_API_KEY)를 설정한 뒤 다시 시도하세요.",
    );
  }

  let userMessage = opts.user;
  let lastError: Error | null = null;
  const totalAttempts = maxRetries + 1;

  for (let attempt = 0; attempt < totalAttempts; attempt++) {
    if (attempt > 0) {
      await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1)); // 1s → 2s → 4s ...
    }

    let failureReason: string | null = null;
    try {
      const content = await requestChatCompletion(system, userMessage, timeoutMs);

      let parsed: unknown;
      try {
        parsed = JSON.parse(extractJsonText(content));
      } catch (err) {
        failureReason = `JSON 파싱 실패: ${err instanceof Error ? err.message : String(err)}`;
        throw new Error(failureReason);
      }

      const validated = schema.safeParse(parsed);
      if (!validated.success) {
        const issues = validated.error.issues
          .slice(0, 10)
          .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("; ");
        failureReason = `스키마 검증 실패: ${issues}`;
        throw new Error(failureReason);
      }

      return validated.data;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      if (error instanceof NonRetryableError) {
        throw error;
      }
      lastError = error;

      // 파싱/검증 실패 시 다음 시도의 user 메시지에 실패 사유를 덧붙여 self-correction 유도
      if (failureReason) {
        userMessage =
          `${opts.user}\n\n[이전 응답 오류]\n` +
          `직전 응답이 다음 이유로 거부되었습니다: ${failureReason}\n` +
          `요구된 JSON 스키마를 정확히 따르는 순수 JSON 객체만 출력하세요. ` +
          `코드펜스, 설명 문장, JSON 외 텍스트를 포함하지 마세요.`;
      }
    }
  }

  throw new Error(
    `LLM JSON 요청이 ${totalAttempts}회 시도 후 실패했습니다. 마지막 원인: ${
      lastError ? lastError.message : "알 수 없음"
    }`,
  );
}

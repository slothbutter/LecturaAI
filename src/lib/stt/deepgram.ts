import { openAsBlob } from "node:fs";
import { env } from "@/lib/env";
import type { TranscriptSegment } from "@/lib/schemas";
import { fetchWithRetry, type SttProvider, type SttResult } from "./types";

const DEEPGRAM_URL =
  "https://api.deepgram.com/v1/listen?model=nova-2&smart_format=true&utterances=true&detect_language=true";

/** words 기반 fallback 문장 병합 시 한 세그먼트 최대 길이 (초) */
const FALLBACK_MAX_SEGMENT_SEC = 15;
/** 문장 종결로 간주할 문자 (smart_format 구두점 기준) */
const SENTENCE_END_RE = /[.!?…。！？]$/;

interface DeepgramWord {
  word?: string;
  punctuated_word?: string;
  start?: number;
  end?: number;
}

interface DeepgramUtterance {
  start?: number;
  end?: number;
  transcript?: string;
}

interface DeepgramResponse {
  results?: {
    utterances?: DeepgramUtterance[];
    channels?: Array<{
      detected_language?: string | null;
      alternatives?: Array<{
        transcript?: string;
        words?: DeepgramWord[];
      }>;
    }>;
  };
}

/**
 * Deepgram (nova-2) 기반 STT 어댑터.
 * SDK 없이 fetch 로 오디오 바이너리를 직접 전송한다.
 */
export class DeepgramProvider implements SttProvider {
  readonly name = "deepgram";

  async transcribe(
    audioPath: string,
    onProgress?: (completed: number, total: number) => void,
  ): Promise<SttResult> {
    if (!env.DEEPGRAM_API_KEY) {
      throw new Error(
        "Deepgram API 키가 설정되지 않았습니다. DEEPGRAM_API_KEY 환경변수를 확인해 주세요.",
      );
    }

    // openAsBlob: 파일 전체를 메모리에 올리지 않고 파일 기반 Blob 으로 전송
    const blob = await openAsBlob(audioPath, { type: "audio/mpeg" });

    const res = await fetchWithRetry(
      DEEPGRAM_URL,
      {
        method: "POST",
        headers: {
          Authorization: `Token ${env.DEEPGRAM_API_KEY}`,
          "Content-Type": "audio/mpeg",
        },
        body: blob,
      },
      { label: "Deepgram" },
    );

    const data = (await res.json()) as DeepgramResponse;
    const channel = data.results?.channels?.[0];
    const alternative = channel?.alternatives?.[0];

    const utterances = data.results?.utterances ?? [];
    let segments: TranscriptSegment[] = utterances
      .map((u) => ({
        start: Number(u.start ?? 0),
        end: Number(u.end ?? 0),
        text: String(u.transcript ?? "").trim(),
      }))
      .filter((seg) => seg.text.length > 0);

    // utterances 가 없으면 words 기반 문장 병합 fallback
    if (segments.length === 0) {
      segments = segmentsFromWords(alternative?.words ?? []);
    }

    const result: SttResult = {
      language: channel?.detected_language ?? null,
      segments,
      fullText: String(alternative?.transcript ?? "").trim(),
    };
    // Deepgram 은 단일 요청 처리 — 완료 시 1/1 보고
    onProgress?.(1, 1);
    return result;
  }
}

/**
 * words[] 를 문장 단위 세그먼트로 병합하는 fallback.
 * - 구두점(., !, ? 등)으로 끝나면 문장 종료
 * - 문장이 너무 길어지면 FALLBACK_MAX_SEGMENT_SEC 기준으로 분리
 */
function segmentsFromWords(words: DeepgramWord[]): TranscriptSegment[] {
  const segments: TranscriptSegment[] = [];
  let buffer: string[] = [];
  let segStart: number | null = null;
  let segEnd = 0;

  const flush = () => {
    const text = buffer.join(" ").trim();
    if (text.length > 0 && segStart !== null) {
      segments.push({ start: segStart, end: segEnd, text });
    }
    buffer = [];
    segStart = null;
  };

  for (const w of words) {
    const text = String(w.punctuated_word ?? w.word ?? "").trim();
    if (text.length === 0) continue;

    const start = Number(w.start ?? 0);
    const end = Number(w.end ?? start);

    if (segStart === null) segStart = start;
    segEnd = end;
    buffer.push(text);

    const sentenceEnded = SENTENCE_END_RE.test(text);
    const tooLong = segEnd - segStart >= FALLBACK_MAX_SEGMENT_SEC;
    if (sentenceEnded || tooLong) flush();
  }
  flush();

  return segments;
}

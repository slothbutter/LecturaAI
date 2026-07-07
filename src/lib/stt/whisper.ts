import { openAsBlob } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { env } from "@/lib/env";
import { removeFiles, splitAudio } from "@/lib/media";
import type { TranscriptSegment } from "@/lib/schemas";
import { fetchWithRetry, type SttProvider, type SttResult } from "./types";

/** OpenAI Whisper 업로드 한도는 25MB — 여유를 두고 24MB 초과 시 분할 */
const MAX_DIRECT_BYTES = 24 * 1024 * 1024;
/** 분할 시 조각 길이 (초) — 48kbps mono mp3 기준 1200초 ≈ 7MB */
const SPLIT_SEGMENT_SEC = 1200;
/** 분할 조각 동시 전사 개수 — 429/5xx 는 fetchWithRetry 가 재시도 (3은 레이트리밋 안전 범위) */
const WHISPER_CONCURRENCY = 3;

// ─── 환각 필터 임계값 (openai/whisper 공식 decode 기본값 준거) ───
/** no_speech_prob 가 이 값을 초과하고 (AND) avg_logprob 도 낮으면 무음 환각으로 판정 */
const NO_SPEECH_PROB_THRESHOLD = 0.6;
/** avg_logprob 가 이 값 미만 — 무음 환각 판정의 AND 조건 (단독으로는 드롭하지 않음) */
const AVG_LOGPROB_THRESHOLD = -1.0;
/** compression_ratio 가 이 값을 초과하면 반복 루프 환각으로 판정 */
const COMPRESSION_RATIO_THRESHOLD = 2.4;
/** trim 후 동일 텍스트가 이 횟수 이상 연속되면 환각 루프로 보고 첫 1개만 유지 */
const REPEAT_COLLAPSE_MIN = 3;

/**
 * 간단한 async pool (세마포어 패턴).
 * - 최대 `concurrency` 개의 worker 가 공유 커서(nextIndex)에서 다음 작업을 가져가 실행
 * - 결과는 **완료 순서가 아니라 입력 인덱스 위치**에 기록되어 순서가 보장된다
 * - 하나라도 실패하면 전체 reject (Promise.all 동작과 동일)
 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  const worker = async (): Promise<void> => {
    while (true) {
      const index = nextIndex;
      if (index >= items.length) return;
      nextIndex += 1;
      results[index] = await fn(items[index], index);
    }
  };

  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

interface WhisperSegment {
  start: number;
  end: number;
  text: string;
  /** 해당 구간이 무음일 확률 (구버전/프록시 응답엔 없을 수 있음 — 없으면 필터 통과) */
  no_speech_prob?: number;
  /** 토큰 평균 로그 확률 (옵셔널 — 없으면 필터 통과) */
  avg_logprob?: number;
  /** 텍스트 gzip 압축비 — 높으면 반복 루프 의심 (옵셔널 — 없으면 필터 통과) */
  compression_ratio?: number;
}

interface WhisperVerboseJson {
  language?: string | null;
  text?: string;
  segments?: WhisperSegment[];
}

/**
 * Whisper 환각(hallucination) 세그먼트 필터.
 * 조각별 응답 파싱 직후(offset 보정 전) 적용한다.
 *
 * 드롭 규칙 (보수적 — 실제 발화를 지우는 것이 환각을 남기는 것보다 나쁘다):
 * 1. trim 후 빈 텍스트
 * 2. no_speech_prob > 0.6 **AND** avg_logprob < -1.0 (무음 환각 — 둘 다 있어야 판정)
 * 3. compression_ratio > 2.4 (반복 루프 환각)
 * 4. trim 후 동일 텍스트 3회 이상 연속 → 첫 1개만 유지
 * 메타데이터 필드가 없는 세그먼트는 규칙 2·3을 통과시킨다.
 */
function filterHallucinatedSegments(segments: readonly WhisperSegment[]): {
  kept: WhisperSegment[];
  dropped: number;
} {
  let dropped = 0;

  // 규칙 1~3: 세그먼트 단위 판정
  const survivors: WhisperSegment[] = [];
  for (const seg of segments) {
    const text = String(seg.text ?? "").trim();
    if (text.length === 0) {
      dropped += 1;
      continue;
    }
    const noSpeechProb =
      typeof seg.no_speech_prob === "number" ? seg.no_speech_prob : null;
    const avgLogprob =
      typeof seg.avg_logprob === "number" ? seg.avg_logprob : null;
    if (
      noSpeechProb !== null &&
      avgLogprob !== null &&
      noSpeechProb > NO_SPEECH_PROB_THRESHOLD &&
      avgLogprob < AVG_LOGPROB_THRESHOLD
    ) {
      dropped += 1;
      continue;
    }
    const compressionRatio =
      typeof seg.compression_ratio === "number" ? seg.compression_ratio : null;
    if (
      compressionRatio !== null &&
      compressionRatio > COMPRESSION_RATIO_THRESHOLD
    ) {
      dropped += 1;
      continue;
    }
    survivors.push(seg);
  }

  // 규칙 4: 동일(trim) 텍스트 연속 런이 REPEAT_COLLAPSE_MIN 이상이면 첫 1개만 유지
  const kept: WhisperSegment[] = [];
  let runStart = 0;
  for (let i = 1; i <= survivors.length; i += 1) {
    const isBoundary =
      i === survivors.length ||
      survivors[i].text.trim() !== survivors[runStart].text.trim();
    if (!isBoundary) continue;
    const runLength = i - runStart;
    if (runLength >= REPEAT_COLLAPSE_MIN) {
      kept.push(survivors[runStart]);
      dropped += runLength - 1;
    } else {
      kept.push(...survivors.slice(runStart, i));
    }
    runStart = i;
  }

  return { kept, dropped };
}

/**
 * OpenAI Whisper (audio/transcriptions) 기반 STT 어댑터.
 * SDK 없이 fetch + multipart FormData 로 호출한다.
 */
export class WhisperProvider implements SttProvider {
  readonly name = "whisper";

  async transcribe(
    audioPath: string,
    onProgress?: (completed: number, total: number) => void,
  ): Promise<SttResult> {
    if (!env.OPENAI_API_KEY) {
      throw new Error(
        "OpenAI API 키가 설정되지 않았습니다. OPENAI_API_KEY 환경변수를 확인해 주세요.",
      );
    }

    const { size } = await stat(audioPath);
    if (size <= MAX_DIRECT_BYTES) {
      const result = await this.transcribeFile(audioPath, 0);
      onProgress?.(1, 1);
      return result;
    }

    // 25MB 제한 초과 → 오디오를 조각으로 분할해 동시 3개 병렬 전사 후 병합
    const parts = await splitAudio(audioPath, SPLIT_SEGMENT_SEC);
    try {
      const total = parts.length;
      // 완료 카운터 — Node 싱글스레드에서 await 이후 동기 증가라 경합 없이 단조 증가
      let completed = 0;
      const results = await mapWithConcurrency(
        parts,
        WHISPER_CONCURRENCY,
        async (part) => {
          const partResult = await this.transcribeFile(
            part.path,
            part.offsetSec,
          );
          completed += 1;
          onProgress?.(completed, total);
          return partResult;
        },
      );
      // results 는 입력(조각) 인덱스 순 — offsetSec 보정된 타임스탬프 순서와 일치
      return mergeResults(results);
    } finally {
      try {
        await removeFiles(parts.map((p) => p.path));
      } catch (err) {
        // 조각 삭제 실패(EPERM 등)가 성공한 전사 결과를 덮어쓰지 않도록 경고만 남긴다
        console.warn("[whisper] 분할 오디오 조각 삭제 실패:", err);
      }
    }
  }

  /** 단일 오디오 파일 전사. offsetSec 만큼 타임스탬프를 보정한다. */
  private async transcribeFile(
    filePath: string,
    offsetSec: number,
  ): Promise<SttResult> {
    const form = new FormData();
    form.append("model", "whisper-1");
    form.append("response_format", "verbose_json");
    form.append("timestamp_granularities[]", "segment");
    // openAsBlob: 파일 전체를 메모리에 올리지 않고 파일 기반 Blob 으로 첨부
    const blob = await openAsBlob(filePath, { type: "audio/mpeg" });
    form.append("file", blob, path.basename(filePath));

    const baseUrl = env.OPENAI_BASE_URL.replace(/\/+$/, "");
    const res = await fetchWithRetry(
      `${baseUrl}/audio/transcriptions`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` },
        body: form,
      },
      { label: "Whisper" },
    );

    const data = (await res.json()) as WhisperVerboseJson;

    // 환각 필터: 파싱 직후(offset 보정 전) 적용
    const rawSegments = data.segments ?? [];
    const { kept, dropped } = filterHallucinatedSegments(rawSegments);
    if (dropped > 0) {
      console.warn(
        `[whisper] 환각 의심 세그먼트 드롭: ${dropped}/${rawSegments.length} (${path.basename(filePath)})`,
      );
    }

    const segments: TranscriptSegment[] = kept.map((seg) => ({
      start: Number(seg.start) + offsetSec,
      end: Number(seg.end) + offsetSec,
      text: String(seg.text ?? "").trim(),
    }));

    // 드롭이 있으면 fullText 도 필터된 세그먼트로 재구성해 환각 텍스트 유입을 차단
    const fullText =
      dropped > 0
        ? segments.map((s) => s.text).join(" ")
        : String(data.text ?? "").trim();

    return {
      language: data.language ?? null,
      segments,
      fullText,
    };
  }
}

/** 조각별 결과 병합 — 타임스탬프는 이미 offset 보정된 상태 */
function mergeResults(results: SttResult[]): SttResult {
  return {
    language: results.find((r) => r.language)?.language ?? null,
    segments: results.flatMap((r) => r.segments),
    fullText: results
      .map((r) => r.fullText)
      .filter((t) => t.length > 0)
      .join(" "),
  };
}

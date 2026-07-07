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

interface WhisperSegment {
  start: number;
  end: number;
  text: string;
}

interface WhisperVerboseJson {
  language?: string | null;
  text?: string;
  segments?: WhisperSegment[];
}

/**
 * OpenAI Whisper (audio/transcriptions) 기반 STT 어댑터.
 * SDK 없이 fetch + multipart FormData 로 호출한다.
 */
export class WhisperProvider implements SttProvider {
  readonly name = "whisper";

  async transcribe(audioPath: string): Promise<SttResult> {
    if (!env.OPENAI_API_KEY) {
      throw new Error(
        "OpenAI API 키가 설정되지 않았습니다. OPENAI_API_KEY 환경변수를 확인해 주세요.",
      );
    }

    const { size } = await stat(audioPath);
    if (size <= MAX_DIRECT_BYTES) {
      return this.transcribeFile(audioPath, 0);
    }

    // 25MB 제한 초과 → 오디오를 조각으로 분할해 순차 처리 후 병합
    const parts = await splitAudio(audioPath, SPLIT_SEGMENT_SEC);
    try {
      const results: SttResult[] = [];
      for (const part of parts) {
        // 순차 처리 (레이트리밋 안전)
        results.push(await this.transcribeFile(part.path, part.offsetSec));
      }
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

    const segments: TranscriptSegment[] = (data.segments ?? [])
      .map((seg) => ({
        start: Number(seg.start) + offsetSec,
        end: Number(seg.end) + offsetSec,
        text: String(seg.text ?? "").trim(),
      }))
      .filter((seg) => seg.text.length > 0);

    return {
      language: data.language ?? null,
      segments,
      fullText: String(data.text ?? "").trim(),
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

import fs from "node:fs/promises";
import { JobStatus, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  beginJobRun,
  completeJob,
  markJobFailed,
  setJobProgress,
  setJobStatus,
} from "@/lib/jobs";
import { extractAudio, extractMetadata } from "@/lib/media";
import { buildAudioPath, ensureDirs, isPathInsideStorage } from "@/lib/storage";
import { getSttProvider } from "@/lib/stt";
import { chunkSegments } from "@/lib/chunking";
import { generateSummary } from "@/lib/llm/summarize";
import {
  SummaryResultSchema,
  TranscriptSegmentsSchema,
  type TranscriptSegment,
} from "@/lib/schemas";

/**
 * 처리 파이프라인 상태 기계.
 *
 * UPLOADED → EXTRACTING_METADATA → EXTRACTING_AUDIO → TRANSCRIBING
 *   → CHUNKING → SUMMARIZING → GENERATING_RESULT → COMPLETED / (예외 → FAILED)
 *
 * - 각 단계는 idempotent: 재시도 시 이미 완료된 단계(DB에 산출물이 있는 단계)는 건너뛴다.
 * - runPipeline 은 절대 throw 하지 않는다. 모든 예외는 markJobFailed 로 흡수한다.
 * - 원본 동영상/오디오 파일은 삭제하지 않는다 (스트리밍·재시도에 필요).
 */

/**
 * 동일 videoId 중복 실행 방지 가드 (프로세스 단위).
 * dev 모드 HMR 로 모듈이 재평가돼도 가드가 유지되도록
 * prisma.ts 와 같은 방식으로 globalThis 에 캐시한다.
 */
const globalForPipeline = globalThis as unknown as {
  runningVideoIds: Set<string> | undefined;
};

const runningVideoIds: Set<string> =
  globalForPipeline.runningVideoIds ?? new Set<string>();

if (process.env.NODE_ENV !== "production") {
  globalForPipeline.runningVideoIds = runningVideoIds;
}

/**
 * 단계 내 세부 진행률 fire-and-forget 갱신.
 * - await 하지 않고 void 처리 → 미완 Promise 누수 없음.
 * - setJobProgress 실패(일시적 DB 오류 등)가 파이프라인을 죽이면 안 되므로 catch 로 삼킨다.
 */
function reportProgress(videoId: string, progress: number): void {
  void setJobProgress(videoId, progress).catch(() => {
    // 진행률 갱신 실패는 무시 — 다음 콜백/단계 전환에서 자연히 보정된다.
  });
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function runPipeline(videoId: string): Promise<void> {
  if (runningVideoIds.has(videoId)) {
    // 이미 이 videoId 의 파이프라인이 실행 중 — 중복 실행 방지
    return;
  }
  runningVideoIds.add(videoId);

  try {
    const started = await beginJobRun(videoId);
    if (!started) {
      // DB 레벨 가드: 다른 프로세스/요청이 이미 이 잡을 실행 중 — 조용히 종료
      return;
    }

    const video = await prisma.video.findUnique({
      where: { id: videoId },
      include: { transcript: true, summary: true },
    });
    if (!video) {
      throw new Error(`영상을 찾을 수 없습니다 (videoId: ${videoId}).`);
    }

    // DB 에 저장된 경로 변조(path traversal) 방어 — 허용된 저장 디렉토리 밖이면 즉시 실패.
    if (!isPathInsideStorage(video.filePath)) {
      throw new Error(
        `동영상 파일 경로가 허용된 저장 위치를 벗어나 처리할 수 없습니다 (videoId: ${videoId}).`,
      );
    }

    await ensureDirs();

    // 1) 메타데이터 추출 (durationSec 이 이미 있으면 skip)
    let durationSec = video.durationSec;
    if (durationSec == null) {
      await setJobStatus(videoId, JobStatus.EXTRACTING_METADATA);
      const meta = await extractMetadata(video.filePath);
      await prisma.video.update({
        where: { id: videoId },
        data: {
          durationSec: meta.durationSec,
          width: meta.width,
          height: meta.height,
          codec: meta.codec,
        },
      });
      durationSec = meta.durationSec;
    }

    // 2) 오디오 추출 (audioPath 가 있고 실제 파일이 존재하면 skip)
    let audioPath = video.audioPath;
    if (!audioPath || !(await fileExists(audioPath))) {
      await setJobStatus(videoId, JobStatus.EXTRACTING_AUDIO);
      // 새 경로는 buildAudioPath 로 서버가 직접 생성하므로 별도 검증이 필요 없다.
      audioPath = buildAudioPath(videoId);
      await extractAudio(video.filePath, audioPath);
      await prisma.video.update({
        where: { id: videoId },
        data: { audioPath },
      });
    } else if (!isPathInsideStorage(audioPath)) {
      // 기존 파일 재사용 분기 — DB 에 저장된 audioPath 변조 방어.
      throw new Error(
        `오디오 파일 경로가 허용된 저장 위치를 벗어나 처리할 수 없습니다 (videoId: ${videoId}).`,
      );
    }

    // 3) STT (Transcript 가 이미 있으면 skip)
    let segments: TranscriptSegment[];
    if (video.transcript) {
      segments = TranscriptSegmentsSchema.parse(video.transcript.segments);
    } else {
      await setJobStatus(videoId, JobStatus.TRANSCRIBING);
      // TRANSCRIBING 세부 진행률: 조각 완료마다 30 → 55%
      const stt = await getSttProvider().transcribe(audioPath, (done, total) => {
        reportProgress(videoId, 30 + Math.floor((25 * done) / total));
      });
      segments = TranscriptSegmentsSchema.parse(stt.segments);
      await prisma.transcript.upsert({
        where: { videoId },
        create: {
          videoId,
          language: stt.language,
          segments: segments as unknown as Prisma.InputJsonValue,
          fullText: stt.fullText,
        },
        update: {
          language: stt.language,
          segments: segments as unknown as Prisma.InputJsonValue,
          fullText: stt.fullText,
        },
      });
    }

    // 4) 청킹
    await setJobStatus(videoId, JobStatus.CHUNKING);
    const chunks = chunkSegments(segments);
    if (chunks.length === 0) {
      throw new Error("인식된 음성이 없습니다");
    }

    // 5~6) 요약 + 결과 생성 (Summary 가 이미 있으면 통째로 skip)
    if (!video.summary) {
      await setJobStatus(videoId, JobStatus.SUMMARIZING);
      // SUMMARIZING 세부 진행률: map 청크 완료마다 65 → 85%
      const summary = await generateSummary({
        durationSec,
        chunks,
        onProgress: (done, total) => {
          reportProgress(videoId, 65 + Math.floor((20 * done) / total));
        },
      });

      await setJobStatus(videoId, JobStatus.GENERATING_RESULT);
      const validated = SummaryResultSchema.parse(summary);
      await prisma.summary.upsert({
        where: { videoId },
        create: {
          videoId,
          data: validated as unknown as Prisma.InputJsonValue,
        },
        update: {
          data: validated as unknown as Prisma.InputJsonValue,
        },
      });
    }

    // 7) 완료
    await completeJob(videoId);
  } catch (err) {
    try {
      await markJobFailed(videoId, err);
    } catch (markErr) {
      // FAILED 기록조차 실패한 경우 — 로그만 남기고 절대 caller 로 전파하지 않는다
      console.error(`[pipeline] markJobFailed 실패 (videoId: ${videoId})`, markErr);
    }
  } finally {
    runningVideoIds.delete(videoId);
  }
}

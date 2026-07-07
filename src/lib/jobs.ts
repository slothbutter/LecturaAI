import { JobStatus, Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { PROGRESS_BY_STATUS } from '@/lib/schemas';

// 단일 출처는 src/lib/schemas.ts — 기존 호출부 호환을 위해 재export 한다.
export { PROGRESS_BY_STATUS };

function clampProgress(progress: number): number {
  if (Number.isNaN(progress)) return 0;
  return Math.min(100, Math.max(0, Math.round(progress)));
}

/**
 * API 키/시크릿으로 보이는 토큰을 에러 메시지에서 마스킹한다.
 * - 알려진 접두사 키(sk-, sk_live_, Bearer 토큰 등)
 * - 32자 이상 연속 영숫자 토큰(대부분의 API 키 형태)
 */
function maskSecrets(message: string): string {
  return message
    .replace(/\b(sk|pk|rk)[-_][A-Za-z0-9_-]{8,}/g, '[REDACTED]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi, 'Bearer [REDACTED]')
    .replace(/\b(api[-_]?key|token|secret|authorization)(["']?\s*[:=]\s*["']?)[^\s"'&]{6,}/gi, '$1$2[REDACTED]')
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '[REDACTED]');
}

async function updateJob(videoId: string, data: Prisma.ProcessingJobUpdateInput): Promise<void> {
  try {
    await prisma.processingJob.update({
      where: { videoId },
      data,
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
      throw new Error(`ProcessingJob not found for videoId "${videoId}"`);
    }
    throw err;
  }
}

/**
 * 잡 상태를 변경한다. progress 생략 시 PROGRESS_BY_STATUS의 기본값 사용.
 * FAILED로 직접 설정하지 말 것 — markJobFailed를 사용한다.
 */
export async function setJobStatus(videoId: string, status: JobStatus, progress?: number): Promise<void> {
  await updateJob(videoId, {
    status,
    progress: clampProgress(progress ?? PROGRESS_BY_STATUS[status]),
  });
}

/**
 * 단계 내 세부 진행률 갱신 (0~100 클램프).
 * fire-and-forget 호출들의 DB 쓰기 완료 순서가 뒤집혀도 progress가 역행하지 않도록
 * 조건부 updateMany(현재값 < 새값)로 단조 증가를 DB 레벨에서 보장한다.
 * count 0 중 "이미 더 높은 값"은 정상이므로 조용히 무시하고,
 * videoId가 존재하지 않는 경우만 기존과 동일하게 에러를 던진다.
 * 단계 전환(setJobStatus)·재시도 리셋(beginJobRun)은 무조건 갱신을 유지해
 * 재시도 시 진행률이 낮아지는 정상 경로를 보존한다.
 */
export async function setJobProgress(videoId: string, progress: number): Promise<void> {
  const next = clampProgress(progress);
  const { count } = await prisma.processingJob.updateMany({
    where: { videoId, progress: { lt: next } },
    data: { progress: next },
  });
  if (count === 0) {
    // 이미 더 높은 진행률이면 정상 — 잡 자체가 없을 때만 기존 동작대로 에러
    const exists = await prisma.processingJob.findUnique({
      where: { videoId },
      select: { videoId: true },
    });
    if (!exists) {
      throw new Error(`ProcessingJob not found for videoId "${videoId}"`);
    }
  }
}

/**
 * 잡을 실패 처리한다. 에러 메시지만 저장(스택 제외)하고 시크릿을 마스킹한다.
 * progress는 실패 시점 값을 유지한다.
 */
export async function markJobFailed(videoId: string, error: unknown): Promise<void> {
  const rawMessage = error instanceof Error ? error.message : String(error);
  await updateJob(videoId, {
    status: JobStatus.FAILED,
    errorMessage: maskSecrets(rawMessage).slice(0, 2000),
    finishedAt: new Date(),
  });
}

/** 파이프라인이 진행 중인 것으로 간주하는 중간 상태 6종. */
const IN_PROGRESS_STATUSES: JobStatus[] = [
  JobStatus.EXTRACTING_METADATA,
  JobStatus.EXTRACTING_AUDIO,
  JobStatus.TRANSCRIBING,
  JobStatus.CHUNKING,
  JobStatus.SUMMARIZING,
  JobStatus.GENERATING_RESULT,
];

/**
 * 잡 실행 시작: attempts +1, errorMessage/finishedAt 초기화.
 * DB 레벨 중복 실행 가드 — 이미 진행 중(중간 상태 6종)이거나 잡이 없으면
 * 아무것도 갱신하지 않고 false 를 반환한다 (updateMany 조건부 갱신).
 * 가드 통과와 동시에 status 를 EXTRACTING_METADATA 로 원자 전환해
 * 멀티 인스턴스에서 두 프로세스가 동시에 가드를 통과하지 못하게 한다.
 * (파이프라인은 산출물 존재 기준으로 단계를 skip 하므로 status 선전환은 무해하고,
 * 직후 setJobStatus(EXTRACTING_METADATA)와 중복돼도 문제 없다.)
 * startedAt 은 아직 없을 때만(최초 실행) 현재 시각으로 설정한다.
 */
export async function beginJobRun(videoId: string): Promise<boolean> {
  const { count } = await prisma.processingJob.updateMany({
    where: {
      videoId,
      status: { notIn: IN_PROGRESS_STATUSES },
    },
    data: {
      status: JobStatus.EXTRACTING_METADATA,
      progress: PROGRESS_BY_STATUS[JobStatus.EXTRACTING_METADATA],
      attempts: { increment: 1 },
      errorMessage: null,
      finishedAt: null,
    },
  });
  if (count === 0) {
    // 이미 실행 중이거나 잡이 존재하지 않음
    return false;
  }

  // startedAt 은 최초 실행 시에만 설정 (조건부 갱신)
  await prisma.processingJob.updateMany({
    where: { videoId, startedAt: null },
    data: { startedAt: new Date() },
  });

  return true;
}

/** 잡 완료 처리: COMPLETED, progress 100, finishedAt 설정. */
export async function completeJob(videoId: string): Promise<void> {
  await updateJob(videoId, {
    status: JobStatus.COMPLETED,
    progress: 100,
    finishedAt: new Date(),
  });
}

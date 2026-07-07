import { z } from "zod";

/* -------------------------------------------------------------------------- */
/* Transcript                                                                 */
/* -------------------------------------------------------------------------- */

/** STT 결과의 개별 세그먼트 */
export const TranscriptSegmentSchema = z.object({
  start: z.number(),
  end: z.number(),
  text: z.string(),
});
export type TranscriptSegment = z.infer<typeof TranscriptSegmentSchema>;

export const TranscriptSegmentsSchema = z.array(TranscriptSegmentSchema);

/* -------------------------------------------------------------------------- */
/* AI 요약 출력 스키마                                                          */
/* -------------------------------------------------------------------------- */

export const TimelineItemSchema = z.object({
  timeSec: z.number(),
  label: z.string(),
});
export type TimelineItem = z.infer<typeof TimelineItemSchema>;

export const ChapterSchema = z.object({
  title: z.string(),
  startSec: z.number(),
  endSec: z.number(),
  notes: z.string(),
});
export type Chapter = z.infer<typeof ChapterSchema>;

export const QuizSchema = z.object({
  question: z.string(),
  choices: z.array(z.string()).optional(),
  answer: z.string(),
  explanation: z.string().optional(),
});
export type Quiz = z.infer<typeof QuizSchema>;

export const KeyConceptSchema = z.object({
  term: z.string(),
  description: z.string(),
});
export type KeyConcept = z.infer<typeof KeyConceptSchema>;

export const GlossaryItemSchema = z.object({
  term: z.string(),
  definition: z.string(),
});
export type GlossaryItem = z.infer<typeof GlossaryItemSchema>;

export const SummaryResultSchema = z.object({
  shortSummary: z.string(),
  fullSummary: z.string(),
  timeline: z.array(TimelineItemSchema),
  chapters: z.array(ChapterSchema),
  keyConcepts: z.array(KeyConceptSchema),
  glossary: z.array(GlossaryItemSchema),
  quizzes: z.array(QuizSchema),
  actionItems: z.array(z.string()),
});
export type SummaryResult = z.infer<typeof SummaryResultSchema>;

/* -------------------------------------------------------------------------- */
/* 처리 단계 (ProcessingJob.status 와 1:1 대응)                                 */
/* -------------------------------------------------------------------------- */

export const JOB_STEPS = [
  { status: "UPLOADED", label: "업로드 완료" },
  { status: "EXTRACTING_METADATA", label: "메타데이터 추출 중" },
  { status: "EXTRACTING_AUDIO", label: "오디오 추출 중" },
  { status: "TRANSCRIBING", label: "음성 인식 중" },
  { status: "CHUNKING", label: "텍스트 분할 중" },
  { status: "SUMMARIZING", label: "요약 생성 중" },
  { status: "GENERATING_RESULT", label: "결과 정리 중" },
  { status: "COMPLETED", label: "완료" },
] as const;

export type JobStepStatus = (typeof JOB_STEPS)[number]["status"];

/**
 * 각 파이프라인 단계 진입 시점의 기본 진행률 (서버·클라이언트 공용 단일 출처).
 * 키는 Prisma JobStatus 값과 1:1 대응한다.
 * FAILED 는 실패 시점의 진행률을 유지해야 하므로 여기 값은 사용하지 않는다
 * (markJobFailed 에서 progress 를 건드리지 않음).
 */
export const PROGRESS_BY_STATUS: Record<JobStepStatus | "FAILED", number> = {
  UPLOADED: 0,
  EXTRACTING_METADATA: 5,
  EXTRACTING_AUDIO: 15,
  TRANSCRIBING: 30,
  CHUNKING: 55,
  SUMMARIZING: 65,
  GENERATING_RESULT: 85,
  COMPLETED: 100,
  FAILED: 0,
};

/** status → 한국어 라벨 (FAILED 포함) */
export const JOB_STATUS_LABELS: Record<string, string> = {
  ...Object.fromEntries(JOB_STEPS.map((s) => [s.status, s.label])),
  FAILED: "처리 실패",
};

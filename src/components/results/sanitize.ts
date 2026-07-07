import { z } from "zod";
import {
  ChapterSchema,
  GlossaryItemSchema,
  KeyConceptSchema,
  QuizSchema,
  TimelineItemSchema,
  type SummaryResult,
} from "@/lib/schemas";

/**
 * 배열 형태의 값에서 스키마를 통과하는 항목만 골라낸다.
 * 배열이 아니거나 항목이 깨져 있어도 절대 throw 하지 않는다.
 */
function pickValidItems<T>(value: unknown, schema: z.ZodType<T>): T[] {
  if (!Array.isArray(value)) return [];
  const result: T[] = [];
  for (const item of value) {
    const parsed = schema.safeParse(item);
    if (parsed.success) result.push(parsed.data);
  }
  return result;
}

function pickString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}

/**
 * 서버에서 받은 SummaryResult JSON을 느슨하게 검증한다.
 * 필드 누락·타입 불일치·일부 항목 손상이 있어도 사용 가능한 부분만 남긴다.
 */
export function sanitizeSummary(raw: unknown): Partial<SummaryResult> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  const obj = raw as Record<string, unknown>;

  return {
    shortSummary: pickString(obj.shortSummary),
    fullSummary: pickString(obj.fullSummary),
    timeline: pickValidItems(obj.timeline, TimelineItemSchema),
    chapters: pickValidItems(obj.chapters, ChapterSchema),
    keyConcepts: pickValidItems(obj.keyConcepts, KeyConceptSchema),
    glossary: pickValidItems(obj.glossary, GlossaryItemSchema),
    quizzes: pickValidItems(obj.quizzes, QuizSchema),
    actionItems: pickValidItems(obj.actionItems, z.string()),
  };
}

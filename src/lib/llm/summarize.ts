import { z } from "zod";
import { chatJson } from "@/lib/llm/client";
import { SummaryResultSchema, type SummaryResult } from "@/lib/schemas";
import type { TranscriptChunk } from "@/lib/chunking";

/**
 * 강의 요약 생성 (map → reduce 2단계)
 *
 * 1단계(map): 각 청크마다 부분 요약 + 챕터/개념/타임라인 후보를 추출한다.
 *   - 프롬프트에 청크의 startSec/endSec 범위와 세그먼트별 [초] 타임스탬프를
 *     넣어 모델이 실제 초 단위 값을 사용하도록 유도한다.
 *   - 청크는 순차 처리한다 (rate limit 및 컨텍스트 안정성).
 * 2단계(reduce): 부분 결과 전체를 합쳐 최종 SummaryResult 를 생성하고
 *   SummaryResultSchema 로 검증한 뒤, 타임스탬프를 [0, durationSec] 로
 *   코드 레벨에서 한 번 더 안전 클램프한다.
 */

/* -------------------------------------------------------------------------- */
/* 1단계(map) 부분 결과 스키마                                                  */
/* -------------------------------------------------------------------------- */

const ChapterCandidateSchema = z.object({
  title: z.string(),
  startSec: z.number(),
  endSec: z.number(),
  note: z.string(),
});

const ConceptCandidateSchema = z.object({
  term: z.string(),
  description: z.string(),
});

const TimelineCandidateSchema = z.object({
  timeSec: z.number(),
  label: z.string(),
});

const PartialResultSchema = z.object({
  partialSummary: z.string(),
  chapterCandidates: z.array(ChapterCandidateSchema),
  conceptCandidates: z.array(ConceptCandidateSchema),
  timelineCandidates: z.array(TimelineCandidateSchema),
});

type PartialResult = z.infer<typeof PartialResultSchema>;

/** 부분 결과 + 해당 구간의 시간 범위 (계층적 reduce 시 그룹 범위 추적용) */
interface RangedPartial {
  partial: PartialResult;
  startSec: number;
  endSec: number;
}

/** reduce 한 번에 넣을 수 있는 부분 결과 최대 개수 — 초과 시 계층적 통합 */
const MAX_REDUCE_PARTIALS = 12;
/** 계층적 통합 시 한 그룹의 크기 (8~10 권장) */
const MERGE_GROUP_SIZE = 10;

/* -------------------------------------------------------------------------- */
/* 유틸                                                                        */
/* -------------------------------------------------------------------------- */

function formatSec(sec: number): string {
  return (Math.round(sec * 10) / 10).toString();
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** 세그먼트를 "[12.3초] 텍스트" 형태의 줄들로 직렬화 */
function renderSegments(chunk: TranscriptChunk): string {
  return chunk.segments
    .map((seg) => `[${formatSec(seg.start)}초] ${seg.text}`)
    .join("\n");
}

/* -------------------------------------------------------------------------- */
/* 1단계(map): 청크별 부분 요약                                                 */
/* -------------------------------------------------------------------------- */

const MAP_SYSTEM_PROMPT = `당신은 강의 영상의 전사(transcript) 일부를 분석해 학습 자료의 재료를 뽑아내는 전문 분석가입니다.
반드시 아래 형식의 JSON 객체 하나만 출력하세요 (다른 텍스트, 코드펜스 금지):
{
  "partialSummary": "이 구간의 핵심 내용 요약 (한국어, 3~6문장)",
  "chapterCandidates": [{ "title": "챕터 제목", "startSec": 숫자, "endSec": 숫자, "note": "이 챕터에서 다룬 내용 상세 노트" }],
  "conceptCandidates": [{ "term": "핵심 용어/개념", "description": "설명" }],
  "timelineCandidates": [{ "timeSec": 숫자, "label": "해당 시점에 일어난 일 (짧은 라벨)" }]
}
규칙:
- 모든 텍스트는 한국어로 작성합니다.
- startSec / endSec / timeSec 은 반드시 전사에 표기된 [초] 타임스탬프에 근거한 실제 초 단위 숫자여야 합니다. 임의의 값을 만들지 마세요.
- 타임스탬프는 이 청크의 시간 범위 안에 있어야 합니다.
- 배열이 비어도 됩니다. 근거 없는 내용을 지어내지 마세요.`;

function buildMapUserPrompt(
  chunk: TranscriptChunk,
  chunkCount: number,
  durationSec: number,
): string {
  return `전체 영상 길이: ${formatSec(durationSec)}초
이 청크: ${chunk.index + 1}/${chunkCount} 번째, 시간 범위 ${formatSec(chunk.startSec)}초 ~ ${formatSec(chunk.endSec)}초

아래는 이 구간의 전사입니다. 각 줄 앞의 [초] 는 해당 발화의 시작 시각(초)입니다.

${renderSegments(chunk)}

위 내용을 분석해 지정된 JSON 형식으로만 답하세요.`;
}

/* -------------------------------------------------------------------------- */
/* 중간 통합(merge): 계층적 reduce — 부분 결과 여러 개를 같은 스키마로 통합       */
/* -------------------------------------------------------------------------- */

const MERGE_SYSTEM_PROMPT = `당신은 강의 영상의 구간별 부분 분석 결과 여러 개를 하나의 부분 분석 결과로 통합하는 전문 에디터입니다.
반드시 아래 형식의 JSON 객체 하나만 출력하세요 (다른 텍스트, 코드펜스 금지):
{
  "partialSummary": "통합 구간의 핵심 내용 요약 (한국어, 4~8문장)",
  "chapterCandidates": [{ "title": "챕터 제목", "startSec": 숫자, "endSec": 숫자, "note": "이 챕터에서 다룬 내용 상세 노트" }],
  "conceptCandidates": [{ "term": "핵심 용어/개념", "description": "설명" }],
  "timelineCandidates": [{ "timeSec": 숫자, "label": "해당 시점에 일어난 일 (짧은 라벨)" }]
}
규칙:
- 모든 텍스트는 한국어로 작성합니다.
- 입력된 부분 결과들의 내용을 빠짐없이 반영하되, 중복 항목은 병합하고 덜 중요한 항목은 걸러 핵심만 남기세요.
- startSec / endSec / timeSec 은 반드시 입력 부분 결과에 있는 실제 초 값에 근거해야 합니다. 임의의 값을 만들지 마세요.
- chapterCandidates 는 startSec 오름차순, timelineCandidates 는 timeSec 오름차순으로 정렬하세요.
- 배열이 비어도 됩니다. 근거 없는 내용을 지어내지 마세요.`;

function buildMergeUserPrompt(
  group: RangedPartial[],
  durationSec: number,
): string {
  const sections = group.map((rp, i) => {
    const range = `${formatSec(rp.startSec)}초 ~ ${formatSec(rp.endSec)}초`;
    return [
      `### 부분 결과 ${i + 1} (${range})`,
      `요약: ${rp.partial.partialSummary}`,
      `챕터 후보: ${JSON.stringify(rp.partial.chapterCandidates)}`,
      `개념 후보: ${JSON.stringify(rp.partial.conceptCandidates)}`,
      `타임라인 후보: ${JSON.stringify(rp.partial.timelineCandidates)}`,
    ].join("\n");
  });

  return `전체 영상 길이: ${formatSec(durationSec)}초
통합 대상 구간: ${formatSec(group[0].startSec)}초 ~ ${formatSec(group[group.length - 1].endSec)}초

아래의 연속된 부분 분석 결과들을 하나의 부분 분석 결과 JSON 으로 통합하세요.

${sections.join("\n\n")}`;
}

/**
 * 부분 결과가 MAX_REDUCE_PARTIALS 를 초과하면 MERGE_GROUP_SIZE 개씩 묶어
 * 중간 통합을 반복한다 (계층적 reduce). 결과 스키마가 partial 과 동일하므로
 * 개수가 줄어들 때까지 반복 적용 가능하다 — 4시간+ 영상에서도 최종 reduce
 * 프롬프트가 컨텍스트를 초과하지 않는다.
 */
async function hierarchicalMerge(
  ranged: RangedPartial[],
  durationSec: number,
): Promise<RangedPartial[]> {
  let current = ranged;
  while (current.length > MAX_REDUCE_PARTIALS) {
    const next: RangedPartial[] = [];
    for (let i = 0; i < current.length; i += MERGE_GROUP_SIZE) {
      const group = current.slice(i, i + MERGE_GROUP_SIZE);
      if (group.length === 1) {
        next.push(group[0]);
        continue;
      }
      const merged = await chatJson({
        system: MERGE_SYSTEM_PROMPT,
        user: buildMergeUserPrompt(group, durationSec),
        schema: PartialResultSchema,
      });
      next.push({
        partial: merged,
        startSec: group[0].startSec,
        endSec: group[group.length - 1].endSec,
      });
    }
    current = next;
  }
  return current;
}

/* -------------------------------------------------------------------------- */
/* 2단계(reduce): 최종 SummaryResult 생성                                       */
/* -------------------------------------------------------------------------- */

const REDUCE_SYSTEM_PROMPT = `당신은 강의 영상 전체의 부분 분석 결과들을 통합해 완성도 높은 학습 자료를 만드는 전문 에디터입니다.
반드시 아래 형식의 JSON 객체 하나만 출력하세요 (다른 텍스트, 코드펜스 금지):
{
  "shortSummary": "3~5문장의 짧은 요약",
  "fullSummary": "상세 요약 — 마크다운 문법 없이 평문 단락으로",
  "timeline": [{ "timeSec": 숫자, "label": "짧은 라벨" }],
  "chapters": [{ "title": "챕터 제목", "startSec": 숫자, "endSec": 숫자, "notes": "학습 노트" }],
  "keyConcepts": [{ "term": "용어", "description": "설명" }],
  "glossary": [{ "term": "용어", "definition": "정의" }],
  "quizzes": [{ "question": "문제", "choices": ["보기1", "보기2", "보기3", "보기4"], "answer": "정답", "explanation": "해설" }],
  "actionItems": ["학습자가 이후에 할 일"]
}
규칙:
- 모든 출력은 한국어로 작성합니다.
- shortSummary: 3~5문장.
- fullSummary: 마크다운 기호(#, *, - 등) 없이 순수한 평문 단락들로 작성합니다. 단락 구분은 빈 줄로만 합니다.
- timeline: timeSec 오름차순으로 정렬하고, 모든 timeSec 은 0 이상, 영상 길이 이내여야 합니다. 주요 전환점 위주로 6~15개.
- chapters: 구간이 서로 겹치지 않게 하고(startSec < endSec, 다음 챕터의 startSec 은 이전 endSec 이상), 영상 전체를 자연스럽게 커버하세요. notes 는 그 챕터만 읽어도 복습이 되도록 학습 노트 수준으로 상세하게 작성합니다.
- keyConcepts: 강의의 핵심 개념 5~12개.
- glossary: 학습자가 찾아볼 만한 용어 정의 목록.
- quizzes: 4~8개. 객관식 문제는 choices 배열(3~5개 보기)을 반드시 포함하고 answer 는 보기 중 하나와 정확히 일치해야 합니다. explanation 에 해설을 씁니다.
- actionItems: 학습자가 강의 후 실천할 항목 3~7개.
- 모든 타임스탬프는 부분 분석 결과에 있는 실제 초 값에 근거해야 하며, 영상 길이를 초과하면 안 됩니다.`;

function buildReduceUserPrompt(
  partials: RangedPartial[],
  durationSec: number,
): string {
  const sections = partials.map((rp, i) => {
    const range = `${formatSec(rp.startSec)}초 ~ ${formatSec(rp.endSec)}초`;
    return [
      `### 구간 ${i + 1} (${range})`,
      `요약: ${rp.partial.partialSummary}`,
      `챕터 후보: ${JSON.stringify(rp.partial.chapterCandidates)}`,
      `개념 후보: ${JSON.stringify(rp.partial.conceptCandidates)}`,
      `타임라인 후보: ${JSON.stringify(rp.partial.timelineCandidates)}`,
    ].join("\n");
  });

  return `전체 영상 길이: ${formatSec(durationSec)}초 (모든 타임스탬프는 0 ~ ${formatSec(durationSec)}초 범위여야 함)

아래는 영상을 구간별로 분석한 부분 결과들입니다. 이를 모두 통합해 최종 학습 자료 JSON 을 생성하세요.

${sections.join("\n\n")}`;
}

/* -------------------------------------------------------------------------- */
/* 안전 클램프                                                                  */
/* -------------------------------------------------------------------------- */

/** 검증된 결과의 타임스탬프를 [0, durationSec] 범위로 코드 레벨에서 보정 */
function clampSummary(result: SummaryResult, durationSec: number): SummaryResult {
  const max = Math.max(0, durationSec);

  const timeline = result.timeline
    .map((item) => ({ ...item, timeSec: clamp(item.timeSec, 0, max) }))
    .sort((a, b) => a.timeSec - b.timeSec);

  const chapters = result.chapters.map((ch) => {
    const startSec = clamp(ch.startSec, 0, max);
    const endSec = clamp(ch.endSec, startSec, max);
    return { ...ch, startSec, endSec };
  });

  return { ...result, timeline, chapters };
}

/* -------------------------------------------------------------------------- */
/* 공개 API                                                                    */
/* -------------------------------------------------------------------------- */

export async function generateSummary(input: {
  durationSec: number;
  chunks: TranscriptChunk[];
}): Promise<SummaryResult> {
  const { durationSec, chunks } = input;

  if (chunks.length === 0) {
    throw new Error("요약할 전사 내용이 없습니다 (청크 0개).");
  }

  // 1단계(map): 청크 순차 처리
  const partials: RangedPartial[] = [];
  for (const chunk of chunks) {
    const partial = await chatJson({
      system: MAP_SYSTEM_PROMPT,
      user: buildMapUserPrompt(chunk, chunks.length, durationSec),
      schema: PartialResultSchema,
    });
    partials.push({
      partial,
      startSec: chunk.startSec,
      endSec: chunk.endSec,
    });
  }

  // 1.5단계(계층적 merge): 부분 결과가 많으면(4시간+ 영상) 그룹 단위로
  // 중간 통합해 최종 reduce 프롬프트의 컨텍스트 초과를 방지
  const reduced = await hierarchicalMerge(partials, durationSec);

  // 2단계(reduce): 부분 결과 통합 → 최종 결과
  const result = await chatJson({
    system: REDUCE_SYSTEM_PROMPT,
    user: buildReduceUserPrompt(reduced, durationSec),
    schema: SummaryResultSchema,
  });

  return clampSummary(result, durationSec);
}

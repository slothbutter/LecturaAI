import { z } from "zod";
import { chatJson } from "@/lib/llm/client";
import {
  QuizSchema,
  SummaryResultSchema,
  type Quiz,
  type SummaryResult,
} from "@/lib/schemas";
import type { TranscriptChunk } from "@/lib/chunking";

/**
 * 강의 요약 생성 (gist → map → reduce → quiz 4단계)
 *
 * 0단계(gist): map 시작 전 chatJson 1회로 강의 전체 요지(3~5문장)를 생성한다.
 *   - 입력은 모든 청크의 앞부분을 균등 샘플링해 총 GIST_INPUT_CHAR_CAP(1만자)
 *     이내로 캡한다 (비용 상한).
 *   - 실패해도 파이프라인을 중단하지 않는다 — 빈 gist 로 계속 진행한다
 *     (요지는 보강재이지 필수가 아님).
 * 1단계(map): 각 청크마다 부분 요약 + 챕터/개념/타임라인 후보를 추출한다.
 *   - 프롬프트에 청크의 startSec/endSec 범위와 세그먼트별 [초] 타임스탬프를
 *     넣어 모델이 실제 초 단위 값을 사용하도록 유도한다.
 *   - 청크는 동시 MAP_CONCURRENCY(4)개 async pool 로 병렬 처리하되,
 *     결과는 완료 순서가 아니라 청크 인덱스 순서로 재조립한다.
 *   - 프롬프트 보강: (a) 글로벌 gist 를 "강의 전체 요지(참고)"로 주입,
 *     (b) 직전 청크의 마지막 최대 2개 세그먼트를 "직전 맥락(참고용)"으로
 *     주입해 청크 경계의 지시어("이것", "방금 말한") 해석을 돕는다.
 * 2단계(reduce): 부분 결과 전체를 합쳐 최종 SummaryResult 를 생성한다.
 *   이 단계의 quizzes 는 의도적으로 빈 배열이다 (프롬프트로 지시).
 * 3단계(quiz): reduce 가 만든 최종 학습 자료(fullSummary + chapters.notes +
 *   keyConcepts + glossary)만을 입력으로 chatJson 1회를 추가 호출해 퀴즈를
 *   생성한다 — 전사·부분 결과는 입력에서 배제해 "요약에 없는 내용 출제"를
 *   구조적으로 차단한다. 이 패스가 chatJson 재시도까지 소진하며 실패하면
 *   그대로 throw 한다 (파이프라인 FAILED 수렴 원칙 유지).
 * 최종적으로 quizzes 를 병합해 SummaryResultSchema 로 재검증하고,
 * 타임스탬프를 [0, durationSec] 로 코드 레벨에서 한 번 더 안전 클램프한다.
 *
 * 진행률 보고: onProgress(completed, total) 는 map 단계만 보고한다
 * (total = chunks.length, gist/merge/reduce/quiz 는 미보고). 미전달 시 기존과 동일.
 */

/* -------------------------------------------------------------------------- */
/* 동시성 풀 유틸                                                              */
/* -------------------------------------------------------------------------- */

/** map 단계 동시 처리 개수 (429 레이트리밋 안전 범위) */
const MAP_CONCURRENCY = 4;

/**
 * 간단한 async pool (세마포어 패턴).
 * - 최대 concurrency 개의 worker 가 공유 커서에서 다음 인덱스를 가져가 처리한다.
 * - 결과는 완료 순서가 아니라 입력 인덱스 위치(results[i])에 기록되므로
 *   반환 배열은 항상 입력 순서와 일치한다.
 * - 어느 한 작업이라도 실패하면 전체가 reject 된다 (기존 순차 처리와 동일한
 *   실패 의미론).
 */
async function runPool<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let cursor = 0;

  async function drain(): Promise<void> {
    while (true) {
      const index = cursor;
      if (index >= items.length) return;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  }

  const workers = Array.from(
    { length: Math.max(1, Math.min(concurrency, items.length)) },
    () => drain(),
  );
  await Promise.all(workers);
  return results;
}

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
/* 0단계(gist): 강의 전체 요지 선행 패스                                        */
/* -------------------------------------------------------------------------- */

/** gist 입력 총 글자수 상한 (비용 상한) */
const GIST_INPUT_CHAR_CAP = 10_000;

const GistSchema = z.object({ gist: z.string() });

const GIST_SYSTEM_PROMPT = `당신은 강의 영상 전사에서 발췌한 조각들을 읽고 강의 전체의 요지를 파악하는 전문 분석가입니다.
반드시 아래 형식의 JSON 객체 하나만 출력하세요 (다른 텍스트, 코드펜스 금지):
{ "gist": "강의 전체 요지 (한국어, 3~5문장)" }
규칙:
- 한국어로 작성합니다.
- 발췌 조각들에 근거해 강의의 주제, 흐름, 목적을 요약하세요. 근거 없는 내용을 지어내지 마세요.`;

/**
 * 모든 청크의 앞부분을 균등 샘플링해 총 GIST_INPUT_CHAR_CAP 이내의
 * gist 입력 텍스트를 만든다. 청크당 예산 = floor(상한 / 청크 수).
 */
function buildGistUserPrompt(
  chunks: TranscriptChunk[],
  durationSec: number,
): string {
  const perChunkBudget = Math.max(
    1,
    Math.floor(GIST_INPUT_CHAR_CAP / chunks.length),
  );
  const excerpts = chunks.map((chunk) => {
    const head = chunk.text.slice(0, perChunkBudget);
    return `[${formatSec(chunk.startSec)}초~] ${head}`;
  });

  return `전체 영상 길이: ${formatSec(durationSec)}초

아래는 강의 전사를 시간 순으로 균등 발췌한 조각들입니다 (각 조각은 해당 구간의 앞부분).

${excerpts.join("\n\n")}

위 발췌를 바탕으로 강의 전체 요지를 3~5문장으로 작성해 지정된 JSON 형식으로만 답하세요.`;
}

/**
 * gist 선행 패스. 실패 시 빈 문자열을 반환하고 파이프라인은 계속 진행한다
 * (gist 는 map 프롬프트 보강재일 뿐 필수 입력이 아님).
 */
async function generateGist(
  chunks: TranscriptChunk[],
  durationSec: number,
): Promise<string> {
  try {
    const { gist } = await chatJson({
      system: GIST_SYSTEM_PROMPT,
      user: buildGistUserPrompt(chunks, durationSec),
      schema: GistSchema,
    });
    return gist.trim();
  } catch {
    return "";
  }
}

/* -------------------------------------------------------------------------- */
/* 1단계(map): 청크별 부분 요약                                                 */
/* -------------------------------------------------------------------------- */

const MAP_SYSTEM_PROMPT = `당신은 강의 영상의 전사(transcript) 일부에서 학습자가 배워야 할 "지식 자체"를 추출하는 전문 분석가입니다.
반드시 아래 형식의 JSON 객체 하나만 출력하세요 (다른 텍스트, 코드펜스 금지):
{
  "partialSummary": "이 구간이 전달한 핵심 지식 서술 (한국어 — 주제 1개당 3~5문장, 주제가 여러 개면 문장 수를 그에 비례해 늘려 모든 주제를 서술)",
  "chapterCandidates": [{ "title": "챕터 제목", "startSec": 숫자, "endSec": 숫자, "note": "이 구간의 지식을 자기완결적으로 정리한 학습 노트" }],
  "conceptCandidates": [{ "term": "핵심 용어/개념", "description": "정의와 핵심 원리를 실제로 담은 설명" }],
  "timelineCandidates": [{ "timeSec": 숫자, "label": "해당 시점의 핵심 내용 (짧은 라벨)" }]
}
커버리지 — 절대 규칙 (가장 중요):
- partialSummary·chapterCandidates·timelineCandidates 는 이 청크의 전체 시간 범위(startSec ~ endSec)를 빠짐없이 커버해야 합니다. 청크 후반부의 주제도 전반부와 동일한 비중으로 추출하세요 — 앞부분만 요약하고 뒷부분을 생략하는 것은 오류입니다.
- 주제가 전환되면 chapterCandidates 를 반드시 별도 항목으로 분리하세요. 서로 다른 주제를 하나의 챕터 후보로 뭉뚱그리거나, 뒤 주제를 누락하지 마세요.
- 출력 전에 자체 점검하세요: 마지막 챕터 후보의 endSec 이 전사의 마지막 [초] 타임스탬프 근처까지 도달하는가? 도달하지 않는다면 누락된 후반부 주제를 추가해야 합니다 (후반부가 잡담·잡음뿐인 경우만 예외).
추출 기준 — "무엇을 다뤘나"가 아니라 "무슨 지식을 줬나"를 기록합니다:
- 정의, 원리·메커니즘, 공식·수치, 구체적 예시, 논거, 실무 팁을 실제 내용 그대로 담으세요.
- 좋은 예: "X란 ~이다. 핵심은 ~ 때문에 ~라는 점이다." / 나쁜 예: "X의 개념에 대해 설명합니다."
금지 사항:
- 메타 서술 금지: "~에 대해 설명합니다", "~을 다룹니다", "~을 이야기합니다", "~을 소개합니다" 류의 표현을 쓰지 마세요. 설명된 내용 자체를 서술하세요.
- 잡담·인사·운영 멘트(접속/화면/소리 확인, 출석 체크, 휴식 안내, 마이크 테스트 등 온라인 강의 운영 발화)는 요약·챕터·개념·타임라인 어디에도 포함하지 마세요.
- 무의미한 반복 문구, 맥락 없는 외국어 문장, 뜬금없는 상투구 등 전사 오류(무음 구간 잡음)로 보이는 텍스트는 무시하세요.
규칙:
- 모든 텍스트는 한국어로 작성합니다.
- startSec / endSec / timeSec 은 반드시 전사에 표기된 [초] 타임스탬프에 근거한 실제 초 단위 숫자여야 합니다. 임의의 값을 만들지 마세요.
- 타임스탬프는 이 청크의 시간 범위 안에 있어야 합니다.
- 배열이 비어도 됩니다. 근거 없는 내용을 지어내지 마세요.
- "강의 전체 요지" 와 "직전 맥락" 이 주어지면 참고 자료로만 사용하세요. 요약 대상은 오직 이 청크의 전사입니다.`;

/** 직전 청크의 마지막 최대 2개 세그먼트를 "[초] 텍스트" 줄들로 직렬화 */
function renderPrevContext(prevChunk: TranscriptChunk): string {
  const tail = prevChunk.segments.slice(-2);
  return tail
    .map((seg) => `[${formatSec(seg.start)}초] ${seg.text}`)
    .join("\n");
}

function buildMapUserPrompt(
  chunk: TranscriptChunk,
  chunkCount: number,
  durationSec: number,
  gist: string,
  prevChunk: TranscriptChunk | undefined,
): string {
  const gistSection = gist
    ? `강의 전체 요지(참고):
${gist}

`
    : "";

  const prevSection =
    prevChunk && prevChunk.segments.length > 0
      ? `직전 맥락(참고용 — 요약 대상 아님, 지시어 해석에만 사용):
${renderPrevContext(prevChunk)}

`
      : "";

  return `전체 영상 길이: ${formatSec(durationSec)}초
이 청크: ${chunk.index + 1}/${chunkCount} 번째, 시간 범위 ${formatSec(chunk.startSec)}초 ~ ${formatSec(chunk.endSec)}초

${gistSection}${prevSection}아래는 이 구간의 전사입니다. 각 줄 앞의 [초] 는 해당 발화의 시작 시각(초)입니다.

${renderSegments(chunk)}

위 내용을 분석해 지정된 JSON 형식으로만 답하세요.`;
}

/* -------------------------------------------------------------------------- */
/* 중간 통합(merge): 계층적 reduce — 부분 결과 여러 개를 같은 스키마로 통합       */
/* -------------------------------------------------------------------------- */

const MERGE_SYSTEM_PROMPT = `당신은 강의 영상의 구간별 부분 분석 결과 여러 개를 하나의 부분 분석 결과로 통합하는 전문 에디터입니다.
반드시 아래 형식의 JSON 객체 하나만 출력하세요 (다른 텍스트, 코드펜스 금지):
{
  "partialSummary": "통합 구간이 전달한 핵심 지식 서술 (한국어, 4~10문장)",
  "chapterCandidates": [{ "title": "챕터 제목", "startSec": 숫자, "endSec": 숫자, "note": "이 구간의 지식을 자기완결적으로 정리한 학습 노트" }],
  "conceptCandidates": [{ "term": "핵심 용어/개념", "description": "정의와 핵심 원리를 실제로 담은 설명" }],
  "timelineCandidates": [{ "timeSec": 숫자, "label": "해당 시점의 핵심 내용 (짧은 라벨)" }]
}
규칙:
- 모든 텍스트는 한국어로 작성합니다.
- 입력된 부분 결과들의 내용을 빠짐없이 반영하되, 중복 항목은 병합하고 덜 중요한 항목은 걸러 핵심만 남기세요.
- 통합 과정에서 구체적 지식(정의, 원리·메커니즘, 공식·수치, 예시, 논거, 실무 팁)을 뭉개거나 추상화하지 말고 내용 그대로 보존하세요.
- 메타 서술 금지: "~에 대해 설명합니다/다룹니다/이야기합니다" 류 표현을 쓰지 마세요. 지식 자체를 서술하세요.
- 자체 점검(self-check): 출력을 확정하기 전에 각 필드를 다시 읽고, "~합니다/됩니다/다룹니다/설명합니다/강조됩니다"처럼 내용 없이 언급만 하는 문장을 발견하면 그 문장을 해당 내용의 실제 지식 서술로 교체하세요. 교체할 실제 내용이 부분 결과에 없으면 그 문장을 삭제하세요.
- 잡담·인사·운영 멘트(접속 확인, 휴식 안내 등)나 전사 오류로 보이는 잡음이 입력에 섞여 있으면 결과에서 제외하세요.
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

const REDUCE_SYSTEM_PROMPT = `당신은 강의 영상 전체의 부분 분석 결과들을 통합해, 영상을 보지 않은 사람도 읽는 것만으로 핵심 지식을 배울 수 있는 학습 자료를 만드는 전문 에디터입니다.
반드시 아래 형식의 JSON 객체 하나만 출력하세요 (다른 텍스트, 코드펜스 금지):
{
  "shortSummary": "3~5문장의 짧은 요약",
  "fullSummary": "학습 노트 스타일 상세 요약 — 마크다운 문법 없이 평문 단락으로",
  "timeline": [{ "timeSec": 숫자, "label": "짧은 라벨" }],
  "chapters": [{ "title": "챕터 제목", "startSec": 숫자, "endSec": 숫자, "notes": "학습 노트" }],
  "keyConcepts": [{ "term": "용어", "description": "설명" }],
  "glossary": [{ "term": "용어", "definition": "정의" }],
  "quizzes": [],
  "actionItems": ["학습자가 이후에 할 일"]
}
작성 원칙 — 지식 중심:
- 진행 나열("먼저 ~을 다루고, 이어서 ~을 설명합니다")이 아니라 강의가 전달한 지식 자체(정의, 원리·메커니즘, 공식·수치, 구체적 예시, 논거, 실무 팁)를 서술하세요.
- 부분 결과들에 등장하는 모든 주제의 구체 지식(고유명사, 수치, 절차, 원리)을 앞뒤 순서와 무관하게 동일한 비중과 구체성으로 보존하세요. 특정 주제를 한 문장으로 뭉뚱그리지 마세요 — 뒤쪽 구간의 주제도 앞쪽 주제와 같은 수준의 구체성으로 서술해야 합니다.
- 메타 서술 금지: "~에 대해 설명합니다", "~을 다룹니다", "~을 이야기합니다", "~을 소개합니다" 류의 표현을 어떤 필드에서도 쓰지 마세요.
- 자체 점검(self-check): 출력을 확정하기 전에 각 필드를 다시 읽고, "~합니다/됩니다/다룹니다/설명합니다/강조됩니다"처럼 내용 없이 언급만 하는 문장을 발견하면 그 문장을 해당 내용의 실제 지식 서술로 교체하세요. 교체할 실제 내용이 부분 결과에 없으면 그 문장을 삭제하세요.
- 잡담·인사·운영 멘트(접속 확인, 휴식 안내 등)는 학습 자료에 포함하지 마세요.
규칙:
- 모든 출력은 한국어로 작성합니다.
- shortSummary: 3~5문장. 강의의 핵심 주제와 결론을 담습니다.
- fullSummary: 학습 노트 스타일의 여러 단락. 영상을 안 보고 이 글만 읽어도 실제로 배우는 것이 있어야 합니다 — 핵심 개념의 정의, 왜 그런지(원리·논거), 어떻게 쓰는지(예시·팁)를 실제 내용으로 담으세요. 마크다운 기호(#, *, - 등) 없이 순수한 평문 단락들로 작성하고, 단락 구분은 빈 줄로만 합니다.
- timeline: timeSec 오름차순으로 정렬하고, 모든 timeSec 은 0 이상, 영상 길이 이내여야 합니다. 주요 전환점 위주로 6~15개.
- chapters: 주제가 전환될 때마다 챕터를 분리하세요. 가이드: 대략 10~20분(600~1200초)당 1개, 영상 길이가 30분(1800초)을 넘으면 최소 3개 이상. 구간이 서로 겹치지 않게 하고(startSec < endSec, 다음 챕터의 startSec 은 이전 endSec 이상), 영상 전체를 자연스럽게 커버하세요. notes 는 해당 구간의 지식을 자기완결적으로 정리한 학습 노트로, 그 챕터만 읽어도 해당 구간을 복습할 수 있어야 합니다.
- keyConcepts: 강의의 핵심 개념 5~12개. description 에 정의와 핵심 원리를 실제 내용으로 담으세요.
- glossary: 학습자가 찾아볼 만한 용어 목록. definition 은 강의에서 설명된 내용에 근거한 정의여야 합니다.
- quizzes: 반드시 빈 배열 [] 로 출력하세요. 퀴즈는 별도 단계에서 생성됩니다.
- actionItems: 강의 내용에 근거해 학습자가 실천·복습할 구체적 항목 3~7개.
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

  // 챕터 개수 가이드: 대략 10~20분당 1개, 30분 초과 영상은 최소 3개
  const minChapters = durationSec > 1800 ? Math.max(3, Math.floor(durationSec / 1200)) : 1;
  const maxChapters = Math.max(minChapters, Math.ceil(durationSec / 600));

  return `전체 영상 길이: ${formatSec(durationSec)}초 (모든 타임스탬프는 0 ~ ${formatSec(durationSec)}초 범위여야 함)
이 영상 길이 기준 챕터 개수 가이드: 약 ${minChapters}~${maxChapters}개 (주제 전환 지점마다 분리)

아래는 영상을 구간별로 분석한 부분 결과들입니다. 이를 모두 통합해 최종 학습 자료 JSON 을 생성하세요.

${sections.join("\n\n")}`;
}

/* -------------------------------------------------------------------------- */
/* 3단계(quiz): 최종 학습 자료 기반 퀴즈 생성 (근거 보장 별도 패스)               */
/* -------------------------------------------------------------------------- */

/**
 * 퀴즈 패스 응답 스키마. chatJson 은 JSON 객체 하나를 기대하므로
 * z.array(QuizSchema) 를 quizzes 필드로 감싼 객체로 검증한다.
 */
const QuizPassSchema = z.object({
  quizzes: z.array(QuizSchema).min(1),
});

const QUIZ_SYSTEM_PROMPT = `당신은 주어진 학습 자료(전체 요약, 챕터별 학습 노트, 핵심 개념, 용어집)만을 근거로 복습 퀴즈를 출제하는 전문 출제자입니다.
반드시 아래 형식의 JSON 객체 하나만 출력하세요 (다른 텍스트, 코드펜스 금지):
{
  "quizzes": [{ "question": "문제", "choices": ["보기1", "보기2", "보기3", "보기4"], "answer": "정답", "explanation": "해설" }]
}
절대 규칙 — 근거 제한:
- 아래 user 메시지로 제공되는 자료에 명시된 내용만으로 문제·정답·해설을 구성하세요.
- 자료 밖의 배경지식, 일반 상식, 추론으로 보충한 사실을 문제·보기·정답·해설 어디에도 사용하지 마세요. 자료에 근거를 찾을 수 없는 문제는 만들지 마세요.
- explanation 에는 정답의 근거가 되는 자료 내 내용을 반영해 서술하세요 (자료의 어떤 설명 때문에 정답인지가 드러나야 합니다).
출제 규칙:
- 모든 텍스트는 한국어로 작성합니다.
- 총 4~8문항.
- 객관식 문제는 choices 배열에 보기 4개를 포함하고, answer 는 choices 중 하나와 문자열이 정확히 일치해야 합니다.
- 오답 보기는 자료의 주제 범위 안에서 그럴듯하되 자료 내용과 명확히 구별되게 만드세요.
- 특정 챕터에 편중되지 않게 자료 전체에서 고르게 출제하세요.`;

/**
 * 퀴즈 패스 입력은 최종 학습 자료 텍스트로만 제한한다
 * (fullSummary + chapters.notes + keyConcepts + glossary — 전사·부분 결과 금지).
 * 요약에 없는 내용이 출제될 수 없도록 입력 단계에서 차단하는 것이 핵심이다.
 */
function buildQuizUserPrompt(result: SummaryResult): string {
  const chapterNotes = result.chapters
    .map((ch, i) => `${i + 1}. ${ch.title}\n${ch.notes}`)
    .join("\n\n");
  const concepts = result.keyConcepts
    .map((c) => `- ${c.term}: ${c.description}`)
    .join("\n");
  const glossary = result.glossary
    .map((g) => `- ${g.term}: ${g.definition}`)
    .join("\n");

  return `아래 학습 자료에 명시된 내용만을 근거로 복습 퀴즈 4~8문항을 출제해 지정된 JSON 형식으로만 답하세요.

## 전체 요약
${result.fullSummary}

## 챕터별 학습 노트
${chapterNotes || "(없음)"}

## 핵심 개념
${concepts || "(없음)"}

## 용어집
${glossary || "(없음)"}`;
}

/**
 * 최종 학습 자료만을 입력으로 퀴즈를 생성한다.
 * chatJson 이 재시도까지 소진하며 실패하면 그대로 throw 한다
 * (파이프라인 FAILED 수렴 — 부분 성공으로 넘어가지 않는다).
 */
async function generateQuizzes(result: SummaryResult): Promise<Quiz[]> {
  const { quizzes } = await chatJson({
    system: QUIZ_SYSTEM_PROMPT,
    user: buildQuizUserPrompt(result),
    schema: QuizPassSchema,
  });
  return quizzes;
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
  /**
   * map 단계 진행 콜백 (옵셔널 — 미전달 시 기존 동작과 동일).
   * 청크 하나의 부분 요약이 완료될 때마다 (완료수, 총수=chunks.length) 로
   * 호출된다. gist / 계층적 merge / 최종 reduce 는 보고하지 않는다.
   */
  onProgress?: (completed: number, total: number) => void;
}): Promise<SummaryResult> {
  const { durationSec, chunks, onProgress } = input;

  if (chunks.length === 0) {
    throw new Error("요약할 전사 내용이 없습니다 (청크 0개).");
  }

  // 0단계(gist): 전체 요지 선행 패스 — 실패해도 빈 gist 로 계속
  const gist = await generateGist(chunks, durationSec);

  // 1단계(map): 청크 동시 MAP_CONCURRENCY 개 병렬 처리, 인덱스 순 재조립
  const total = chunks.length;
  let completed = 0;
  const mapResults = await runPool(
    chunks,
    MAP_CONCURRENCY,
    async (chunk, index): Promise<RangedPartial> => {
      const prevChunk = index > 0 ? chunks[index - 1] : undefined;
      const partial = await chatJson({
        system: MAP_SYSTEM_PROMPT,
        user: buildMapUserPrompt(chunk, total, durationSec, gist, prevChunk),
        schema: PartialResultSchema,
      });
      completed += 1;
      onProgress?.(completed, total);
      return {
        partial,
        startSec: chunk.startSec,
        endSec: chunk.endSec,
      };
    },
  );

  // 1.5단계(계층적 merge): 부분 결과가 많으면(4시간+ 영상) 그룹 단위로
  // 중간 통합해 최종 reduce 프롬프트의 컨텍스트 초과를 방지
  const reduced = await hierarchicalMerge(mapResults, durationSec);

  // 2단계(reduce): 부분 결과 통합 → 최종 학습 자료 (quizzes 는 빈 배열로 출력됨)
  const result = await chatJson({
    system: REDUCE_SYSTEM_PROMPT,
    user: buildReduceUserPrompt(reduced, durationSec),
    schema: SummaryResultSchema,
  });

  // 3단계(quiz): 최종 학습 자료만 입력으로 퀴즈 생성 → 병합 후 재검증.
  // 실패(재시도 소진) 시 throw 되어 파이프라인이 FAILED 로 수렴한다.
  const quizzes = await generateQuizzes(result);
  const finalResult = SummaryResultSchema.parse({ ...result, quizzes });

  return clampSummary(finalResult, durationSec);
}

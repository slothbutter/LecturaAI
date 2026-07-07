"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  BookOpenText,
  Clock,
  FileVideo,
  Home,
  ListChecks,
  TriangleAlert,
} from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import {
  TranscriptSegmentSchema,
  type SummaryResult,
  type TranscriptSegment,
} from "@/lib/schemas";
import { EmptyState } from "@/components/results/empty-state";
import { formatTime, formatTimeRange } from "@/components/results/format";
import { QuizItem } from "@/components/results/quiz-item";
import { sanitizeSummary } from "@/components/results/sanitize";

type Phase = "loading" | "notFound" | "loadError" | "ready";

interface VideoMeta {
  originalName: string;
  durationSec: number | null;
}

interface TranscriptState {
  language: string | null;
  segments: TranscriptSegment[];
}

interface ResultsScreenProps {
  videoId: string;
}

/** 전사 세그먼트 배열을 방어적으로 검증해 유효한 항목만 남긴다. */
function pickValidSegments(value: unknown): TranscriptSegment[] {
  if (!Array.isArray(value)) return [];
  const result: TranscriptSegment[] = [];
  for (const item of value) {
    const parsed = TranscriptSegmentSchema.safeParse(item);
    if (parsed.success) result.push(parsed.data);
  }
  return result;
}

export function ResultsScreen({ videoId }: ResultsScreenProps) {
  const router = useRouter();
  const videoRef = React.useRef<HTMLVideoElement>(null);

  const [phase, setPhase] = React.useState<Phase>("loading");
  const [meta, setMeta] = React.useState<VideoMeta | null>(null);
  const [summary, setSummary] = React.useState<Partial<SummaryResult>>({});
  const [transcript, setTranscript] = React.useState<TranscriptState>({
    language: null,
    segments: [],
  });

  /* ------------------------------------------------------------------ */
  /* 데이터 로드: video 메타 → (COMPLETED 확인) → summary + transcript      */
  /* ------------------------------------------------------------------ */
  React.useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const videoRes = await fetch(`/api/videos/${videoId}`, {
          cache: "no-store",
        });
        if (cancelled) return;

        if (videoRes.status === 404) {
          setPhase("notFound");
          return;
        }
        if (!videoRes.ok) {
          setPhase("loadError");
          return;
        }

        const videoData = await videoRes.json().catch(() => null);
        if (cancelled) return;
        if (!videoData) {
          setPhase("loadError");
          return;
        }

        const jobStatus: string | null =
          typeof videoData?.job?.status === "string"
            ? videoData.job.status
            : null;

        // 아직 처리 중이거나 실패한 영상은 처리 화면에서 상태/재시도를 다룬다.
        if (jobStatus !== "COMPLETED") {
          router.replace(`/processing/${videoId}`);
          return;
        }

        setMeta({
          originalName:
            typeof videoData.originalName === "string"
              ? videoData.originalName
              : "",
          durationSec:
            typeof videoData.durationSec === "number"
              ? videoData.durationSec
              : null,
        });

        const [summaryRes, transcriptRes] = await Promise.all([
          fetch(`/api/videos/${videoId}/summary`, { cache: "no-store" }),
          fetch(`/api/videos/${videoId}/transcript`, { cache: "no-store" }),
        ]);
        if (cancelled) return;

        if (!summaryRes.ok) {
          // COMPLETED 인데 요약이 없는 비정상 상태 — 오류 화면으로 안내
          setPhase("loadError");
          return;
        }
        const summaryBody = await summaryRes.json().catch(() => null);
        if (cancelled) return;
        setSummary(
          sanitizeSummary(
            (summaryBody as { data?: unknown } | null)?.data ?? null,
          ),
        );

        // 전사는 부가 정보 — 실패해도 결과 화면 자체는 보여준다.
        if (transcriptRes.ok) {
          const transcriptBody = await transcriptRes.json().catch(() => null);
          if (cancelled) return;
          setTranscript({
            language:
              typeof (transcriptBody as { language?: unknown } | null)
                ?.language === "string"
                ? ((transcriptBody as { language: string }).language)
                : null,
            segments: pickValidSegments(
              (transcriptBody as { segments?: unknown } | null)?.segments,
            ),
          });
        }

        setPhase("ready");
      } catch {
        if (!cancelled) setPhase("loadError");
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [videoId, router]);

  /** 타임라인/챕터/전사 클릭 시 해당 시점으로 플레이어 이동 */
  const seekTo = React.useCallback((sec: number | null | undefined) => {
    const el = videoRef.current;
    if (!el || typeof sec !== "number" || !Number.isFinite(sec)) return;
    el.currentTime = Math.max(0, sec);
    el.play().catch(() => {
      // 자동 재생이 차단되어도 위치 이동 자체는 유지된다.
    });
    el.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, []);

  /* ------------------------------------------------------------------ */
  /* 오류 / 로딩 상태                                                     */
  /* ------------------------------------------------------------------ */
  if (phase === "notFound" || phase === "loadError") {
    const isNotFound = phase === "notFound";
    return (
      <main className="flex min-h-screen flex-col items-center justify-center p-6">
        <Card className="w-full max-w-md text-center">
          <CardHeader>
            <div className="mx-auto mb-2 flex size-12 items-center justify-center rounded-full bg-destructive/10 text-destructive">
              <TriangleAlert className="size-6" />
            </div>
            <CardTitle className="text-lg">
              {isNotFound
                ? "영상을 찾을 수 없습니다"
                : "결과를 불러오지 못했습니다"}
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col items-center gap-4">
            <p className="text-sm text-muted-foreground">
              {isNotFound
                ? "요청하신 영상이 존재하지 않거나 삭제되었습니다."
                : "학습 결과를 불러오는 중 문제가 발생했습니다. 잠시 후 다시 시도해 주세요."}
            </p>
            <div className="flex flex-wrap justify-center gap-2">
              {!isNotFound ? (
                <Button
                  variant="outline"
                  render={<Link href={`/processing/${videoId}`} />}
                  nativeButton={false}
                >
                  처리 상태 확인
                </Button>
              ) : null}
              <Button render={<Link href="/" />} nativeButton={false}>
                <Home data-icon="inline-start" />
                홈으로 돌아가기
              </Button>
            </div>
          </CardContent>
        </Card>
      </main>
    );
  }

  if (phase === "loading" || !meta) {
    return (
      <main className="mx-auto flex min-h-screen w-full max-w-4xl flex-col gap-4 p-6">
        <Skeleton className="h-8 w-1/2" />
        <Skeleton className="aspect-video w-full rounded-xl" />
        <Skeleton className="h-8 w-2/3" />
        <Skeleton className="h-40 w-full rounded-xl" />
      </main>
    );
  }

  /* ------------------------------------------------------------------ */
  /* 본 화면                                                              */
  /* ------------------------------------------------------------------ */
  const forceHours = (meta.durationSec ?? 0) >= 3600;
  const timeline = summary.timeline ?? [];
  const chapters = summary.chapters ?? [];
  const keyConcepts = summary.keyConcepts ?? [];
  const glossary = summary.glossary ?? [];
  const quizzes = summary.quizzes ?? [];
  const actionItems = summary.actionItems ?? [];
  const segments = transcript.segments ?? [];

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-4xl flex-col gap-5 p-6">
      {/* 헤더 */}
      <header className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <FileVideo className="size-4.5" />
          </span>
          <div className="min-w-0">
            <h1
              className="truncate text-lg font-semibold tracking-tight"
              title={meta.originalName}
            >
              {meta.originalName || "업로드한 영상"}
            </h1>
            <p className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1">
                <Clock className="size-3" aria-hidden="true" />
                {formatTime(meta.durationSec, forceHours)}
              </span>
              {transcript.language ? (
                <Badge variant="secondary">{transcript.language}</Badge>
              ) : null}
            </p>
          </div>
        </div>
        <Button
          variant="outline"
          size="sm"
          render={<Link href="/" />}
          nativeButton={false}
        >
          <Home data-icon="inline-start" />새 영상 분석
        </Button>
      </header>

      {/* 플레이어 */}
      <video
        ref={videoRef}
        src={`/api/videos/${videoId}/stream`}
        controls
        preload="metadata"
        className="aspect-video w-full rounded-xl border bg-black"
      >
        브라우저가 동영상 재생을 지원하지 않습니다.
      </video>

      {/* 한 줄 요약 */}
      {summary.shortSummary ? (
        <Alert>
          <BookOpenText />
          <AlertTitle>한 줄 요약</AlertTitle>
          <AlertDescription>{summary.shortSummary}</AlertDescription>
        </Alert>
      ) : null}

      {/* 탭 */}
      <Tabs defaultValue="summary">
        <TabsList className="w-full overflow-x-auto">
          <TabsTrigger value="summary">요약</TabsTrigger>
          <TabsTrigger value="timeline">타임라인</TabsTrigger>
          <TabsTrigger value="chapters">챕터</TabsTrigger>
          <TabsTrigger value="concepts">개념·용어</TabsTrigger>
          <TabsTrigger value="quizzes">퀴즈</TabsTrigger>
          <TabsTrigger value="transcript">전사</TabsTrigger>
          <TabsTrigger value="actions">액션 아이템</TabsTrigger>
        </TabsList>

        {/* 요약 */}
        <TabsContent value="summary">
          <Card>
            <CardHeader>
              <CardTitle>전체 요약</CardTitle>
            </CardHeader>
            <CardContent>
              {summary.fullSummary ? (
                <p className="text-sm leading-6 whitespace-pre-wrap">
                  {summary.fullSummary}
                </p>
              ) : (
                <EmptyState message="생성된 요약이 없습니다." />
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* 타임라인 */}
        <TabsContent value="timeline">
          <Card>
            <CardHeader>
              <CardTitle>타임라인</CardTitle>
            </CardHeader>
            <CardContent>
              {timeline.length > 0 ? (
                <ol className="flex flex-col">
                  {timeline.map((item, i) => (
                    <li key={i}>
                      <button
                        type="button"
                        onClick={() => seekTo(item?.timeSec)}
                        className="flex w-full items-baseline gap-3 rounded-lg px-2 py-2 text-left text-sm transition-colors hover:bg-muted/60"
                      >
                        <span className="shrink-0 font-mono text-xs text-primary tabular-nums">
                          {formatTime(item?.timeSec, forceHours)}
                        </span>
                        <span className="whitespace-pre-wrap">
                          {item?.label ?? ""}
                        </span>
                      </button>
                    </li>
                  ))}
                </ol>
              ) : (
                <EmptyState message="생성된 타임라인이 없습니다." />
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* 챕터 */}
        <TabsContent value="chapters">
          {chapters.length > 0 ? (
            <div className="flex flex-col gap-3">
              {chapters.map((chapter, i) => (
                <Card key={i}>
                  <CardHeader>
                    <CardTitle className="flex flex-wrap items-baseline justify-between gap-2 text-base">
                      <span className="whitespace-pre-wrap">
                        {chapter?.title ?? ""}
                      </span>
                      <button
                        type="button"
                        onClick={() => seekTo(chapter?.startSec)}
                        className="shrink-0 font-mono text-xs font-normal text-primary tabular-nums hover:underline"
                      >
                        {formatTimeRange(
                          chapter?.startSec,
                          chapter?.endSec,
                          forceHours,
                        )}
                      </button>
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-sm leading-6 whitespace-pre-wrap text-muted-foreground">
                      {chapter?.notes ?? ""}
                    </p>
                  </CardContent>
                </Card>
              ))}
            </div>
          ) : (
            <EmptyState message="생성된 챕터가 없습니다." />
          )}
        </TabsContent>

        {/* 핵심 개념 + 용어집 */}
        <TabsContent value="concepts">
          <div className="flex flex-col gap-4">
            <Card>
              <CardHeader>
                <CardTitle>핵심 개념</CardTitle>
              </CardHeader>
              <CardContent>
                {keyConcepts.length > 0 ? (
                  <dl className="flex flex-col gap-3">
                    {keyConcepts.map((concept, i) => (
                      <div key={i}>
                        <dt className="text-sm font-semibold">
                          {concept?.term ?? ""}
                        </dt>
                        <dd className="mt-0.5 text-sm leading-6 whitespace-pre-wrap text-muted-foreground">
                          {concept?.description ?? ""}
                        </dd>
                      </div>
                    ))}
                  </dl>
                ) : (
                  <EmptyState message="생성된 핵심 개념이 없습니다." />
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>용어집</CardTitle>
              </CardHeader>
              <CardContent>
                {glossary.length > 0 ? (
                  <dl className="flex flex-col gap-3">
                    {glossary.map((item, i) => (
                      <div key={i}>
                        <dt className="text-sm font-semibold">
                          {item?.term ?? ""}
                        </dt>
                        <dd className="mt-0.5 text-sm leading-6 whitespace-pre-wrap text-muted-foreground">
                          {item?.definition ?? ""}
                        </dd>
                      </div>
                    ))}
                  </dl>
                ) : (
                  <EmptyState message="생성된 용어가 없습니다." />
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* 퀴즈 */}
        <TabsContent value="quizzes">
          {quizzes.length > 0 ? (
            <div className="flex flex-col gap-3">
              {quizzes.map((quiz, i) => (
                <QuizItem key={i} quiz={quiz} index={i} />
              ))}
            </div>
          ) : (
            <EmptyState message="생성된 퀴즈가 없습니다." />
          )}
        </TabsContent>

        {/* 전사 */}
        <TabsContent value="transcript">
          <Card>
            <CardHeader>
              <CardTitle>전사 스크립트</CardTitle>
            </CardHeader>
            <CardContent>
              {segments.length > 0 ? (
                <ol className="flex max-h-[28rem] flex-col overflow-y-auto pr-1">
                  {segments.map((segment, i) => (
                    <li key={i}>
                      <button
                        type="button"
                        onClick={() => seekTo(segment?.start)}
                        className="flex w-full items-baseline gap-3 rounded-lg px-2 py-1.5 text-left text-sm transition-colors hover:bg-muted/60"
                      >
                        <span className="shrink-0 font-mono text-xs text-primary tabular-nums">
                          {formatTime(segment?.start, forceHours)}
                        </span>
                        <span className="whitespace-pre-wrap">
                          {segment?.text ?? ""}
                        </span>
                      </button>
                    </li>
                  ))}
                </ol>
              ) : (
                <EmptyState message="전사 결과가 없습니다." />
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* 액션 아이템 */}
        <TabsContent value="actions">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-1.5">
                <ListChecks className="size-4 text-primary" />
                학습 액션 아이템
              </CardTitle>
            </CardHeader>
            <CardContent>
              {actionItems.length > 0 ? (
                <ul className="flex list-disc flex-col gap-1.5 pl-5 text-sm">
                  {actionItems.map((item, i) => (
                    <li key={i} className="whitespace-pre-wrap">
                      {item}
                    </li>
                  ))}
                </ul>
              ) : (
                <EmptyState message="생성된 액션 아이템이 없습니다." />
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </main>
  );
}

"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  FileVideo,
  Home,
  LoaderCircle,
  RotateCcw,
  TriangleAlert,
  WifiOff,
} from "lucide-react";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Progress,
  ProgressLabel,
  ProgressValue,
} from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import {
  JOB_STATUS_LABELS,
  JOB_STEPS,
  PROGRESS_BY_STATUS,
} from "@/lib/schemas";
import { StepChecklist } from "@/components/processing/step-checklist";

const POLL_INTERVAL_MS = 2500;
const MAX_SILENT_FAILURES = 5;

type Phase = "loading" | "notFound" | "loadError" | "ready";

interface JobState {
  id: string;
  status: string;
  progress: number;
  errorMessage: string | null;
  attempts: number | null;
  /** 잡 종료 시각 (ISO 문자열) — 재시도 후 낡은 FAILED 응답 판별에 사용 */
  finishedAt: string | null;
}

/**
 * 재시도 클릭 시점의 실패 잡 스냅샷.
 * 폴링 응답의 FAILED 가 이 값보다 새로우면(더 늦은 finishedAt 또는 증가한
 * attempts) 재시도 이후의 새 실패이므로 즉시 표시하고, 그렇지 않으면
 * 재시도가 아직 반영되지 않은 낡은 응답이므로 무시한다.
 */
interface RetryBaseline {
  finishedAt: string | null;
  attempts: number | null;
}

interface ProcessingScreenProps {
  videoId: string;
}

/**
 * 서버가 내려준 progress(0~100)를 PROGRESS_BY_STATUS 로 역매핑해
 * 실패한 단계 인덱스를 계산한다 (예: progress 30 → TRANSCRIBING).
 * progress 이하의 임계값을 갖는 마지막 단계가 실패 지점이다.
 */
function failedStepIndexFromProgress(progress: number): number {
  const clamped = Math.min(Math.max(progress, 0), 100);
  let index = 0;
  for (const [i, step] of JOB_STEPS.entries()) {
    if (step.status === "COMPLETED") break;
    if (clamped >= PROGRESS_BY_STATUS[step.status]) index = i;
  }
  return index;
}

export function ProcessingScreen({ videoId }: ProcessingScreenProps) {
  const router = useRouter();

  const [phase, setPhase] = React.useState<Phase>("loading");
  const [fileName, setFileName] = React.useState<string>("");
  const [job, setJob] = React.useState<JobState | null>(null);
  const [polling, setPolling] = React.useState(false);
  const [failCount, setFailCount] = React.useState(0);
  const [retrying, setRetrying] = React.useState(false);
  const [retryError, setRetryError] = React.useState<string | null>(null);
  /** 재시도 클릭 시점의 실패 잡 스냅샷 — null 이면 재시도 대기 중이 아님 */
  const retryBaselineRef = React.useRef<RetryBaseline | null>(null);

  /* ------------------------------------------------------------------ */
  /* 1) 진입 시 video + job 조회                                          */
  /* ------------------------------------------------------------------ */
  React.useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const res = await fetch(`/api/videos/${videoId}`, {
          cache: "no-store",
        });
        if (cancelled) return;

        if (res.status === 404) {
          setPhase("notFound");
          return;
        }
        if (!res.ok) {
          setPhase("loadError");
          return;
        }

        const data = await res.json().catch(() => null);
        if (cancelled) return;
        if (!data) {
          setPhase("loadError");
          return;
        }

        setFileName(
          typeof data.originalName === "string" ? data.originalName : "",
        );

        const j = data.job;
        if (!j?.id) {
          // 영상은 있으나 처리 작업 레코드가 없는 비정상 상태
          setPhase("loadError");
          return;
        }

        const status: string =
          typeof j.status === "string" ? j.status : "UPLOADED";

        setJob({
          id: j.id,
          status,
          progress: typeof j.progress === "number" ? j.progress : 0,
          errorMessage:
            typeof j.errorMessage === "string" ? j.errorMessage : null,
          // attempts / finishedAt 은 /api/jobs 폴링 첫 응답에서 채워진다
          attempts: null,
          finishedAt: null,
        });
        setPhase("ready");

        if (status === "COMPLETED") {
          router.replace(`/results/${videoId}`);
          return;
        }
        // FAILED 여도 attempts 확보를 위해 한 번은 폴링을 돈다.
        // (폴링 틱이 FAILED 를 확인하면 스스로 멈춘다)
        setPolling(true);
      } catch {
        if (!cancelled) setPhase("loadError");
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [videoId, router]);

  const jobId = job?.id ?? null;

  /* ------------------------------------------------------------------ */
  /* 2) GET /api/jobs/[jobId] 2.5초 폴링                                  */
  /* ------------------------------------------------------------------ */
  React.useEffect(() => {
    if (!jobId || !polling) return;

    let cancelled = false;
    let inFlight = false;

    async function tick() {
      if (inFlight || cancelled) return;
      inFlight = true;
      try {
        const res = await fetch(`/api/jobs/${jobId}`, { cache: "no-store" });
        if (cancelled) return;

        if (!res.ok) {
          // 서버 오류/일시 장애 — 조용히 다음 틱에 재시도
          setFailCount((n) => n + 1);
          return;
        }

        const data = await res.json().catch(() => null);
        if (cancelled) return;
        if (!data || typeof data.status !== "string") {
          setFailCount((n) => n + 1);
          return;
        }

        setFailCount(0);

        const status: string = data.status;
        const attempts: number | null =
          typeof data.attempts === "number" ? data.attempts : null;
        const finishedAt: string | null =
          typeof data.finishedAt === "string" ? data.finishedAt : null;

        // 재시도(202) 직후 파이프라인이 잡을 리셋하기 전의 낡은 FAILED 판별:
        // 재시도 클릭 시점 스냅샷보다 새로운 finishedAt(또는 증가한 attempts)이면
        // 재시도 이후의 새 실패이므로 즉시 표시하고, 그렇지 않으면(재시도 반영 전
        // 응답) 무시하고 다음 틱을 기다린다.
        if (status === "FAILED" && retryBaselineRef.current) {
          const baseline = retryBaselineRef.current;
          const newerFinishedAt =
            finishedAt != null &&
            baseline.finishedAt != null &&
            Date.parse(finishedAt) > Date.parse(baseline.finishedAt);
          const moreAttempts =
            attempts != null &&
            baseline.attempts != null &&
            attempts > baseline.attempts;
          const comparable =
            baseline.finishedAt != null || baseline.attempts != null;
          if (comparable && !newerFinishedAt && !moreAttempts) {
            // 재시도 반영 전의 낡은 FAILED — 무시
            return;
          }
        }
        // FAILED 가 아니면 재시도가 반영된 것이고, 새 FAILED 면 위에서 통과했다.
        retryBaselineRef.current = null;

        setJob((prev) => ({
          id: prev?.id ?? jobId!,
          status,
          progress: typeof data.progress === "number" ? data.progress : 0,
          errorMessage:
            typeof data.errorMessage === "string" ? data.errorMessage : null,
          attempts,
          finishedAt,
        }));

        if (status === "COMPLETED") {
          setPolling(false);
          router.replace(`/results/${videoId}`);
        } else if (status === "FAILED") {
          setPolling(false);
        }
      } catch {
        // 네트워크 순단 — 조용히 다음 틱에 재시도
        if (!cancelled) setFailCount((n) => n + 1);
      } finally {
        inFlight = false;
      }
    }

    tick();
    const intervalId = setInterval(tick, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, [jobId, polling, videoId, router]);

  /* ------------------------------------------------------------------ */
  /* 3) 재시도                                                            */
  /* ------------------------------------------------------------------ */
  async function handleRetry() {
    if (retrying) return;
    setRetrying(true);
    setRetryError(null);
    try {
      const res = await fetch(`/api/videos/${videoId}/retry`, {
        method: "POST",
      });
      const data = await res.json().catch(() => null);

      if (res.status === 202) {
        // 재시도 클릭 시점의 실패 잡 스냅샷 저장 — 이후 폴링에서
        // 이보다 낡은 FAILED(재시도 반영 전 응답)만 무시한다.
        retryBaselineRef.current = {
          finishedAt: job?.finishedAt ?? null,
          attempts: job?.attempts ?? null,
        };
        // 폴링 재개 (attempts/errorMessage 는 다음 폴링 응답이 갱신)
        setJob((prev) =>
          prev
            ? { ...prev, status: "UPLOADED", progress: 0, errorMessage: null }
            : prev,
        );
        setFailCount(0);
        setPolling(true);
      } else {
        setRetryError(
          typeof data?.error === "string"
            ? data.error
            : "재시도 요청에 실패했습니다. 잠시 후 다시 시도해 주세요.",
        );
      }
    } catch {
      setRetryError("네트워크 오류로 재시도 요청에 실패했습니다.");
    } finally {
      setRetrying(false);
    }
  }

  /* ------------------------------------------------------------------ */
  /* 렌더링                                                               */
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
                : "정보를 불러오지 못했습니다"}
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col items-center gap-4">
            <p className="text-sm text-muted-foreground">
              {isNotFound
                ? "요청하신 영상이 존재하지 않거나 삭제되었습니다."
                : "영상 처리 정보를 불러오는 중 문제가 발생했습니다. 잠시 후 다시 시도해 주세요."}
            </p>
            <Button render={<Link href="/" />} nativeButton={false}>
              <Home data-icon="inline-start" />
              홈으로 돌아가기
            </Button>
          </CardContent>
        </Card>
      </main>
    );
  }

  if (phase === "loading" || !job) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center p-6">
        <Card className="w-full max-w-lg">
          <CardHeader>
            <Skeleton className="h-5 w-2/3" />
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <Skeleton className="h-2 w-full" />
            <Skeleton className="h-4 w-1/3" />
            <div className="flex flex-col gap-3 pt-2">
              {(JOB_STEPS ?? []).map((step) => (
                <Skeleton key={step.status} className="h-6 w-full" />
              ))}
            </div>
          </CardContent>
        </Card>
      </main>
    );
  }

  const isFailed = job.status === "FAILED";
  const isCompleted = job.status === "COMPLETED";
  const progress = Math.min(Math.max(job.progress ?? 0, 0), 100);
  const statusLabel = JOB_STATUS_LABELS[job.status] ?? job.status;
  const failedStepIndex = isFailed
    ? failedStepIndexFromProgress(progress)
    : null;

  return (
    <main className="flex min-h-screen flex-col items-center justify-center p-6">
      <div className="flex w-full max-w-lg flex-col gap-4">
        <Card>
          <CardHeader>
            <div className="flex items-start justify-between gap-3">
              <div className="flex min-w-0 items-center gap-2.5">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <FileVideo className="size-4.5" />
                </span>
                <div className="min-w-0">
                  <CardTitle className="truncate text-base" title={fileName}>
                    {fileName || "업로드한 영상"}
                  </CardTitle>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    AI가 강의 내용을 분석하고 있습니다
                  </p>
                </div>
              </div>
              {job.attempts != null && job.attempts > 1 && (
                <Badge variant="secondary" className="shrink-0">
                  {job.attempts}번째 시도
                </Badge>
              )}
            </div>
          </CardHeader>

          <CardContent className="flex flex-col gap-5">
            {/* 전체 진행률 */}
            <Progress value={progress} aria-label="전체 진행률">
              <ProgressLabel>전체 진행률</ProgressLabel>
              <ProgressValue className="tabular-nums" />
            </Progress>

            {/* 현재 단계 라벨 */}
            <div className="flex items-center gap-2 text-sm">
              {isFailed ? (
                <TriangleAlert className="size-4 text-destructive" />
              ) : isCompleted ? null : (
                <LoaderCircle className="size-4 animate-spin text-primary" />
              )}
              <span
                className={
                  isFailed
                    ? "font-medium text-destructive"
                    : "font-medium text-foreground"
                }
              >
                {statusLabel}
              </span>
            </div>

            {/* 실패 안내 + 재시도 */}
            {isFailed && (
              <Alert variant="destructive">
                <TriangleAlert />
                <AlertTitle>처리 중 오류가 발생했습니다</AlertTitle>
                <AlertDescription>
                  <p>
                    {job.errorMessage ||
                      "알 수 없는 오류로 처리가 중단되었습니다."}
                  </p>
                  {job.attempts != null && (
                    <p className="mt-1 text-xs">
                      지금까지 {job.attempts}회 시도했습니다.
                    </p>
                  )}
                  {retryError && (
                    <p className="mt-1 text-xs font-medium">{retryError}</p>
                  )}
                  <div className="mt-3">
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={handleRetry}
                      disabled={retrying}
                    >
                      {retrying ? (
                        <LoaderCircle
                          data-icon="inline-start"
                          className="animate-spin"
                        />
                      ) : (
                        <RotateCcw data-icon="inline-start" />
                      )}
                      재시도
                    </Button>
                  </div>
                </AlertDescription>
              </Alert>
            )}

            {/* 네트워크 순단 안내 (연속 5회 이상 폴링 실패 시) */}
            {!isFailed && failCount >= MAX_SILENT_FAILURES && (
              <Alert>
                <WifiOff />
                <AlertTitle>연결이 불안정합니다</AlertTitle>
                <AlertDescription>
                  진행 상태를 불러오지 못하고 있습니다. 네트워크 연결을 확인해
                  주세요. 계속해서 자동으로 재시도합니다.
                </AlertDescription>
              </Alert>
            )}

            <Separator />

            {/* 단계별 체크리스트 */}
            <StepChecklist
              status={job.status}
              failedStepIndex={failedStepIndex}
            />
          </CardContent>
        </Card>

        <p className="text-center text-xs text-muted-foreground">
          처리가 완료되면 결과 화면으로 자동 이동합니다. 이 페이지를 벗어나도
          처리는 계속됩니다.
        </p>
      </div>
    </main>
  );
}

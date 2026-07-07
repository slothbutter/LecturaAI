"use client";

import { Check, LoaderCircle, X } from "lucide-react";
import { JOB_STEPS } from "@/lib/schemas";
import { cn } from "@/lib/utils";

type StepVisualState = "done" | "current" | "pending" | "failed";

interface StepChecklistProps {
  /** 현재 잡 status (JobStatus 문자열, FAILED 포함) */
  status: string;
  /** status === "FAILED" 일 때 X 를 표시할 단계 인덱스 (JOB_STEPS 기준) */
  failedStepIndex: number | null;
}

function resolveStepState(
  index: number,
  status: string,
  failedStepIndex: number | null,
): StepVisualState {
  if (status === "COMPLETED") return "done";

  if (status === "FAILED") {
    const failedAt =
      failedStepIndex != null &&
      failedStepIndex >= 0 &&
      failedStepIndex < JOB_STEPS.length
        ? failedStepIndex
        : 0;
    if (index < failedAt) return "done";
    if (index === failedAt) return "failed";
    return "pending";
  }

  const currentIndex = Math.max(
    JOB_STEPS.findIndex((step) => step.status === status),
    0,
  );
  if (index < currentIndex) return "done";
  if (index === currentIndex) return "current";
  return "pending";
}

/**
 * JOB_STEPS 기반 단계별 체크리스트.
 * 완료=체크 / 현재=스피너 강조 / 대기=회색 / 실패=X (destructive)
 */
export function StepChecklist({ status, failedStepIndex }: StepChecklistProps) {
  return (
    <ol className="flex flex-col" aria-label="처리 단계 목록">
      {(JOB_STEPS ?? []).map((step, index) => {
        const state = resolveStepState(index, status, failedStepIndex);
        const isLast = index === JOB_STEPS.length - 1;

        return (
          <li key={step.status} className="flex gap-3">
            {/* 아이콘 + 세로 연결선 */}
            <div className="flex flex-col items-center">
              <span
                className={cn(
                  "flex size-6 shrink-0 items-center justify-center rounded-full border text-[0.65rem] transition-colors",
                  state === "done" &&
                    "border-primary bg-primary text-primary-foreground",
                  state === "current" &&
                    "border-primary/60 bg-primary/10 text-primary",
                  state === "pending" &&
                    "border-border bg-muted text-muted-foreground/60",
                  state === "failed" &&
                    "border-destructive bg-destructive/10 text-destructive",
                )}
                aria-hidden="true"
              >
                {state === "done" && <Check className="size-3.5" />}
                {state === "current" && (
                  <LoaderCircle className="size-3.5 animate-spin" />
                )}
                {state === "failed" && <X className="size-3.5" />}
                {state === "pending" && (
                  <span className="size-1.5 rounded-full bg-current" />
                )}
              </span>
              {!isLast && (
                <span
                  className={cn(
                    "my-0.5 w-px flex-1 min-h-4 rounded-full transition-colors",
                    state === "done" ? "bg-primary/60" : "bg-border",
                  )}
                  aria-hidden="true"
                />
              )}
            </div>

            {/* 라벨 */}
            <div className={cn("pb-4 pt-0.5", isLast && "pb-0")}>
              <p
                className={cn(
                  "text-sm leading-6 transition-colors",
                  state === "done" && "text-foreground",
                  state === "current" && "font-semibold text-primary",
                  state === "pending" && "text-muted-foreground/70",
                  state === "failed" && "font-semibold text-destructive",
                )}
              >
                {step.label}
                {state === "current" && (
                  <span className="sr-only"> (진행 중)</span>
                )}
                {state === "done" && <span className="sr-only"> (완료)</span>}
                {state === "failed" && (
                  <span className="sr-only"> (실패)</span>
                )}
              </p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

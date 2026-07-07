"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Progress,
  ProgressLabel,
  ProgressValue,
} from "@/components/ui/progress";

/** 서버 업로드 API(ALLOWED_EXTENSIONS)와 동일한 확장자 화이트리스트 */
const ALLOWED_EXTENSIONS = [
  ".mp4",
  ".mov",
  ".m4v",
  ".webm",
  ".mkv",
  ".avi",
] as const;

const ACCEPT_ATTR = ALLOWED_EXTENSIONS.join(",") + ",video/*";

type Phase = "idle" | "selected" | "uploading" | "processing" | "processFailed";

/** 파일 크기를 사람이 읽기 좋은 문자열로 변환 */
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "-";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"] as const;
  let value = bytes;
  let unit: string = "B";
  for (const u of units) {
    value /= 1024;
    unit = u;
    if (value < 1024) break;
  }
  return `${value.toFixed(1)} ${unit}`;
}

/** 클라이언트 사전 검증: 확장자 / MIME / 크기. 통과 시 null, 실패 시 한국어 메시지 */
function validateFile(file: File, maxUploadMb: number): string | null {
  const name = file.name ?? "";
  const dotIndex = name.lastIndexOf(".");
  const ext = dotIndex >= 0 ? name.slice(dotIndex).toLowerCase() : "";

  if (!(ALLOWED_EXTENSIONS as readonly string[]).includes(ext)) {
    return `지원하지 않는 파일 확장자입니다. (${ALLOWED_EXTENSIONS.join(", ")} 만 가능)`;
  }
  if (!(file.type ?? "").toLowerCase().startsWith("video/")) {
    return "동영상 파일(video/*)만 업로드할 수 있습니다.";
  }
  if (file.size > maxUploadMb * 1024 * 1024) {
    return `파일이 최대 업로드 크기(${maxUploadMb}MB)를 초과했습니다. (선택한 파일: ${formatBytes(file.size)})`;
  }
  return null;
}

/** 응답 본문에서 { error } 메시지를 방어적으로 추출 */
function extractErrorMessage(body: unknown, fallback: string): string {
  if (
    body !== null &&
    typeof body === "object" &&
    "error" in body &&
    typeof (body as { error: unknown }).error === "string"
  ) {
    return (body as { error: string }).error;
  }
  return fallback;
}

/** XMLHttpRequest 로 업로드 — fetch 는 업로드 진행률을 지원하지 않음 */
function uploadWithProgress(
  file: File,
  onProgress: (percent: number) => void,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/videos/upload");
    xhr.responseType = "json";

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) {
        onProgress(Math.min(100, Math.round((event.loaded / event.total) * 100)));
      }
    };

    xhr.onload = () => {
      resolve({ status: xhr.status, body: xhr.response as unknown });
    };
    xhr.onerror = () => {
      reject(new Error("네트워크 오류로 업로드에 실패했습니다."));
    };
    xhr.onabort = () => {
      reject(new Error("업로드가 중단되었습니다."));
    };

    const formData = new FormData();
    formData.append("file", file);
    xhr.send(formData);
  });
}

interface UploadFormProps {
  /**
   * 최대 업로드 크기(MB).
   * 단일 출처: 서버 .env 의 MAX_UPLOAD_MB — 서버 컴포넌트(src/app/page.tsx)가
   * "@/lib/env" 의 env.MAX_UPLOAD_MB 를 읽어 전달한다.
   */
  maxUploadMb: number;
}

export function UploadForm({ maxUploadMb }: UploadFormProps) {
  const router = useRouter();
  const inputRef = React.useRef<HTMLInputElement>(null);
  const dragDepthRef = React.useRef(0);

  const [phase, setPhase] = React.useState<Phase>("idle");
  const [file, setFile] = React.useState<File | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [progress, setProgress] = React.useState(0);
  const [isDragOver, setIsDragOver] = React.useState(false);
  /** 업로드(201)에 성공한 videoId — process 실패 시 재업로드 없이 재시도에 사용 */
  const [uploadedVideoId, setUploadedVideoId] = React.useState<string | null>(
    null,
  );

  const busy = phase === "uploading" || phase === "processing";

  const resetToIdle = React.useCallback(() => {
    setPhase("idle");
    setFile(null);
    setProgress(0);
    setUploadedVideoId(null);
    if (inputRef.current) inputRef.current.value = "";
  }, []);

  const handleFileSelected = React.useCallback(
    (selected: File | null) => {
      if (!selected) return;
      const validationError = validateFile(selected, maxUploadMb);
      if (validationError) {
        setError(validationError);
        setFile(null);
        setPhase("idle");
        setUploadedVideoId(null);
        if (inputRef.current) inputRef.current.value = "";
        return;
      }
      setError(null);
      setFile(selected);
      setUploadedVideoId(null);
      setPhase("selected");
    },
    [maxUploadMb],
  );

  const openFileDialog = React.useCallback(() => {
    if (busy) return;
    inputRef.current?.click();
  }, [busy]);

  const onInputChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    handleFileSelected(event.target.files?.[0] ?? null);
  };

  const onDragEnter = (event: React.DragEvent) => {
    event.preventDefault();
    if (busy) return;
    dragDepthRef.current += 1;
    setIsDragOver(true);
  };

  const onDragOver = (event: React.DragEvent) => {
    event.preventDefault();
  };

  const onDragLeave = (event: React.DragEvent) => {
    event.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setIsDragOver(false);
  };

  const onDrop = (event: React.DragEvent) => {
    event.preventDefault();
    dragDepthRef.current = 0;
    setIsDragOver(false);
    if (busy) return;
    handleFileSelected(event.dataTransfer?.files?.[0] ?? null);
  };

  /**
   * 처리 파이프라인 시작 요청.
   * 202/200 = 시작 성공, 409(이미 처리 중) 도 성공으로 취급해 처리 화면으로 이동.
   * 실패 시 업로드된 videoId 를 유지한 채 "processFailed" 로 전환해
   * 재업로드 없이 분석만 재시도할 수 있게 한다.
   */
  const startProcess = React.useCallback(
    async (videoId: string) => {
      setError(null);
      setPhase("processing");
      try {
        const res = await fetch(`/api/videos/${videoId}/process`, {
          method: "POST",
        });
        if (res.status === 202 || res.status === 200 || res.status === 409) {
          router.push(`/processing/${videoId}`);
          return;
        }
        let body: unknown = null;
        try {
          body = await res.json();
        } catch {
          // 본문이 JSON 이 아닌 경우 — fallback 메시지 사용
        }
        setError(
          extractErrorMessage(
            body,
            "분석 작업을 시작하지 못했습니다. 잠시 후 다시 시도해 주세요.",
          ),
        );
        setPhase("processFailed");
      } catch {
        setError("네트워크 오류로 분석 작업을 시작하지 못했습니다.");
        setPhase("processFailed");
      }
    },
    [router],
  );

  const startUpload = async () => {
    if (!file || busy || phase === "processFailed") return;

    // 제출 직전 재검증(선택 이후 상수/상태 불일치 방어)
    const validationError = validateFile(file, maxUploadMb);
    if (validationError) {
      setError(validationError);
      resetToIdle();
      return;
    }

    setError(null);
    setProgress(0);
    setPhase("uploading");

    // 1) 업로드 (XHR — 진행률 표시)
    let videoId: string | null = null;
    try {
      const { status, body } = await uploadWithProgress(file, setProgress);
      if (status !== 201) {
        setError(
          extractErrorMessage(body, "업로드에 실패했습니다. 잠시 후 다시 시도해 주세요."),
        );
        setPhase("selected");
        setProgress(0);
        return;
      }
      const id = (body as { video?: { id?: unknown } } | null)?.video?.id;
      if (typeof id !== "string" || id.length === 0) {
        setError("서버 응답을 해석할 수 없습니다. 잠시 후 다시 시도해 주세요.");
        setPhase("selected");
        setProgress(0);
        return;
      }
      videoId = id;
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "업로드 중 오류가 발생했습니다.",
      );
      setPhase("selected");
      setProgress(0);
      return;
    }

    // 2) 처리 파이프라인 시작 요청 (실패해도 videoId 는 유지 — 재업로드 불필요)
    setUploadedVideoId(videoId);
    await startProcess(videoId);
  };

  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle>동영상 업로드</CardTitle>
        <CardDescription>
          강의 영상 1개를 업로드하면 AI 학습 노트를 만들어 드립니다. (최대{" "}
          {maxUploadMb.toLocaleString()}MB)
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {error ? (
          <Alert variant="destructive">
            <AlertTitle>문제가 발생했습니다</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        <div
          role="button"
          tabIndex={busy ? -1 : 0}
          aria-label="동영상 파일 선택 또는 드래그 앤 드롭"
          aria-disabled={busy}
          onClick={openFileDialog}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              openFileDialog();
            }
          }}
          onDragEnter={onDragEnter}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
          className={[
            "flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed px-6 py-10 text-center transition-colors outline-none",
            "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
            busy
              ? "cursor-not-allowed opacity-60"
              : "cursor-pointer hover:border-primary/50 hover:bg-muted/40",
            isDragOver
              ? "border-primary bg-primary/5"
              : "border-border",
          ].join(" ")}
        >
          <svg
            aria-hidden="true"
            className="size-8 text-muted-foreground"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M12 16V4m0 0-4 4m4-4 4 4" />
            <path d="M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
          </svg>
          <p className="text-sm font-medium">
            {isDragOver
              ? "여기에 놓으면 파일이 선택됩니다"
              : "동영상 파일을 끌어다 놓거나 클릭하여 선택하세요"}
          </p>
          <p className="text-xs text-muted-foreground">
            {ALLOWED_EXTENSIONS.join(" · ")} / 최대{" "}
            {maxUploadMb.toLocaleString()}MB / 파일 1개
          </p>
          <input
            ref={inputRef}
            type="file"
            accept={ACCEPT_ATTR}
            className="hidden"
            onChange={onInputChange}
            disabled={busy}
          />
        </div>

        {file ? (
          <div className="flex items-center justify-between gap-3 rounded-lg border bg-muted/30 px-3 py-2">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium" title={file.name}>
                {file.name}
              </p>
              <p className="text-xs text-muted-foreground">
                {formatBytes(file.size)}
              </p>
            </div>
            {phase === "selected" || phase === "processFailed" ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={(event) => {
                  event.stopPropagation();
                  resetToIdle();
                }}
              >
                제거
              </Button>
            ) : null}
          </div>
        ) : null}

        {phase === "uploading" ? (
          <Progress value={progress}>
            <ProgressLabel>업로드 중…</ProgressLabel>
            <ProgressValue>{() => `${progress}%`}</ProgressValue>
          </Progress>
        ) : null}

        {phase === "processing" ? (
          <p className="text-sm text-muted-foreground" role="status">
            업로드 완료 — 분석 작업을 시작하는 중입니다…
          </p>
        ) : null}

        {phase === "processFailed" && uploadedVideoId ? (
          <>
            <p className="text-sm text-muted-foreground" role="status">
              업로드는 이미 완료되었습니다 — 재업로드 없이 분석만 다시
              시도합니다.
            </p>
            <Button
              className="w-full"
              onClick={() => startProcess(uploadedVideoId)}
            >
              분석 재시도
            </Button>
          </>
        ) : (
          <Button
            className="w-full"
            disabled={!file || busy}
            onClick={startUpload}
          >
            {busy ? (
              <>
                <svg
                  aria-hidden="true"
                  className="size-4 animate-spin"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                >
                  <path d="M12 3a9 9 0 1 0 9 9" />
                </svg>
                {phase === "uploading"
                  ? `업로드 중… ${progress}%`
                  : "분석 시작 요청 중…"}
              </>
            ) : (
              "업로드 및 분석 시작"
            )}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

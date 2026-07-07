import { createWriteStream, type WriteStream } from "node:fs";
import { unlink } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import Busboy from "busboy";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { MAX_UPLOAD_BYTES, env } from "@/lib/env";
import {
  buildUploadPath,
  ensureDirs,
  isPathInsideStorage,
  sanitizeFileName,
} from "@/lib/storage";
import { serializeVideo } from "@/lib/serialize";

export const runtime = "nodejs";

/** 허용 동영상 확장자 화이트리스트 */
const ALLOWED_EXTENSIONS = new Set([
  ".mp4",
  ".mov",
  ".m4v",
  ".webm",
  ".mkv",
  ".avi",
]);

/** HTTP 상태 코드를 동반하는 업로드 에러 */
class UploadError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "UploadError";
    this.status = status;
  }
}

interface ParsedUpload {
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  filePath: string;
}

/** 부분적으로 기록된 파일을 안전하게 삭제한다 (없어도 무시). */
async function cleanupPartialFile(filePath: string | null): Promise<void> {
  if (!filePath || !isPathInsideStorage(filePath)) return;
  try {
    await unlink(filePath);
  } catch {
    // 파일이 아직 생성되지 않았거나 이미 삭제된 경우 — 무시
  }
}

/**
 * multipart/form-data 요청 본문을 busboy로 스트리밍 파싱하여
 * "file" 필드 1개를 디스크에 직접 기록한다. 메모리 버퍼링 없음.
 */
function parseUpload(request: Request): Promise<ParsedUpload> {
  const contentType = request.headers.get("content-type") ?? "";

  return new Promise<ParsedUpload>((resolve, reject) => {
    let bb: Busboy.Busboy;
    try {
      bb = Busboy({
        headers: { "content-type": contentType },
        limits: {
          files: 1,
          fileSize: MAX_UPLOAD_BYTES,
        },
      });
    } catch {
      reject(
        new UploadError(400, "multipart/form-data 요청을 파싱할 수 없습니다."),
      );
      return;
    }

    const source = Readable.fromWeb(
      request.body as unknown as WebReadableStream<Uint8Array>,
    );

    let settled = false;
    let fileHandled = false;
    let busboyDone = false;
    let savedPath: string | null = null;
    let writeStream: WriteStream | null = null;
    let result: ParsedUpload | null = null;

    const succeed = () => {
      if (settled) return;
      // busboy 파싱 종료 + 파일 쓰기 완료가 모두 끝났을 때만 resolve
      if (!busboyDone || result === null) return;
      settled = true;
      resolve(result);
    };

    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      source.unpipe(bb);
      source.destroy();
      if (writeStream && !writeStream.destroyed) {
        writeStream.destroy();
      }
      void cleanupPartialFile(savedPath).finally(() => reject(err));
    };

    bb.on("file", (fieldName, fileStream, info) => {
      // 첫 번째 "file" 필드만 처리, 그 외 파일 필드는 스트림만 소비하고 무시
      if (fieldName !== "file" || fileHandled) {
        fileStream.resume();
        return;
      }
      fileHandled = true;

      const originalName = sanitizeFileName(info.filename ?? "");
      const ext = path.extname(originalName).toLowerCase();
      const mimeType = (info.mimeType ?? "").toLowerCase();

      if (!ALLOWED_EXTENSIONS.has(ext) || !mimeType.startsWith("video/")) {
        fileStream.resume();
        fail(
          new UploadError(
            415,
            "지원하지 않는 파일 형식입니다. (mp4, mov, m4v, webm, mkv, avi 동영상만 가능)",
          ),
        );
        return;
      }

      const filePath = buildUploadPath(originalName);
      savedPath = filePath;

      let bytesWritten = 0;
      const ws = createWriteStream(filePath);
      writeStream = ws;

      fileStream.on("data", (chunk: Buffer) => {
        bytesWritten += chunk.length;
      });

      // busboy limits.fileSize 초과 시: 스트림이 잘리고 'limit' 이벤트 발생
      fileStream.on("limit", () => {
        fail(
          new UploadError(
            413,
            `파일이 최대 업로드 크기(${env.MAX_UPLOAD_MB}MB)를 초과했습니다.`,
          ),
        );
      });

      fileStream.on("error", () => {
        fail(new UploadError(400, "파일 스트림 처리 중 오류가 발생했습니다."));
      });

      ws.on("error", () => {
        fail(new UploadError(500, "파일 저장 중 오류가 발생했습니다."));
      });

      ws.on("finish", () => {
        if (settled) return;
        result = {
          originalName,
          mimeType,
          sizeBytes: bytesWritten,
          filePath,
        };
        succeed();
      });

      fileStream.pipe(ws);
    });

    bb.on("error", () => {
      fail(new UploadError(400, "업로드 본문을 파싱할 수 없습니다."));
    });

    bb.on("close", () => {
      busboyDone = true;
      if (!fileHandled) {
        fail(new UploadError(400, '"file" 필드가 필요합니다.'));
        return;
      }
      succeed();
    });

    source.on("error", () => {
      fail(new UploadError(400, "업로드가 중단되었습니다."));
    });

    source.pipe(bb);
  });
}

export async function POST(request: Request): Promise<NextResponse> {
  let uploaded: ParsedUpload | null = null;

  try {
    // 1) 사전 검증: Content-Type / Content-Length / body 존재
    const contentType = request.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().includes("multipart/form-data")) {
      return NextResponse.json(
        { error: "multipart/form-data 요청이어야 합니다." },
        { status: 400 },
      );
    }

    const contentLengthHeader = request.headers.get("content-length");
    if (contentLengthHeader !== null) {
      const contentLength = Number(contentLengthHeader);
      if (Number.isFinite(contentLength) && contentLength > MAX_UPLOAD_BYTES) {
        return NextResponse.json(
          {
            error: `파일이 최대 업로드 크기(${env.MAX_UPLOAD_MB}MB)를 초과했습니다.`,
          },
          { status: 413 },
        );
      }
    }

    if (!request.body) {
      return NextResponse.json(
        { error: "요청 본문이 비어 있습니다." },
        { status: 400 },
      );
    }

    // 2) 저장 디렉토리 보장 후 스트리밍 파싱 + 디스크 기록
    await ensureDirs();
    uploaded = await parseUpload(request);

    // 3) DB 기록: Video + ProcessingJob(UPLOADED) — nested create로 원자적 생성
    const created = await prisma.video.create({
      data: {
        originalName: uploaded.originalName,
        mimeType: uploaded.mimeType,
        sizeBytes: BigInt(uploaded.sizeBytes),
        filePath: uploaded.filePath,
        job: {
          create: {
            status: "UPLOADED",
            progress: 0,
          },
        },
      },
      include: { job: true },
    });

    const { job, ...video } = created;
    if (!job) {
      // nested create 이므로 도달 불가하지만, 타입 안전을 위해 방어
      throw new Error("ProcessingJob 생성에 실패했습니다.");
    }

    // 파이프라인 시작은 POST /api/videos/[videoId]/process 전담 —
    // 프론트엔드가 업로드 성공 후 process 를 호출한다.
    return NextResponse.json(
      { video: serializeVideo(video), jobId: job.id },
      { status: 201 },
    );
  } catch (err) {
    // DB 실패 등 파싱 이후 단계의 실패 시에도 저장된 파일 정리
    await cleanupPartialFile(uploaded?.filePath ?? null);

    if (err instanceof UploadError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }

    return NextResponse.json(
      { error: "업로드 처리 중 서버 오류가 발생했습니다." },
      { status: 500 },
    );
  }
}

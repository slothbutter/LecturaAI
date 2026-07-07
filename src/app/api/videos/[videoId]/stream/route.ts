import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { isPathInsideStorage } from "@/lib/storage";

export const runtime = "nodejs";

const ParamsSchema = z.object({ videoId: z.string().min(1) });

type RangeParseResult =
  | { kind: "none" }
  | { kind: "unsatisfiable" }
  | { kind: "range"; start: number; end: number };

/**
 * HTTP Range 헤더 파싱 (RFC 9110, 단일 범위만 지원).
 * - "bytes=start-end" / "bytes=start-" / "bytes=-suffix"
 * - 문법이 유효하지 않은 Range(정규식 불일치, 다중 범위 "bytes=0-1,5-6",
 *   역전 범위 "bytes=5-3" 등)는 RFC 9110에 따라 헤더를 **무시**하고
 *   전체 응답(200)으로 처리한다 → { kind: "none" }.
 * - 416(unsatisfiable)은 문법은 유효하지만 진짜로 만족 불가능한 경우에만:
 *   start >= size, suffix 길이 0 (bytes=-0), 빈 파일에 대한 범위 요청.
 */
function parseRange(rangeHeader: string | null, size: number): RangeParseResult {
  if (!rangeHeader) return { kind: "none" };

  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!match) return { kind: "none" };

  const [, startStr, endStr] = match;
  if (startStr === "" && endStr === "") return { kind: "none" };

  if (startStr === "") {
    // suffix range: 마지막 N 바이트 (bytes=-N)
    const suffix = Number(endStr);
    if (!Number.isSafeInteger(suffix)) return { kind: "none" };
    // bytes=-0 또는 빈 파일 → 만족 불가
    if (suffix <= 0 || size === 0) return { kind: "unsatisfiable" };
    const start = Math.max(0, size - suffix);
    return { kind: "range", start, end: size - 1 };
  }

  const start = Number(startStr);
  if (!Number.isSafeInteger(start)) return { kind: "none" };

  let end = endStr === "" ? size - 1 : Number(endStr);
  if (!Number.isSafeInteger(end)) return { kind: "none" };
  // 역전 범위(bytes=5-3)는 유효하지 않은 문법 → Range 무시
  if (endStr !== "" && end < start) return { kind: "none" };

  // 문법은 유효하나 시작점이 파일 크기 이상 → 만족 불가
  if (start >= size) return { kind: "unsatisfiable" };

  end = Math.min(end, size - 1);
  return { kind: "range", start, end };
}

/**
 * GET/HEAD 공통 처리. HEAD 는 헤더만 내려주고 body 를 생략한다.
 */
async function handleStream(
  req: NextRequest,
  ctx: { params: Promise<{ videoId: string }> },
  includeBody: boolean,
): Promise<Response> {
  try {
    const rawParams = await ctx.params;
    const parsed = ParamsSchema.safeParse(rawParams);
    if (!parsed.success) {
      return NextResponse.json({ error: "잘못된 videoId 입니다." }, { status: 400 });
    }
    const { videoId } = parsed.data;

    const video = await prisma.video.findUnique({
      where: { id: videoId },
      select: { filePath: true, mimeType: true },
    });

    if (!video) {
      return NextResponse.json(
        { error: "해당 영상을 찾을 수 없습니다." },
        { status: 404 },
      );
    }

    if (!video.filePath || !isPathInsideStorage(video.filePath)) {
      return NextResponse.json(
        { error: "영상 파일 경로가 유효하지 않습니다." },
        { status: 404 },
      );
    }

    let fileStat;
    try {
      fileStat = await stat(video.filePath);
    } catch {
      return NextResponse.json(
        { error: "영상 파일을 찾을 수 없습니다." },
        { status: 404 },
      );
    }
    if (!fileStat.isFile()) {
      return NextResponse.json(
        { error: "영상 파일을 찾을 수 없습니다." },
        { status: 404 },
      );
    }

    const size = fileStat.size;
    const contentType = video.mimeType || "application/octet-stream";
    const range = parseRange(req.headers.get("range"), size);

    if (range.kind === "unsatisfiable") {
      return NextResponse.json(
        { error: "요청한 범위를 만족할 수 없습니다." },
        {
          status: 416,
          headers: {
            "Content-Range": `bytes */${size}`,
            "Accept-Ranges": "bytes",
          },
        },
      );
    }

    if (range.kind === "range") {
      const { start, end } = range;
      const headers = new Headers({
        "Content-Type": contentType,
        "Content-Range": `bytes ${start}-${end}/${size}`,
        "Accept-Ranges": "bytes",
        "Content-Length": String(end - start + 1),
        "Cache-Control": "no-store",
      });

      if (!includeBody) {
        return new Response(null, { status: 206, headers });
      }

      const nodeStream = createReadStream(video.filePath, { start, end });
      const body = Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;
      return new Response(body, { status: 206, headers });
    }

    // Range 헤더 없음 → 전체 파일 200
    const headers = new Headers({
      "Content-Type": contentType,
      "Accept-Ranges": "bytes",
      "Content-Length": String(size),
      "Cache-Control": "no-store",
    });

    if (!includeBody) {
      return new Response(null, { status: 200, headers });
    }

    const nodeStream = createReadStream(video.filePath);
    const body = Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;
    return new Response(body, { status: 200, headers });
  } catch (err) {
    console.error("[GET /api/videos/[videoId]/stream]", err);
    return NextResponse.json(
      { error: "영상 스트리밍 중 오류가 발생했습니다." },
      { status: 500 },
    );
  }
}

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ videoId: string }> },
): Promise<Response> {
  return handleStream(req, ctx, true);
}

export async function HEAD(
  req: NextRequest,
  ctx: { params: Promise<{ videoId: string }> },
): Promise<Response> {
  return handleStream(req, ctx, false);
}

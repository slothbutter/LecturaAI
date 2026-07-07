import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { toJsonSafe } from "@/lib/serialize";

export const runtime = "nodejs";

const ParamsSchema = z.object({ jobId: z.string().min(1) });

/**
 * GET /api/jobs/[jobId]
 * ProcessingJob 상태 폴링용 조회. 캐시 금지.
 */
export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ jobId: string }> },
): Promise<NextResponse> {
  try {
    const rawParams = await ctx.params;
    const parsed = ParamsSchema.safeParse(rawParams);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "잘못된 jobId 입니다." },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      );
    }
    const { jobId } = parsed.data;

    const job = await prisma.processingJob.findUnique({ where: { id: jobId } });

    if (!job) {
      return NextResponse.json(
        { error: "해당 작업을 찾을 수 없습니다." },
        { status: 404, headers: { "Cache-Control": "no-store" } },
      );
    }

    return NextResponse.json(
      toJsonSafe({
        id: job.id,
        videoId: job.videoId,
        status: job.status,
        progress: job.progress,
        errorMessage: job.errorMessage,
        attempts: job.attempts,
        startedAt: job.startedAt,
        finishedAt: job.finishedAt,
      }),
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    console.error("[GET /api/jobs/[jobId]]", err);
    return NextResponse.json(
      { error: "작업 상태를 조회하는 중 오류가 발생했습니다." },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}

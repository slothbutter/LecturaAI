import { NextRequest, NextResponse, after } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { runPipeline } from "@/lib/pipeline";

export const runtime = "nodejs";

const ParamsSchema = z.object({ videoId: z.string().min(1) });

/**
 * POST /api/videos/[videoId]/process
 * 처리 파이프라인 백그라운드 트리거.
 * - UPLOADED / FAILED 상태에서만 시작 가능
 * - COMPLETED 이면 200 (이미 완료)
 * - 그 외 중간 상태면 409 (이미 처리 중)
 */
export async function POST(
  _req: NextRequest,
  ctx: { params: Promise<{ videoId: string }> },
): Promise<NextResponse> {
  try {
    const rawParams = await ctx.params;
    const parsed = ParamsSchema.safeParse(rawParams);
    if (!parsed.success) {
      return NextResponse.json({ error: "잘못된 videoId 입니다." }, { status: 400 });
    }
    const { videoId } = parsed.data;

    const video = await prisma.video.findUnique({
      where: { id: videoId },
      include: { job: true },
    });

    if (!video || !video.job) {
      return NextResponse.json(
        { error: "해당 영상 또는 처리 작업을 찾을 수 없습니다." },
        { status: 404 },
      );
    }

    const job = video.job;

    if (job.status === "COMPLETED") {
      return NextResponse.json(
        { message: "이미 완료됨", jobId: job.id },
        { status: 200 },
      );
    }

    if (job.status !== "UPLOADED" && job.status !== "FAILED") {
      return NextResponse.json(
        { error: "이미 처리 중입니다" },
        { status: 409 },
      );
    }

    after(() => {
      // runPipeline 은 throw 하지 않는 계약이지만 안전망을 한 겹 더 둔다.
      runPipeline(videoId).catch((err) => {
        console.error("[POST /api/videos/[videoId]/process] pipeline error", err);
      });
    });

    return NextResponse.json(
      { jobId: job.id, status: job.status },
      { status: 202 },
    );
  } catch (err) {
    console.error("[POST /api/videos/[videoId]/process]", err);
    return NextResponse.json(
      { error: "처리 작업을 시작하는 중 오류가 발생했습니다." },
      { status: 500 },
    );
  }
}

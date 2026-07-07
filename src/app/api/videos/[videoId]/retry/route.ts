import { NextRequest, NextResponse, after } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { runPipeline } from "@/lib/pipeline";

export const runtime = "nodejs";

const ParamsSchema = z.object({ videoId: z.string().min(1) });

/**
 * POST /api/videos/[videoId]/retry
 * FAILED 상태의 작업만 재시도한다.
 * attempts 증가 / errorMessage 초기화는 파이프라인의 beginJobRun 책임.
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

    const job = await prisma.processingJob.findUnique({ where: { videoId } });

    if (!job) {
      return NextResponse.json(
        { error: "해당 영상의 처리 작업을 찾을 수 없습니다." },
        { status: 404 },
      );
    }

    if (job.status !== "FAILED") {
      return NextResponse.json(
        { error: "실패한 작업만 재시도할 수 있습니다." },
        { status: 409 },
      );
    }

    after(() => {
      // runPipeline 은 throw 하지 않는 계약이지만 안전망을 한 겹 더 둔다.
      runPipeline(videoId).catch((err) => {
        console.error("[POST /api/videos/[videoId]/retry] pipeline error", err);
      });
    });

    return NextResponse.json(
      { jobId: job.id, status: "RESTARTED" },
      { status: 202 },
    );
  } catch (err) {
    console.error("[POST /api/videos/[videoId]/retry]", err);
    return NextResponse.json(
      { error: "재시도를 시작하는 중 오류가 발생했습니다." },
      { status: 500 },
    );
  }
}

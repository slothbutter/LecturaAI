import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { serializeVideo } from "@/lib/serialize";

export const runtime = "nodejs";

const ParamsSchema = z.object({ videoId: z.string().min(1) });

/**
 * GET /api/videos/[videoId]
 * Video 단건 조회 (+ 처리 Job 상태). 폴링 UI가 사용한다.
 */
export async function GET(
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

    if (!video) {
      return NextResponse.json(
        { error: "해당 영상을 찾을 수 없습니다." },
        { status: 404 },
      );
    }

    const { job, ...videoOnly } = video;

    return NextResponse.json({
      ...serializeVideo(videoOnly),
      job: job
        ? {
            id: job.id,
            status: job.status,
            progress: job.progress,
            errorMessage: job.errorMessage,
          }
        : null,
    });
  } catch (err) {
    console.error("[GET /api/videos/[videoId]]", err);
    return NextResponse.json(
      { error: "영상 정보를 조회하는 중 오류가 발생했습니다." },
      { status: 500 },
    );
  }
}

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

const ParamsSchema = z.object({ videoId: z.string().min(1) });

/**
 * GET /api/videos/[videoId]/transcript
 * STT 결과(언어, 타임스탬프 세그먼트, 전체 텍스트) 조회.
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

    const transcript = await prisma.transcript.findUnique({
      where: { videoId },
    });

    if (!transcript) {
      return NextResponse.json(
        {
          error:
            "아직 전사 결과가 없습니다. 영상 처리가 진행 중이거나 실패했을 수 있습니다.",
        },
        { status: 404 },
      );
    }

    return NextResponse.json({
      language: transcript.language,
      segments: transcript.segments,
      fullText: transcript.fullText,
    });
  } catch (err) {
    console.error("[GET /api/videos/[videoId]/transcript]", err);
    return NextResponse.json(
      { error: "전사 결과를 조회하는 중 오류가 발생했습니다." },
      { status: 500 },
    );
  }
}

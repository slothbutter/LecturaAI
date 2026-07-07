import type { Metadata } from "next";
import { ProcessingScreen } from "@/components/processing/processing-screen";

export const metadata: Metadata = {
  title: "처리 진행 중 | LecturaAI",
  description: "업로드한 강의 영상의 AI 분석 진행 상황을 확인합니다.",
};

/**
 * /processing/[videoId]
 * Next 16: params 는 Promise — 서버 래퍼에서 await 후 클라이언트 컴포넌트에 전달한다.
 */
export default async function ProcessingPage({
  params,
}: {
  params: Promise<{ videoId: string }>;
}) {
  const { videoId } = await params;
  return <ProcessingScreen videoId={videoId} />;
}

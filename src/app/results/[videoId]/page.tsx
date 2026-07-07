import type { Metadata } from "next";
import { ResultsScreen } from "@/components/results/results-screen";

export const metadata: Metadata = {
  title: "학습 결과 | LecturaAI",
  description: "AI가 분석한 강의 영상의 요약·타임라인·퀴즈 결과를 확인합니다.",
};

/**
 * /results/[videoId]
 * Next 16: params 는 Promise — 서버 래퍼에서 await 후 클라이언트 컴포넌트에 전달한다.
 */
export default async function ResultsPage({
  params,
}: {
  params: Promise<{ videoId: string }>;
}) {
  const { videoId } = await params;
  return <ResultsScreen videoId={videoId} />;
}

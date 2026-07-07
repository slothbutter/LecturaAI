import { UploadForm } from "@/components/upload/upload-form";
import { env } from "@/lib/env";

export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-8 px-4 py-12">
      <header className="flex flex-col items-center gap-2 text-center">
        <h1 className="text-4xl font-bold tracking-tight">LecturaAI</h1>
        <p className="text-muted-foreground">
          강의 영상을 업로드하면 AI가 요약·타임라인·퀴즈가 담긴 학습 노트를
          만들어 드립니다.
        </p>
      </header>
      <div className="w-full max-w-xl">
        {/* 최대 업로드 크기 단일 출처: .env(MAX_UPLOAD_MB) — 서버에서 읽어 prop 으로 전달 */}
        <UploadForm maxUploadMb={env.MAX_UPLOAD_MB} />
      </div>
    </main>
  );
}

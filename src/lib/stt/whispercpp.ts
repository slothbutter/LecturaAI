import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { env } from "@/lib/env";
import { removeFiles } from "@/lib/media";
import type { TranscriptSegment } from "@/lib/schemas";
import type { SttProvider, SttResult } from "./types";

/**
 * whisper.cpp(whisper-cli) 기반 로컬 STT 어댑터 — 테스트/개발용.
 * API 과금 없이 실제 전사를 수행한다. 파일 크기 제한이 없으므로
 * API 어댑터(whisper.ts)의 25MB 분할·병렬 전사 로직이 필요 없다.
 *
 * 실행 요건: `brew install whisper-cpp` + ggml 모델 파일(WHISPER_CPP_MODEL).
 */

/** whisper-cli -oj 출력의 transcription[] 항목 (offsets 는 밀리초) */
interface WhisperCppTranscriptionItem {
  offsets?: { from?: number; to?: number };
  text?: string;
}

interface WhisperCppJson {
  result?: { language?: string | null };
  transcription?: WhisperCppTranscriptionItem[];
}

/**
 * whisper-cli JSON 출력을 SttResult 로 변환한다.
 * - offsets(ms) → start/end(초)
 * - trim 후 빈 텍스트, offsets 가 숫자가 아닌 항목은 드롭
 * - API 어댑터의 환각 필터(no_speech_prob 등)는 whisper.cpp JSON 에
 *   해당 메타데이터가 없어 적용하지 않는다 (테스트 용도 트레이드오프)
 */
export function parseWhisperCppJson(data: WhisperCppJson): SttResult {
  const segments: TranscriptSegment[] = [];
  for (const item of data.transcription ?? []) {
    const text = String(item.text ?? "").trim();
    if (text.length === 0) continue;
    const fromMs = Number(item.offsets?.from);
    const toMs = Number(item.offsets?.to);
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) continue;
    segments.push({ start: fromMs / 1000, end: toMs / 1000, text });
  }
  return {
    language: data.result?.language ?? null,
    segments,
    fullText: segments.map((s) => s.text).join(" "),
  };
}

/**
 * whisper-cli 를 spawn 으로 실행한다.
 * media.ts 의 run()(execFile)은 종료 후 일괄 버퍼링이라 진행률을 얻을 수 없어,
 * stderr 를 스트리밍하며 `-pp` 가 출력하는 "progress = NN%" 라인을 파싱한다.
 * 전사는 장시간 작업이므로 타임아웃은 두지 않는다.
 */
function runWhisperCli(
  bin: string,
  args: string[],
  onPercent: (percent: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true });

    let stderrTail = "";
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      // 에러 메시지용으로 마지막 4KB 만 유지 (장시간 실행 시 메모리 누적 방지)
      stderrTail = (stderrTail + text).slice(-4096);
      for (const match of text.matchAll(/progress\s*=\s*(\d+)%/g)) {
        onPercent(Math.min(100, Number(match[1])));
      }
    });
    // stdout 은 사용하지 않지만 파이프 버퍼가 차서 프로세스가 멈추지 않도록 소비한다
    child.stdout.resume();

    child.on("error", (err) => {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        reject(
          new Error(
            `whisper.cpp 실행 파일(${bin})을 찾을 수 없습니다. ` +
              "'brew install whisper-cpp' 로 설치하거나 WHISPER_CPP_BIN 환경변수를 확인해 주세요.",
          ),
        );
        return;
      }
      reject(err);
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      const lastStderrLine =
        stderrTail
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line.length > 0)
          .pop() ?? "";
      reject(
        new Error(
          `${bin} failed (exit code ${code})${lastStderrLine ? `: ${lastStderrLine}` : ""}`,
        ),
      );
    });
  });
}

export class WhisperCppProvider implements SttProvider {
  readonly name = "whispercpp";

  async transcribe(
    audioPath: string,
    onProgress?: (completed: number, total: number) => void,
  ): Promise<SttResult> {
    try {
      await fs.access(env.WHISPER_CPP_MODEL);
    } catch {
      throw new Error(
        `whisper.cpp 모델 파일이 없습니다: ${env.WHISPER_CPP_MODEL}\n` +
          "다운로드: mkdir -p storage/models && curl -L -o storage/models/ggml-large-v3-turbo.bin " +
          "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin",
      );
    }

    // -of 는 확장자 없는 출력 경로 프리픽스 — <오디오와 같은 디렉토리>/<base>.whispercpp.json 이 생성된다
    const outPrefix = path.join(
      path.dirname(audioPath),
      `${path.basename(audioPath, path.extname(audioPath))}.whispercpp`,
    );
    const jsonPath = `${outPrefix}.json`;

    // 진행률은 단조 증가만 보고 (whisper.cpp 는 조각 경계에서 낮은 값을 다시 찍을 수 있음)
    let lastPercent = 0;
    const reportPercent = (percent: number): void => {
      if (percent <= lastPercent) return;
      lastPercent = percent;
      onProgress?.(percent, 100);
    };

    try {
      await runWhisperCli(
        env.WHISPER_CPP_BIN,
        [
          "-m", env.WHISPER_CPP_MODEL,
          "-f", audioPath,
          "-oj",
          "-of", outPrefix,
          "-l", "auto",
          "-np",
          "-pp",
        ],
        reportPercent,
      );

      let data: WhisperCppJson;
      try {
        data = JSON.parse(await fs.readFile(jsonPath, "utf8")) as WhisperCppJson;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(
          `whisper.cpp 출력(JSON)을 읽을 수 없습니다 (${jsonPath}): ${message}`,
        );
      }

      const result = parseWhisperCppJson(data);
      reportPercent(100);
      return result;
    } finally {
      try {
        await removeFiles([jsonPath]);
      } catch (err) {
        // 임시 JSON 삭제 실패가 성공한 전사 결과를 덮어쓰지 않도록 경고만 남긴다
        console.warn("[whispercpp] 출력 JSON 삭제 실패:", err);
      }
    }
  }
}

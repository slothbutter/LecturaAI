import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

import { env } from "@/lib/env";

/**
 * ffprobe/ffmpeg 래퍼 모듈.
 * - 반드시 execFile(인자 배열) 사용 — 셸 문자열 조합 금지(셸 인젝션 방지).
 * - 긴 영상(4시간+) 대비 maxBuffer 32MB, 타임아웃은 작업 성격에 맞게 넉넉히.
 */

const MAX_BUFFER = 32 * 1024 * 1024; // 32MB
const PROBE_TIMEOUT_MS = 30_000; // 메타데이터 추출: 30초

export interface VideoMetadata {
  durationSec: number;
  width: number | null;
  height: number | null;
  codec: string | null;
}

interface RunResult {
  stdout: string;
  stderr: string;
}

/** execFile 을 Promise 로 감싼 실행 헬퍼. 실패 시 stderr 마지막 줄을 포함한 에러를 던진다. */
function run(
  bin: string,
  args: string[],
  opts: { timeoutMs?: number } = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      {
        maxBuffer: MAX_BUFFER,
        // timeout 0 = 무제한 (오디오 추출 등 장시간 작업용)
        timeout: opts.timeoutMs ?? 0,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          const lastStderrLine =
            stderr
              .split(/\r?\n/)
              .map((line) => line.trim())
              .filter((line) => line.length > 0)
              .pop() ?? "";
          const killed = (error as NodeJS.ErrnoException & { killed?: boolean })
            .killed;
          const reason = killed
            ? `timed out after ${opts.timeoutMs}ms`
            : error.message.split("\n")[0];
          reject(
            new Error(
              `${bin} failed (${reason})${lastStderrLine ? `: ${lastStderrLine}` : ""}`,
            ),
          );
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
}

interface FfprobeOutput {
  format?: { duration?: string };
  streams?: FfprobeStream[];
}

/**
 * ffprobe 로 비디오 메타데이터를 추출한다.
 * - duration 을 구할 수 없으면 에러.
 * - 오디오 스트림이 하나도 없으면 에러 (STT 파이프라인 진행 불가).
 */
export async function extractMetadata(filePath: string): Promise<VideoMetadata> {
  const { stdout } = await run(
    "ffprobe",
    [
      "-v",
      "error",
      "-print_format",
      "json",
      "-show_format",
      "-show_streams",
      filePath,
    ],
    { timeoutMs: PROBE_TIMEOUT_MS },
  );

  let probe: FfprobeOutput;
  try {
    probe = JSON.parse(stdout) as FfprobeOutput;
  } catch {
    throw new Error("ffprobe 출력(JSON)을 파싱할 수 없습니다.");
  }

  const streams = probe.streams ?? [];
  const videoStream = streams.find((s) => s.codec_type === "video") ?? null;
  const audioStream = streams.find((s) => s.codec_type === "audio") ?? null;

  if (!audioStream) {
    throw new Error(
      "오디오 트랙이 없는 영상입니다. 음성이 포함된 영상을 업로드해 주세요.",
    );
  }

  const durationSec = Number.parseFloat(probe.format?.duration ?? "");
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    throw new Error("영상 길이(duration)를 확인할 수 없습니다.");
  }

  return {
    durationSec,
    width: typeof videoStream?.width === "number" ? videoStream.width : null,
    height: typeof videoStream?.height === "number" ? videoStream.height : null,
    codec:
      typeof videoStream?.codec_name === "string" ? videoStream.codec_name : null,
  };
}

/**
 * ffmpeg 로 STT 최적화 오디오(mp3, mono, 16kHz, 48kbps)를 추출한다.
 * 장시간 영상 대비 타임아웃 없이 실행한다.
 */
export async function extractAudio(
  videoPath: string,
  audioPath: string,
): Promise<void> {
  await fs.mkdir(path.dirname(audioPath), { recursive: true });
  await run("ffmpeg", [
    "-y",
    "-i",
    videoPath,
    "-vn",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-b:a",
    "48k",
    audioPath,
  ]);
}

/**
 * ffmpeg segment muxer 로 오디오를 segmentSec 단위로 분할한다.
 * 산출물: AUDIO_DIR/<원본파일명(확장자 제외)>.partNNN.mp3
 * offsetSec = index * segmentSec (segment muxer 는 균등 분할).
 */
export async function splitAudio(
  audioPath: string,
  segmentSec: number,
): Promise<Array<{ path: string; offsetSec: number }>> {
  if (!Number.isFinite(segmentSec) || segmentSec <= 0) {
    throw new Error("segmentSec 은 0보다 큰 숫자여야 합니다.");
  }

  await fs.mkdir(env.AUDIO_DIR, { recursive: true });

  const baseName = path.basename(audioPath, path.extname(audioPath));
  const outputPattern = path.join(env.AUDIO_DIR, `${baseName}.part%03d.mp3`);
  const partPattern = new RegExp(
    `^${escapeRegExp(baseName)}\\.part(\\d{3,})\\.mp3$`,
  );

  // 이전에 중단된 실행이 남긴 stale 조각이 이번 결과에 섞이지 않도록 먼저 삭제
  const existingEntries = await fs.readdir(env.AUDIO_DIR);
  const staleParts = existingEntries
    .filter((name) => partPattern.test(name))
    .map((name) => path.join(env.AUDIO_DIR, name));
  if (staleParts.length > 0) {
    await removeFiles(staleParts);
  }

  await run("ffmpeg", [
    "-y",
    "-i",
    audioPath,
    "-f",
    "segment",
    "-segment_time",
    String(segmentSec),
    "-c",
    "copy",
    outputPattern,
  ]);

  const entries = await fs.readdir(env.AUDIO_DIR);
  const parts = entries
    .map((name) => {
      const match = partPattern.exec(name);
      if (!match) return null;
      return { name, index: Number.parseInt(match[1], 10) };
    })
    .filter((p): p is { name: string; index: number } => p !== null)
    .sort((a, b) => a.index - b.index)
    .map((p) => ({
      path: path.join(env.AUDIO_DIR, p.name),
      offsetSec: p.index * segmentSec,
    }));

  if (parts.length === 0) {
    throw new Error("오디오 분할 결과 파일이 생성되지 않았습니다.");
  }

  return parts;
}

/** 파일들을 삭제한다. 존재하지 않는 파일(ENOENT)은 조용히 무시. */
export async function removeFiles(paths: string[]): Promise<void> {
  await Promise.all(
    paths.map(async (p) => {
      try {
        await fs.unlink(p);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") {
          throw error;
        }
      }
    }),
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

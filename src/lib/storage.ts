import { mkdir } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { env } from "@/lib/env";

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;
const UNSAFE_CHARS = /[<>:"|?*]/g;
const VALID_EXT = /^\.[a-z0-9]{1,10}$/;

/**
 * 업로드/오디오 저장 디렉토리가 존재하도록 보장한다.
 * 여러 번 호출해도 안전하다 (idempotent).
 */
export async function ensureDirs(): Promise<void> {
  await mkdir(env.UPLOAD_DIR, { recursive: true });
  await mkdir(env.AUDIO_DIR, { recursive: true });
}

/**
 * 파일 이름을 저장에 안전한 형태로 정규화한다.
 * - 경로 구분자/상위 디렉토리 참조 등 경로 조작(path traversal)을 제거한다.
 * - 제어 문자와 파일시스템 예약 문자를 제거/치환한다.
 * - 유니코드(한글 등)는 NFC 정규화 후 유지한다.
 */
export function sanitizeFileName(name: string): string {
  // 어떤 OS 구분자가 오더라도 마지막 세그먼트만 취한다.
  const lastSegment = name.normalize("NFC").split(/[/\\]+/).pop() ?? "";

  const cleaned = lastSegment
    .replace(CONTROL_CHARS, "")
    .replace(UNSAFE_CHARS, "_")
    // 선행 마침표 제거 (숨김 파일 및 ".." 방지)
    .replace(/^\.+/, "")
    .trim();

  return cleaned.length > 0 ? cleaned.slice(0, 200) : "file";
}

/**
 * 원본 파일명으로부터 확장자를 추출한다. 없으면 fallback 을 사용한다.
 */
function safeExtension(originalName: string, fallback: string): string {
  const ext = path.extname(sanitizeFileName(originalName)).toLowerCase();
  return VALID_EXT.test(ext) ? ext : fallback;
}

/**
 * 업로드된 동영상이 저장될 절대경로를 생성한다.
 * 파일명은 충돌 방지를 위해 UUID 기반으로 만든다.
 */
export function buildUploadPath(originalName: string): string {
  const ext = safeExtension(originalName, ".mp4");
  return path.join(env.UPLOAD_DIR, `${randomUUID()}${ext}`);
}

/**
 * 추출된 오디오가 저장될 절대경로를 생성한다.
 * videoId 기준으로 결정적(deterministic) 경로를 만든다.
 */
export function buildAudioPath(videoId: string, ext: string = ".mp3"): string {
  const safeId = videoId.replace(/[^a-zA-Z0-9_-]/g, "");
  const safeExt = VALID_EXT.test(ext.toLowerCase()) ? ext.toLowerCase() : ".mp3";
  return path.join(env.AUDIO_DIR, `${safeId}${safeExt}`);
}

/**
 * 주어진 경로가 허용된 저장 디렉토리(UPLOAD_DIR/AUDIO_DIR) 내부인지 검증한다.
 * 파일 읽기/삭제 전에 사용해 경로 조작을 방지한다.
 */
export function isPathInsideStorage(filePath: string): boolean {
  const resolved = path.resolve(filePath);
  return [env.UPLOAD_DIR, env.AUDIO_DIR].some(
    (dir) => resolved === dir || resolved.startsWith(dir + path.sep),
  );
}

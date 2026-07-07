import type { Video } from "@prisma/client";

/**
 * BigInt 안전 직렬화 헬퍼.
 * Prisma의 Video.sizeBytes 는 BigInt 라서 JSON.stringify 가 그대로 던지면 TypeError가 난다.
 * API 응답 전에 이 헬퍼들로 변환한다.
 */

/** JSON 응답용 Video 형태 (sizeBytes: BigInt → number) */
export type SerializedVideo = Omit<Video, "sizeBytes" | "createdAt"> & {
  sizeBytes: number;
  createdAt: string;
};

/**
 * Video 레코드를 JSON 직렬화 가능한 객체로 변환한다.
 * sizeBytes 는 number 로 변환한다. (Number.MAX_SAFE_INTEGER ≈ 9PB 이므로
 * 업로드 상한(MAX_UPLOAD_MB) 내에서는 정밀도 손실이 없다.)
 */
export function serializeVideo(video: Video): SerializedVideo {
  return {
    ...video,
    sizeBytes: Number(video.sizeBytes),
    createdAt: video.createdAt.toISOString(),
  };
}

/**
 * 임의의 값을 재귀적으로 순회하며 BigInt → number(안전 범위 초과 시 string),
 * Date → ISO string 으로 변환한다. 중첩 include 결과 등 범용 직렬화에 사용한다.
 */
export function toJsonSafe(value: unknown): unknown {
  if (typeof value === "bigint") {
    return value <= BigInt(Number.MAX_SAFE_INTEGER) &&
      value >= BigInt(-Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : value.toString();
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return value.map(toJsonSafe);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        toJsonSafe(v),
      ]),
    );
  }
  return value;
}

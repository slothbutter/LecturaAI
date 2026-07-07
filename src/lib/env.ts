import path from "node:path";
import { z } from "zod";

/**
 * 서버 환경변수를 Zod로 검증/파싱한다.
 * - UPLOAD_DIR / AUDIO_DIR 는 상대경로일 수 있으므로 process.cwd() 기준 절대경로로 resolve 한다.
 * - MAX_UPLOAD_MB 는 number 로 강제 변환한다.
 */
const envSchema = z.object({
  DATABASE_URL: z
    .string()
    .min(1, "DATABASE_URL is required")
    .refine(
      (v) => v.startsWith("postgresql://") || v.startsWith("postgres://"),
      "DATABASE_URL must be a PostgreSQL connection string",
    ),
  STT_PROVIDER: z.enum(["whisper", "deepgram"]).default("whisper"),
  OPENAI_API_KEY: z.string().default(""),
  OPENAI_BASE_URL: z.url().default("https://api.openai.com/v1"),
  LLM_MODEL: z.string().min(1).default("gpt-4o-mini"),
  DEEPGRAM_API_KEY: z.string().default(""),
  UPLOAD_DIR: z
    .string()
    .min(1)
    .default("./storage/uploads")
    // turbopackIgnore: 런타임 디렉터리 경로 resolve — 번들 트레이싱 대상 아님
    .transform((p) => path.resolve(/*turbopackIgnore: true*/ process.cwd(), p)),
  AUDIO_DIR: z
    .string()
    .min(1)
    .default("./storage/audio")
    // turbopackIgnore: 런타임 디렉터리 경로 resolve — 번들 트레이싱 대상 아님
    .transform((p) => path.resolve(/*turbopackIgnore: true*/ process.cwd(), p)),
  MAX_UPLOAD_MB: z.coerce
    .number()
    .int()
    .positive()
    .default(2048),
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid environment variables:\n${details}`);
  }
  return parsed.data;
}

export const env: Env = loadEnv();

/** 최대 업로드 크기 (bytes) */
export const MAX_UPLOAD_BYTES: number = env.MAX_UPLOAD_MB * 1024 * 1024;

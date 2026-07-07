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
  STT_PROVIDER: z.enum(["whisper", "deepgram", "whispercpp"]).default("whisper"),
  OPENAI_API_KEY: z.string().default(""),
  OPENAI_BASE_URL: z.url().default("https://api.openai.com/v1"),
  LLM_MODEL: z.string().min(1).default("gpt-4o-mini"),
  /**
   * LLM(chat/completions) 전용 엔드포인트/키 — 미설정 시 OPENAI_* 로 fallback.
   * STT(whisper API)와 분리되어 있어 요약만 로컬 LLM(Ollama 등)으로 보낼 수 있다.
   * 빈 문자열은 "미설정"으로 취급한다.
   */
  LLM_BASE_URL: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.url().optional(),
  ),
  LLM_API_KEY: z.string().optional(),
  DEEPGRAM_API_KEY: z.string().default(""),
  /** whisper.cpp 실행 파일 — 절대경로가 아니면 PATH 에서 탐색 */
  WHISPER_CPP_BIN: z.string().min(1).default("whisper-cli"),
  WHISPER_CPP_MODEL: z
    .string()
    .min(1)
    .default("./storage/models/ggml-large-v3-turbo.bin")
    // turbopackIgnore: 런타임 파일 경로 resolve — 번들 트레이싱 대상 아님
    .transform((p) => path.resolve(/*turbopackIgnore: true*/ process.cwd(), p)),
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

/** LLM_* fallback 을 적용한 최종 env 형태 — LLM_BASE_URL/LLM_API_KEY 는 항상 채워진다 */
const envSchemaWithFallback = envSchema.transform((data) => ({
  ...data,
  LLM_BASE_URL: data.LLM_BASE_URL ?? data.OPENAI_BASE_URL,
  LLM_API_KEY: data.LLM_API_KEY || data.OPENAI_API_KEY,
}));

export type Env = z.infer<typeof envSchemaWithFallback>;

function loadEnv(): Env {
  const parsed = envSchemaWithFallback.safeParse(process.env);
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

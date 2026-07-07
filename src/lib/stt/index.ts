import { env } from "@/lib/env";
import { DeepgramProvider } from "./deepgram";
import { WhisperProvider } from "./whisper";
import { WhisperCppProvider } from "./whispercpp";
import type { SttProvider } from "./types";

export type { SttProvider, SttResult } from "./types";

/** env.STT_PROVIDER 값에 따라 STT 어댑터를 반환한다. */
export function getSttProvider(): SttProvider {
  switch (env.STT_PROVIDER) {
    case "deepgram":
      return new DeepgramProvider();
    case "whisper":
      return new WhisperProvider();
    case "whispercpp":
      return new WhisperCppProvider();
    default: {
      // env 스키마상 도달 불가하지만 방어적으로 처리
      const provider: never = env.STT_PROVIDER;
      throw new Error(`지원하지 않는 STT 제공자입니다: ${String(provider)}`);
    }
  }
}

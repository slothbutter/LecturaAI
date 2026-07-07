# 로컬 LLM 요약(Ollama) 설계

날짜: 2026-07-07
상태: 구현·검증 완료 (whispercpp STT 설계의 후속 — [[2026-07-07-whispercpp-stt-provider-design]])

## 목적

테스트 중 요약(LLM) 단계도 API 과금 없이 실행한다. OpenAI quota 소진(429)으로
요약 e2e 가 막힌 상태를 로컬 LLM 으로 해소하고, 충분해지면 OpenAI/Claude 로
env 만으로 복귀한다.

## 접근

기존 `chatJson`(src/lib/llm/client.ts)이 이미 OpenAI 호환 /chat/completions +
`response_format: json_object` + 코드펜스 방어 파싱 + Zod 검증 + self-correction
재시도 구조라서 **새 클라이언트 코드가 필요 없다**. Ollama 의 OpenAI 호환
엔드포인트(`http://localhost:11434/v1`)로 base URL 만 바꾼다.

## 변경 사항

1. `src/lib/env.ts` — `LLM_BASE_URL`/`LLM_API_KEY` 추가(미설정·빈 문자열이면
   `OPENAI_BASE_URL`/`OPENAI_API_KEY` 로 fallback, 스키마 `.transform` 으로 보장).
   Whisper API 가 쓰는 `OPENAI_*` 와 분리되어 STT/LLM 을 독립 전환할 수 있다.
2. `src/lib/llm/client.ts` — URL/Authorization/키 가드가 `LLM_*` 를 사용 (3줄).
3. `ollama/Modelfile` — `FROM exaone3.5:7.8b` + `PARAMETER num_ctx 16384` 파생
   모델(`lectura-exaone`). **이유**: Ollama 기본 컨텍스트(4096 토큰)로는 청킹
   상한(6,000자 ≈ 한국어 6천~9천 토큰) 프롬프트가 조용히 잘린다. 모델에 박아
   서버 설정과 무관하게 보장한다.
4. `.env`(로컬) — `LLM_BASE_URL=http://localhost:11434/v1`, `LLM_API_KEY=ollama`,
   `LLM_MODEL=lectura-exaone`. 프로덕션 복귀: 세 줄 제거 + `LLM_MODEL=gpt-4o-mini`.

모델 선택: EXAONE 3.5 7.8B (LG, 한국어 특화, 4.8GB — 16GB M2 에 여유,
연구용 라이선스라 테스트 용도로만 사용. 프로덕션은 어차피 API 모델).

## 검증 (2026-07-07)

- OpenAI 호환 스모크: `response_format: json_object` 로 유효 JSON 반환 확인
- e2e: quota 로 FAILED 였던 영상(cmra9j4ym…) retry → 전사 skip(멱등) →
  로컬 LLM 으로 gist/map/reduce/quiz 완주 → **COMPLETED**, 8필드 전부
  SummaryResultSchema 통과. API 호출 0회.

## 알려진 한계

- Ollama 서버가 떠 있어야 한다 (`ollama serve` 또는 `brew services start ollama`).
- 로컬 추론은 느리다: 14초 영상 요약에 ~4.5분(호출 4회). 긴 강의는 map 병렬
  요청이 Ollama 큐에서 직렬화되어 chatJson 타임아웃(180초)에 걸릴 수 있음 —
  장시간 영상 테스트에서 재현되면 타임아웃 env 화가 다음 단계.
- Turbopack 온디맨드 라우트 첫 컴파일이 iCloud 경로에서 수 분 걸린 사례 있음
  (retry 라우트) — 멈춘 게 아니라 늦는 것일 수 있으니 로그의 Compiling 라인 확인.

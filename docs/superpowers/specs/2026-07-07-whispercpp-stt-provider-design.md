# whisper.cpp 로컬 STT provider 설계

날짜: 2026-07-07
상태: 사용자 승인 완료

## 목적

테스트 중 OpenAI Whisper API 크레딧 소모를 없앤다. 로컬에서 whisper.cpp(`whisper-cli`)로
실제 전사를 수행하는 STT provider를 추가하고, `.env`의 `STT_PROVIDER` 값 하나로
API(`whisper`) ↔ 로컬(`whispercpp`)을 전환한다. 프로덕션 코드 경로는 변경하지 않는다.

## 배경

- 비용의 대부분은 Whisper API(분당 $0.006 — 1시간 강의 ≈ $0.36). 요약용 gpt-4o-mini는 미미.
- `SttProvider` 인터페이스(`src/lib/stt/types.ts`)로 이미 추상화되어 있어 provider 추가만으로 충분.
- 실행 환경: Apple M2(Metal 가속), `whisper-cli` brew 설치 완료,
  `storage/models/ggml-large-v3-turbo.bin`(1.6GB) 다운로드 완료.
- `extractAudio`(`src/lib/media.ts`)가 만드는 오디오는 mono 16kHz mp3 —
  whisper-cli 지원 형식(flac, mp3, ogg, wav)이라 추가 변환 불필요.

## 변경 사항

### 1. `src/lib/env.ts`

- `STT_PROVIDER`: `z.enum(["whisper", "deepgram", "whispercpp"])`
- `WHISPER_CPP_BIN`: 기본 `"whisper-cli"` (PATH 탐색)
- `WHISPER_CPP_MODEL`: 기본 `"./storage/models/ggml-large-v3-turbo.bin"`,
  UPLOAD_DIR와 같은 방식으로 `process.cwd()` 기준 절대경로 resolve

### 2. `src/lib/stt/whispercpp.ts` (신규)

`WhisperCppProvider implements SttProvider`:

1. 모델 파일 존재 확인 — 없으면 다운로드 curl 명령이 담긴 한국어 에러
2. 실행: `whisper-cli -m <model> -f <mp3> -oj -of <AUDIO_DIR/<base>.whispercpp> -l auto -np -pp`
   - 파일 크기 제한이 없으므로 API 버전의 25MB 분할 로직 불필요 (통째로 전사)
3. 진행률: `spawn` 기반 실행, stderr의 `progress = NN%` 라인을 파싱해
   `onProgress(percent, 100)` 호출 → 파이프라인의 30→55% 구간에 매핑.
   (`media.ts`의 `run()`은 execFile 버퍼링이라 스트리밍 불가 — provider 내부에 spawn 헬퍼)
4. 출력 JSON의 `transcription[]`(`offsets`는 ms)을 `SttResult`(초 단위)로 변환.
   빈 텍스트 세그먼트만 드롭 — API 버전의 환각 필터(no_speech_prob 등)는
   whisper.cpp JSON에 해당 메타데이터가 없어 적용하지 않음(테스트 용도 트레이드오프).
   변환 로직은 순수 함수로 분리해 단독 검증 가능하게 한다.
5. 임시 JSON 파일은 `removeFiles`로 정리
6. 에러: 바이너리 ENOENT → `brew install whisper-cpp` 안내,
   비정상 종료 → stderr 마지막 줄 포함(`media.ts` 패턴)

### 3. `src/lib/stt/index.ts`

`case "whispercpp": return new WhisperCppProvider();` 추가.

### 4. 문서

`.env.example`에 `STT_PROVIDER` 주석 갱신 + `WHISPER_CPP_BIN`/`WHISPER_CPP_MODEL` 추가,
설치(brew) 및 모델 다운로드(curl) 안내 주석.

## 검증

- 프로젝트에 테스트 러너가 없으므로: JSON→SttResult 변환 순수 함수를 one-off 스크립트로 검증
- e2e: `.env`를 `STT_PROVIDER=whispercpp`로 바꾸고 짧은 샘플 영상 업로드 →
  전사 → 학습 노트 생성까지 확인 (Whisper API 호출 0회)

## 비고

- 파이프라인(`src/lib/pipeline.ts`)은 `getSttProvider()` 뒤의 인터페이스만 보므로 무변경
- 프로덕션 복귀는 `.env`에서 `STT_PROVIDER=whisper` 한 줄

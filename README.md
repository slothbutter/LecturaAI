# LecturaAI

동영상 강의 파일을 업로드하면 AI가 자동으로 내용을 분석·요약해 주는 웹 애플리케이션입니다.

## 동작 흐름

업로드 → 메타데이터 추출 → 오디오 추출 → STT(음성 인식) → 청킹 → LLM 요약 → 결과 생성 → 완료

결과물: 짧은 요약, 전체 요약, 타임라인, 챕터별 노트, 핵심 개념, 용어집, 퀴즈, 액션 아이템

## 기술 스택

- Next.js (App Router) + TypeScript
- Tailwind CSS + shadcn/ui
- Prisma + PostgreSQL
- Zod (환경변수 및 AI 출력 검증)
- STT: OpenAI Whisper 또는 Deepgram
- 요약: OpenAI 호환 LLM

## 시작하기

```bash
# 1. 의존성 설치
npm install

# 2. 환경변수 설정
cp .env.example .env
# .env 에서 DATABASE_URL, OPENAI_API_KEY 등을 채운다

# 3. DB 마이그레이션 (PostgreSQL 실행 중이어야 함)
npx prisma migrate dev

# 4. 개발 서버 실행
npm run dev
```

## 프로젝트 구조

```
prisma/schema.prisma   # DB 스키마 (Video / Transcript / ProcessingJob / Summary)
src/lib/env.ts         # 환경변수 Zod 검증
src/lib/prisma.ts      # PrismaClient 싱글턴
src/lib/storage.ts     # 파일 저장 경로 유틸
src/lib/schemas.ts     # AI 출력/트랜스크립트 Zod 스키마, 처리 단계 상수
src/lib/serialize.ts   # BigInt 안전 JSON 직렬화 헬퍼
storage/uploads        # 업로드된 동영상 (git 미추적)
storage/audio          # 추출된 오디오 (git 미추적)
```

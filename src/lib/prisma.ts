import { PrismaClient } from "@prisma/client";

/**
 * PrismaClient 싱글턴.
 * Next.js dev 모드의 핫 리로드 시 커넥션이 계속 늘어나는 것을 막기 위해
 * globalThis 에 인스턴스를 캐시한다.
 */
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma: PrismaClient =
  globalForPrisma.prisma ??
  new PrismaClient({
    log:
      process.env.NODE_ENV === "development"
        ? ["warn", "error"]
        : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

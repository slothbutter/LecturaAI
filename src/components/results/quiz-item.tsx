"use client";

import * as React from "react";
import type { Quiz } from "@/lib/schemas";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface QuizItemProps {
  quiz: Quiz;
  index: number;
}

/**
 * 퀴즈 1문항 카드.
 * - choices가 있으면 라디오 스타일로 보기를 표시하고 선택할 수 있다(로컬 상태).
 * - "정답 보기" 토글로 answer + explanation을 공개한다.
 */
export function QuizItem({ quiz, index }: QuizItemProps) {
  const [revealed, setRevealed] = React.useState(false);
  const [selected, setSelected] = React.useState<number | null>(null);

  const choices = Array.isArray(quiz?.choices) ? quiz.choices : [];
  const question = quiz?.question ?? "";
  const answer = quiz?.answer ?? "";
  const explanation = quiz?.explanation;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-start gap-2">
          <span className="shrink-0 text-muted-foreground">Q{index + 1}.</span>
          <span className="whitespace-pre-wrap">{question}</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {choices.length > 0 ? (
          <ul className="flex flex-col gap-1.5" role="radiogroup" aria-label={`퀴즈 ${index + 1} 보기`}>
            {choices.map((choice, ci) => {
              const isSelected = selected === ci;
              const isAnswer = revealed && choice === answer;
              return (
                <li key={ci}>
                  <label
                    className={[
                      "flex cursor-pointer items-center gap-2.5 rounded-lg border px-3 py-2 text-sm transition-colors",
                      isAnswer
                        ? "border-primary bg-primary/10 font-medium"
                        : isSelected
                          ? "border-foreground/30 bg-muted"
                          : "border-border hover:bg-muted/50",
                    ].join(" ")}
                  >
                    <input
                      type="radio"
                      name={`quiz-${index}`}
                      className="size-3.5 shrink-0 accent-primary"
                      checked={isSelected}
                      onChange={() => setSelected(ci)}
                    />
                    <span className="whitespace-pre-wrap">{choice}</span>
                    {isAnswer ? (
                      <span className="ml-auto shrink-0 text-xs text-primary">정답</span>
                    ) : null}
                  </label>
                </li>
              );
            })}
          </ul>
        ) : null}

        <div>
          <Button
            variant="outline"
            size="sm"
            aria-expanded={revealed}
            onClick={() => setRevealed((prev) => !prev)}
          >
            {revealed ? "정답 숨기기" : "정답 보기"}
          </Button>
        </div>

        {revealed ? (
          <div className="rounded-lg bg-muted p-3 text-sm">
            <p>
              <span className="font-semibold">정답: </span>
              <span className="whitespace-pre-wrap">{answer}</span>
            </p>
            {explanation ? (
              <p className="mt-1.5 whitespace-pre-wrap text-muted-foreground">
                <span className="font-semibold text-foreground">해설: </span>
                {explanation}
              </p>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

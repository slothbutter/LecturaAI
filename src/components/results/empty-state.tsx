/**
 * 탭 콘텐츠가 비어 있을 때 표시하는 공용 빈 상태 컴포넌트.
 */
export function EmptyState({
  message = "생성된 항목이 없습니다.",
}: {
  message?: string;
}) {
  return (
    <div className="flex items-center justify-center rounded-xl border border-dashed border-border py-12 text-sm text-muted-foreground">
      {message}
    </div>
  );
}

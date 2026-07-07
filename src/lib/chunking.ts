import type { TranscriptSegment } from "@/lib/schemas";

export interface TranscriptChunk {
  index: number;
  startSec: number;
  endSec: number;
  text: string;
  segments: TranscriptSegment[];
}

const DEFAULT_MAX_CHARS = 6000;

/**
 * Split transcript segments into chunks of roughly maxChars characters.
 * - Segments are processed in start-time order.
 * - Segment boundaries are preserved (a segment is never split).
 * - A single segment longer than maxChars becomes its own chunk.
 */
export function chunkSegments(
  segments: TranscriptSegment[],
  maxChars: number = DEFAULT_MAX_CHARS,
): TranscriptChunk[] {
  if (segments.length === 0) return [];

  const sorted = [...segments].sort((a, b) => a.start - b.start);
  const chunks: TranscriptChunk[] = [];

  let current: TranscriptSegment[] = [];
  let currentChars = 0;

  const flush = (): void => {
    if (current.length === 0) return;
    const first = current[0];
    const last = current[current.length - 1];
    chunks.push({
      index: chunks.length,
      startSec: first.start,
      endSec: last.end,
      text: current.map((s) => s.text).join(" "),
      segments: current,
    });
    current = [];
    currentChars = 0;
  };

  for (const segment of sorted) {
    const segChars = segment.text.length;
    // +1 for the joining space when the chunk already has content
    const projected =
      current.length === 0 ? segChars : currentChars + 1 + segChars;

    if (current.length > 0 && projected > maxChars) {
      flush();
      current.push(segment);
      currentChars = segChars;
    } else {
      current.push(segment);
      currentChars = projected;
    }
  }

  flush();
  return chunks;
}

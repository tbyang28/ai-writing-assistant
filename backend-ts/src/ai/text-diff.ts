import { diffArrays } from 'diff';

import { codePointLength, codePointSlice } from '../shared/text';

export interface DiffSegment {
  type: 'equal' | 'delete' | 'insert';
  text: string;
}

/**
 * 字符级 diff —— 移植 ai_service.py 的 build_text_diff。
 *
 * difflib.SequenceMatcher → diff 包 diffArrays（按码点切分数组，避免代理对被切半）。
 * 「≤4 字等片段粘连」启发式：当待 flush 的增删段之间夹着一小段（≤4 字）等文
 * 且后面还是增删段时，把这段等文同时计入两侧，避免碎片化 equal 打断替换对。
 */
export function buildTextDiff(original: string, revised: string): DiffSegment[] {
  const parts = diffArrays(Array.from(original), Array.from(revised));
  const segments: DiffSegment[] = [];
  let pendingOld: string[] = [];
  let pendingNew: string[] = [];

  const flushPending = () => {
    if (pendingOld.length > 0) {
      segments.push({ type: 'delete', text: pendingOld.join('') });
      pendingOld = [];
    }
    if (pendingNew.length > 0) {
      segments.push({ type: 'insert', text: pendingNew.join('') });
      pendingNew = [];
    }
  };

  for (let idx = 0; idx < parts.length; idx++) {
    const part = parts[idx];
    const isChange = Boolean(part.added || part.removed);

    if (!isChange) {
      const text = part.value.join('');
      const next = parts[idx + 1];
      const nextIsChange = next ? Boolean(next.added || next.removed) : false;
      if (
        (pendingOld.length > 0 || pendingNew.length > 0) &&
        text.length > 0 &&
        text.length <= 4 &&
        nextIsChange
      ) {
        // 短等片段：并入两侧待 flush 区，保持替换对完整
        pendingOld.push(text);
        pendingNew.push(text);
      } else {
        flushPending();
        if (text) {
          segments.push({ type: 'equal', text });
        }
      }
    } else if (part.removed) {
      if (part.value.length > 0) {
        pendingOld.push(part.value.join(''));
      }
    } else if (part.added) {
      if (part.value.length > 0) {
        pendingNew.push(part.value.join(''));
      }
    }
  }

  flushPending();
  return segments;
}

/** 变更摘要（UI 展示用）：delete+insert 配对成「将X改为Y」，最多 limit 条 */
export function summarizeDiff(segments: DiffSegment[], limit = 6, excerptLen = 48): string[] {
  const summaries: string[] = [];
  let i = 0;
  while (i < segments.length && summaries.length < limit) {
    const current = segments[i];
    const nextSegment = i + 1 < segments.length ? segments[i + 1] : null;

    if (current.type === 'delete' && nextSegment?.type === 'insert') {
      const old = current.text.trim();
      const next = nextSegment.text.trim();
      if (old || next) {
        summaries.push(`将「${codePointSlice(old, 0, excerptLen)}」改为「${codePointSlice(next, 0, excerptLen)}」`);
      }
      i += 2;
      continue;
    }

    if (current.type === 'delete') {
      const text = current.text.trim();
      if (text) {
        summaries.push(`删除「${codePointSlice(text, 0, excerptLen)}」`);
      }
    } else if (current.type === 'insert') {
      const text = current.text.trim();
      if (text) {
        summaries.push(`新增「${codePointSlice(text, 0, excerptLen)}」`);
      }
    }
    i += 1;
  }

  return summaries;
}

/** 润色的输出预算：原文长度 × 1.4 + 384，夹在 [512, 4096]（长度按码点） */
export function estimatePolishDiffMaxTokens(text: string): number {
  return Math.max(512, Math.min(4096, Math.floor(codePointLength(text) * 1.4) + 384));
}

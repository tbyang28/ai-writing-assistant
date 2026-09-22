import { codePointSlice } from '../shared/text';

export interface ExtractedCharacter {
  name: string;
  role: string;
  bio: string;
  confidence: number;
}

/**
 * 解析 LLM 的人物抽取输出 —— 移植 parse_character_extraction。
 * 容忍 markdown 代码围栏与前后杂文；解析失败抛 SyntaxError
 * （控制器转成 502「AI 返回格式无法解析，请重试」，对齐 Python 的 JSONDecodeError 分支）。
 */
export function parseCharacterExtraction(rawText: string): ExtractedCharacter[] {
  let text = rawText.trim();
  if (text.startsWith('```')) {
    // Python str.strip("`")：两端的所有反引号都剥掉
    text = text.replace(/^`+/, '').replace(/`+$/, '');
    if (text.toLowerCase().startsWith('json')) {
      text = text.slice(4).trim();
    }
  }

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    text = text.slice(start, end + 1);
  }

  const data = JSON.parse(text) as { characters?: unknown };
  const characters = Array.isArray(data?.characters) ? data.characters : [];

  const normalized: ExtractedCharacter[] = [];
  const seen = new Set<string>();

  for (const rawItem of characters) {
    const item = (rawItem ?? {}) as Record<string, unknown>;
    const name = String(item.name ?? '').trim();
    if (!name || seen.has(name)) {
      continue;
    }
    seen.add(name);

    const confidence = Number(item.confidence || 0.7);
    if (Number.isNaN(confidence)) {
      // Python float("...") 对非数值抛错 → 500；这里同语义抛出
      throw new TypeError(`invalid confidence: ${String(item.confidence)}`);
    }

    normalized.push({
      name: codePointSlice(name, 0, 30),
      role: codePointSlice(String(item.role || '未知').trim(), 0, 30),
      bio: codePointSlice(String(item.bio || '').trim(), 0, 160),
      confidence,
    });
  }

  return normalized.slice(0, 12);
}

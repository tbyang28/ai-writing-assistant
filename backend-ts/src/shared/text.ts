/**
 * 文本度量工具 —— Python 的 len()/切片按「码点」计数，
 * JS 的 string.length 按 UTF-16 码元（CJK 扩展 B 区字符占 2 个），
 * 所有字数统计和截断必须走这里，保证与 Python 版数值一致。
 */

/** Python `_word_count(text) = len(text.replace(" ", "").replace("\n", ""))`：只剥空格和换行 */
export function wordCount(text: string): number {
  return codePoints(text.replaceAll(' ', '').replaceAll('\n', '')).length;
}

/** Python `len(text)` 的码点语义 */
export function codePointLength(text: string): number {
  return codePoints(text).length;
}

/**
 * Python `json.dumps(list, ensure_ascii=False)` 兼容序列化 —— 项目分隔符是 ", "
 * （JSON.stringify 是 ","）。tags 字段以字符串形态出入 API，字节级对齐 Python。
 */
export function pyJsonDumpsList(items: string[]): string {
  return `[${items.map((item) => JSON.stringify(item)).join(', ')}]`;
}

/**
 * Python `json.dumps(list)`（ensure_ascii=True 默认）兼容序列化 ——
 * create_inspiration 用的就是这个默认形态：非 ASCII 字符转 \uXXXX 转义。
 * 与 demo seed（显式 ensure_ascii=False）不一致是 Python 侧的事实，照样复刻。
 */
export function pyJsonDumpsAsciiList(items: string[]): string {
  const escape = (s: string) =>
    JSON.stringify(s).replace(
      /[\u0080-￿]/g,
      (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`,
    );
  return `[${items.map(escape).join(', ')}]`;
}

/** Python `text[start:end]` 的码点语义切片（支持负数下标语义交给调用方避免） */
export function codePointSlice(text: string, start: number, end?: number): string {
  return codePoints(text).slice(start, end).join('');
}

function codePoints(text: string): string[] {
  return Array.from(text);
}

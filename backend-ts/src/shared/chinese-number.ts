/**
 * 整数转中文数字 —— 逐行移植 backend/app/utils/chinese_number.py。
 *
 * 用于章节标题自动生成，如 1 → 一、13 → 十三、105 → 一百零五。
 * 支持范围 1..99999999（一亿以内）。
 */

const DIGITS = '零一二三四五六七八九';
const UNITS = ['', '十', '百', '千'];
const BIG_UNITS = ['', '万', '亿'];

/** 将 0-9999 的整数转为中文，不处理前导/末尾的「零」合并 */
function fourDigitsToChinese(num: number): string {
  if (num === 0) {
    return '';
  }
  const chars: string[] = [];
  let unitPos = 0;
  let hasZero = false;
  let rest = num;
  while (rest > 0) {
    const digit = rest % 10;
    if (digit === 0) {
      // 仅在已有非零字符且尚未记录零时，标记需要补零
      if (chars.length > 0 && !hasZero) {
        hasZero = true;
      }
    } else {
      if (hasZero) {
        chars.push(DIGITS[0]);
        hasZero = false;
      }
      chars.push(UNITS[unitPos]);
      chars.push(DIGITS[digit]);
    }
    rest = Math.floor(rest / 10);
    unitPos += 1;
  }
  return chars.reverse().join('');
}

export function toChineseNumber(n: number): string {
  if (!Number.isInteger(n)) {
    throw new TypeError('n 必须为整数');
  }
  if (n <= 0) {
    throw new Error('n 必须为正整数');
  }
  if (n >= 100000000) {
    throw new Error('n 超出支持范围（需小于一亿）');
  }

  if (n < 10) {
    return DIGITS[n];
  }

  // 分段处理：亿 / 万 / 个，每段 4 位
  const segments: Array<[value: number, bigPos: number]> = [];
  let bigPos = 0;
  let rest = n;
  while (rest > 0) {
    segments.push([rest % 10000, bigPos]);
    rest = Math.floor(rest / 10000);
    bigPos += 1;
  }

  const parts: string[] = [];
  for (let i = segments.length - 1; i >= 0; i--) {
    const [value, pos] = segments[i];
    if (value === 0) {
      continue;
    }
    let segStr = fourDigitsToChinese(value);
    // 小于 1000 的非首段需补「零」，如 一万零五
    if (parts.length > 0 && value < 1000) {
      segStr = DIGITS[0] + segStr;
    }
    parts.push(segStr + BIG_UNITS[pos]);
  }

  let result = parts.join('');
  // 10-19 习惯写作「十几」而非「一十几」
  if (result.startsWith('一十')) {
    result = result.slice(1);
  }
  return result;
}

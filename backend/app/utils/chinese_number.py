"""整数转中文数字工具。

主要用于章节标题自动生成，如 1 → 一、13 → 十三、105 → 一百零五。
"""

_DIGITS = "零一二三四五六七八九"
_UNITS = ["", "十", "百", "千"]
_BIG_UNITS = ["", "万", "亿"]


def _four_digits_to_chinese(num: int) -> str:
    """将 0-9999 的整数转为中文，不处理前导/末尾的「零」合并。"""
    if num == 0:
        return ""
    chars = []
    unit_pos = 0
    has_zero = False
    while num > 0:
        digit = num % 10
        if digit == 0:
            # 仅在已有非零字符且尚未记录零时，标记需要补零
            if chars and not has_zero:
                has_zero = True
        else:
            if has_zero:
                chars.append(_DIGITS[0])
                has_zero = False
            chars.append(_UNITS[unit_pos])
            chars.append(_DIGITS[digit])
        num //= 10
        unit_pos += 1
    return "".join(reversed(chars))


def to_chinese_number(n: int) -> str:
    """将正整数转为中文数字。

    支持 1 到 99999999（亿以内）。
    示例：1→一, 10→十, 13→十三, 20→二十, 105→一百零五, 1024→一千零二十四,
    10000→一万, 100000000 及以上不支持。
    """
    if not isinstance(n, int) or isinstance(n, bool):
        raise TypeError("n 必须为整数")
    if n <= 0:
        raise ValueError("n 必须为正整数")
    if n >= 100000000:
        raise ValueError("n 超出支持范围（需小于一亿）")

    if n < 10:
        return _DIGITS[n]

    # 分段处理：亿 / 万 / 个，每段 4 位
    segments = []
    big_pos = 0
    while n > 0:
        segments.append((n % 10000, big_pos))
        n //= 10000
        big_pos += 1

    parts = []
    for value, big_pos in reversed(segments):
        if value == 0:
            continue
        seg_str = _four_digits_to_chinese(value)
        # 小于 1000 的非首段需补「零」，如 一万零五
        if parts and value < 1000:
            seg_str = _DIGITS[0] + seg_str
        parts.append(seg_str + _BIG_UNITS[big_pos])

    result = "".join(parts)

    # 10-19 习惯写作「十几」而非「一十几」
    if result.startswith("一十"):
        result = result[1:]

    return result

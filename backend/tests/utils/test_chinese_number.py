import pytest

from app.utils.chinese_number import to_chinese_number


class TestToChineseNumber:
    @pytest.mark.parametrize(
        "n,expected",
        [
            (1, "一"),
            (2, "二"),
            (9, "九"),
            (10, "十"),
            (11, "十一"),
            (13, "十三"),
            (19, "十九"),
            (20, "二十"),
            (21, "二十一"),
            (99, "九十九"),
            (100, "一百"),
            (101, "一百零一"),
            (105, "一百零五"),
            (110, "一百一十"),
            (111, "一百一十一"),
            (1000, "一千"),
            (1024, "一千零二十四"),
            (2026, "二千零二十六"),
            (10000, "一万"),
            (10001, "一万零一"),
            (10500, "一万零五百"),
            (100000, "十万"),
            (1100000, "一百一十万"),
        ],
    )
    def test_valid_numbers(self, n, expected):
        assert to_chinese_number(n) == expected

    def test_chapter_title_format(self):
        assert f"第{to_chinese_number(1)}章" == "第一章"
        assert f"第{to_chinese_number(13)}章" == "第十三章"

    @pytest.mark.parametrize("n", [0, -1, -100])
    def test_non_positive_raises(self, n):
        with pytest.raises(ValueError):
            to_chinese_number(n)

    def test_out_of_range_raises(self):
        with pytest.raises(ValueError):
            to_chinese_number(100000000)

    @pytest.mark.parametrize("n", [True, 1.5, "1"])
    def test_non_int_raises(self, n):
        with pytest.raises(TypeError):
            to_chinese_number(n)

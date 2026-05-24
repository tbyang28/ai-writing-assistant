"""services/rag_service.py 单元测试

覆盖范围（纯函数部分）：
  - cosine_similarity：相同向量、正交向量、反向向量、零向量
  - split_into_chunks：分块大小、重叠、边界情况
"""
import math
import json

import pytest

from app.services.rag_service import cosine_similarity, split_into_chunks


class TestCosineSimilarity:
    def test_identical_vectors(self):
        """相同向量相似度为 1.0"""
        v = [1.0, 2.0, 3.0]
        assert cosine_similarity(v, v) == pytest.approx(1.0)

    def test_orthogonal_vectors(self):
        """正交向量相似度为 0.0"""
        a = [1.0, 0.0]
        b = [0.0, 1.0]
        assert cosine_similarity(a, b) == pytest.approx(0.0)

    def test_opposite_vectors(self):
        """方向相反的向量相似度为 -1.0"""
        a = [1.0, 2.0]
        b = [-1.0, -2.0]
        assert cosine_similarity(a, b) == pytest.approx(-1.0)

    def test_similar_vectors_close_to_one(self):
        """相近向量相似度接近 1.0"""
        a = [1.0, 2.0, 3.0, 4.0, 5.0]
        b = [1.1, 2.1, 2.9, 4.2, 4.8]
        score = cosine_similarity(a, b)
        assert 0.9 < score < 1.0

    def test_similar_vectors_close_to_zero(self):
        """差异大的向量相似度接近 0"""
        a = [1.0, 0.0, 0.0]
        b = [0.0, 100.0, 0.0]
        assert abs(cosine_similarity(a, b)) < 0.01

    def test_zero_vector(self):
        """零向量相似度为 0.0（避免除零错误）"""
        a = [0.0, 0.0, 0.0]
        b = [1.0, 2.0, 3.0]
        assert cosine_similarity(a, b) == 0.0

    def test_both_zero_vectors(self):
        """两个零向量相似度为 0.0"""
        assert cosine_similarity([0.0, 0.0], [0.0, 0.0]) == 0.0

    def test_single_element_vectors(self):
        """单元素向量"""
        assert cosine_similarity([5.0], [5.0]) == pytest.approx(1.0)
        assert cosine_similarity([5.0], [-5.0]) == pytest.approx(-1.0)

    def test_large_vectors(self):
        """高维向量也能正确计算"""
        a = [float(i) for i in range(100)]
        b = [float(i * 1.01) for i in range(100)]
        score = cosine_similarity(a, b)
        # 接近 1.0 但不是完全相等
        assert 0.9 < score < 1.0


class TestSplitIntoChunks:
    def test_short_text_single_chunk(self):
        """短文本只返回一个块"""
        text = "你好世界"
        chunks = split_into_chunks(text)
        assert len(chunks) == 1
        assert chunks[0] == text

    def test_empty_text(self):
        """空文本返回包含空字符串的列表"""
        chunks = split_into_chunks("")
        assert len(chunks) == 1
        assert chunks[0] == ""

    def test_chunk_size_respected(self):
        """每个块不超过 CHUNK_SIZE 字符"""
        text = "a" * 1200
        chunks = split_into_chunks(text)
        for chunk in chunks:
            assert len(chunk) <= 500  # CHUNK_SIZE = 500

    def test_overlap_exists(self):
        """相邻块之间有重叠"""
        text = "x" * 900
        chunks = split_into_chunks(text)
        assert len(chunks) >= 2
        # 第二块应该包含第一块末尾的内容
        # CHUNK_SIZE=500, CHUNK_OVERLAP=100, 位移=400
        # 块0: [0:500], 块1: [400:800], 应该重叠 [400:500]
        assert chunks[0][400:] == chunks[1][:100]

    def test_multiple_chunks_count(self):
        """计算大文本的块数是否正确"""
        # CHUNK_SIZE=500, CHUNK_OVERLAP=100, stride=400
        # 长度 1200 → 需要 3 块
        text = "a" * 1200
        chunks = split_into_chunks(text)
        expected_count = math.ceil((1200 - 100) / 400)  # ceil(1100/400) = ceil(2.75) = 3
        assert len(chunks) == expected_count

    def test_content_covered_from_start_to_end(self):
        """分块覆盖了文本的完整范围：第一块以开头开始，最后一块以结尾结束"""
        text = "a" * 1500
        chunks = split_into_chunks(text)
        assert chunks[0] == text[:500]
        # 最后一块应包含原文本末尾的内容
        assert chunks[-1][-100:] == text[-100:]

    def test_overlap_value_exact(self):
        """验证实际重叠量等于 CHUNK_OVERLAP"""
        text = "".join(chr(ord("a") + i % 26) for i in range(2000))
        chunks = split_into_chunks(text)
        if len(chunks) >= 2:
            # 块0 尾部 100 字 == 块1 头部 100 字
            assert chunks[0][-100:] == chunks[1][:100]

"""services/ai_service.py mock HTTP 测试

覆盖范围：
  - call_siliconflow：非流式调用的请求/响应
  - build_messages + call_siliconflow 集成
"""
import json
import pytest

from app.services.ai_service import call_siliconflow, build_messages
from app.config import settings


class TestCallSiliconflowMocked:
    """使用 pytest-httpx mock SiliconFlow API 调用"""

    async def test_non_stream_response(self, httpx_mock):
        """非流式请求返回正确的 answer"""
        mock_response = {
            "choices": [{"message": {"content": "你好，我是 AI 助手"}}]
        }
        httpx_mock.add_response(
            url=f"{settings.siliconflow_base_url}/chat/completions",
            method="POST",
            json=mock_response,
            status_code=200,
        )

        messages = [{"role": "user", "content": "你好"}]
        result = await call_siliconflow(messages, stream=False)

        assert result["answer"] == "你好，我是 AI 助手"

    async def test_request_headers_and_body(self, httpx_mock):
        """验证请求头包含正确的认证信息"""
        mock_response = {
            "choices": [{"message": {"content": "ok"}}]
        }
        httpx_mock.add_response(
            url=f"{settings.siliconflow_base_url}/chat/completions",
            method="POST",
            json=mock_response,
            status_code=200,
        )

        await call_siliconflow(
            [{"role": "user", "content": "hi"}],
            stream=False,
        )

        request = httpx_mock.get_request()
        assert request.headers["Authorization"] == f"Bearer {settings.siliconflow_api_key}"
        assert request.headers["Content-Type"] == "application/json"

        body = json.loads(request.content)
        assert body["model"] == settings.deepseek_model
        assert body["stream"] is False
        assert body["max_tokens"] == 4096
        assert len(body["messages"]) == 1

    async def test_custom_generation_options(self, httpx_mock):
        """调用方可以收紧输出预算和采样温度"""
        mock_response = {
            "choices": [{"message": {"content": "ok"}}]
        }
        httpx_mock.add_response(
            url=f"{settings.siliconflow_base_url}/chat/completions",
            method="POST",
            json=mock_response,
            status_code=200,
        )

        await call_siliconflow(
            [{"role": "user", "content": "hi"}],
            stream=False,
            max_tokens=768,
            temperature=0.35,
        )

        request = httpx_mock.get_request()
        body = json.loads(request.content)
        assert body["max_tokens"] == 768
        assert body["temperature"] == 0.35

    async def test_api_error_raises_exception(self, httpx_mock):
        """API 返回错误时抛出异常"""
        httpx_mock.add_response(
            url=f"{settings.siliconflow_base_url}/chat/completions",
            method="POST",
            status_code=401,
            json={"message": "Invalid API key"},
        )

        messages = [{"role": "user", "content": "hi"}]
        with pytest.raises(Exception):
            await call_siliconflow(messages, stream=False)

    async def test_with_build_messages_integration(self, httpx_mock):
        """build_messages + call_siliconflow 集成"""
        mock_response = {
            "choices": [{"message": {"content": "大纲内容"}}]
        }
        httpx_mock.add_response(
            url=f"{settings.siliconflow_base_url}/chat/completions",
            method="POST",
            json=mock_response,
            status_code=200,
        )

        messages = build_messages("outline", "生成武侠小说大纲")
        result = await call_siliconflow(messages, stream=False)

        assert result["answer"] == "大纲内容"
        request = httpx_mock.get_request()
        body = json.loads(request.content)
        # 第一条消息应该是 system prompt
        assert body["messages"][0]["role"] == "system"

    async def test_empty_api_key_returns_error(self, httpx_mock):
        """API key 为空时，请求发出后返回 401"""
        httpx_mock.add_response(
            url=f"{settings.siliconflow_base_url}/chat/completions",
            method="POST",
            status_code=401,
            json={"message": "Invalid API key"},
        )

        messages = [{"role": "user", "content": "hi"}]
        with pytest.raises(Exception):
            await call_siliconflow(messages, stream=False)

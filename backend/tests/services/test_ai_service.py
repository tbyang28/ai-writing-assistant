"""services/ai_service.py 单元测试

覆盖范围（纯函数部分）：
  - build_messages：system prompt 选择、历史消息截断
  - _extract_ai_error：异常信息提取（作为内部函数，从 ai 路由引入测试）
"""
import pytest

from app.services.ai_service import build_messages, build_text_diff, summarize_diff, SYSTEM_PROMPTS


class TestBuildMessages:
    def test_chat_system_prompt(self):
        """chat 指令使用 chat system prompt"""
        messages = build_messages("chat", "你好")
        assert len(messages) == 2
        assert messages[0]["role"] == "system"
        assert messages[0]["content"] == SYSTEM_PROMPTS["chat"]
        assert messages[1]["role"] == "user"
        assert messages[1]["content"] == "你好"

    def test_continue_system_prompt(self):
        """continue 指令使用 continue system prompt"""
        messages = build_messages("continue", "继续写")
        assert messages[0]["content"] == SYSTEM_PROMPTS["continue"]

    def test_improve_system_prompt(self):
        """improve 指令使用 improve system prompt"""
        messages = build_messages("improve", "润色这段")
        assert messages[0]["content"] == SYSTEM_PROMPTS["improve"]

    def test_fix_system_prompt(self):
        """fix 指令使用 fix system prompt"""
        messages = build_messages("fix", "校对这段")
        assert messages[0]["content"] == SYSTEM_PROMPTS["fix"]

    def test_summarize_system_prompt(self):
        """summarize 指令使用 summarize system prompt"""
        messages = build_messages("summarize", "概括这段")
        assert messages[0]["content"] == SYSTEM_PROMPTS["summarize"]

    def test_outline_system_prompt(self):
        """outline 指令使用 outline system prompt"""
        messages = build_messages("outline", "生成大纲")
        assert messages[0]["content"] == SYSTEM_PROMPTS["outline"]

    def test_unknown_key_falls_back_to_chat(self):
        """未知 system_key 回退到 chat prompt"""
        messages = build_messages("nonexistent_key", "测试")
        assert messages[0]["content"] == SYSTEM_PROMPTS["chat"]

    def test_includes_history(self):
        """历史消息正确添加到 system 和 user 之间"""
        history = [
            {"role": "user", "content": "上一轮问题"},
            {"role": "assistant", "content": "上一轮回复"},
        ]
        messages = build_messages("chat", "新问题", history)
        assert len(messages) == 4
        assert messages[1] == history[0]
        assert messages[2] == history[1]
        assert messages[3]["role"] == "user" and messages[3]["content"] == "新问题"

    def test_history_truncated_to_last_10(self):
        """历史消息超过 10 条时截断为最近 10 条"""
        history = [
            {"role": "user" if i % 2 == 0 else "assistant", "content": f"消息{i}"}
            for i in range(20)
        ]
        messages = build_messages("chat", "新问题", history)
        # system + 10 条历史 + 最新 user = 12
        assert len(messages) == 12
        assert messages[0]["role"] == "system"
        # 最近 10 条历史 = msgs[1..10]
        assert messages[1]["content"] == "消息10"  # 第 11 条（0-indexed 10）
        assert messages[10]["content"] == "消息19"  # 第 20 条

    def test_empty_history(self):
        """空历史消息不影响结果"""
        messages = build_messages("chat", "你好", [])
        assert len(messages) == 2

    def test_none_history(self):
        """history 为 None 时"""
        messages = build_messages("chat", "你好", None)
        assert len(messages) == 2

    def test_history_with_invalid_roles_filtered(self):
        """非 user/assistant 角色的历史消息应该被过滤"""
        history = [
            {"role": "user", "content": "你好"},
            {"role": "system", "content": "不要包含我"},
            {"role": "assistant", "content": "回复"},
            {"role": "tool", "content": "也不要包含我"},
        ]
        messages = build_messages("chat", "新问题", history)
        # system + 2 条有效历史 + 最新 user = 4
        assert len(messages) == 4
        contents = [m["content"] for m in messages]
        assert "你好" in contents
        assert "回复" in contents
        assert "不要包含我" not in contents
        assert "也不要包含我" not in contents

    def test_system_prompts_have_all_required_keys(self):
        """所有必要的 system prompt key 都存在"""
        required_keys = {"chat", "continue", "improve", "polish_diff", "fix", "summarize", "outline"}
        assert required_keys.issubset(SYSTEM_PROMPTS.keys())

    def test_all_system_prompts_are_strings(self):
        """所有 system prompt 都是非空字符串"""
        for key, prompt in SYSTEM_PROMPTS.items():
            assert isinstance(prompt, str)
            assert len(prompt) > 50, f"{key} 的 system prompt 太短了"


class TestTextDiff:
    def test_build_text_diff_for_replacement(self):
        segments = build_text_diff("他慢慢的走进屋子。", "他缓缓走进屋子。")
        assert {"type": "delete", "text": "慢慢的"} in segments
        assert {"type": "insert", "text": "缓缓"} in segments

    def test_summarize_diff_for_replace_pair(self):
        segments = [
            {"type": "equal", "text": "他"},
            {"type": "delete", "text": "慢慢的"},
            {"type": "insert", "text": "缓缓"},
            {"type": "equal", "text": "走进屋子。"},
        ]
        summaries = summarize_diff(segments)
        assert summaries[0] == "将「慢慢的」改为「缓缓」"

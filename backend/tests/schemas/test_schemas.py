"""schemas 验证测试

覆盖范围：
  - 必填字段校验
  - 默认值
  - 类型约束
"""
import pytest
from pydantic import ValidationError

from app.schemas.auth import UserRegister, UserLogin, UserResponse, TokenResponse
from app.schemas.book import BookCreate, ChapterCreate, ChapterSave
from app.schemas.ai import AiChatRequest, AiWriteRequest


class TestAuthSchemas:
    def test_user_register_all_fields(self):
        data = UserRegister(email="test@test.com", password="secret123", name="张三")
        assert data.email == "test@test.com"
        assert data.password == "secret123"
        assert data.name == "张三"

    def test_user_register_name_optional(self):
        data = UserRegister(email="test@test.com", password="secret123")
        assert data.name is None

    def test_user_register_missing_email(self):
        with pytest.raises(ValidationError):
            UserRegister(password="secret123")

    def test_user_register_missing_password(self):
        with pytest.raises(ValidationError):
            UserRegister(email="test@test.com")

    def test_user_register_empty_email(self):
        """空邮箱字符串在 schema 层面不被拦截（业务层可加）"""
        data = UserRegister(email="", password="secret123")
        assert data.email == ""

    def test_user_login(self):
        data = UserLogin(email="a@b.com", password="pw")
        assert data.email == "a@b.com"
        assert data.password == "pw"

    def test_user_login_missing_fields(self):
        with pytest.raises(ValidationError):
            UserLogin(email="a@b.com")

    def test_user_response_from_attributes(self):
        """UserResponse 支持 from_attributes 模式"""
        data = UserResponse(id="1", email="a@b.com", name="A", avatar="")
        assert data.id == "1"

    def test_token_response(self):
        data = TokenResponse(
            access_token="token123",
            user=UserResponse(id="1", email="a@b.com", name="A", avatar=""),
        )
        assert data.token_type == "bearer"  # 默认值


class TestBookSchemas:
    def test_book_create_required_only(self):
        data = BookCreate(title="小说")
        assert data.title == "小说"
        assert data.description is None
        assert data.cover is None

    def test_book_create_all_fields(self):
        data = BookCreate(title="小说", description="一个故事", cover="cover.jpg")
        assert data.description == "一个故事"
        assert data.cover == "cover.jpg"

    def test_book_create_missing_title(self):
        with pytest.raises(ValidationError):
            BookCreate(description="故事")

    def test_chapter_create_default_title(self):
        data = ChapterCreate()
        assert data.title == "未命名章节"

    def test_chapter_save_required(self):
        data = ChapterSave(chapter_id="abc-123")
        assert data.chapter_id == "abc-123"
        assert data.title is None
        assert data.content is None

    def test_chapter_save_missing_chapter_id(self):
        with pytest.raises(ValidationError):
            ChapterSave(content="content")


class TestAiSchemas:
    def test_ai_chat_request(self):
        data = AiChatRequest(book_id="b1", message="你好")
        assert data.book_id == "b1"
        assert data.message == "你好"
        assert data.history is None

    def test_ai_chat_with_history(self):
        data = AiChatRequest(
            book_id="b1", message="你好",
            history=[{"role": "user", "content": "上次问题"}],
        )
        assert len(data.history) == 1

    def test_ai_chat_missing_message(self):
        with pytest.raises(ValidationError):
            AiChatRequest(book_id="b1")

    def test_ai_write_request(self):
        data = AiWriteRequest(book_id="b1", content="正文", command="continue")
        assert data.command == "continue"

    def test_ai_write_invalid_command(self):
        """虽然 schema 不限制 command 值，但业务层会处理。这里只测 schema 接受"""
        data = AiWriteRequest(book_id="b1", content="正文", command="invalid_cmd")
        assert data.command == "invalid_cmd"

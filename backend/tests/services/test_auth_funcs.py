"""services/auth.py 单元测试

覆盖范围（纯函数部分）：
  - hash_password / verify_password：加盐哈希、正确/错误密码
  - create_access_token：token 生成、解码、过期时间
"""
import time

import pytest
from jose import jwt, JWTError

from app.config import settings
from app.services.auth import hash_password, verify_password, create_access_token


class TestHashPassword:
    def test_hash_and_verify_success(self):
        """正确密码可以验证通过"""
        pw = "MyP@ssw0rd!"
        hashed = hash_password(pw)
        assert hashed != pw
        assert verify_password(pw, hashed)

    def test_verify_wrong_password(self):
        """错误密码验证失败"""
        hashed = hash_password("correct-password")
        assert not verify_password("wrong-password", hashed)

    def test_verify_empty_string(self):
        """空密码验证失败"""
        hashed = hash_password("some-password")
        assert not verify_password("", hashed)

    def test_same_password_different_hash(self):
        """同一个密码每次哈希结果不同（bcrypt 自动加盐）"""
        pw = "test123"
        h1 = hash_password(pw)
        h2 = hash_password(pw)
        assert h1 != h2
        # 但两个哈希都能验证通过
        assert verify_password(pw, h1)
        assert verify_password(pw, h2)

    def test_hash_with_special_characters(self):
        """特殊字符密码也能正确处理"""
        pw = "!@#$%^&*()_+-=[]{}|;':\",./<>?`~"
        hashed = hash_password(pw)
        assert verify_password(pw, hashed)

    def test_hash_with_unicode(self):
        """中文等 Unicode 密码也能正确处理"""
        pw = "密码123🌟"
        hashed = hash_password(pw)
        assert verify_password(pw, hashed)


class TestCreateAccessToken:
    def test_token_contains_user_id(self):
        """token 的 sub 字段包含用户 ID"""
        uid = "test-user-id"
        token = create_access_token(uid)
        payload = jwt.decode(token, settings.secret_key, algorithms=[settings.algorithm])
        assert payload["sub"] == uid

    def test_token_has_expiry(self):
        """token 包含过期时间"""
        token = create_access_token("user-1")
        payload = jwt.decode(token, settings.secret_key, algorithms=[settings.algorithm])
        assert "exp" in payload
        assert payload["exp"] > time.time()

    def test_token_uses_correct_algorithm(self):
        """token 使用配置中指定的算法"""
        token = create_access_token("user-1")
        payload = jwt.decode(token, settings.secret_key, algorithms=[settings.algorithm])
        assert payload.get("sub") == "user-1"

    def test_token_wrong_secret_fails(self):
        """使用错误的密钥解码应失败"""
        token = create_access_token("user-1")
        with pytest.raises(JWTError):
            jwt.decode(token, "wrong-secret", algorithms=[settings.algorithm])

    def test_multiple_tokens_have_expiry(self):
        """同一用户生成的两次 token 都有过期时间"""
        from jose import jwt
        token1 = create_access_token("user-1")
        token2 = create_access_token("user-1")
        payload1 = jwt.decode(token1, settings.secret_key, algorithms=[settings.algorithm])
        payload2 = jwt.decode(token2, settings.secret_key, algorithms=[settings.algorithm])
        assert payload1["sub"] == "user-1"
        assert payload2["sub"] == "user-1"
        assert "exp" in payload1
        assert "exp" in payload2

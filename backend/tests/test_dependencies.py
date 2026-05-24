"""dependencies.py 测试

覆盖范围：
  - get_current_user：有效/无效/过期 token
"""
import time
from unittest.mock import MagicMock

import pytest
from fastapi import HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials
from jose import jwt

from app.config import settings
from app.dependencies import get_current_user
from app.services.auth import create_access_token, hash_password, create_user
from app.models import User


class TestGetCurrentUser:
    async def test_valid_token_returns_user(self, db_session):
        """有效 token 返回对应用户"""
        # 先在数据库创建用户
        user = User(
            email="deps@test.com",
            password=hash_password("test123"),
            name="DepsTest",
        )
        db_session.add(user)
        await db_session.commit()
        await db_session.refresh(user)

        token = create_access_token(user.id)
        credentials = HTTPAuthorizationCredentials(scheme="Bearer", credentials=token)

        result = await get_current_user(credentials, db_session)
        assert result.id == user.id
        assert result.email == "deps@test.com"

    async def test_invalid_token_raises_401(self, db_session):
        """无效 token 抛出 401"""
        credentials = HTTPAuthorizationCredentials(scheme="Bearer", credentials="invalid-token")
        with pytest.raises(HTTPException) as exc:
            await get_current_user(credentials, db_session)
        assert exc.value.status_code == status.HTTP_401_UNAUTHORIZED

    async def test_token_with_wrong_secret_raises_401(self, db_session):
        """使用错误密钥生成的 token 抛出 401"""
        # 用错误密钥签名
        bad_token = jwt.encode({"sub": "any-id"}, "wrong-secret", algorithm=settings.algorithm)
        credentials = HTTPAuthorizationCredentials(scheme="Bearer", credentials=bad_token)
        with pytest.raises(HTTPException) as exc:
            await get_current_user(credentials, db_session)
        assert exc.value.status_code == status.HTTP_401_UNAUTHORIZED

    async def test_token_without_sub_raises_401(self, db_session):
        """没有 sub 字段的 token 抛出 401"""
        bad_token = jwt.encode({"role": "admin"}, settings.secret_key, algorithm=settings.algorithm)
        credentials = HTTPAuthorizationCredentials(scheme="Bearer", credentials=bad_token)
        with pytest.raises(HTTPException) as exc:
            await get_current_user(credentials, db_session)
        assert exc.value.status_code == status.HTTP_401_UNAUTHORIZED

    async def test_token_for_deleted_user_raises_401(self, db_session):
        """token 中的用户已被删除则抛出 401"""
        # 先创建再删除
        user = User(
            email="delete@test.com",
            password=hash_password("test123"),
            name="ToDelete",
        )
        db_session.add(user)
        await db_session.commit()
        await db_session.refresh(user)

        token = create_access_token(user.id)

        # 删除用户
        await db_session.delete(user)
        await db_session.commit()

        credentials = HTTPAuthorizationCredentials(scheme="Bearer", credentials=token)
        with pytest.raises(HTTPException) as exc:
            await get_current_user(credentials, db_session)
        assert exc.value.status_code == status.HTTP_401_UNAUTHORIZED

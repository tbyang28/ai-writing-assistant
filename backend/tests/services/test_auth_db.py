"""services/auth.py 数据库集成测试

覆盖范围：
  - create_user：用户创建、密码哈希、重复邮箱
  - get_user_by_email：查询命中/未命中
"""
import pytest

from app.services.auth import (
    create_user,
    get_user_by_email,
    hash_password,
    verify_password,
)


class TestCreateUser:
    async def test_create_user_success(self, db_session):
        """正常创建用户返回 User 对象"""
        user = await create_user(db_session, "new@test.com", "password123", "NewUser")
        assert user.id is not None
        assert user.email == "new@test.com"
        assert user.name == "NewUser"

    async def test_password_is_hashed(self, db_session):
        """数据库中存储的是哈希后的密码，不是明文"""
        user = await create_user(db_session, "hash@test.com", "mypassword", "HashTest")
        assert user.password != "mypassword"
        assert verify_password("mypassword", user.password)

    async def test_name_defaults_to_email_prefix(self, db_session):
        """不传 name 时，默认取邮箱 @ 前部分"""
        user = await create_user(db_session, "zhangsan@test.com", "password123")
        assert user.name == "zhangsan"

    async def test_duplicate_email_raises(self, db_session):
        """重复邮箱注册引发 IntegrityError"""
        await create_user(db_session, "dup@test.com", "password123")
        with pytest.raises(Exception):  # SQLAlchemy IntegrityError
            await create_user(db_session, "dup@test.com", "other123")

    async def test_user_has_timestamps(self, db_session):
        """创建的用户带有 created_at / updated_at"""
        user = await create_user(db_session, "time@test.com", "password123")
        assert user.created_at is not None
        assert user.updated_at is not None


class TestGetUserByEmail:
    async def test_find_existing_user(self, db_session):
        """通过邮箱能查到已创建的用户"""
        await create_user(db_session, "find@test.com", "password123", "Finder")
        user = await get_user_by_email(db_session, "find@test.com")
        assert user is not None
        assert user.email == "find@test.com"
        assert user.name == "Finder"

    async def test_find_nonexistent_email(self, db_session):
        """不存在的邮箱返回 None"""
        user = await get_user_by_email(db_session, "nobody@test.com")
        assert user is None

    async def test_email_case_sensitive(self, db_session):
        """邮箱查询默认区分大小写"""
        await create_user(db_session, "Case@test.com", "password123")
        user = await get_user_by_email(db_session, "case@test.com")
        assert user is None  # SQLite 默认 LIKE 不区分大小写？实际取决于 collation
        # 这里只是确认查询行为，如果 SQLite 不区分大小写也可能查到
        # 但至少不会出现预期外的错误

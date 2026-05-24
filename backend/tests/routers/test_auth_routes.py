"""routers/auth.py API 测试

覆盖范围：
  - POST /api/auth/register：成功注册、重复邮箱
  - POST /api/auth/login：成功登录、错误密码
  - GET  /api/auth/profile：获取个人信息、未认证
"""
import pytest


class TestRegister:
    async def test_register_success(self, async_client):
        """注册成功返回 token 和用户信息"""
        resp = await async_client.post("/api/auth/register", json={
            "email": "new@test.com",
            "password": "password123",
            "name": "NewUser",
        })
        assert resp.status_code == 200
        data = resp.json()
        assert "access_token" in data
        assert data["token_type"] == "bearer"
        assert data["user"]["email"] == "new@test.com"
        assert data["user"]["name"] == "NewUser"
        assert "id" in data["user"]

    async def test_register_without_name(self, async_client):
        """不传 name 时可以注册成功，name 默认取邮箱前缀"""
        resp = await async_client.post("/api/auth/register", json={
            "email": "zhangsan@test.com",
            "password": "password123",
        })
        assert resp.status_code == 200
        data = resp.json()
        assert data["user"]["name"] == "zhangsan"

    async def test_register_duplicate_email(self, async_client):
        """重复邮箱注册返回 400"""
        await async_client.post("/api/auth/register", json={
            "email": "dup@test.com",
            "password": "password123",
        })
        resp = await async_client.post("/api/auth/register", json={
            "email": "dup@test.com",
            "password": "other123",
        })
        assert resp.status_code == 400
        assert "邮箱已注册" in resp.json()["detail"]

    async def test_register_missing_password(self, async_client):
        """缺少必填字段返回 422"""
        resp = await async_client.post("/api/auth/register", json={
            "email": "test@test.com",
        })
        assert resp.status_code == 422


class TestLogin:
    async def test_login_success(self, async_client):
        """正确账号密码登录成功"""
        # 先注册
        await async_client.post("/api/auth/register", json={
            "email": "login@test.com",
            "password": "password123",
            "name": "LoginUser",
        })
        # 再登录
        resp = await async_client.post("/api/auth/login", json={
            "email": "login@test.com",
            "password": "password123",
        })
        assert resp.status_code == 200
        data = resp.json()
        assert "access_token" in data
        assert data["user"]["email"] == "login@test.com"
        assert data["user"]["name"] == "LoginUser"

    async def test_login_wrong_password(self, async_client):
        """错误密码返回 401"""
        await async_client.post("/api/auth/register", json={
            "email": "wrongpw@test.com",
            "password": "correct123",
        })
        resp = await async_client.post("/api/auth/login", json={
            "email": "wrongpw@test.com",
            "password": "wrong456",
        })
        assert resp.status_code == 401
        assert "邮箱或密码错误" in resp.json()["detail"]

    async def test_login_nonexistent_email(self, async_client):
        """不存在的邮箱返回 401"""
        resp = await async_client.post("/api/auth/login", json={
            "email": "nobody@test.com",
            "password": "password123",
        })
        assert resp.status_code == 401

    async def test_login_missing_fields(self, async_client):
        """缺少字段返回 422"""
        resp = await async_client.post("/api/auth/login", json={})
        assert resp.status_code == 422


class TestProfile:
    async def test_get_profile_authenticated(self, async_client):
        """已认证用户可以获取个人信息"""
        # 注册获取 token
        reg_resp = await async_client.post("/api/auth/register", json={
            "email": "profile@test.com",
            "password": "password123",
            "name": "ProfileUser",
        })
        token = reg_resp.json()["access_token"]

        # 访问 profile
        resp = await async_client.get(
            "/api/auth/profile",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["email"] == "profile@test.com"
        assert data["name"] == "ProfileUser"

    async def test_get_profile_without_token(self, async_client):
        """未认证访问 profile 返回 403"""
        resp = await async_client.get("/api/auth/profile")
        assert resp.status_code == 403

    async def test_get_profile_invalid_token(self, async_client):
        """无效 token 返回 401"""
        resp = await async_client.get(
            "/api/auth/profile",
            headers={"Authorization": "Bearer invalid-token"},
        )
        assert resp.status_code == 401

"""
pytest 共享 fixture

分层设计：
  - 纯函数测试：无需任何 fixture，直接 import 被测函数即可
  - DB 集成测试：使用 async_db_session fixture
  - API 路由测试：使用 async_client fixture
"""
from typing import AsyncGenerator

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine, async_sessionmaker

from app.database import Base, get_db
from app.main import app
from app.models import User
from app.services.auth import hash_password

# -------- 内存 SQLite 引擎（每个 worker 独立） --------
TEST_DATABASE_URL = "sqlite+aiosqlite://"

_test_engine = create_async_engine(TEST_DATABASE_URL, echo=False)
_test_async_session = async_sessionmaker(_test_engine, class_=AsyncSession, expire_on_commit=False)


@pytest_asyncio.fixture(autouse=True)
async def setup_db():
    """每个测试前重建表（确保测试隔离）"""
    async with _test_engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield
    async with _test_engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)


@pytest_asyncio.fixture
async def db_session() -> AsyncGenerator[AsyncSession, None]:
    """提供独立的数据库会话"""
    async with _test_async_session() as session:
        yield session


# -------- FastAPI TestClient（异步） --------

async def override_get_db() -> AsyncGenerator[AsyncSession, None]:
    """覆盖 FastAPI 的 get_db 依赖，使用测试数据库"""
    async with _test_async_session() as session:
        yield session


@pytest_asyncio.fixture
async def async_client(db_session: AsyncSession) -> AsyncGenerator[AsyncClient, None]:
    """提供异步测试客户端"""
    app.dependency_overrides[get_db] = override_get_db
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        yield client
    app.dependency_overrides.clear()


# -------- 预置测试数据 --------

@pytest_asyncio.fixture
async def test_user(db_session: AsyncSession) -> User:
    """创建一个预置的测试用户"""
    user = User(
        email="test@example.com",
        password=hash_password("password123"),
        name="TestUser",
    )
    db_session.add(user)
    await db_session.commit()
    await db_session.refresh(user)
    return user

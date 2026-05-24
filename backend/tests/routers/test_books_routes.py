"""routers/books.py API 测试

覆盖范围：
  - Books CRUD：创建、列表、详情、更新、删除、权限隔离
  - Chapters CRUD：创建、保存（含字数统计）、发布、删除
  - Outlines / Characters / Inspirations：创建、列表
  - Stats：作品统计、写作统计
"""

import pytest


def _auth_header(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture
async def user_token(async_client) -> str:
    """注册用户并返回 token"""
    resp = await async_client.post("/api/auth/register", json={
        "email": "bookuser@test.com",
        "password": "password123",
    })
    return resp.json()["access_token"]


@pytest.fixture
async def second_user_token(async_client) -> str:
    """第二个用户，用于权限隔离测试"""
    resp = await async_client.post("/api/auth/register", json={
        "email": "other@test.com",
        "password": "password123",
    })
    return resp.json()["access_token"]


@pytest.fixture
async def created_book(async_client, user_token: str) -> dict:
    """创建一个测试用作品"""
    resp = await async_client.post(
        "/api/books",
        json={"title": "测试小说", "description": "一本测试用的小说"},
        headers=_auth_header(user_token),
    )
    return resp.json()


class TestBooks:
    async def test_create_book(self, async_client, user_token: str):
        """创建作品返回 201 和作品信息"""
        resp = await async_client.post(
            "/api/books",
            json={"title": "新小说", "description": "描述"},
            headers=_auth_header(user_token),
        )
        assert resp.status_code == 201
        data = resp.json()
        assert data["title"] == "新小说"
        assert data["description"] == "描述"
        assert data["status"] == "DRAFT"
        assert "id" in data

    async def test_create_book_no_description(self, async_client, user_token: str):
        """不传 description 也能创建"""
        resp = await async_client.post(
            "/api/books",
            json={"title": "无描述"},
            headers=_auth_header(user_token),
        )
        assert resp.status_code == 201
        assert resp.json()["description"] == ""

    async def test_list_books(self, async_client, user_token: str, created_book: dict):
        """列出当前用户的所有作品"""
        resp = await async_client.get(
            "/api/books",
            headers=_auth_header(user_token),
        )
        assert resp.status_code == 200
        data = resp.json()
        assert len(data) >= 1
        assert any(b["id"] == created_book["id"] for b in data)

    async def test_get_book_detail(self, async_client, user_token: str, created_book: dict):
        """获取作品详情包含章节/大纲/角色/灵感"""
        resp = await async_client.get(
            f"/api/books/{created_book['id']}",
            headers=_auth_header(user_token),
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["id"] == created_book["id"]
        assert "chapters" in data
        assert "outlines" in data
        assert "characters" in data
        assert "inspirations" in data

    async def test_get_book_not_found(self, async_client, user_token: str):
        """不存在的作品返回 404"""
        resp = await async_client.get(
            "/api/books/nonexistent-id",
            headers=_auth_header(user_token),
        )
        assert resp.status_code == 404

    async def test_update_book(self, async_client, user_token: str, created_book: dict):
        """更新作品信息"""
        resp = await async_client.put(
            f"/api/books/{created_book['id']}",
            json={"title": "已修改", "status": "SERIAL"},
            headers=_auth_header(user_token),
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["title"] == "已修改"

    async def test_delete_book(self, async_client, user_token: str, created_book: dict):
        """删除作品"""
        resp = await async_client.delete(
            f"/api/books/{created_book['id']}",
            headers=_auth_header(user_token),
        )
        assert resp.status_code == 204

    async def test_book_authorization(self, async_client, user_token: str,
                                       second_user_token: str, created_book: dict):
        """用户 A 不能操作用户 B 的作品"""
        resp = await async_client.get(
            f"/api/books/{created_book['id']}",
            headers=_auth_header(second_user_token),
        )
        assert resp.status_code == 404

    async def test_create_book_unauthenticated(self, async_client):
        """未认证不能创建作品"""
        resp = await async_client.post("/api/books", json={"title": "test"})
        assert resp.status_code == 403


class TestChapters:
    async def test_create_chapter(self, async_client, user_token: str, created_book: dict):
        """创建章节"""
        resp = await async_client.post(
            f"/api/books/{created_book['id']}/chapters",
            json={"title": "第一章"},
            headers=_auth_header(user_token),
        )
        assert resp.status_code == 201
        data = resp.json()
        assert data["title"] == "第一章"
        assert data["book_id"] == created_book["id"]
        assert data["order"] == 1

    async def test_create_chapter_auto_order(self, async_client, user_token: str, created_book: dict):
        """连续创建章节 order 自动递增"""
        c1 = await async_client.post(
            f"/api/books/{created_book['id']}/chapters",
            json={},
            headers=_auth_header(user_token),
        )
        c2 = await async_client.post(
            f"/api/books/{created_book['id']}/chapters",
            json={},
            headers=_auth_header(user_token),
        )
        assert c1.json()["order"] == 1  # 如果之前有测试创建过章节，order 可能 >1
        assert c2.json()["order"] == c1.json()["order"] + 1

    async def test_save_chapter(self, async_client, user_token: str, created_book: dict):
        """保存章节内容并计算字数"""
        c = await async_client.post(
            f"/api/books/{created_book['id']}/chapters",
            json={"title": "待保存"},
            headers=_auth_header(user_token),
        )
        chapter_id = c.json()["id"]

        content = "你好世界！Hello World! "
        resp = await async_client.put(
            "/api/chapters/save",
            json={"chapter_id": chapter_id, "content": content},
            headers=_auth_header(user_token),
        )
        assert resp.status_code == 200
        assert resp.json()["word_count"] > 0

    async def test_save_chapter_updates_book_word_count(self, async_client, user_token: str, created_book: dict):
        """保存章节后作品总字数更新"""
        c = await async_client.post(
            f"/api/books/{created_book['id']}/chapters",
            json={"title": "字数测试"},
            headers=_auth_header(user_token),
        )
        await async_client.put(
            "/api/chapters/save",
            json={"chapter_id": c.json()["id"], "content": "a" * 100},
            headers=_auth_header(user_token),
        )

        book_resp = await async_client.get(
            f"/api/books/{created_book['id']}",
            headers=_auth_header(user_token),
        )
        assert book_resp.json()["word_count"] >= 100

    async def test_publish_chapter(self, async_client, user_token: str, created_book: dict):
        """发布章节"""
        c = await async_client.post(
            f"/api/books/{created_book['id']}/chapters",
            json={"title": "发布测试"},
            headers=_auth_header(user_token),
        )
        resp = await async_client.post(
            "/api/chapters/publish",
            json={"chapter_id": c.json()["id"]},
            headers=_auth_header(user_token),
        )
        assert resp.status_code == 200
        assert resp.json()["status"] == "PUBLISHED"

    async def test_delete_chapter(self, async_client, user_token: str, created_book: dict):
        """删除章节"""
        c = await async_client.post(
            f"/api/books/{created_book['id']}/chapters",
            json={"title": "待删除"},
            headers=_auth_header(user_token),
        )
        resp = await async_client.delete(
            f"/api/books/{created_book['id']}/chapters/{c.json()['id']}",
            headers=_auth_header(user_token),
        )
        assert resp.status_code == 204

    async def test_get_chapter(self, async_client, user_token: str, created_book: dict):
        """获取单个章节"""
        c = await async_client.post(
            f"/api/books/{created_book['id']}/chapters",
            json={"title": "查看测试"},
            headers=_auth_header(user_token),
        )
        resp = await async_client.get(
            f"/api/chapters/{c.json()['id']}",
            headers=_auth_header(user_token),
        )
        assert resp.status_code == 200
        assert resp.json()["title"] == "查看测试"


class TestOutlines:
    async def test_create_and_list_outlines(self, async_client, user_token: str, created_book: dict):
        """大纲创建和列表"""
        resp = await async_client.post(
            f"/api/books/{created_book['id']}/outlines",
            json={"title": "第一卷", "content": "第一章到第十章"},
            headers=_auth_header(user_token),
        )
        assert resp.status_code == 201

        list_resp = await async_client.get(
            f"/api/books/{created_book['id']}/outlines",
            headers=_auth_header(user_token),
        )
        assert list_resp.status_code == 200
        assert len(list_resp.json()) >= 1
        assert list_resp.json()[0]["title"] == "第一卷"


class TestCharacters:
    async def test_create_and_list_characters(self, async_client, user_token: str, created_book: dict):
        """角色创建和列表"""
        resp = await async_client.post(
            f"/api/books/{created_book['id']}/characters",
            json={"name": "张三", "role": "主角", "bio": "剑客"},
            headers=_auth_header(user_token),
        )
        assert resp.status_code == 201

        list_resp = await async_client.get(
            f"/api/books/{created_book['id']}/characters",
            headers=_auth_header(user_token),
        )
        assert list_resp.status_code == 200
        names = [c["name"] for c in list_resp.json()]
        assert "张三" in names


class TestInspirations:
    async def test_create_and_list_inspirations(self, async_client, user_token: str, created_book: dict):
        """灵感创建和列表"""
        resp = await async_client.post(
            f"/api/books/{created_book['id']}/inspirations",
            json={"title": "灵感一", "content": "一个有趣的点子", "tags": ["武侠", "奇幻"]},
            headers=_auth_header(user_token),
        )
        assert resp.status_code == 201

        list_resp = await async_client.get(
            f"/api/books/{created_book['id']}/inspirations",
            headers=_auth_header(user_token),
        )
        assert list_resp.status_code == 200
        assert list_resp.json()[0]["title"] == "灵感一"


class TestStats:
    async def test_book_stats(self, async_client, user_token: str, created_book: dict):
        """作品统计"""
        resp = await async_client.get(
            "/api/books/stats",
            headers=_auth_header(user_token),
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["totalBooks"] >= 1
        assert "totalWords" in data
        assert "totalChapters" in data

    async def test_writing_stats(self, async_client, user_token: str, created_book: dict):
        """写作统计"""
        resp = await async_client.get(
            "/api/stats?days=7",
            headers=_auth_header(user_token),
        )
        assert resp.status_code == 200
        data = resp.json()
        assert "today_word_count" in data
        assert "total_word_count" in data
        assert "last_7_days" in data
        assert len(data["last_7_days"]) == 7

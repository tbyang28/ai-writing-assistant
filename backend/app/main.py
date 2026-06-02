import traceback
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.database import init_db
from app.routers import auth, books, ai
from app.config import settings
from app.services.ai_service import close_client


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    yield
    await close_client()


app = FastAPI(
    title="AI 写作助手",
    description="AI-Copilot Writing Platform Backend",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://localhost:5174",
        "http://localhost",
        "http://127.0.0.1:5173",
        "https://*.vercel.app",
        "https://ai-writing-assistant-web.onrender.com",
    ],
    allow_origin_regex=settings.cors_allow_origin_regex,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    traceback.print_exc()
    return JSONResponse(
        status_code=500,
        content={"detail": f"Internal server error: {str(exc)}"},
    )


app.include_router(auth.router)
app.include_router(books.router)
app.include_router(ai.router)


@app.get("/")
async def root():
    return {
        "status": "ok",
        "message": "AI Writing Platform Backend is running",
        "docs": "/docs",
        "health": "/api/health",
    }


@app.get("/api/health")
async def health():
    return {"status": "ok", "message": "AI Writing Platform Backend is running"}


@app.get("/health")
async def health_alias():
    return await health()

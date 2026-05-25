from pydantic_settings import BaseSettings

# 可选 AI 模型列表（前端切换用）
# key 是显示名，value 是 SiliconFlow API 的 model ID
AI_MODELS: dict[str, str] = {
    "DeepSeek-V4-Flash": "deepseek-ai/DeepSeek-V4-Flash",
    "DeepSeek-V3.2": "deepseek-ai/DeepSeek-V3.2",
    "GLM-4.7": "zai-org/GLM-4.7",
    "GLM-Z1-32B": "THUDM/GLM-Z1-32B-0414",
    "MiniMax-M2.5": "MiniMaxAI/MiniMax-M2.5",
}


class Settings(BaseSettings):
    database_url: str = "sqlite+aiosqlite:///./writing_platform.db"
    secret_key: str = "change-this-secret-key"
    algorithm: str = "HS256"
    access_token_expire_minutes: int = 1440
    siliconflow_api_key: str = ""
    siliconflow_base_url: str = "https://api.siliconflow.cn/v1"
    deepseek_model: str = "deepseek-ai/DeepSeek-V3.2"

    class Config:
        env_file = ".env"


settings = Settings()

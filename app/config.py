from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


BASE_DIR = Path(__file__).resolve().parent.parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=BASE_DIR / ".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    database_url: str = Field(
        default=f"sqlite:///{BASE_DIR / 'forecasting.db'}",
        description="SQLAlchemy database URL.",
    )
    openai_api_key: str | None = Field(
        default=None,
        description="OpenAI API key for live AI-assisted forecasting.",
    )
    openai_model: str = Field(
        default="gpt-5",
        description="OpenAI model used for live forecast analysis.",
    )
    demo_ai_without_key: bool = Field(
        default=True,
        description="Use deterministic demo AI findings when OPENAI_API_KEY is not set.",
    )


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()

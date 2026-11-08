"""Loads NVIDIA credentials from the environment or the repo-root .env file."""

import os
from pathlib import Path

from dotenv import load_dotenv
from pydantic import BaseModel, SecretStr

REPO_ROOT = Path(__file__).resolve().parents[3]


class ConfigError(RuntimeError):
    """Required configuration is missing."""


class Settings(BaseModel):
    api_key: SecretStr
    base_url: str
    model: str


def load_settings() -> Settings:
    # Real environment variables take precedence over .env.
    load_dotenv(REPO_ROOT / ".env", override=False)
    required = ("NVIDIA_API_KEY", "NVIDIA_BASE_URL", "NVIDIA_MODEL")
    values = {name: os.environ.get(name, "").strip() for name in required}
    missing = [name for name, value in values.items() if not value]
    if missing:
        raise ConfigError(
            f"Missing {', '.join(missing)}. Set them in {REPO_ROOT / '.env'} "
            "or in the environment."
        )
    return Settings(
        api_key=SecretStr(values["NVIDIA_API_KEY"]),
        base_url=values["NVIDIA_BASE_URL"],
        model=values["NVIDIA_MODEL"],
    )

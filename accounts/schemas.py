"""Validated account and administrator request bodies."""

import re
from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator
from accounts.store import SERVICES


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Login(StrictModel):
    username: str = Field(min_length=3, max_length=254)
    password: str = Field(min_length=1, max_length=128)

    @field_validator("username")
    @classmethod
    def normalize_identifier(cls, value):
        value = value.strip().lower()
        if "@" in value:
            from pydantic import TypeAdapter

            return str(TypeAdapter(EmailStr).validate_python(value)).lower()
        if not re.fullmatch(r"[a-z0-9_.-]{3,64}", value):
            raise ValueError("请输入邮箱或用户名")
        return value


class Register(StrictModel):
    email: EmailStr = Field(max_length=254)
    password: str = Field(min_length=6, max_length=128)


class RegistrationDefaults(StrictModel):
    rpm: int = Field(ge=1, le=600)
    daily_requests: int = Field(ge=1, le=1000000)
    concurrency: int = Field(ge=1, le=8)


class Refresh(StrictModel):
    refresh_token: str = Field(min_length=20, max_length=256)


class NewPassword(StrictModel):
    current_password: str = Field(min_length=1, max_length=128)
    new_password: str = Field(min_length=6, max_length=128)


class NewUser(StrictModel):
    username: str = Field(min_length=3, max_length=64, pattern=r"^[a-zA-Z0-9_.-]+$")
    services: list[str] = Field(
        default_factory=lambda: sorted(SERVICES), min_length=1, max_length=3
    )
    rpm: int = Field(default=30, ge=0, le=600)
    daily_requests: int = Field(default=1000, ge=0, le=1000000)
    concurrency: int = Field(default=2, ge=1, le=8)


class UpdateUser(StrictModel):
    enabled: bool | None = None
    services: list[str] | None = Field(default=None, max_length=3)
    rpm: int | None = Field(default=None, ge=0, le=1000000000)
    daily_requests: int | None = Field(default=None, ge=0, le=1000000000)
    concurrency: int | None = Field(default=None, ge=1, le=8)


class NewKey(StrictModel):
    name: str = Field(min_length=1, max_length=80)
    services: list[str] = Field(min_length=1, max_length=3)
    days: int = Field(default=90, ge=1, le=365)

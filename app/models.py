from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import DateTime, ForeignKey, Integer, Numeric, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Product(Base):
    __tablename__ = "products"

    id: Mapped[int] = mapped_column(primary_key=True)
    item_code: Mapped[str] = mapped_column(String(128), unique=True, index=True)
    product_name: Mapped[str] = mapped_column(String(255))
    brand: Mapped[str] = mapped_column(String(128))
    product_type: Mapped[str] = mapped_column(String(32))
    description: Mapped[str] = mapped_column(Text)
    retail_price: Mapped[float] = mapped_column(Numeric(10, 2))

    forecast_values: Mapped[list[ForecastValue]] = relationship(
        back_populates="product", cascade="all, delete-orphan"
    )
    actual_shipments: Mapped[list[ActualShipment]] = relationship(
        back_populates="product", cascade="all, delete-orphan"
    )
    historical_forecasts: Mapped[list[HistoricalForecast]] = relationship(
        back_populates="product", cascade="all, delete-orphan"
    )
    findings: Mapped[list[AIFinding]] = relationship(back_populates="product")


class ForecastUpload(Base):
    __tablename__ = "forecast_uploads"

    id: Mapped[int] = mapped_column(primary_key=True)
    original_filename: Mapped[str] = mapped_column(String(255))
    status: Mapped[str] = mapped_column(String(32), default="active")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    error_message: Mapped[str | None] = mapped_column(Text)

    values: Mapped[list[ForecastValue]] = relationship(
        back_populates="forecast_upload", cascade="all, delete-orphan"
    )
    ai_jobs: Mapped[list[AIJob]] = relationship(
        back_populates="forecast_upload", cascade="all, delete-orphan"
    )


class ForecastValue(Base):
    __tablename__ = "forecast_values"
    __table_args__ = (
        UniqueConstraint("forecast_upload_id", "product_id", "month_year", name="uq_forecast_product_month"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    forecast_upload_id: Mapped[int] = mapped_column(ForeignKey("forecast_uploads.id"))
    product_id: Mapped[int] = mapped_column(ForeignKey("products.id"))
    month_year: Mapped[str] = mapped_column(String(7))
    forecast_units: Mapped[int] = mapped_column(Integer)

    forecast_upload: Mapped[ForecastUpload] = relationship(back_populates="values")
    product: Mapped[Product] = relationship(back_populates="forecast_values")


class ActualShipment(Base):
    __tablename__ = "actual_shipments"
    __table_args__ = (
        UniqueConstraint("product_id", "month_year", name="uq_actual_product_month"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    product_id: Mapped[int] = mapped_column(ForeignKey("products.id"))
    month_year: Mapped[str] = mapped_column(String(7))
    units_shipped: Mapped[int] = mapped_column(Integer)

    product: Mapped[Product] = relationship(back_populates="actual_shipments")


class HistoricalForecast(Base):
    __tablename__ = "historical_forecasts"
    __table_args__ = (
        UniqueConstraint("product_id", "month_year", name="uq_historical_forecast_product_month"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    product_id: Mapped[int] = mapped_column(ForeignKey("products.id"))
    month_year: Mapped[str] = mapped_column(String(7))
    forecast_units: Mapped[int] = mapped_column(Integer)

    product: Mapped[Product] = relationship(back_populates="historical_forecasts")


class AIJob(Base):
    __tablename__ = "ai_jobs"

    id: Mapped[int] = mapped_column(primary_key=True)
    forecast_upload_id: Mapped[int] = mapped_column(ForeignKey("forecast_uploads.id"))
    status: Mapped[str] = mapped_column(String(32), default="queued")
    user_context: Mapped[str] = mapped_column(Text, default="")
    openai_response_id: Mapped[str | None] = mapped_column(String(255))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    error_message: Mapped[str | None] = mapped_column(Text)

    forecast_upload: Mapped[ForecastUpload] = relationship(back_populates="ai_jobs")
    findings: Mapped[list[AIFinding]] = relationship(
        back_populates="ai_job", cascade="all, delete-orphan"
    )


class AIFinding(Base):
    __tablename__ = "ai_findings"

    id: Mapped[int] = mapped_column(primary_key=True)
    ai_job_id: Mapped[int] = mapped_column(ForeignKey("ai_jobs.id"))
    product_id: Mapped[int] = mapped_column(ForeignKey("products.id"))
    month_year: Mapped[str] = mapped_column(String(7))
    finding_type: Mapped[str] = mapped_column(String(32))
    description: Mapped[str] = mapped_column(Text)
    impact: Mapped[int] = mapped_column(Integer)
    citations_json: Mapped[str] = mapped_column(Text, default="[]")

    ai_job: Mapped[AIJob] = relationship(back_populates="findings")
    product: Mapped[Product] = relationship(back_populates="findings")

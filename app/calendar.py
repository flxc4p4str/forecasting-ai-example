from __future__ import annotations

from datetime import date


def month_key(year: int, month: int) -> str:
    return f"{year:04d}-{month:02d}"


def add_months(year: int, month: int, offset: int) -> tuple[int, int]:
    zero_based = (year * 12 + month - 1) + offset
    return zero_based // 12, zero_based % 12 + 1


def current_months(count: int = 12, today: date | None = None) -> list[str]:
    today = today or date.today()
    return [month_key(*add_months(today.year, today.month, offset)) for offset in range(count)]


def same_month_last_year(month_year: str) -> str:
    year, month = month_year.split("-")
    return f"{int(year) - 1:04d}-{month}"

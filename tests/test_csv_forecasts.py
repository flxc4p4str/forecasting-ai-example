from __future__ import annotations

from datetime import date

import pytest

from app.csv_forecasts import ForecastCSVError, forecast_template_csv, parse_forecast_csv


def test_template_includes_item_code_and_twelve_months() -> None:
    contents = forecast_template_csv(today=date(2026, 5, 8))

    header = contents.splitlines()[0].split(",")

    assert header[0] == "item_code"
    assert header[-12:] == [
        "2026-05",
        "2026-06",
        "2026-07",
        "2026-08",
        "2026-09",
        "2026-10",
        "2026-11",
        "2026-12",
        "2027-01",
        "2027-02",
        "2027-03",
        "2027-04",
    ]


def test_parse_forecast_csv_normalizes_item_codes_and_unit_values() -> None:
    contents = "\n".join(
        [
            "item_code,2026-05,2026-06",
            "CHANEL-N5-EDP,100,125",
        ]
    )

    months, rows = parse_forecast_csv(contents)

    assert months == ["2026-05", "2026-06"]
    assert len(rows) == 1
    assert rows[0].item_code == "CHANEL-N5-EDP"
    assert rows[0].values["2026-06"] == 125


def test_parse_forecast_csv_rejects_missing_item_code_column() -> None:
    with pytest.raises(ForecastCSVError, match="item_code"):
        parse_forecast_csv("product_name,2026-05\nAmber,100\n")


def test_parse_forecast_csv_rejects_duplicate_item_codes() -> None:
    contents = "item_code,2026-05\nA1,100\nA1,200\n"

    with pytest.raises(ForecastCSVError, match="Duplicate"):
        parse_forecast_csv(contents)


def test_parse_forecast_csv_rejects_non_integer_values() -> None:
    contents = "item_code,2026-05\nA1,125.50\n"

    with pytest.raises(ForecastCSVError, match="non-integer"):
        parse_forecast_csv(contents)


def test_parse_forecast_csv_rejects_negative_units() -> None:
    contents = "item_code,2026-05\nA1,-1\n"

    with pytest.raises(ForecastCSVError, match="negative"):
        parse_forecast_csv(contents)

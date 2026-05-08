from __future__ import annotations

import csv
from dataclasses import dataclass
from datetime import date
from io import StringIO
import re

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.calendar import current_months
from app.models import ForecastUpload, ForecastValue, Product


MONTH_RE = re.compile(r"^\d{4}-\d{2}$")
REQUIRED_ITEM_CODE = "item_code"


class ForecastCSVError(ValueError):
    pass


@dataclass(frozen=True)
class ParsedForecastRow:
    item_code: str
    values: dict[str, int]


def forecast_template_csv(today: date | None = None, products: list[Product] | None = None) -> str:
    output = StringIO()
    months = current_months(today=today)
    fieldnames = [REQUIRED_ITEM_CODE, *months]
    writer = csv.DictWriter(output, fieldnames=fieldnames)
    writer.writeheader()

    if products:
        for product in products:
            row = {REQUIRED_ITEM_CODE: product.item_code}
            for month_index, month in enumerate(months):
                row[month] = str(1000 + month_index * 25)
            writer.writerow(row)
    else:
        writer.writerow({REQUIRED_ITEM_CODE: "CHANEL-N5-EDP", months[0]: "1280"})
    return output.getvalue()


def parse_forecast_csv(contents: str) -> tuple[list[str], list[ParsedForecastRow]]:
    reader = csv.DictReader(StringIO(contents))
    if not reader.fieldnames:
        raise ForecastCSVError("CSV must include a header row.")

    fieldnames = [field.strip() for field in reader.fieldnames]
    if REQUIRED_ITEM_CODE not in fieldnames:
        raise ForecastCSVError("CSV must include an item_code column.")

    month_columns = [field for field in fieldnames if MONTH_RE.match(field)]
    if not month_columns:
        raise ForecastCSVError("CSV must include at least one month column in YYYY-MM format.")

    seen_item_codes: set[str] = set()
    rows: list[ParsedForecastRow] = []
    for index, raw_row in enumerate(reader, start=2):
        row = {key.strip(): (value or "").strip() for key, value in raw_row.items() if key}
        item_code = row.get(REQUIRED_ITEM_CODE, "")
        if not item_code:
            raise ForecastCSVError(f"Row {index} is missing item_code.")
        if item_code in seen_item_codes:
            raise ForecastCSVError(f"Duplicate item_code {item_code!r}.")
        seen_item_codes.add(item_code)

        values: dict[str, int] = {}
        for month in month_columns:
            raw_value = row.get(month, "")
            if raw_value == "":
                raise ForecastCSVError(f"Row {index} is missing value for {month}.")
            try:
                units = int(raw_value.replace(",", ""))
            except ValueError as exc:
                raise ForecastCSVError(
                    f"Row {index} has non-integer value {raw_value!r} for {month}."
                ) from exc
            if units < 0:
                raise ForecastCSVError(f"Row {index} has negative forecast units for {month}.")
            values[month] = units

        rows.append(ParsedForecastRow(item_code=item_code, values=values))

    if not rows:
        raise ForecastCSVError("CSV must include at least one forecast row.")

    return month_columns, rows


def apply_forecast_csv(
    db: Session,
    forecast_upload: ForecastUpload,
    parsed_rows: list[ParsedForecastRow],
) -> None:
    products = {
        product.item_code: product
        for product in db.scalars(select(Product).order_by(Product.item_code))
    }
    existing_values = {
        (value.product_id, value.month_year): value
        for value in forecast_upload.values
    }

    for parsed in parsed_rows:
        product = products.get(parsed.item_code)
        if product is None:
            raise ForecastCSVError(
                f"Unknown item_code {parsed.item_code!r}; forecast CSVs can only update existing ERP products."
            )

        for month_year, units in parsed.values.items():
            key = (product.id, month_year)
            existing = existing_values.get(key)
            if existing:
                existing.forecast_units = units
            else:
                forecast_upload.values.append(
                    ForecastValue(
                        forecast_upload=forecast_upload,
                        product=product,
                        month_year=month_year,
                        forecast_units=units,
                    )
                )

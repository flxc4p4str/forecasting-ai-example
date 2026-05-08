from __future__ import annotations

from dataclasses import dataclass
from datetime import date

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.calendar import current_months, same_month_last_year
from app.models import ActualShipment, ForecastUpload, ForecastValue, HistoricalForecast, Product


@dataclass(frozen=True)
class ProductSeed:
    item_code: str
    product_name: str
    brand: str
    product_type: str
    description: str
    retail_price: float
    base_units: int
    trend: float
    promo_months: tuple[int, ...]


PRODUCTS = [
    ProductSeed(
        item_code="CHANEL-N5-EDP",
        product_name="Chanel N°5 Eau de Parfum",
        brand="Chanel",
        product_type="basic",
        description="Iconic aldehydic floral fragrance built around May rose and jasmine, with bright citrus facets and a smooth bourbon vanilla trail.",
        retail_price=190.00,
        base_units=1180,
        trend=1.03,
        promo_months=(5, 11, 12),
    ),
    ProductSeed(
        item_code="DIOR-SAUV-EDP",
        product_name="Dior Sauvage Eau de Parfum",
        brand="Dior",
        product_type="basic",
        description="Citrus-and-vanilla fragrance inspired by desert twilight, pairing spicy Calabrian bergamot with Papua New Guinean vanilla.",
        retail_price=165.00,
        base_units=1680,
        trend=1.05,
        promo_months=(6, 11, 12),
    ),
    ProductSeed(
        item_code="MFK-BR540-EDP",
        product_name="Maison Francis Kurkdjian Baccarat Rouge 540 Eau de Parfum",
        brand="Maison Francis Kurkdjian",
        product_type="basic",
        description="Amber woody floral scent with jasmine, saffron, ambergris mineral facets, and freshly cut cedar.",
        retail_price=325.00,
        base_units=620,
        trend=1.08,
        promo_months=(2, 11, 12),
    ),
    ProductSeed(
        item_code="YSL-LIBRE-EDP",
        product_name="Yves Saint Laurent Libre Eau de Parfum",
        brand="Yves Saint Laurent",
        product_type="basic",
        description="Floral lavender fragrance contrasting Moroccan orange blossom, French lavender, and warm vanilla in a couture bottle.",
        retail_price=160.00,
        base_units=1120,
        trend=1.06,
        promo_months=(3, 5, 12),
    ),
    ProductSeed(
        item_code="TF-LOSTCHERRY-EDP",
        product_name="Tom Ford Lost Cherry Eau de Parfum",
        brand="Tom Ford",
        product_type="promo",
        description="Luscious cherry fragrance with black cherry, bitter almond, cherry liqueur, rose, jasmine sambac, sandalwood, vetiver, and cedarwood.",
        retail_price=255.00,
        base_units=540,
        trend=1.07,
        promo_months=(2, 10, 12),
    ),
    ProductSeed(
        item_code="JM-WSS-COLOGNE",
        product_name="Jo Malone Wood Sage & Sea Salt Cologne",
        brand="Jo Malone London",
        product_type="basic",
        description="Fresh woody coastal cologne with ambrette seed, sea salt, and sage notes inspired by windswept British shores.",
        retail_price=165.00,
        base_units=740,
        trend=1.04,
        promo_months=(6, 7, 8),
    ),
]


def seed_demo_data(db: Session, today: date | None = None) -> None:
    if db.scalar(select(Product.id).limit(1)) is not None:
        return

    months = current_months(today=today)
    forecast = ForecastUpload(original_filename="Demo ERP forecast", status="active")
    db.add(forecast)

    for index, seed in enumerate(PRODUCTS):
        product = Product(
            item_code=seed.item_code,
            product_name=seed.product_name,
            brand=seed.brand,
            product_type=seed.product_type,
            description=seed.description,
            retail_price=seed.retail_price,
        )
        db.add(product)

        for month_index, month_year in enumerate(months):
            month_number = int(month_year[-2:])
            seasonal = seasonal_multiplier(month_number, seed.promo_months)
            last_year_month = same_month_last_year(month_year)
            last_year_actual = int(seed.base_units * seasonal * (0.94 + month_index * 0.006))
            last_year_forecast = int(last_year_actual * (0.96 + ((index + month_index) % 5) * 0.018))
            this_year_forecast = int(last_year_actual * seed.trend * (1.0 + ((month_index % 4) - 1.5) * 0.018))

            db.add(
                ActualShipment(
                    product=product,
                    month_year=last_year_month,
                    units_shipped=last_year_actual,
                )
            )
            db.add(
                HistoricalForecast(
                    product=product,
                    month_year=last_year_month,
                    forecast_units=last_year_forecast,
                )
            )
            db.add(
                ForecastValue(
                    forecast_upload=forecast,
                    product=product,
                    month_year=month_year,
                    forecast_units=this_year_forecast,
                )
            )

    db.commit()


def seasonal_multiplier(month: int, promo_months: tuple[int, ...]) -> float:
    if month in promo_months:
        return 1.38
    if month in (11, 12):
        return 1.18
    if month in (1, 2):
        return 0.88
    if month in (6, 7, 8):
        return 1.08
    return 1.0

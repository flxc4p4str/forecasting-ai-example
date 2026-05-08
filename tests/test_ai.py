from __future__ import annotations

import pytest

from sqlalchemy import select

from app.ai import AIFindingGroup, AIItem, load_prompt, parse_ai_response, persist_findings
from app.models import AIFinding, AIJob, ForecastUpload, ForecastValue, Product


def test_parse_ai_response_returns_finding_groups() -> None:
    payload = {
        "findings": [
            {
                "product_id": "A1",
                "month_year": "2026-05",
                "considerations": [{"description": "Regional event may lift demand.", "impact": 2}],
                "recommendations": [{"description": "Feature the product in display.", "impact": 3}],
            }
        ]
    }

    findings = parse_ai_response(payload)

    assert len(findings) == 1
    assert findings[0].product_id == "A1"
    assert findings[0].month_year == "2026-05"
    assert findings[0].considerations[0].impact == 2
    assert findings[0].recommendations[0].description == "Feature the product in display."


def test_load_prompt_reads_editable_prompt_files() -> None:
    researcher_prompt = load_prompt("ai_researcher.md")
    recommendation_policy = load_prompt("recommendation_policy.md")

    assert "product-market researcher" in researcher_prompt
    assert "not instructions to adjust forecast units" in recommendation_policy


def test_parse_ai_response_rejects_out_of_range_impact() -> None:
    payload = {
        "findings": [
            {
                "product_id": "A1",
                "month_year": "2026-05",
                "considerations": [{"description": "Too large.", "impact": 4}],
                "recommendations": [],
            }
        ]
    }

    with pytest.raises(ValueError, match="between -3 and \\+3"):
        parse_ai_response(payload)


def test_persist_findings_allows_known_product_outside_forecast_month(db_session) -> None:
    product = Product(
        item_code="TF-LOSTCHERRY-EDP",
        product_name="Tom Ford Lost Cherry Eau de Parfum",
        brand="Tom Ford",
        product_type="promo",
        description="Black cherry, bitter almond, cherry liqueur, rose, and woods.",
        retail_price=255,
    )
    forecast = ForecastUpload(original_filename="demo", status="active")
    forecast.values.append(
        ForecastValue(product=product, month_year="2026-05", forecast_units=100)
    )
    job = AIJob(forecast_upload=forecast, status="running")
    db_session.add_all([product, forecast, job])
    db_session.commit()

    persist_findings(
        db_session,
        job,
        [
            AIFindingGroup(
                product_id="TF-LOSTCHERRY-EDP",
                month_year="2026-02",
                considerations=[AIItem(description="Valentine's date-night demand may matter.", impact=2)],
                recommendations=[AIItem(description="Use cherry-red date-night display creative.", impact=1)],
            )
        ],
    )
    db_session.commit()

    findings = db_session.scalars(select(AIFinding)).all()
    assert len(findings) == 2
    assert {finding.month_year for finding in findings} == {"2026-02"}

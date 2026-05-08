from __future__ import annotations

from dataclasses import dataclass
import json
from pathlib import Path
from time import sleep

from openai import OpenAI
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.config import settings
from app.calendar import same_month_last_year
from app.database import SessionLocal
from app.models import AIFinding, AIJob, ForecastUpload, Product, utcnow


PROMPTS_DIR = Path(__file__).with_name("prompts")


@dataclass(frozen=True)
class AIItem:
    description: str
    impact: int


@dataclass(frozen=True)
class AIFindingGroup:
    product_id: str
    month_year: str
    considerations: list[AIItem]
    recommendations: list[AIItem]


FORECAST_ANALYSIS_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["findings"],
    "properties": {
        "findings": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["product_id", "month_year", "considerations", "recommendations"],
                "properties": {
                    "product_id": {"type": "string"},
                    "month_year": {"type": "string", "pattern": r"^\d{4}-\d{2}$"},
                    "considerations": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "additionalProperties": False,
                            "required": ["description", "impact"],
                            "properties": {
                                "description": {"type": "string"},
                                "impact": {"type": "integer", "minimum": -3, "maximum": 3},
                            },
                        },
                    },
                    "recommendations": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "additionalProperties": False,
                            "required": ["description", "impact"],
                            "properties": {
                                "description": {"type": "string"},
                                "impact": {"type": "integer", "minimum": -3, "maximum": 3},
                            },
                        },
                    },
                },
            },
        }
    },
}


def load_prompt(name: str) -> str:
    return (PROMPTS_DIR / name).read_text(encoding="utf-8").strip()


def run_ai_job(db: Session, job_id: int) -> None:
    job = db.scalar(
        select(AIJob)
        .where(AIJob.id == job_id)
        .options(selectinload(AIJob.forecast_upload).selectinload(ForecastUpload.values))
    )
    if job is None:
        return
    if job.status not in {"queued", "running"}:
        return

    try:
        job.status = "running"
        job.started_at = job.started_at or utcnow()
        db.commit()

        forecast = load_forecast_payload(db, job.forecast_upload_id)
        if settings.openai_api_key:
            response_id, findings = request_openai_findings(forecast, job.user_context)
            job.openai_response_id = response_id
        elif settings.demo_ai_without_key:
            findings = demo_findings(forecast)
        else:
            raise RuntimeError("OPENAI_API_KEY is required to run AI analysis.")

        persist_findings(db, job, findings)
        job.status = "completed"
        job.completed_at = utcnow()
        job.error_message = None
        db.commit()
    except Exception as exc:
        db.rollback()
        job = db.get(AIJob, job_id)
        if job:
            job.status = "failed"
            job.completed_at = utcnow()
            job.error_message = str(exc)
            db.commit()


def run_ai_job_by_id(job_id: int) -> None:
    with SessionLocal() as db:
        run_ai_job(db, job_id)


def load_forecast_payload(db: Session, forecast_upload_id: int) -> dict[str, object]:
    forecast = db.scalar(
        select(ForecastUpload)
        .where(ForecastUpload.id == forecast_upload_id)
        .options(selectinload(ForecastUpload.values))
    )
    if forecast is None:
        raise RuntimeError("Forecast upload not found.")

    forecast_values_by_product: dict[int, dict[str, int]] = {}
    for value in forecast.values:
        forecast_values_by_product.setdefault(value.product_id, {})[value.month_year] = value.forecast_units

    products = []
    seeded_products = db.scalars(
        select(Product)
        .order_by(Product.item_code)
        .options(
            selectinload(Product.actual_shipments),
            selectinload(Product.historical_forecasts),
        )
    ).all()
    for product in seeded_products:
        current_forecast = forecast_values_by_product.get(product.id, {})
        actuals = {value.month_year: value.units_shipped for value in product.actual_shipments}
        historical_forecasts = {
            value.month_year: value.forecast_units for value in product.historical_forecasts
        }
        products.append(
            {
                "product_id": product.item_code,
                "product_name": product.product_name,
                "brand": product.brand,
                "type": product.product_type,
                "description": product.description,
                "retail_price": float(product.retail_price),
                "forecast_units": current_forecast,
                "last_year_actual_units": {
                    month: actuals.get(same_month_last_year(month), 0)
                    for month in current_forecast
                },
                "last_year_forecast_units": {
                    month: historical_forecasts.get(same_month_last_year(month), 0)
                    for month in current_forecast
                },
            }
        )
    return {"forecast_upload_id": forecast.id, "products": products}


def request_openai_findings(
    forecast_payload: dict[str, object],
    user_context: str,
) -> tuple[str, list[AIFindingGroup]]:
    client = OpenAI(api_key=settings.openai_api_key)
    response = client.responses.create(
        model=settings.openai_model,
        background=True,
        tools=[{"type": "web_search"}],
        text={
            "format": {
                "type": "json_schema",
                "name": "forecast_ai_findings",
                "strict": True,
                "schema": FORECAST_ANALYSIS_SCHEMA,
            }
        },
        input=[
            {
                "role": "system",
                "content": load_prompt("ai_researcher.md"),
            },
            {
                "role": "user",
                "content": json.dumps(
                    {
                        "forecast": forecast_payload,
                        "customer_context": {
                            "business_type": (
                                "ERP customer planning sell-through support for specialty beauty, "
                                "fragrance, department-store, and boutique retail accounts."
                            ),
                            "market": "United States demo market unless the user context narrows the geography.",
                            "provided_notes": user_context or "No customer-specific notes provided.",
                        },
                        "user_context": user_context,
                        "impact_scale": "-3 to +3, where negative means downward pressure on unit demand.",
                        "recommendation_policy": load_prompt("recommendation_policy.md"),
                        "quality_bar": (
                            "Prefer no finding over a generic one. Each finding should name a concrete "
                            "market signal, season, cultural moment, or product-specific angle."
                        ),
                    }
                ),
            },
        ],
    )
    response_id = response.id
    while response.status in {"queued", "in_progress"}:
        sleep(2)
        response = client.responses.retrieve(response_id)

    if response.status != "completed":
        raise RuntimeError(f"OpenAI response ended with status {response.status}.")

    if getattr(response, "output_text", None):
        raw_json = response.output_text
    else:
        raise RuntimeError("OpenAI response did not include output text.")
    return response_id, parse_ai_response(json.loads(raw_json))


def parse_ai_response(payload: dict[str, object]) -> list[AIFindingGroup]:
    findings: list[AIFindingGroup] = []
    for item in payload.get("findings", []):
        if not isinstance(item, dict):
            continue
        findings.append(
            AIFindingGroup(
                product_id=str(item["product_id"]),
                month_year=str(item["month_year"]),
                considerations=[
                    AIItem(
                        description=str(entry["description"]),
                        impact=validated_impact(entry["impact"]),
                    )
                    for entry in item.get("considerations", [])
                    if isinstance(entry, dict)
                ],
                recommendations=[
                    AIItem(
                        description=str(entry["description"]),
                        impact=validated_impact(entry["impact"]),
                    )
                    for entry in item.get("recommendations", [])
                    if isinstance(entry, dict)
                ],
            )
        )
    return findings


def validated_impact(value: object) -> int:
    impact = int(value)
    if impact < -3 or impact > 3:
        raise ValueError("Impact must be between -3 and +3.")
    return impact


def demo_findings(forecast_payload: dict[str, object]) -> list[AIFindingGroup]:
    products = forecast_payload.get("products", [])
    if not products:
        return []

    findings: list[AIFindingGroup] = []
    for product in products:
        if not isinstance(product, dict):
            continue
        product_id = str(product["product_id"])
        forecast_values = product.get("forecast_units", {})
        if not isinstance(forecast_values, dict):
            continue
        for month_year, template in demo_templates_for_product(product):
            if month_year not in forecast_values:
                continue
            findings.append(
                AIFindingGroup(
                    product_id=product_id,
                    month_year=month_year,
                    considerations=[
                        AIItem(
                            description=consideration["description"],
                            impact=consideration["impact"],
                        )
                        for consideration in template["considerations"]
                    ],
                    recommendations=[
                        AIItem(
                            description=recommendation["description"],
                            impact=recommendation["impact"],
                        )
                        for recommendation in template["recommendations"]
                    ],
                )
            )
    return findings


def demo_templates_for_product(product: dict[str, object]) -> list[tuple[str, dict[str, list[dict[str, object]]]]]:
    months = list((product.get("forecast_units") or {}).keys())
    if len(months) < 6:
        return []

    product_id = str(product["product_id"])
    product_name = str(product["product_name"])
    brand = str(product["brand"])
    product_type = str(product["type"])

    default = [
        (
            months[0],
            {
                "considerations": [
                    {
                        "description": (
                            f"{product_name} is a {product_type} item. No strong external signal was found "
                            "in the demo fixture beyond normal seasonality and account-level execution risk."
                        ),
                        "impact": 0,
                    }
                ],
                "recommendations": [
                    {
                        "description": (
                            f"Ask top {brand} accounts whether they have a specific local event, display window, "
                            "or clienteling moment before creating product-specific support."
                        ),
                        "impact": 0,
                    }
                ],
            },
        )
    ]

    templates = {
        "CHANEL-N5-EDP": [
            (
                months[0],
                {
                    "considerations": [
                        {
                            "description": (
                                "May lines up with Mother's Day and Chanel N°5's classic floral heritage, giving the item "
                                "a stronger gifting hook than a neutral fragrance forecast would show."
                            ),
                            "impact": 2,
                        },
                        {
                            "description": (
                                "The aldehydic floral profile is iconic but not universally easy; younger shoppers may need "
                                "more education than they would for sweeter viral scents."
                            ),
                            "impact": -1,
                        },
                    ],
                    "recommendations": [
                        {
                            "description": (
                                "Give beauty advisors a Mother's Day script that frames N°5 as a heritage gift, paired with "
                                "a quick blotter demo comparing the May rose and jasmine facets."
                            ),
                            "impact": 2,
                        }
                    ],
                },
            ),
            (
                months[2],
                {
                    "considerations": [
                        {
                            "description": (
                                "Mid-summer fragrance browsing can favor lighter citrus and aquatic scents, which may make "
                                "N°5's richer floral signature feel less seasonally urgent."
                            ),
                            "impact": -1,
                        }
                    ],
                    "recommendations": [
                        {
                            "description": (
                                "Use travel-size sampling and appointment follow-ups rather than broad discounting, focusing "
                                "on shoppers already asking for classic luxury fragrances."
                            ),
                            "impact": 1,
                        }
                    ],
                },
            ),
            (
                months[5],
                {
                    "considerations": [
                        {
                            "description": (
                                "Holiday fragrance sets and luxury gifting give Chanel N°5 a strong November setup, especially "
                                "with shoppers looking for recognizable, low-risk prestige gifts."
                            ),
                            "impact": 2,
                        }
                    ],
                    "recommendations": [
                        {
                            "description": (
                                "Prepare a gift-bar placement with wrapped testers, heritage story cards, and advisor prompts "
                                "for shoppers who do not know the recipient's fragrance wardrobe."
                            ),
                            "impact": 2,
                        }
                    ],
                },
            ),
            (
                months[8],
                {
                    "considerations": [
                        {
                            "description": (
                                "Post-holiday traffic often shifts from gift buying to returns and self-purchase; the full-size "
                                "N°5 bottle may lose urgency after December."
                            ),
                            "impact": -2,
                        }
                    ],
                    "recommendations": [
                        {
                            "description": (
                                "Move January messaging to personal fragrance wardrobe refreshes and loyalty-client outreach "
                                "instead of repeating holiday gift copy."
                            ),
                            "impact": 1,
                        }
                    ],
                },
            ),
        ],
        "DIOR-SAUV-EDP": [
            (
                months[1],
                {
                    "considerations": [
                        {
                            "description": (
                                "June contains Father's Day, and Sauvage's mass recognition in men's fragrance makes it a "
                                "high-intent gifting candidate."
                            ),
                            "impact": 3,
                        }
                    ],
                    "recommendations": [
                        {
                            "description": (
                                "Run a Father's Day counter program with fast gift wrapping, scent-strip cards, and a clear "
                                "'safe premium men's gift' positioning."
                            ),
                            "impact": 2,
                        }
                    ],
                },
            ),
            (
                months[3],
                {
                    "considerations": [
                        {
                            "description": (
                                "Back-to-routine shopping can soften fragrance gifting after summer, and Sauvage may face more "
                                "direct comparison against new fall men's launches."
                            ),
                            "impact": -1,
                        }
                    ],
                    "recommendations": [
                        {
                            "description": (
                                "Use advisor-led comparisons that explain the bergamot and vanilla drydown, so shoppers see a "
                                "reason to choose Sauvage over newer woody-aromatic launches."
                            ),
                            "impact": 1,
                        }
                    ],
                },
            ),
            (
                months[6],
                {
                    "considerations": [
                        {
                            "description": (
                                "Holiday men's fragrance gift sets start competing for display space early; Sauvage benefits "
                                "when it is visible before the highest-traffic weeks."
                            ),
                            "impact": 2,
                        }
                    ],
                    "recommendations": [
                        {
                            "description": (
                                "Pitch a men's fragrance destination table with Sauvage as the anchor and smaller add-ons nearby "
                                "for basket building."
                            ),
                            "impact": 2,
                        }
                    ],
                },
            ),
            (
                months[8],
                {
                    "considerations": [
                        {
                            "description": (
                                "After December, Sauvage may still have baseline demand, but gift-led urgency drops and returns "
                                "traffic can reduce conversion."
                            ),
                            "impact": -1,
                        }
                    ],
                    "recommendations": [
                        {
                            "description": (
                                "Shift to loyalty messaging for existing users instead of extending holiday "
                                "gift creative into January."
                            ),
                            "impact": 1,
                        }
                    ],
                },
            ),
        ],
        "MFK-BR540-EDP": [
            (
                months[0],
                {
                    "considerations": [
                        {
                            "description": (
                                "Baccarat Rouge 540 remains a high-awareness amber woody floral, but its high retail price means "
                                "traffic quality and sampling access matter more than raw footfall."
                            ),
                            "impact": -1,
                        }
                    ],
                    "recommendations": [
                        {
                            "description": (
                                "Offer appointment-based fragrance consultations with take-home scent cards so shoppers can justify "
                                "the premium purchase after the first trial."
                            ),
                            "impact": 2,
                        }
                    ],
                },
            ),
            (
                months[2],
                {
                    "considerations": [
                        {
                            "description": (
                                "Warm-weather evening events and wedding-season dressing can support premium statement fragrances, "
                                "but daytime summer wear may favor lighter scents."
                            ),
                            "impact": 1,
                        }
                    ],
                    "recommendations": [
                        {
                            "description": (
                                "Merchandise BR540 around event dressing and evening fragrance wardrobes, with staff language on "
                                "jasmine, saffron, ambergris facets, and cedar."
                            ),
                            "impact": 2,
                        }
                    ],
                },
            ),
            (
                months[5],
                {
                    "considerations": [
                        {
                            "description": (
                                "Back-to-school and back-to-work traffic may bring aspirational browsing, but conversion can stall "
                                "without a discovery-size path for the high-ticket item."
                            ),
                            "impact": -1,
                        }
                    ],
                    "recommendations": [
                        {
                            "description": (
                                "Use discovery vial gifts with qualified premium fragrance purchases to create a lower-friction "
                                "trial path without discounting the bottle."
                            ),
                            "impact": 1,
                        }
                    ],
                },
            ),
            (
                months[7],
                {
                    "considerations": [
                        {
                            "description": (
                                "November luxury gifting gives BR540 a strong occasion, but shoppers may need reassurance when "
                                "buying such a distinctive fragrance for someone else."
                            ),
                            "impact": 2,
                        }
                    ],
                    "recommendations": [
                        {
                            "description": (
                                "Create a 'memorable luxury gift' consultation card that helps advisors qualify recipient taste "
                                "before recommending BR540."
                            ),
                            "impact": 2,
                        }
                    ],
                },
            ),
        ],
        "YSL-LIBRE-EDP": [
            (
                months[0],
                {
                    "considerations": [
                        {
                            "description": (
                                "Libre's orange blossom and lavender contrast gives it a bold floral identity that fits graduation "
                                "and Mother's Day gifting better than a generic floral forecast would imply."
                            ),
                            "impact": 2,
                        }
                    ],
                    "recommendations": [
                        {
                            "description": (
                                "Build a small 'bold floral gifts' display with gift wrap, blotters, and advisor prompts for "
                                "graduates and Mother's Day shoppers."
                            ),
                            "impact": 2,
                        }
                    ],
                },
            ),
            (
                months[3],
                {
                    "considerations": [
                        {
                            "description": (
                                "Late summer can be a quieter prestige fragrance window for Libre unless the story is connected "
                                "to going-out or wardrobe refresh occasions."
                            ),
                            "impact": -1,
                        }
                    ],
                    "recommendations": [
                        {
                            "description": (
                                "Test a weekend evening counter activation that positions Libre as a statement scent for dinners, "
                                "events, and end-of-summer travel."
                            ),
                            "impact": 1,
                        }
                    ],
                },
            ),
            (
                months[6],
                {
                    "considerations": [
                        {
                            "description": (
                                "Holiday party season makes Libre's couture and bold-floral positioning more relevant than in "
                                "routine shopping months."
                            ),
                            "impact": 2,
                        }
                    ],
                    "recommendations": [
                        {
                            "description": (
                                "Place Libre near party makeup and eveningwear-adjacent beauty displays, with copy focused on "
                                "statement fragrance for holiday events."
                            ),
                            "impact": 2,
                        }
                    ],
                },
            ),
            (
                months[9],
                {
                    "considerations": [
                        {
                            "description": (
                                "Early spring gifting can help, but Libre may be less seasonally obvious than fresh floral launches "
                                "unless the lavender/orange blossom contrast is made clear."
                            ),
                            "impact": 0,
                        }
                    ],
                    "recommendations": [
                        {
                            "description": (
                                "Use a side-by-side scent strip comparison against softer florals to highlight Libre's distinctive "
                                "lavender twist."
                            ),
                            "impact": 1,
                        }
                    ],
                },
            ),
        ],
        "TF-LOSTCHERRY-EDP": [
            (
                months[1],
                {
                    "considerations": [
                        {
                            "description": (
                                "Lost Cherry's black cherry and liqueur profile maps strongly to Valentine's and date-night shopping, "
                                "but it is promo-coded and may need occasion-led visibility."
                            ),
                            "impact": 2,
                        }
                    ],
                    "recommendations": [
                        {
                            "description": (
                                "Create a cherry-red date-night display with blotter cards and mini-spray add-ons for Valentine's "
                                "and late-winter evening shopping."
                            ),
                            "impact": 2,
                        }
                    ],
                },
            ),
            (
                months[3],
                {
                    "considerations": [
                        {
                            "description": (
                                "Cherry and gourmand profiles can feel heavy in late summer heat, so the product may lose urgency "
                                "outside evening or nightlife occasions."
                            ),
                            "impact": -1,
                        }
                    ],
                    "recommendations": [
                        {
                            "description": (
                                "Keep the story focused on evening wear and gifting rather than everyday summer freshness, using "
                                "small counter placement instead of broad seasonal displays."
                            ),
                            "impact": 1,
                        }
                    ],
                },
            ),
            (
                months[6],
                {
                    "considerations": [
                        {
                            "description": (
                                "October dark-gourmand and cherry-red merchandising can connect Lost Cherry to fall fragrance "
                                "wardrobe changes and Halloween-adjacent beauty looks."
                            ),
                            "impact": 2,
                        }
                    ],
                    "recommendations": [
                        {
                            "description": (
                                "Run a 'dark cherry' fall table with lipstick-adjacent visual merchandising and staff prompts for "
                                "shoppers seeking richer evening scents."
                            ),
                            "impact": 2,
                        }
                    ],
                },
            ),
            (
                months[8],
                {
                    "considerations": [
                        {
                            "description": (
                                "Holiday luxury gifting helps, but Lost Cherry's distinctive profile can be risky as a blind gift "
                                "unless shoppers can test or buy a smaller format."
                            ),
                            "impact": 1,
                        }
                    ],
                    "recommendations": [
                        {
                            "description": (
                                "Bundle discovery sprays or blotter cards with the full bottle presentation so gift buyers can "
                                "feel more confident choosing a bold scent."
                            ),
                            "impact": 2,
                        }
                    ],
                },
            ),
        ],
        "JM-WSS-COLOGNE": [
            (
                months[0],
                {
                    "considerations": [
                        {
                            "description": (
                                "Wood Sage & Sea Salt's coastal profile lines up with summer travel, resort shopping, and wedding "
                                "guest gifting."
                            ),
                            "impact": 2,
                        }
                    ],
                    "recommendations": [
                        {
                            "description": (
                                "Place it in a coastal travel display with sample cards positioned for destination weddings, "
                                "weekend trips, and fresh unisex gifting."
                            ),
                            "impact": 2,
                        }
                    ],
                },
            ),
            (
                months[2],
                {
                    "considerations": [
                        {
                            "description": (
                                "Peak summer favors salty, airy colognes, so the scent story has a stronger seasonal fit than "
                                "heavier woods or gourmands."
                            ),
                            "impact": 2,
                        }
                    ],
                    "recommendations": [
                        {
                            "description": (
                                "Set up a Jo Malone layering bar that pairs Wood Sage & Sea Salt with brighter or floral colognes "
                                "for personalized summer combinations."
                            ),
                            "impact": 2,
                        }
                    ],
                },
            ),
            (
                months[5],
                {
                    "considerations": [
                        {
                            "description": (
                                "As summer travel fades, the coastal hook weakens, though the clean woody profile can still work "
                                "for back-to-routine self-purchase."
                            ),
                            "impact": -1,
                        }
                    ],
                    "recommendations": [
                        {
                            "description": (
                                "Move messaging from vacation to everyday clean fragrance and clienteling follow-up for "
                                "customers who sampled it during summer."
                            ),
                            "impact": 1,
                        }
                    ],
                },
            ),
            (
                months[7],
                {
                    "considerations": [
                        {
                            "description": (
                                "Holiday gifting can lift Jo Malone, but Wood Sage & Sea Salt may need a unisex gift story to "
                                "stand out from more overtly festive scents."
                            ),
                            "impact": 1,
                        }
                    ],
                    "recommendations": [
                        {
                            "description": (
                                "Feature it in a unisex fragrance gift edit with ribboning and layering suggestions rather than "
                                "placing it only in summer/coastal fixtures."
                            ),
                            "impact": 2,
                        }
                    ],
                },
            ),
        ],
    }

    return templates.get(product_id, default)


def persist_findings(
    db: Session,
    job: AIJob,
    findings: list[AIFindingGroup],
) -> None:
    products = {
        product.item_code: product
        for product in db.scalars(
            select(Product).order_by(Product.item_code)
        )
    }

    for finding in findings:
        product = products.get(finding.product_id)
        if product is None:
            continue
        for consideration in finding.considerations:
            db.add(
                AIFinding(
                    ai_job=job,
                    product=product,
                    month_year=finding.month_year,
                    finding_type="consideration",
                    description=consideration.description,
                    impact=consideration.impact,
                    citations_json="[]",
                )
            )
        for recommendation in finding.recommendations:
            db.add(
                AIFinding(
                    ai_job=job,
                    product=product,
                    month_year=finding.month_year,
                    finding_type="recommendation",
                    description=recommendation.description,
                    impact=recommendation.impact,
                    citations_json="[]",
                )
            )

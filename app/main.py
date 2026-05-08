from __future__ import annotations

from pathlib import Path
from typing import Any

from fastapi import BackgroundTasks, Depends, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import HTMLResponse, JSONResponse, PlainTextResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel
from sqlalchemy import delete, select
from sqlalchemy.orm import Session, selectinload

from app.ai import run_ai_job_by_id
from app.csv_forecasts import (
    ForecastCSVError,
    apply_forecast_csv,
    forecast_template_csv,
    parse_forecast_csv,
)
from app.calendar import current_months, same_month_last_year
from app.database import get_db, init_db
from app.models import AIFinding, AIJob, ForecastUpload, Product


DOCS_DIR = Path(__file__).resolve().parent.parent / "docs"
DOC_FILES = {
    "original-prompt.md": "Original prompt",
    "initial-plan.md": "Initial plan",
    "architecture.md": "Architecture",
}


app = FastAPI(title="Forecasting AI Example", docs_url="/api/docs", redoc_url=None)
app.mount("/static", StaticFiles(directory="app/static"), name="static")
templates = Jinja2Templates(directory="app/templates")
templates.env.cache = None


class AIJobCreate(BaseModel):
    forecast_context: str = ""
    blind_spots: str = ""


@app.on_event("startup")
def on_startup() -> None:
    init_db()


@app.get("/", response_class=HTMLResponse)
def index(
    request: Request,
    db: Session = Depends(get_db),
) -> HTMLResponse:
    forecast = active_forecast(db)
    return render_forecast_workspace(request, db, forecast)


@app.get("/docs", response_class=HTMLResponse)
def docs_index(request: Request) -> HTMLResponse:
    return templates.TemplateResponse(request, "docs.html", {"docs": DOC_FILES})


@app.get("/docs/{doc_name}", response_class=PlainTextResponse)
def docs_file(doc_name: str) -> PlainTextResponse:
    if doc_name not in DOC_FILES:
        raise HTTPException(status_code=404, detail="Document not found")
    return PlainTextResponse((DOCS_DIR / doc_name).read_text())


@app.get("/forecasts/template.csv", response_class=PlainTextResponse)
def download_template(db: Session = Depends(get_db)) -> PlainTextResponse:
    products = db.scalars(select(Product).order_by(Product.item_code)).all()
    return PlainTextResponse(
        forecast_template_csv(products=products),
        media_type="text/csv",
        headers={"Content-Disposition": 'attachment; filename="forecast-template.csv"'},
    )


@app.post("/forecasts")
async def upload_forecast(
    forecast_file: UploadFile = File(...),
    db: Session = Depends(get_db),
) -> RedirectResponse:
    contents = (await forecast_file.read()).decode("utf-8-sig")
    forecast = active_forecast(db)
    forecast.original_filename = forecast_file.filename or "forecast.csv"

    try:
        _, parsed_rows = parse_forecast_csv(contents)
        apply_forecast_csv(db, forecast, parsed_rows)
        clear_ai_jobs(db, forecast.id)
        forecast.status = "active"
        forecast.error_message = None
        db.commit()
    except ForecastCSVError as exc:
        forecast.status = "failed"
        forecast.error_message = str(exc)
        db.commit()
        return RedirectResponse("/?error=1", status_code=303)

    return RedirectResponse("/", status_code=303)


@app.get("/api/forecast")
def api_active_forecast(db: Session = Depends(get_db)) -> Any:
    forecast = active_forecast(db)
    return forecast_workspace_payload(db, forecast)


@app.post("/api/forecasts", response_model=None)
async def api_upload_forecast(
    forecast_file: UploadFile = File(...),
    db: Session = Depends(get_db),
) -> Any:
    contents = (await forecast_file.read()).decode("utf-8-sig")
    forecast = active_forecast(db)
    forecast.original_filename = forecast_file.filename or "forecast.csv"

    try:
        _, parsed_rows = parse_forecast_csv(contents)
        apply_forecast_csv(db, forecast, parsed_rows)
        clear_ai_jobs(db, forecast.id)
        forecast.status = "active"
        forecast.error_message = None
        db.commit()
    except ForecastCSVError as exc:
        forecast.status = "failed"
        forecast.error_message = str(exc)
        db.commit()
        return JSONResponse(
            forecast_workspace_payload(db, forecast),
            status_code=400,
        )

    return forecast_workspace_payload(db, forecast)


@app.get("/forecasts/{forecast_id}", response_class=HTMLResponse)
def forecast_detail(
    forecast_id: int,
    request: Request,
    db: Session = Depends(get_db),
) -> HTMLResponse:
    forecast = get_forecast_or_404(db, forecast_id)
    return render_forecast_workspace(request, db, forecast)


def render_forecast_workspace(
    request: Request,
    db: Session,
    forecast: ForecastUpload,
) -> HTMLResponse:
    products = db.scalars(
        select(Product)
        .order_by(Product.item_code)
        .options(
            selectinload(Product.forecast_values),
            selectinload(Product.actual_shipments),
            selectinload(Product.historical_forecasts),
        )
    ).all()
    months = current_months()
    return templates.TemplateResponse(
        request,
        "forecast_detail.html",
        {
            "forecast": forecast,
            "products": products,
            "months": months,
            "values_by_product": values_by_product(products),
            "chart_payload": chart_payload(products),
            "finding_payload": finding_payload(forecast),
        },
    )


def forecast_workspace_payload(db: Session, forecast: ForecastUpload) -> Any:
    forecast = get_forecast_or_404(db, forecast.id)
    products = db.scalars(
        select(Product)
        .order_by(Product.item_code)
        .options(
            selectinload(Product.forecast_values),
            selectinload(Product.actual_shipments),
            selectinload(Product.historical_forecasts),
        )
    ).all()
    values = values_by_product(products)
    return {
        "forecast": {
            "id": forecast.id,
            "original_filename": forecast.original_filename,
            "status": forecast.status,
            "created_at": forecast.created_at.isoformat(),
            "error_message": forecast.error_message,
        },
        "months": current_months(),
        "products": chart_payload(products),
        "values_by_product": {
            str(product_id): month_values
            for product_id, month_values in values.items()
        },
        "findings": finding_payload(forecast),
    }


@app.post("/ai-jobs", response_class=HTMLResponse)
def create_active_forecast_ai_job(
    request: Request,
    background_tasks: BackgroundTasks,
    forecast_context: str = Form(""),
    blind_spots: str = Form(""),
    db: Session = Depends(get_db),
) -> HTMLResponse:
    forecast = active_forecast(db)
    return create_ai_job_for_forecast(
        forecast.id,
        request,
        background_tasks,
        forecast_context,
        blind_spots,
        db,
    )


@app.post("/api/ai-jobs")
def api_create_active_forecast_ai_job(
    payload: AIJobCreate,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
) -> dict[str, object]:
    forecast = active_forecast(db)
    job = queue_ai_job_for_forecast(
        forecast.id,
        background_tasks,
        payload.forecast_context,
        payload.blind_spots,
        db,
    )
    return ai_job_payload(job)


@app.post("/forecasts/{forecast_id}/ai-jobs", response_class=HTMLResponse)
def create_ai_job(
    forecast_id: int,
    request: Request,
    background_tasks: BackgroundTasks,
    forecast_context: str = Form(""),
    blind_spots: str = Form(""),
    db: Session = Depends(get_db),
) -> HTMLResponse:
    return create_ai_job_for_forecast(
        forecast_id,
        request,
        background_tasks,
        forecast_context,
        blind_spots,
        db,
    )


def create_ai_job_for_forecast(
    forecast_id: int,
    request: Request,
    background_tasks: BackgroundTasks,
    forecast_context: str,
    blind_spots: str,
    db: Session,
) -> HTMLResponse:
    job = queue_ai_job_for_forecast(
        forecast_id,
        background_tasks,
        forecast_context,
        blind_spots,
        db,
    )
    return templates.TemplateResponse(
        request,
        "_ai_job_status.html",
        {"job": job, "findings_by_product": {}, "chart_finding_payload": {}},
    )


def queue_ai_job_for_forecast(
    forecast_id: int,
    background_tasks: BackgroundTasks,
    forecast_context: str,
    blind_spots: str,
    db: Session,
) -> AIJob:
    get_forecast_or_404(db, forecast_id)
    clear_ai_jobs(db, forecast_id)
    user_context = "\n\n".join(
        [
            f"Forecast context:\n{forecast_context.strip()}",
            f"Blind spots or specific questions:\n{blind_spots.strip()}",
        ]
    )
    job = AIJob(forecast_upload_id=forecast_id, user_context=user_context, status="queued")
    db.add(job)
    db.commit()
    background_tasks.add_task(run_ai_job_by_id, job.id)
    return job


def clear_ai_jobs(db: Session, forecast_id: int) -> None:
    job_ids = db.scalars(select(AIJob.id).where(AIJob.forecast_upload_id == forecast_id)).all()
    if not job_ids:
        return
    db.execute(delete(AIFinding).where(AIFinding.ai_job_id.in_(job_ids)))
    db.execute(delete(AIJob).where(AIJob.id.in_(job_ids)))


@app.get("/ai-jobs/{job_id}.json")
def ai_job_json(job_id: int, db: Session = Depends(get_db)) -> dict[str, object]:
    job = get_ai_job_or_404(db, job_id)
    return ai_job_payload(job)


@app.get("/api/ai-jobs/{job_id}")
def api_ai_job_json(job_id: int, db: Session = Depends(get_db)) -> dict[str, object]:
    job = get_ai_job_or_404(db, job_id)
    return ai_job_payload(job)


def ai_job_payload(job: AIJob) -> dict[str, object]:
    return {
        "id": job.id,
        "status": job.status,
        "forecast_upload_id": job.forecast_upload_id,
        "error_message": job.error_message,
        "findings_count": len(job.findings),
        "findings": job_finding_payload(job) if job.status == "completed" else {},
    }


@app.get("/ai-jobs/{job_id}", response_class=HTMLResponse)
def ai_job_status(
    job_id: int,
    request: Request,
    db: Session = Depends(get_db),
) -> HTMLResponse:
    job = get_ai_job_or_404(db, job_id)
    return templates.TemplateResponse(
        request,
        "_ai_job_status.html",
        {
            "job": job,
            "findings_by_product": findings_by_product(job),
            "chart_finding_payload": job_finding_payload(job),
        },
    )


def get_forecast_or_404(db: Session, forecast_id: int) -> ForecastUpload:
    forecast = db.scalar(
        select(ForecastUpload)
        .where(ForecastUpload.id == forecast_id)
        .options(
            selectinload(ForecastUpload.values),
            selectinload(ForecastUpload.ai_jobs).selectinload(AIJob.findings),
        )
    )
    if forecast is None:
        raise HTTPException(status_code=404, detail="Forecast not found")
    return forecast


def get_ai_job_or_404(db: Session, job_id: int) -> AIJob:
    job = db.scalar(
        select(AIJob)
        .where(AIJob.id == job_id)
        .options(
            selectinload(AIJob.findings).selectinload(AIFinding.product),
            selectinload(AIJob.forecast_upload),
        )
    )
    if job is None:
        raise HTTPException(status_code=404, detail="AI job not found")
    return job


def active_forecast(db: Session) -> ForecastUpload:
    forecast = db.scalar(select(ForecastUpload).order_by(ForecastUpload.id).limit(1))
    if forecast is None:
        raise HTTPException(status_code=500, detail="Demo forecast was not seeded.")
    return forecast


def values_by_product(products: list[Product]) -> dict[int, dict[str, int]]:
    return {
        product.id: {
            value.month_year: value.forecast_units
            for value in sorted(product.forecast_values, key=lambda item: item.month_year)
        }
        for product in products
    }


def chart_payload(products: list[Product]) -> list[dict[str, object]]:
    months = current_months()
    payload = []
    for product in products:
        current_forecast = {value.month_year: value.forecast_units for value in product.forecast_values}
        actuals = {value.month_year: value.units_shipped for value in product.actual_shipments}
        historical_forecasts = {
            value.month_year: value.forecast_units for value in product.historical_forecasts
        }
        payload.append(
            {
                "dbId": product.id,
                "itemCode": product.item_code,
                "label": product.product_name,
                "profile": {
                    "brand": product.brand,
                    "type": product.product_type,
                    "description": product.description,
                    "retailPrice": f"${float(product.retail_price):,.2f}",
                    "itemCode": product.item_code,
                },
                "thisYearForecast": [current_forecast.get(month, 0) for month in months],
                "lastYearForecast": [
                    historical_forecasts.get(same_month_last_year(month), 0) for month in months
                ],
                "lastYearActual": [actuals.get(same_month_last_year(month), 0) for month in months],
            }
        )
    return payload


def finding_payload(forecast: ForecastUpload) -> dict[str, dict[str, list[dict[str, object]]]]:
    payload: dict[str, dict[str, list[dict[str, object]]]] = {}
    for job in forecast.ai_jobs:
        if job.status != "completed":
            continue
        for finding in job.findings:
            payload.setdefault(str(finding.product_id), {}).setdefault(finding.month_year, []).append(
                {
                    "type": finding.finding_type,
                    "description": finding.description,
                    "impact": finding.impact,
                }
            )
    return payload


def job_finding_payload(job: AIJob) -> dict[str, dict[str, list[dict[str, object]]]]:
    payload: dict[str, dict[str, list[dict[str, object]]]] = {}
    for finding in job.findings:
        payload.setdefault(str(finding.product_id), {}).setdefault(finding.month_year, []).append(
            {
                "type": finding.finding_type,
                "description": finding.description,
                "impact": finding.impact,
            }
        )
    return payload


def findings_by_product(job: AIJob) -> dict[str, list[object]]:
    grouped: dict[str, list[object]] = {}
    for finding in sorted(job.findings, key=lambda item: (item.month_year, item.finding_type)):
        label = finding.product.product_name if finding.product else str(finding.product_id)
        grouped.setdefault(label, []).append(finding)
    return grouped


def impact_emoji(impact: int) -> str:
    if impact <= -3:
        return "📉"
    if impact < 0:
        return "↘️"
    if impact == 0:
        return "⚪"
    if impact < 3:
        return "↗️"
    return "📈"


templates.env.globals["impact_emoji"] = impact_emoji

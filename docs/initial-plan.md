# Initial Implementation Plan

This document preserves the first implementation plan derived from the original project prompt.

## Summary

Create `docs/architecture.md` as the decision record for a FastAPI + SQLite + HTMX webapp that lets users upload forecast CSVs, inspect forecasts, and run asynchronous AI-assisted forecast analysis.

Recommended AI pattern: use the OpenAI Responses API directly for the POC, with `web_search` enabled, structured JSON output enforced by schema, and background execution for longer-running analysis. This is simpler than adopting the full Agents SDK now, while still using standard agentic primitives: tools, async responses, and structured outputs.

References:

- Responses API: https://platform.openai.com/docs/guides/responses-vs-chat-completions
- Background mode: https://platform.openai.com/docs/guides/background
- Structured Outputs: https://platform.openai.com/docs/guides/structured-outputs?api-mode=responses&lang=python
- Web search tool: https://platform.openai.com/docs/guides/tools-web-search?api-mode=responses

## Key Changes

- Add a `docs/` directory with `architecture.md`.
- Include Mermaid diagrams for:
  - upload-to-visualization flow
  - AI job lifecycle
  - core database entities
- Define the POC stack:
  - FastAPI backend
  - SQLite database
  - SQLAlchemy or SQLModel models
  - HTMX frontend with server-rendered templates
  - OpenAI Python SDK
  - background worker loop inside the FastAPI process for POC simplicity
- Defer Lit, Celery, Redis, Docker, vector stores, and complex multi-agent orchestration until the POC needs them.

## App Design

- CSV upload accepts a pivot-style forecast:
  - required product identifier column
  - optional product name/title column
  - optional metadata/description/location/channel columns
  - month columns in ISO-like `YYYY-MM` format
- Backend normalizes the CSV into:
  - products
  - forecast uploads
  - monthly forecast values
- UI pages:
  - upload/template page
  - forecast table page
  - product detail page with line chart
  - AI-assisted forecasting modal
  - AI results page or inline panel
- Template CSV should include sample optional metadata fields so users understand how richer product context improves analysis.

## AI Workflow

- User clicks `AI-Assisted Forecasting` for a forecast upload.
- Modal collects:
  - how the forecast was prepared
  - assumptions already considered
  - blind spots or specific questions
- Backend creates an `ai_jobs` row with status `queued`.
- Worker starts an OpenAI Responses API request with:
  - model suited for reasoning plus web search
  - `background=true` for long-running work
  - `web_search` tool enabled
  - strict structured output schema
  - forecast rows and user context as input
- Worker polls the OpenAI response until terminal status.
- Parsed results are saved as normalized rows.
- Frontend polls the app's own job endpoint, not OpenAI directly.

The AI output schema should be:

```json
{
  "findings": [
    {
      "product_id": "string",
      "month_year": "YYYY-MM",
      "considerations": [
        {
          "description": "string",
          "impact": 0
        }
      ],
      "recommendations": [
        {
          "description": "string",
          "impact": 0
        }
      ]
    }
  ]
}
```

Use `impact` as a signed integer score for POC purposes, for example `-5` to `5`, not a dollar amount unless the model can justify it from explicit data.

## API Interfaces

- `GET /` shows upload and recent forecasts.
- `GET /forecasts/template.csv` downloads the CSV template.
- `POST /forecasts` uploads and parses a CSV.
- `GET /forecasts/{forecast_id}` shows the forecast table.
- `GET /forecasts/{forecast_id}/products/{product_id}` shows product chart detail.
- `POST /forecasts/{forecast_id}/ai-jobs` creates an AI analysis job.
- `GET /ai-jobs/{job_id}` returns job status and partial/final results HTML for HTMX polling.
- `GET /ai-jobs/{job_id}.json` returns machine-readable job state for debugging.

## Database Model

Core tables:

- `forecast_uploads`: uploaded file metadata and parse status.
- `products`: product ID, display name, optional metadata.
- `forecast_values`: product, month, forecast value.
- `ai_jobs`: forecast ID, user context, OpenAI response ID, status, error message.
- `ai_findings`: product ID, month, type, description, impact, optional source/citation metadata.

Store citations when OpenAI web search returns them, because web search results shown to users should include visible clickable citations.

## Test Plan

- CSV parser accepts valid pivot CSVs and rejects missing product IDs or invalid month columns.
- Template CSV matches the parser's expected format.
- Forecast upload creates products and monthly values correctly.
- Product detail renders line chart data in chronological month order.
- AI job creation stores user context and starts in `queued`.
- Worker handles OpenAI success, refusal, invalid schema, cancellation, and API error states.
- Structured output parsing persists considerations and recommendations correctly.
- HTMX polling shows queued, running, failed, and completed states.

## Assumptions

- This is a local POC, so SQLite and an in-process worker are acceptable.
- Forecast values are numeric but do not need accounting-grade validation.
- One AI job analyzes one uploaded forecast at a time.
- The first implementation should optimize for demo clarity over scale.
- The app will not store sensitive customer data beyond the local POC database.
- The full OpenAI Agents SDK is not required initially; revisit it if the app needs multi-agent handoffs, richer tracing, or custom local tools beyond web search and structured output.

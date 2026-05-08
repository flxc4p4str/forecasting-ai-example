# Forecasting AI Example

A proof-of-concept FastAPI app for AI-assisted unit forecasting. The app starts with seeded ERP-style demo data: product master data, last year's actual shipments, last year's forecast, and this year's rolling 12-month forecast.

## Run Locally

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
uvicorn app.main:app --reload
```

Then open http://127.0.0.1:8000.

For live OpenAI analysis, set:

```bash
cp .env.example .env
# edit .env and set OPENAI_API_KEY
```

Without an API key, AI jobs complete with deterministic demo findings so the POC remains runnable offline.

The CSV upload is optional. It updates forecast units for existing item codes; product data is fixed demo ERP data.

## Docs

- [Original prompt](docs/original-prompt.md)
- [Initial plan](docs/initial-plan.md)
- [Architecture](docs/architecture.md)

# Forecasting AI Example

A proof-of-concept Angular and Express app for AI-assisted unit forecasting. The app starts with seeded ERP-style demo data: product master data, last year's actual shipments, last year's forecast, and this year's rolling 12-month forecast.

## Run Locally

Install the Express API dependencies from the repository root:

```bash
npm install
```

Configure the Infragistics private npm feed before installing the Angular dependencies. The checked-in `frontend/.npmrc` maps the `@infragistics` scope to the licensed feed. Add your licensed feed credentials to your user-level npm config, or copy `frontend/.npmrc.example` to a local untracked config and fill in your token.

```bash
npm config set @infragistics:registry https://packages.infragistics.com/npm/js-licensed/
npm config set //packages.infragistics.com/npm/js-licensed/:username YOUR_INFRAGISTICS_USERNAME
npm config set //packages.infragistics.com/npm/js-licensed/:email YOUR_INFRAGISTICS_EMAIL
npm config set //packages.infragistics.com/npm/js-licensed/:_auth YOUR_INFRAGISTICS_ACCESS_TOKEN
```

Install the Angular dependencies:

```bash
cd frontend
npm install
```

In one terminal, run the Express API:

```bash
npm start
```

In another terminal, run the Angular dev server:

```bash
cd frontend
npm start
```

Then open http://localhost:4200. The Angular dev server proxies `/api`, `/docs`, and `/forecasts` to Express on http://127.0.0.1:3000.

The CSV upload is optional. It updates forecast units for existing item codes; product data is fixed demo ERP data. AI jobs complete with deterministic demo findings so the POC remains runnable offline.

## Python Helpers

The original Python forecast parsing and AI helper modules are still present for reference and tests, but the web API now runs on Node/Express.

```bash
python -m pytest
```

## Docs

- [Original prompt](docs/original-prompt.md)
- [Initial plan](docs/initial-plan.md)
- [Architecture](docs/architecture.md)

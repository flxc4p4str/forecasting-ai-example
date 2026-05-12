# AIController Deployment Notes

## Files

- `AIController.vb` - drop into the existing VB.NET Web API project under the same area as `SOController.vb` / `FMController.vb`.
- `AIT_DDL.sql` - run once in the Oracle schema used by the API.

## Configuration

Set these values as environment variables or add equivalent properties to your existing ABS settings object:

```text
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-5
OPENAI_BASE_URL=https://api.openai.com/v1
DEMO_AI_WITHOUT_KEY=true
OPENAI_WEB_SEARCH_TOOL=web_search
```

`OPENAI_WEB_SEARCH_TOOL` defaults to `web_search` to match the existing Express backend. If your OpenAI project expects the documented preview tool name, set it to `web_search_preview`.

## Prompt Files

The controller attempts to load:

```text
app/prompts/ai_researcher.md
app/prompts/recommendation_policy.md
```

from the application content root. If the files are missing, safe fallback prompt text is used.

## Routes Preserved

The controller uses absolute routes to preserve the current Angular/Express API shape:

```text
GET  /api/forecast
POST /api/forecasts          form field: forecast_file
POST /api/ai-jobs
GET  /api/ai-jobs/{jobId}
GET  /forecasts/template.csv
```

## Important Assumption

The controller keeps the current demo forecast workspace in memory, just like the Express backend. It logs every AI request/response to Oracle, but it does not yet persist uploaded forecast CSV data to Oracle and does not implement cache lookup.

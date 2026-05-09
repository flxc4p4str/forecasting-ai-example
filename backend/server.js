const fs = require('node:fs');
const path = require('node:path');

const express = require('express');
const multer = require('multer');
const { parse } = require('csv-parse/sync');

loadEnvFile(path.join(__dirname, '..', '.env'));

const app = express();
const upload = multer({ storage: multer.memoryStorage() });
const port = Number(process.env.PORT || 3000);
const docsDir = path.join(__dirname, '..', 'docs');
const promptsDir = path.join(__dirname, '..', 'app', 'prompts');
const openAiApiKey = (process.env.OPENAI_API_KEY || '').trim();
const openAiModel = (process.env.OPENAI_MODEL || 'gpt-5').trim();
const demoAiWithoutKey = parseBooleanEnv(process.env.DEMO_AI_WITHOUT_KEY, true);
const openAiBaseUrl = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');

const docFiles = {
  'original-prompt.md': 'Original prompt',
  'initial-plan.md': 'Initial plan',
  'architecture.md': 'Architecture',
};

const forecastAnalysisSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['product_id', 'month_year', 'considerations', 'recommendations'],
        properties: {
          product_id: { type: 'string' },
          month_year: { type: 'string', pattern: '^\\d{4}-\\d{2}$' },
          considerations: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['description', 'impact'],
              properties: {
                description: { type: 'string' },
                impact: { type: 'integer', minimum: -3, maximum: 3 },
              },
            },
          },
          recommendations: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['description', 'impact'],
              properties: {
                description: { type: 'string' },
                impact: { type: 'integer', minimum: -3, maximum: 3 },
              },
            },
          },
        },
      },
    },
  },
};

const productSeeds = [
  {
    itemCode: 'CHANEL-N5-EDP',
    productName: 'Chanel N°5 Eau de Parfum',
    brand: 'Chanel',
    productType: 'basic',
    description:
      'Iconic aldehydic floral fragrance built around May rose and jasmine, with bright citrus facets and a smooth bourbon vanilla trail.',
    retailPrice: 190,
    baseUnits: 1180,
    trend: 1.03,
    promoMonths: [5, 11, 12],
  },
  {
    itemCode: 'DIOR-SAUV-EDP',
    productName: 'Dior Sauvage Eau de Parfum',
    brand: 'Dior',
    productType: 'basic',
    description:
      'Citrus-and-vanilla fragrance inspired by desert twilight, pairing spicy Calabrian bergamot with Papua New Guinean vanilla.',
    retailPrice: 165,
    baseUnits: 1680,
    trend: 1.05,
    promoMonths: [6, 11, 12],
  },
  {
    itemCode: 'MFK-BR540-EDP',
    productName: 'Maison Francis Kurkdjian Baccarat Rouge 540 Eau de Parfum',
    brand: 'Maison Francis Kurkdjian',
    productType: 'basic',
    description:
      'Amber woody floral scent with jasmine, saffron, ambergris mineral facets, and freshly cut cedar.',
    retailPrice: 325,
    baseUnits: 620,
    trend: 1.08,
    promoMonths: [2, 11, 12],
  },
  {
    itemCode: 'YSL-LIBRE-EDP',
    productName: 'Yves Saint Laurent Libre Eau de Parfum',
    brand: 'Yves Saint Laurent',
    productType: 'basic',
    description:
      'Floral lavender fragrance contrasting Moroccan orange blossom, French lavender, and warm vanilla in a couture bottle.',
    retailPrice: 160,
    baseUnits: 1120,
    trend: 1.06,
    promoMonths: [3, 5, 12],
  },
  {
    itemCode: 'TF-LOSTCHERRY-EDP',
    productName: 'Tom Ford Lost Cherry Eau de Parfum',
    brand: 'Tom Ford',
    productType: 'promo',
    description:
      'Luscious cherry fragrance with black cherry, bitter almond, cherry liqueur, rose, jasmine sambac, sandalwood, vetiver, and cedarwood.',
    retailPrice: 255,
    baseUnits: 540,
    trend: 1.07,
    promoMonths: [2, 10, 12],
  },
  {
    itemCode: 'JM-WSS-COLOGNE',
    productName: 'Jo Malone Wood Sage & Sea Salt Cologne',
    brand: 'Jo Malone London',
    productType: 'basic',
    description:
      'Fresh woody coastal cologne with ambrette seed, sea salt, and sage notes inspired by windswept British shores.',
    retailPrice: 165,
    baseUnits: 740,
    trend: 1.04,
    promoMonths: [6, 7, 8],
  },
];

const state = seedDemoData();

app.use(express.json());
app.use((request, response, next) => {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  response.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (request.method === 'OPTIONS') {
    response.sendStatus(204);
    return;
  }
  next();
});

app.get('/api/forecast', (request, response) => {
  response.json(forecastWorkspacePayload());
});

app.post('/api/forecasts', upload.single('forecast_file'), (request, response) => {
  if (!request.file) {
    state.forecast.status = 'failed';
    state.forecast.error_message = 'CSV upload must include a forecast_file.';
    response.status(400).json(forecastWorkspacePayload());
    return;
  }

  state.forecast.original_filename = request.file.originalname || 'forecast.csv';

  try {
    const parsedRows = parseForecastCsv(request.file.buffer.toString('utf8').replace(/^\uFEFF/, ''));
    applyForecastCsv(parsedRows);
    clearAiJobs();
    state.forecast.status = 'active';
    state.forecast.error_message = null;
    response.json(forecastWorkspacePayload());
  } catch (error) {
    state.forecast.status = 'failed';
    state.forecast.error_message = error.message;
    response.status(400).json(forecastWorkspacePayload());
  }
});

app.post('/api/ai-jobs', (request, response) => {
  clearAiJobs();
  const job = {
    id: state.nextJobId++,
    forecast_upload_id: state.forecast.id,
    status: 'queued',
    error_message: null,
    findings: {},
    user_context: [
      `Forecast context:\n${String(request.body?.forecast_context || '').trim()}`,
      `Blind spots or specific questions:\n${String(request.body?.blind_spots || '').trim()}`,
    ].join('\n\n'),
    created_at: new Date().toISOString(),
  };
  state.jobs.set(job.id, job);

  setTimeout(() => runAiJob(job.id), 0);

  response.json(aiJobPayload(job));
});

app.get('/api/ai-jobs/:jobId', (request, response) => {
  const job = state.jobs.get(Number(request.params.jobId));
  if (!job) {
    response.status(404).json({ detail: 'AI job not found' });
    return;
  }
  response.json(aiJobPayload(job));
});

app.get('/forecasts/template.csv', (request, response) => {
  response
    .status(200)
    .set({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="forecast-template.csv"',
    })
    .send(forecastTemplateCsv());
});

app.get('/docs', (request, response) => {
  const links = Object.entries(docFiles)
    .map(([fileName, label]) => `<li><a href="/docs/${fileName}">${escapeHtml(label)}</a></li>`)
    .join('');
  response
    .status(200)
    .type('html')
    .send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Docs</title></head><body><h1>Docs</h1><ul>${links}</ul></body></html>`);
});

app.get('/docs/:docName', (request, response) => {
  const docName = request.params.docName;
  if (!Object.hasOwn(docFiles, docName)) {
    response.status(404).send('Document not found');
    return;
  }
  response.type('text/plain').send(fs.readFileSync(path.join(docsDir, docName), 'utf8'));
});

app.listen(port, () => {
  console.log(`Express API listening on http://127.0.0.1:${port}`);
});

function seedDemoData(today = new Date()) {
  const months = currentMonths(12, today);
  const products = productSeeds.map((seed, index) => {
    const forecastValues = {};
    const actualShipments = {};
    const historicalForecasts = {};

    months.forEach((monthYear, monthIndex) => {
      const monthNumber = Number(monthYear.slice(-2));
      const seasonal = seasonalMultiplier(monthNumber, seed.promoMonths);
      const lastYearMonth = sameMonthLastYear(monthYear);
      const lastYearActual = Math.trunc(seed.baseUnits * seasonal * (0.94 + monthIndex * 0.006));
      const lastYearForecast = Math.trunc(lastYearActual * (0.96 + ((index + monthIndex) % 5) * 0.018));
      const thisYearForecast = Math.trunc(
        lastYearActual * seed.trend * (1.0 + ((monthIndex % 4) - 1.5) * 0.018),
      );

      forecastValues[monthYear] = thisYearForecast;
      actualShipments[lastYearMonth] = lastYearActual;
      historicalForecasts[lastYearMonth] = lastYearForecast;
    });

    return {
      id: index + 1,
      item_code: seed.itemCode,
      product_name: seed.productName,
      brand: seed.brand,
      product_type: seed.productType,
      description: seed.description,
      retail_price: seed.retailPrice,
      forecast_values: forecastValues,
      actual_shipments: actualShipments,
      historical_forecasts: historicalForecasts,
    };
  });

  return {
    forecast: {
      id: 1,
      original_filename: 'Demo ERP forecast',
      status: 'active',
      created_at: new Date().toISOString(),
      error_message: null,
    },
    products,
    jobs: new Map(),
    nextJobId: 1,
  };
}

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex < 0) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function parseBooleanEnv(value, defaultValue) {
  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function forecastWorkspacePayload() {
  const products = chartPayload();
  return {
    forecast: state.forecast,
    months: currentMonths(),
    products,
    values_by_product: valuesByProduct(),
    findings: completedFindingPayload(),
  };
}

function valuesByProduct() {
  return Object.fromEntries(
    state.products.map((product) => [String(product.id), { ...product.forecast_values }]),
  );
}

function chartPayload() {
  const months = currentMonths();
  return state.products.map((product) => ({
    dbId: product.id,
    itemCode: product.item_code,
    label: product.product_name,
    profile: {
      brand: product.brand,
      type: product.product_type,
      description: product.description,
      retailPrice: formatCurrency(product.retail_price),
      itemCode: product.item_code,
    },
    thisYearForecast: months.map((month) => product.forecast_values[month] || 0),
    lastYearForecast: months.map((month) => product.historical_forecasts[sameMonthLastYear(month)] || 0),
    lastYearActual: months.map((month) => product.actual_shipments[sameMonthLastYear(month)] || 0),
  }));
}

function completedFindingPayload() {
  for (const job of state.jobs.values()) {
    if (job.status === 'completed') {
      return job.findings;
    }
  }
  return {};
}

async function runAiJob(jobId) {
  const job = state.jobs.get(jobId);
  if (!job || !['queued', 'running'].includes(job.status)) {
    return;
  }

  try {
    job.status = 'running';
    console.log('openAiApiKey', openAiApiKey);
    if (openAiApiKey) {
      const { responseId, findings } = await requestOpenAiFindings(loadForecastPayload(), job.user_context);
      job.openai_response_id = responseId;
      job.findings = findingsToPayload(findings);
    } else if (demoAiWithoutKey) {
      job.findings = demoFindingPayload();
    } else {
      throw new Error('OPENAI_API_KEY is required to run AI analysis.');
    }

    job.status = 'completed';
    job.error_message = null;
  } catch (error) {
    job.status = 'failed';
    job.error_message = error.message || 'AI analysis failed.';
    job.findings = {};
  }
}

function loadForecastPayload() {
  const months = currentMonths();
  const products = state.products.map((product) => ({
    product_id: product.item_code,
    product_name: product.product_name,
    brand: product.brand,
    type: product.product_type,
    description: product.description,
    retail_price: product.retail_price,
    forecast_units: Object.fromEntries(months.map((month) => [month, product.forecast_values[month] || 0])),
    last_year_actual_units: Object.fromEntries(
      months.map((month) => [month, product.actual_shipments[sameMonthLastYear(month)] || 0]),
    ),
    last_year_forecast_units: Object.fromEntries(
      months.map((month) => [month, product.historical_forecasts[sameMonthLastYear(month)] || 0]),
    ),
  }));

  return { forecast_upload_id: state.forecast.id, products };
}

async function requestOpenAiFindings(forecastPayload, userContext) {
  const response = await openAiRequest('/responses', {
    method: 'POST',
    body: JSON.stringify({
      model: openAiModel,
      background: true,
      tools: [{ type: 'web_search' }],
      text: {
        format: {
          type: 'json_schema',
          name: 'forecast_ai_findings',
          strict: true,
          schema: forecastAnalysisSchema,
        },
      },
      input: [
        {
          role: 'system',
          content: loadPrompt('ai_researcher.md'),
        },
        {
          role: 'user',
          content: JSON.stringify({
            forecast: forecastPayload,
            customer_context: {
              business_type:
                'ERP customer planning sell-through support for specialty beauty, fragrance, department-store, and boutique retail accounts.',
              market: 'United States demo market unless the user context narrows the geography.',
              provided_notes: userContext || 'No customer-specific notes provided.',
            },
            user_context: userContext,
            impact_scale: '-3 to +3, where negative means downward pressure on unit demand.',
            recommendation_policy: loadPrompt('recommendation_policy.md'),
            quality_bar:
              'Prefer no finding over a generic one. Each finding should name a concrete market signal, season, cultural moment, or product-specific angle.',
          }),
        },
      ],
    }),
  });
console.log('response', response);
  const completedResponse = await waitForOpenAiResponse(response);
  const outputText = extractOutputText(completedResponse);
  if (!outputText) {
    throw new Error('OpenAI response did not include output text.');
  }

  return {
    responseId: completedResponse.id,
    findings: parseAiResponse(JSON.parse(outputText)),
  };
}

async function waitForOpenAiResponse(response) {
  let current = response;
  const responseId = current.id;
  if (!responseId) {
    throw new Error('OpenAI response did not include an id.');
  }
  
  const deadline = Date.now() + 240000;
  while (['queued', 'in_progress','running'].includes(current.status)) {
    console.log('current.status', current.status);
    if (Date.now() > deadline) {
      throw new Error('OpenAI response polling timed out.');
    }
    await sleep(2000);
    current = await openAiRequest(`/responses/${encodeURIComponent(responseId)}`);
  }

  if (current.status !== 'completed') {
    throw new Error(openAiResponseError(current) || `OpenAI response ended with status ${current.status}.`);
  }
  console.log('current.status', current.status);
  return current;
}

async function openAiRequest(pathname, options = {}) {
  const response = await fetch(`${openAiBaseUrl}${pathname}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${openAiApiKey}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    const message = payload?.error?.message || `OpenAI request failed with status ${response.status}.`;
    throw new Error(message);
  }

  return payload;
}

function sleep(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function loadPrompt(fileName) {
  return fs.readFileSync(path.join(promptsDir, fileName), 'utf8').trim();
}

function extractOutputText(response) {
  if (typeof response.output_text === 'string') {
    return response.output_text;
  }

  const chunks = [];
  for (const item of response.output || []) {
    for (const content of item.content || []) {
      if (typeof content.text === 'string') {
        chunks.push(content.text);
      }
    }
  }
  return chunks.join('');
}

function openAiResponseError(response) {
  return response?.error?.message || response?.incomplete_details?.reason || '';
}

function parseAiResponse(payload) {
  const findings = [];
  if (!Array.isArray(payload?.findings)) {
    return findings;
  }

  for (const item of payload.findings) {
    if (!item || typeof item !== 'object') {
      continue;
    }

    findings.push({
      productId: String(item.product_id),
      monthYear: String(item.month_year),
      considerations: parseAiItems(item.considerations),
      recommendations: parseAiItems(item.recommendations),
    });
  }

  return findings;
}

function parseAiItems(items) {
  if (!Array.isArray(items)) {
    return [];
  }

  return items
    .filter((item) => item && typeof item === 'object')
    .map((item) => ({
      description: String(item.description || ''),
      impact: validatedImpact(item.impact),
    }))
    .filter((item) => item.description);
}

function validatedImpact(value) {
  const impact = Number.parseInt(value, 10);
  if (!Number.isInteger(impact) || impact < -3 || impact > 3) {
    throw new Error('Impact must be between -3 and +3.');
  }
  return impact;
}

function findingsToPayload(findings) {
  const productsByCode = new Map(state.products.map((product) => [product.item_code, product]));
  const payload = {};

  for (const finding of findings) {
    const product = productsByCode.get(finding.productId);
    if (!product || !product.forecast_values[finding.monthYear]) {
      continue;
    }

    const monthFindings = [
      ...finding.considerations.map((item) => ({ type: 'consideration', ...item })),
      ...finding.recommendations.map((item) => ({ type: 'recommendation', ...item })),
    ];
    if (!monthFindings.length) {
      continue;
    }

    payload[String(product.id)] ||= {};
    payload[String(product.id)][finding.monthYear] = monthFindings;
  }

  return payload;
}

function parseForecastCsv(contents) {
  const rows = parse(contents, {
    bom: true,
    skip_empty_lines: true,
    relax_column_count: true,
  });

  if (!rows.length) {
    throw new Error('CSV must include a header row.');
  }

  const fieldnames = rows[0].map((field) => String(field).trim());
  const itemCodeIndex = fieldnames.indexOf('item_code');
  if (itemCodeIndex < 0) {
    throw new Error('CSV must include an item_code column.');
  }

  const monthIndexes = fieldnames
    .map((field, index) => ({ field, index }))
    .filter(({ field }) => /^\d{4}-\d{2}$/.test(field));

  if (!monthIndexes.length) {
    throw new Error('CSV must include at least one month column in YYYY-MM format.');
  }

  const seenItemCodes = new Set();
  return rows.slice(1).map((row, rowOffset) => {
    const rowNumber = rowOffset + 2;
    const itemCode = String(row[itemCodeIndex] || '').trim();
    if (!itemCode) {
      throw new Error(`Row ${rowNumber} is missing item_code.`);
    }
    if (seenItemCodes.has(itemCode)) {
      throw new Error(`Duplicate item_code '${itemCode}'.`);
    }
    seenItemCodes.add(itemCode);

    const values = {};
    for (const { field, index } of monthIndexes) {
      const rawValue = String(row[index] || '').trim();
      if (rawValue === '') {
        throw new Error(`Row ${rowNumber} is missing value for ${field}.`);
      }
      const units = Number.parseInt(rawValue.replaceAll(',', ''), 10);
      if (!/^-?\d[\d,]*$/.test(rawValue) || Number.isNaN(units)) {
        throw new Error(`Row ${rowNumber} has non-integer value '${rawValue}' for ${field}.`);
      }
      if (units < 0) {
        throw new Error(`Row ${rowNumber} has negative forecast units for ${field}.`);
      }
      values[field] = units;
    }

    return { itemCode, values };
  });
}

function applyForecastCsv(parsedRows) {
  if (!parsedRows.length) {
    throw new Error('CSV must include at least one forecast row.');
  }

  const productsByCode = new Map(state.products.map((product) => [product.item_code, product]));
  for (const parsed of parsedRows) {
    const product = productsByCode.get(parsed.itemCode);
    if (!product) {
      throw new Error(
        `Unknown item_code '${parsed.itemCode}'; forecast CSVs can only update existing ERP products.`,
      );
    }
    Object.assign(product.forecast_values, parsed.values);
  }
}

function clearAiJobs() {
  state.jobs.clear();
}

function aiJobPayload(job) {
  const findings = job.status === 'completed' ? job.findings : {};
  return {
    id: job.id,
    status: job.status,
    forecast_upload_id: job.forecast_upload_id,
    error_message: job.error_message,
    findings_count: countFindings(findings),
    findings,
  };
}

function demoFindingPayload() {
  const months = currentMonths();
  const payload = {};
  for (const product of state.products) {
    const templates = demoTemplates(product, months);
    for (const [month, findings] of templates) {
      payload[String(product.id)] ||= {};
      payload[String(product.id)][month] = findings;
    }
  }
  return payload;
}

function demoTemplates(product, months) {
  const seasonalLift = [
    {
      type: 'consideration',
      description: `${product.product_name} has a seasonal demand window this month; validate account display plans before treating the lift as fully guaranteed.`,
      impact: 2,
    },
    {
      type: 'recommendation',
      description: `Ask top ${product.brand} accounts to confirm sampling, display timing, and inventory coverage for the expected demand window.`,
      impact: 2,
    },
  ];
  const softness = [
    {
      type: 'consideration',
      description: `${product.product_name} may see softer conversion as shopping shifts away from its strongest gifting or occasion-led use case.`,
      impact: -1,
    },
    {
      type: 'recommendation',
      description: `Move messaging toward replenishment and clienteling instead of broad promotional support for ${product.item_code}.`,
      impact: 1,
    },
  ];
  const baseline = [
    {
      type: 'consideration',
      description: `${product.product_name} has no strong external demo signal beyond normal seasonality and account execution risk.`,
      impact: 0,
    },
    {
      type: 'recommendation',
      description: `Use account feedback to separate real product-specific demand from normal ${product.product_type} category movement.`,
      impact: 0,
    },
  ];

  return [
    [months[0], product.product_type === 'promo' ? seasonalLift : baseline],
    [months[2], seasonalLift],
    [months[5], softness],
    [months[7], seasonalLift],
  ].filter(([month]) => Boolean(month));
}

function countFindings(payload) {
  return Object.values(payload).reduce(
    (productTotal, monthMap) =>
      productTotal +
      Object.values(monthMap).reduce((monthTotal, findings) => monthTotal + findings.length, 0),
    0,
  );
}

function forecastTemplateCsv() {
  const months = currentMonths();
  const lines = [['item_code', ...months].join(',')];
  for (const product of state.products) {
    const values = months.map((month, index) => String(product.forecast_values[month] ?? 1000 + index * 25));
    lines.push([product.item_code, ...values].join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}

function currentMonths(count = 12, today = new Date()) {
  return Array.from({ length: count }, (_, offset) => {
    const date = new Date(today.getFullYear(), today.getMonth() + offset, 1);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
  });
}

function sameMonthLastYear(monthYear) {
  const [year, month] = monthYear.split('-');
  return `${Number(year) - 1}-${month}`;
}

function seasonalMultiplier(month, promoMonths) {
  if (promoMonths.includes(month)) return 1.38;
  if ([11, 12].includes(month)) return 1.18;
  if ([1, 2].includes(month)) return 0.88;
  if ([6, 7, 8].includes(month)) return 1.08;
  return 1.0;
}

function formatCurrency(value) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

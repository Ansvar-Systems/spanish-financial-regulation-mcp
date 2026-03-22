# Spanish Financial Regulation MCP

MCP server for querying CNMV (Comision Nacional del Mercado de Valores) and Banco de Espana financial regulations: circulares, guias tecnicas, disposiciones normativas, and enforcement actions.

## Tool prefix: `es_fin_`

## Tools

| Tool | Description |
|------|-------------|
| `es_fin_search_regulations` | Full-text search across CNMV and BdE provisions |
| `es_fin_get_regulation` | Get a specific circular or provision by sourcebook and reference |
| `es_fin_list_sourcebooks` | List all available sourcebooks |
| `es_fin_search_enforcement` | Search CNMV and BdE enforcement actions and sanctions |
| `es_fin_check_currency` | Check whether a provision reference is currently in force |
| `es_fin_about` | Server metadata and tool list |

## Sourcebooks

| ID | Source |
|----|--------|
| `CNMV_CIRCULARES` | CNMV Circulares normativas |
| `CNMV_GUIAS_TECNICAS` | CNMV Guias Tecnicas |
| `BDE_CIRCULARES` | Banco de Espana Circulares |
| `BDE_GUIAS` | Banco de Espana Guias |
| `DGSFP_RESOLUCIONES` | DGSFP Resoluciones |

## Setup

```bash
npm install
npm run seed       # seed sample data
npm run build
npm run dev        # HTTP server on port 3000
```

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CNMV_DB_PATH` | `data/cnmv.db` | Path to SQLite database |
| `PORT` | `3000` | HTTP server port |

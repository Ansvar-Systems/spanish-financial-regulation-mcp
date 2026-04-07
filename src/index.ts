#!/usr/bin/env node

/**
 * Spanish Financial Regulation MCP -- stdio entry point.
 *
 * Provides MCP tools for querying CNMV and Banco de Espana regulations:
 * circulares, guias tecnicas, enforcement actions, and sourcebook lookup.
 *
 * Tool prefix: es_fin_
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  listSourcebooks,
  searchProvisions,
  getProvision,
  searchEnforcement,
  checkProvisionCurrency,
} from "./db.js";
import { buildCitation } from "./utils/citation.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let pkgVersion = "0.1.0";
try {
  const pkg = JSON.parse(
    readFileSync(join(__dirname, "..", "package.json"), "utf8"),
  ) as { version: string };
  pkgVersion = pkg.version;
} catch {
  // fallback to default
}

const SERVER_NAME = "spanish-financial-regulation-mcp";

// --- Tool definitions --------------------------------------------------------

const TOOLS = [
  {
    name: "es_fin_search_regulations",
    description:
      "Busqueda de texto completo en circulares y disposiciones de la CNMV y el Banco de Espana. Devuelve circulares, guias tecnicas, y resoluciones que coincidan con la consulta. Full-text search across CNMV and Banco de Espana provisions.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Consulta de busqueda (p.ej., 'obligaciones de informacion', 'fondos de inversion alternativos', 'resiliencia cibernetica')",
        },
        sourcebook: {
          type: "string",
          description: "Filtrar por identificador de sourcebook (p.ej., CNMV_CIRCULARES, BDE_CIRCULARES, CNMV_GUIAS_TECNICAS). Opcional.",
        },
        status: {
          type: "string",
          enum: ["en_vigor", "derogada", "pendiente"],
          description: "Filtrar por estado de la disposicion. Por defecto incluye todos los estados.",
        },
        limit: {
          type: "number",
          description: "Numero maximo de resultados. Por defecto 20.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "es_fin_get_regulation",
    description:
      "Obtener una circular o disposicion especifica por sourcebook y referencia. Acepta referencias como 'Circular 1/2022' o 'BdE Circular 2/2016 Art. 5'.",
    inputSchema: {
      type: "object" as const,
      properties: {
        sourcebook: {
          type: "string",
          description: "Identificador del sourcebook (p.ej., CNMV_CIRCULARES, BDE_CIRCULARES, CNMV_GUIAS_TECNICAS)",
        },
        reference: {
          type: "string",
          description: "Referencia completa de la disposicion (p.ej., 'Circular 1/2022', 'Circular 3/2013 Art. 4')",
        },
      },
      required: ["sourcebook", "reference"],
    },
  },
  {
    name: "es_fin_list_sourcebooks",
    description:
      "Listar todos los sourcebooks disponibles: CNMV Circulares, Guias Tecnicas, Banco de Espana Circulares, y otros organismos reguladores espanoles.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "es_fin_search_enforcement",
    description:
      "Buscar expedientes sancionadores y resoluciones disciplinarias de la CNMV y el Banco de Espana. Devuelve multas, sanciones y resoluciones de entidades.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Consulta de busqueda (p.ej., nombre de entidad, tipo de infraccion, 'abuso de mercado')",
        },
        action_type: {
          type: "string",
          enum: ["multa", "sancion", "resolucion", "advertencia"],
          description: "Filtrar por tipo de accion. Opcional.",
        },
        limit: {
          type: "number",
          description: "Numero maximo de resultados. Por defecto 20.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "es_fin_check_currency",
    description:
      "Verificar si una referencia normativa especifica esta actualmente en vigor. Devuelve el estado y la fecha de entrada en vigor.",
    inputSchema: {
      type: "object" as const,
      properties: {
        reference: {
          type: "string",
          description: "Referencia normativa a verificar (p.ej., 'Circular 1/2022', 'BdE Circular 4/2017')",
        },
      },
      required: ["reference"],
    },
  },
  {
    name: "es_fin_about",
    description: "Devolver metadatos sobre este servidor MCP: version, fuente de datos, lista de herramientas.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
];

// --- Zod schemas for argument validation ------------------------------------

const SearchRegulationsArgs = z.object({
  query: z.string().min(1),
  sourcebook: z.string().optional(),
  status: z.enum(["en_vigor", "derogada", "pendiente"]).optional(),
  limit: z.number().int().positive().max(100).optional(),
});

const GetRegulationArgs = z.object({
  sourcebook: z.string().min(1),
  reference: z.string().min(1),
});

const SearchEnforcementArgs = z.object({
  query: z.string().min(1),
  action_type: z.enum(["multa", "sancion", "resolucion", "advertencia"]).optional(),
  limit: z.number().int().positive().max(100).optional(),
});

const CheckCurrencyArgs = z.object({
  reference: z.string().min(1),
});

// --- Helper ------------------------------------------------------------------

function textContent(data: unknown) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(data, null, 2) },
    ],
  };
}

function errorContent(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true as const,
  };
}

// --- Server setup ------------------------------------------------------------

const server = new Server(
  { name: SERVER_NAME, version: pkgVersion },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  try {
    switch (name) {
      case "es_fin_search_regulations": {
        const parsed = SearchRegulationsArgs.parse(args);
        const results = searchProvisions({
          query: parsed.query,
          sourcebook: parsed.sourcebook,
          status: parsed.status,
          limit: parsed.limit,
        });
        return textContent({ results, count: results.length });
      }

      case "es_fin_get_regulation": {
        const parsed = GetRegulationArgs.parse(args);
        const provision = getProvision(parsed.sourcebook, parsed.reference);
        if (!provision) {
          return errorContent(
            `Disposicion no encontrada: ${parsed.sourcebook} ${parsed.reference}`,
          );
        }
        const _citation = buildCitation(
          `${parsed.sourcebook} ${parsed.reference}`,
          (provision as Record<string, unknown>).title as string || `${parsed.sourcebook} ${parsed.reference}`,
          "es_fin_get_regulation",
          { sourcebook: parsed.sourcebook, reference: parsed.reference },
        );
        return textContent({ ...provision as Record<string, unknown>, _citation });
      }

      case "es_fin_list_sourcebooks": {
        const sourcebooks = listSourcebooks();
        return textContent({ sourcebooks, count: sourcebooks.length });
      }

      case "es_fin_search_enforcement": {
        const parsed = SearchEnforcementArgs.parse(args);
        const results = searchEnforcement({
          query: parsed.query,
          action_type: parsed.action_type,
          limit: parsed.limit,
        });
        return textContent({ results, count: results.length });
      }

      case "es_fin_check_currency": {
        const parsed = CheckCurrencyArgs.parse(args);
        const currency = checkProvisionCurrency(parsed.reference);
        return textContent(currency);
      }

      case "es_fin_about": {
        return textContent({
          name: SERVER_NAME,
          version: pkgVersion,
          description:
            "CNMV (Comision Nacional del Mercado de Valores) y Banco de Espana MCP server. Proporciona acceso a circulares, guias tecnicas, disposiciones normativas, y expedientes sancionadores.",
          data_sources: [
            "CNMV Circulares (https://www.cnmv.es/portal/legislacion/Circulares.aspx)",
            "CNMV Guias Tecnicas (https://www.cnmv.es/portal/legislacion/GuiasTecnicas.aspx)",
            "Banco de Espana Circulares (https://www.bde.es/wbe/es/publicaciones/legislacion-normativa/circulares-banco-espana/)",
          ],
          tools: TOOLS.map((t) => ({ name: t.name, description: t.description })),
        });
      }

      default:
        return errorContent(`Herramienta desconocida: ${name}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return errorContent(`Error ejecutando ${name}: ${message}`);
  }
});

// --- Main --------------------------------------------------------------------

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`${SERVER_NAME} v${pkgVersion} running on stdio\n`);
}

main().catch((err) => {
  process.stderr.write(`Fatal error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});

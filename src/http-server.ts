#!/usr/bin/env node

/**
 * HTTP Server Entry Point for Docker Deployment
 *
 * Provides Streamable HTTP transport for remote MCP clients.
 * Use src/index.ts for local stdio-based usage.
 *
 * Endpoints:
 *   GET  /health  -- liveness probe
 *   POST /mcp     -- MCP Streamable HTTP (session-aware)
 */

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  listSourcebooks,
  searchProvisions,
  getProvision,
  searchEnforcement,
  checkProvisionCurrency,
} from "./db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = parseInt(process.env["PORT"] ?? "3000", 10);
const SERVER_NAME = "spanish-financial-regulation-mcp";

let pkgVersion = "0.1.0";
try {
  const pkg = JSON.parse(
    readFileSync(join(__dirname, "..", "package.json"), "utf8"),
  ) as { version: string };
  pkgVersion = pkg.version;
} catch {
  // fallback
}

// --- Tool definitions (shared with index.ts) ---------------------------------

const TOOLS = [
  {
    name: "es_fin_search_regulations",
    description:
      "Busqueda de texto completo en circulares y disposiciones de la CNMV y el Banco de Espana. Devuelve circulares, guias tecnicas, y resoluciones que coincidan con la consulta.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Consulta de busqueda" },
        sourcebook: { type: "string", description: "Filtrar por sourcebook (p.ej., CNMV_CIRCULARES, BDE_CIRCULARES). Opcional." },
        status: {
          type: "string",
          enum: ["en_vigor", "derogada", "pendiente"],
          description: "Filtrar por estado. Opcional.",
        },
        limit: { type: "number", description: "Max resultados (por defecto 20)." },
      },
      required: ["query"],
    },
  },
  {
    name: "es_fin_get_regulation",
    description:
      "Obtener una circular o disposicion especifica por sourcebook y referencia (p.ej., Circular 1/2022).",
    inputSchema: {
      type: "object" as const,
      properties: {
        sourcebook: { type: "string", description: "Identificador del sourcebook (p.ej., CNMV_CIRCULARES, BDE_CIRCULARES)" },
        reference: { type: "string", description: "Referencia de la disposicion (p.ej., Circular 1/2022)" },
      },
      required: ["sourcebook", "reference"],
    },
  },
  {
    name: "es_fin_list_sourcebooks",
    description: "Listar todos los sourcebooks disponibles con nombres y descripciones.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "es_fin_search_enforcement",
    description:
      "Buscar expedientes sancionadores de la CNMV y el Banco de Espana -- multas, sanciones y resoluciones disciplinarias.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Consulta de busqueda (nombre de entidad, tipo de infraccion, etc.)" },
        action_type: {
          type: "string",
          enum: ["multa", "sancion", "resolucion", "advertencia"],
          description: "Filtrar por tipo de accion. Opcional.",
        },
        limit: { type: "number", description: "Max resultados (por defecto 20)." },
      },
      required: ["query"],
    },
  },
  {
    name: "es_fin_check_currency",
    description: "Verificar si una referencia normativa especifica esta actualmente en vigor.",
    inputSchema: {
      type: "object" as const,
      properties: {
        reference: { type: "string", description: "Referencia normativa (p.ej., Circular 1/2022)" },
      },
      required: ["reference"],
    },
  },
  {
    name: "es_fin_about",
    description: "Devolver metadatos sobre este servidor MCP: version, fuente de datos, lista de herramientas.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
  },
];

// --- Zod schemas -------------------------------------------------------------

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

// --- MCP server factory ------------------------------------------------------

function createMcpServer(): Server {
  const server = new Server(
    { name: SERVER_NAME, version: pkgVersion },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;

    function textContent(data: unknown) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      };
    }

    function errorContent(message: string) {
      return {
        content: [{ type: "text" as const, text: message }],
        isError: true as const,
      };
    }

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
          return textContent(provision);
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

  return server;
}

// --- HTTP server -------------------------------------------------------------

async function main(): Promise<void> {
  const sessions = new Map<
    string,
    { transport: StreamableHTTPServerTransport; server: Server }
  >();

  const httpServer = createServer((req, res) => {
    handleRequest(req, res, sessions).catch((err) => {
      console.error(`[${SERVER_NAME}] Unhandled error:`, err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
    });
  });

  async function handleRequest(
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
    activeSessions: Map<
      string,
      { transport: StreamableHTTPServerTransport; server: Server }
    >,
  ): Promise<void> {
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", server: SERVER_NAME, version: pkgVersion }));
      return;
    }

    if (url.pathname === "/mcp") {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;

      if (sessionId && activeSessions.has(sessionId)) {
        const session = activeSessions.get(sessionId)!;
        await session.transport.handleRequest(req, res);
        return;
      }

      // New session -- create a fresh MCP server instance per session
      const mcpServer = createMcpServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK type mismatch with exactOptionalPropertyTypes
      await mcpServer.connect(transport as any);

      transport.onclose = () => {
        if (transport.sessionId) {
          activeSessions.delete(transport.sessionId);
        }
        mcpServer.close().catch(() => {});
      };

      await transport.handleRequest(req, res);

      // Store AFTER handleRequest -- sessionId is set during initialize
      if (transport.sessionId) {
        activeSessions.set(transport.sessionId, { transport, server: mcpServer });
      }
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  }

  httpServer.listen(PORT, () => {
    console.error(`${SERVER_NAME} v${pkgVersion} (HTTP) listening on port ${PORT}`);
    console.error(`MCP endpoint:  http://localhost:${PORT}/mcp`);
    console.error(`Health check:  http://localhost:${PORT}/health`);
  });

  process.on("SIGTERM", () => {
    console.error("Received SIGTERM, shutting down...");
    httpServer.close(() => process.exit(0));
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

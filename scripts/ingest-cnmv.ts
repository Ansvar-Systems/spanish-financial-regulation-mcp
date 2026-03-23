/**
 * CNMV Ingestion Crawler
 *
 * Scrapes the CNMV website (cnmv.es) and populates the SQLite database with
 * financial regulation data: circulares, guias tecnicas, and enforcement actions.
 *
 * Data sources:
 *   - Circulares:     https://www.cnmv.es/portal/legislacion/circulares?lang=es
 *                     (sub-pages by year range: 1989-1995 through 2021-current)
 *   - Guias tecnicas: https://www.cnmv.es/portal/legislacion/guias-tecnicas?lang=es
 *   - Sanciones:      https://www.cnmv.es/Portal/consultas/registrosanciones/verregsanciones?lang=es
 *
 * Prerequisites:
 *   npm install cheerio @types/cheerio
 *
 * Usage:
 *   npx tsx scripts/ingest-cnmv.ts
 *   npx tsx scripts/ingest-cnmv.ts --dry-run    # scrape but do not write to DB
 *   npx tsx scripts/ingest-cnmv.ts --resume      # skip already-ingested references
 *   npx tsx scripts/ingest-cnmv.ts --force       # drop and recreate DB first
 */

import Database from "better-sqlite3";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import * as cheerio from "cheerio";
import { SCHEMA_SQL } from "../src/db.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DB_PATH = process.env["CNMV_DB_PATH"] ?? "data/cnmv.db";
const RATE_LIMIT_MS = 1_500;
const MAX_RETRIES = 3;
const RETRY_BACKOFF_MS = 3_000;
const REQUEST_TIMEOUT_MS = 30_000;

const BASE_URL = "https://www.cnmv.es";

/** Year-range sub-pages under /portal/legislacion/ for circulares. */
const CIRCULAR_PAGES = [
  "circulares-2021-2025",
  "circulares-2016-2020",
  "circulares-2011-2015",
  "circulares-2006-2010",
  "circulares-2001-2005",
  "circulares-1996-2000",
  "circulares-1989-1995",
] as const;

const GUIAS_TECNICAS_URL = `${BASE_URL}/portal/legislacion/guias-tecnicas?lang=es`;
const SANCTIONS_BASE_URL = `${BASE_URL}/Portal/consultas/registrosanciones/verregsanciones`;
const MAX_SANCTION_PAGES = 25; // safety cap — currently ~18 pages

// ---------------------------------------------------------------------------
// CLI flags
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const resume = args.includes("--resume");
const force = args.includes("--force");

// ---------------------------------------------------------------------------
// Logging helpers
// ---------------------------------------------------------------------------

function log(msg: string): void {
  const ts = new Date().toISOString().slice(0, 19);
  console.log(`[${ts}] ${msg}`);
}

function warn(msg: string): void {
  const ts = new Date().toISOString().slice(0, 19);
  console.warn(`[${ts}] WARN: ${msg}`);
}

function error(msg: string): void {
  const ts = new Date().toISOString().slice(0, 19);
  console.error(`[${ts}] ERROR: ${msg}`);
}

// ---------------------------------------------------------------------------
// Rate-limited HTTP fetch with retries
// ---------------------------------------------------------------------------

let lastRequestAt = 0;

async function rateLimitedFetch(url: string): Promise<string> {
  const now = Date.now();
  const elapsed = now - lastRequestAt;
  if (elapsed < RATE_LIMIT_MS) {
    await sleep(RATE_LIMIT_MS - elapsed);
  }

  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      lastRequestAt = Date.now();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      const resp = await fetch(url, {
        signal: controller.signal,
        headers: {
          "User-Agent":
            "AnsvarCNMVCrawler/1.0 (+https://ansvar.eu; compliance research)",
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "es-ES,es;q=0.9,en;q=0.5",
        },
      });
      clearTimeout(timeout);

      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status} for ${url}`);
      }

      return await resp.text();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < MAX_RETRIES) {
        const backoff = RETRY_BACKOFF_MS * attempt;
        warn(`Attempt ${attempt}/${MAX_RETRIES} failed for ${url}: ${lastError.message} — retrying in ${backoff}ms`);
        await sleep(backoff);
      }
    }
  }

  throw new Error(
    `Failed after ${MAX_RETRIES} attempts for ${url}: ${lastError?.message ?? "unknown error"}`,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Database bootstrap
// ---------------------------------------------------------------------------

function initDb(): Database.Database {
  const dir = dirname(DB_PATH);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    log(`Created data directory: ${dir}`);
  }

  if (force && existsSync(DB_PATH)) {
    unlinkSync(DB_PATH);
    log(`Deleted existing database (--force)`);
  }

  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  log(`Database initialised at ${DB_PATH}`);
  return db;
}

// ---------------------------------------------------------------------------
// Sourcebook seeding
// ---------------------------------------------------------------------------

interface SourcebookDef {
  id: string;
  name: string;
  description: string;
}

const SOURCEBOOKS: SourcebookDef[] = [
  {
    id: "CNMV_CIRCULARES",
    name: "CNMV Circulares",
    description:
      "Circulares normativas emitidas por la Comision Nacional del Mercado de Valores que desarrollan la regulacion de mercados de valores, fondos de inversion, y entidades financieras.",
  },
  {
    id: "CNMV_GUIAS_TECNICAS",
    name: "CNMV Guias Tecnicas",
    description:
      "Guias tecnicas de la CNMV que desarrollan criterios de supervision y mejores practicas para entidades supervisadas, incluyendo resiliencia cibernetica y gobierno corporativo.",
  },
  {
    id: "BDE_CIRCULARES",
    name: "Banco de Espana Circulares",
    description:
      "Circulares normativas emitidas por el Banco de Espana que desarrollan la regulacion bancaria, supervisora, y financiera para entidades de credito y otros sujetos obligados.",
  },
  {
    id: "BDE_GUIAS",
    name: "Banco de Espana Guias",
    description:
      "Guias y documentos de criterios del Banco de Espana sobre supervision bancaria, gestion de riesgos, y cumplimiento normativo.",
  },
  {
    id: "DGSFP_RESOLUCIONES",
    name: "DGSFP Resoluciones",
    description:
      "Resoluciones e instrucciones de la Direccion General de Seguros y Fondos de Pensiones que regulan el sector asegurador y los planes de pensiones en Espana.",
  },
];

function seedSourcebooks(db: Database.Database): void {
  const stmt = db.prepare(
    "INSERT OR IGNORE INTO sourcebooks (id, name, description) VALUES (?, ?, ?)",
  );
  for (const sb of SOURCEBOOKS) {
    stmt.run(sb.id, sb.name, sb.description);
  }
  log(`Seeded ${SOURCEBOOKS.length} sourcebooks`);
}

// ---------------------------------------------------------------------------
// Resume helper — loads existing references to skip duplicates
// ---------------------------------------------------------------------------

function loadExistingReferences(db: Database.Database): Set<string> {
  const rows = db
    .prepare("SELECT reference FROM provisions")
    .all() as Array<{ reference: string }>;
  return new Set(rows.map((r) => r.reference));
}

function loadExistingEnforcementRefs(db: Database.Database): Set<string> {
  const rows = db
    .prepare("SELECT reference_number FROM enforcement_actions WHERE reference_number IS NOT NULL")
    .all() as Array<{ reference_number: string }>;
  return new Set(rows.map((r) => r.reference_number));
}

// ---------------------------------------------------------------------------
// Types for scraped data
// ---------------------------------------------------------------------------

interface ScrapedProvision {
  sourcebook_id: string;
  reference: string;
  title: string;
  text: string;
  type: string;
  status: string;
  effective_date: string | null;
  chapter: string | null;
  section: string | null;
}

interface ScrapedEnforcement {
  firm_name: string;
  reference_number: string | null;
  action_type: string;
  amount: number | null;
  date: string | null;
  summary: string;
  sourcebook_references: string | null;
}

// ---------------------------------------------------------------------------
// Scraping: CNMV Circulares
// ---------------------------------------------------------------------------

/**
 * Parses a CNMV circulares year-range page (e.g. circulares-2016-2020).
 *
 * Page structure: <h2> year headings, followed by paragraphs or list items
 * containing <a> links to BOE PDFs with the circular title text.
 */
async function scrapeCircularPage(slug: string): Promise<ScrapedProvision[]> {
  const url = `${BASE_URL}/portal/legislacion/${slug}?lang=es`;
  log(`Scraping circulares: ${url}`);

  const html = await rateLimitedFetch(url);
  const $ = cheerio.load(html);
  const provisions: ScrapedProvision[] = [];

  // The main content area contains year headings (h2) and entries below them.
  // Each circular appears as a text block with an <a> link to its BOE publication.
  // We scan all <a> elements whose text or parent text matches "Circular N/YYYY".

  // Strategy: find all links on the page whose href points to BOE or CNMV docs,
  // and whose surrounding text mentions "Circular".
  const circularPattern = /Circular\s+(\d+\/\d{4})/i;
  const datePattern = /(\d{1,2})\s+de\s+(\w+)\s+de\s+(\d{4})/i;

  const processedRefs = new Set<string>();

  $("a").each((_, el) => {
    const anchor = $(el);
    const href = anchor.attr("href") ?? "";
    // Only process links to BOE or CNMV document portals
    if (!href.includes("boe.es") && !href.includes("cnmv.es/DocPortal")) {
      return;
    }

    // Get the full text context: the parent element's text
    const parentEl = anchor.closest("p, li, div, td");
    const contextText = parentEl.length > 0 ? parentEl.text().trim() : anchor.text().trim();

    const refMatch = contextText.match(circularPattern);
    if (!refMatch?.[1]) {
      return;
    }

    const reference = `Circular ${refMatch[1]}`;
    if (processedRefs.has(reference)) {
      return;
    }
    processedRefs.add(reference);

    // Extract date from context text
    const dateMatch = contextText.match(datePattern);
    const effectiveDate = dateMatch ? parseSpanishDate(dateMatch[0]) : null;

    // Determine year from reference
    const refYear = refMatch[1].split("/")[1] ?? "";

    // Build title: use the full context text, trimmed
    const title = cleanText(contextText).slice(0, 500);

    // Build description text from context
    const text = cleanText(contextText);

    if (text.length < 10) {
      return; // skip near-empty entries
    }

    provisions.push({
      sourcebook_id: "CNMV_CIRCULARES",
      reference,
      title: `${reference}, de la CNMV`,
      text,
      type: "circular",
      status: "en_vigor",
      effective_date: effectiveDate,
      chapter: refYear,
      section: null,
    });
  });

  log(`  Found ${provisions.length} circulares in ${slug}`);
  return provisions;
}

/**
 * Fetches the full text of a circular from its BOE link.
 * BOE pages are HTML with the full legal text.
 * Returns the cleaned text content, or null if the link is a PDF.
 */
async function fetchBoeText(url: string): Promise<string | null> {
  // Skip PDF links — we cannot parse those without a PDF library
  if (url.endsWith(".pdf")) {
    return null;
  }

  try {
    const html = await rateLimitedFetch(url);
    const $ = cheerio.load(html);

    // BOE HTML pages use various content containers
    const contentSelectors = [
      "#textoxslt",
      ".texto",
      ".documento-texto",
      "#documento",
      "article",
      ".content",
    ];

    for (const sel of contentSelectors) {
      const el = $(sel);
      if (el.length > 0) {
        return cleanText(el.text());
      }
    }

    // Fallback: use body text stripped of nav elements
    $("nav, header, footer, script, style, .menu, .sidebar").remove();
    const bodyText = $("body").text().trim();
    if (bodyText.length > 100) {
      return cleanText(bodyText);
    }
  } catch (err) {
    warn(`Could not fetch BOE text from ${url}: ${err instanceof Error ? err.message : String(err)}`);
  }

  return null;
}

// ---------------------------------------------------------------------------
// Scraping: CNMV Guias Tecnicas
// ---------------------------------------------------------------------------

async function scrapeGuiasTecnicas(): Promise<ScrapedProvision[]> {
  log(`Scraping guias tecnicas: ${GUIAS_TECNICAS_URL}`);

  const html = await rateLimitedFetch(GUIAS_TECNICAS_URL);
  const $ = cheerio.load(html);
  const provisions: ScrapedProvision[] = [];

  const gtPattern = /G(?:u[ií]a\s+[Tt][eé]cnica|T)\s*(\d+\/\d{4})/i;
  const processedRefs = new Set<string>();

  $("a").each((_, el) => {
    const anchor = $(el);
    const href = anchor.attr("href") ?? "";

    // Only process links to CNMV DocPortal or BOE
    if (!href.includes("DocPortal") && !href.includes("boe.es") && !href.includes("cnmv.es")) {
      return;
    }

    const parentEl = anchor.closest("p, li, div, td");
    const contextText = parentEl.length > 0 ? parentEl.text().trim() : anchor.text().trim();

    const refMatch = contextText.match(gtPattern);
    if (!refMatch?.[1]) {
      return;
    }

    const reference = `GT ${refMatch[1]}`;
    if (processedRefs.has(reference)) {
      return;
    }
    processedRefs.add(reference);

    const refParts = refMatch[1].split("/");
    const refYear = refParts[1] ?? "";

    const title = cleanText(contextText).slice(0, 500);
    const text = cleanText(contextText);

    if (text.length < 10) {
      return;
    }

    provisions.push({
      sourcebook_id: "CNMV_GUIAS_TECNICAS",
      reference,
      title,
      text,
      type: "guia_tecnica",
      status: "en_vigor",
      effective_date: `${refYear}-01-01`,
      chapter: refYear,
      section: null,
    });
  });

  log(`  Found ${provisions.length} guias tecnicas`);
  return provisions;
}

// ---------------------------------------------------------------------------
// Scraping: CNMV Enforcement Actions (Sanciones)
// ---------------------------------------------------------------------------

async function scrapeSanctions(): Promise<ScrapedEnforcement[]> {
  log(`Scraping sanctions registry`);
  const enforcements: ScrapedEnforcement[] = [];
  const processedFirms = new Set<string>();

  for (let page = 0; page < MAX_SANCTION_PAGES; page++) {
    const url = `${SANCTIONS_BASE_URL}?lang=es&page=${page}`;
    log(`  Fetching sanctions page ${page}: ${url}`);

    let html: string;
    try {
      html = await rateLimitedFetch(url);
    } catch (err) {
      warn(`Failed to fetch sanctions page ${page}: ${err instanceof Error ? err.message : String(err)}`);
      break;
    }

    const $ = cheerio.load(html);
    const pageEnforcements = parseSanctionsPage($);

    if (pageEnforcements.length === 0) {
      log(`  No sanctions found on page ${page} — stopping pagination`);
      break;
    }

    for (const enf of pageEnforcements) {
      // De-duplicate by firm_name + date
      const key = `${enf.firm_name}|${enf.date ?? ""}`;
      if (!processedFirms.has(key)) {
        processedFirms.add(key);
        enforcements.push(enf);
      }
    }

    // Check if this is the last page: look for a "next" link or pagination marker
    const hasNext = $("a").toArray().some((el) => {
      const href = $(el).attr("href") ?? "";
      return href.includes(`page=${page + 1}`);
    });

    if (!hasNext) {
      log(`  No next-page link found after page ${page} — stopping`);
      break;
    }
  }

  log(`  Found ${enforcements.length} enforcement actions total`);
  return enforcements;
}

/**
 * Parses a single page of the CNMV sanctions registry.
 *
 * Each entry on the page contains:
 *   - An incorporation date
 *   - A resolution description linking to a PDF
 *   - The sanctioned entity or individual name
 */
function parseSanctionsPage($: cheerio.CheerioAPI): ScrapedEnforcement[] {
  const enforcements: ScrapedEnforcement[] = [];

  // The sanctions page lists entries as linked resolution descriptions.
  // Each entry links to /webservices/verdocumento/ver?e=... or similar PDF URLs.

  const datePattern = /(\d{2})\/(\d{2})\/(\d{4})/;
  const amountPattern = /(\d[\d.,]*)\s*(euros?|EUR|€)/i;
  const resolutionPattern = /[Rr]esoluci[oó]n/;

  // Strategy: find all links to resolution documents
  const links = $("a").toArray();

  for (const el of links) {
    const anchor = $(el);
    const href = anchor.attr("href") ?? "";

    // Filter for resolution document links
    if (!href.includes("verdocumento") && !href.includes("DocPortal")) {
      continue;
    }

    const linkText = anchor.text().trim();
    if (!resolutionPattern.test(linkText) && linkText.length < 20) {
      continue;
    }

    // Get the surrounding context for entity names and dates
    const parentEl = anchor.closest("li, div, p, tr, td");
    const fullContext = parentEl.length > 0 ? parentEl.text().trim() : linkText;

    // Extract date
    const dateMatch = fullContext.match(datePattern);
    let isoDate: string | null = null;
    if (dateMatch?.[1] && dateMatch[2] && dateMatch[3]) {
      isoDate = `${dateMatch[3]}-${dateMatch[2]}-${dateMatch[1]}`;
    }

    // Extract amount if mentioned
    let amount: number | null = null;
    const amountMatch = fullContext.match(amountPattern);
    if (amountMatch?.[1]) {
      amount = parseFloat(amountMatch[1].replace(/\./g, "").replace(",", "."));
    }

    // Determine firm name: text after the resolution description, or from the link text
    // We try to extract entity names from the full context
    const firmName = extractFirmName(fullContext, linkText);
    if (!firmName || firmName.length < 3) {
      continue;
    }

    // Determine action type from text content
    const actionType = classifySanctionType(fullContext);

    // Generate a reference number from date and firm
    const refNumber = generateSanctionRef(isoDate, firmName);

    enforcements.push({
      firm_name: firmName,
      reference_number: refNumber,
      action_type: actionType,
      amount,
      date: isoDate,
      summary: cleanText(fullContext).slice(0, 2000),
      sourcebook_references: null,
    });
  }

  return enforcements;
}

/**
 * Attempts to extract the sanctioned firm or individual name from the
 * sanctions page context text. The CNMV registry typically shows the
 * entity name as part of the resolution description.
 */
function extractFirmName(fullContext: string, linkText: string): string {
  // The resolution text often follows the pattern:
  // "Resolución de [date] ... por la que se publica(n) la(s) sanción(es) ... a [ENTITY]"
  const entityMatch = fullContext.match(
    /(?:sanci[oó]n(?:es)?|impuesta[s]?)\s+(?:a|por)\s+(.+?)(?:\s*\(|$|\.\s)/i,
  );
  if (entityMatch?.[1]) {
    return cleanText(entityMatch[1]).slice(0, 200);
  }

  // Try pattern: "por infracción ... de [ENTITY]"
  const infraMatch = fullContext.match(
    /infracci[oó]n\s+(?:muy\s+)?grave[s]?\s+(?:de|a)\s+(.+?)(?:\s*\(|$|\.\s)/i,
  );
  if (infraMatch?.[1]) {
    return cleanText(infraMatch[1]).slice(0, 200);
  }

  // Fallback: look for text that is not part of the resolution boilerplate
  // Common pattern: the firm/person name follows the date or BOE reference
  const boeMatch = fullContext.match(
    /BOE\s+(?:de\s+)?\d{1,2}\/\d{1,2}\/\d{4}\)?\.?\s*(.+)/i,
  );
  if (boeMatch?.[1]) {
    const candidate = cleanText(boeMatch[1]).split(/[.;]/)[0] ?? "";
    if (candidate.length > 3) {
      return candidate.slice(0, 200);
    }
  }

  // Last resort: use the link text itself, removing common resolution preamble
  const cleaned = linkText
    .replace(/Resoluci[oó]n\s+de\s+\d+.*?(por\s+la\s+que|,)/i, "")
    .trim();
  if (cleaned.length > 3) {
    return cleaned.slice(0, 200);
  }

  return linkText.slice(0, 200);
}

function classifySanctionType(text: string): string {
  const lower = text.toLowerCase();
  if (lower.includes("multa")) return "multa";
  if (lower.includes("inhabilitaci")) return "inhabilitacion";
  if (lower.includes("amonestaci")) return "amonestacion";
  if (lower.includes("revocaci")) return "revocacion";
  if (lower.includes("resoluci")) return "resolucion";
  if (lower.includes("sanci")) return "sancion";
  return "sancion";
}

function generateSanctionRef(date: string | null, firmName: string): string {
  const datePart = date ? date.replace(/-/g, "") : "00000000";
  const firmSlug = firmName
    .slice(0, 20)
    .replace(/[^a-zA-Z0-9]/g, "")
    .toUpperCase();
  return `CNMV-SAN-${datePart}-${firmSlug}`;
}

// ---------------------------------------------------------------------------
// Scraping: BOE full text for individual circulares
// ---------------------------------------------------------------------------

/**
 * For circulares that link to BOE HTML pages (not PDFs), fetches the full
 * legal text and enriches the provision's text field.
 *
 * Only processes non-PDF URLs to avoid needing a PDF parser.
 */
async function enrichCircularText(
  provisions: ScrapedProvision[],
  circularPageLinks: Map<string, string>,
): Promise<void> {
  let enriched = 0;
  for (const prov of provisions) {
    const boeUrl = circularPageLinks.get(prov.reference);
    if (!boeUrl || boeUrl.endsWith(".pdf")) {
      continue;
    }

    const fullText = await fetchBoeText(boeUrl);
    if (fullText && fullText.length > prov.text.length) {
      prov.text = fullText;
      enriched++;
    }
  }
  if (enriched > 0) {
    log(`  Enriched ${enriched} provisions with full BOE text`);
  }
}

/**
 * Collects BOE/CNMV document URLs from a circulares page,
 * keyed by circular reference (e.g. "Circular 1/2022").
 */
async function collectCircularLinks(slug: string): Promise<Map<string, string>> {
  const url = `${BASE_URL}/portal/legislacion/${slug}?lang=es`;
  const html = await rateLimitedFetch(url);
  const $ = cheerio.load(html);
  const links = new Map<string, string>();

  const circularPattern = /Circular\s+(\d+\/\d{4})/i;

  $("a").each((_, el) => {
    const anchor = $(el);
    const href = anchor.attr("href") ?? "";
    if (!href.includes("boe.es") && !href.includes("cnmv.es/DocPortal")) {
      return;
    }

    const parentEl = anchor.closest("p, li, div, td");
    const contextText = parentEl.length > 0 ? parentEl.text().trim() : anchor.text().trim();
    const refMatch = contextText.match(circularPattern);
    if (!refMatch?.[1]) {
      return;
    }

    const reference = `Circular ${refMatch[1]}`;
    if (!links.has(reference)) {
      // Resolve relative URLs
      const fullUrl = href.startsWith("http")
        ? href
        : href.startsWith("/")
          ? `${BASE_URL}${href}`
          : `${BASE_URL}/${href}`;
      links.set(reference, fullUrl);
    }
  });

  return links;
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

function cleanText(raw: string): string {
  return raw
    .replace(/\s+/g, " ")
    .replace(/\n+/g, " ")
    .replace(/\t+/g, " ")
    .trim();
}

const SPANISH_MONTHS: Record<string, string> = {
  enero: "01",
  febrero: "02",
  marzo: "03",
  abril: "04",
  mayo: "05",
  junio: "06",
  julio: "07",
  agosto: "08",
  septiembre: "09",
  octubre: "10",
  noviembre: "11",
  diciembre: "12",
};

/**
 * Parses a Spanish date string like "19 de enero de 2022" into ISO "2022-01-19".
 * Returns null if parsing fails.
 */
function parseSpanishDate(dateStr: string): string | null {
  const match = dateStr.match(/(\d{1,2})\s+de\s+(\w+)\s+de\s+(\d{4})/i);
  if (!match?.[1] || !match[2] || !match[3]) {
    return null;
  }

  const day = match[1].padStart(2, "0");
  const monthName = match[2].toLowerCase();
  const month = SPANISH_MONTHS[monthName];
  const year = match[3];

  if (!month) {
    return null;
  }

  return `${year}-${month}-${day}`;
}

// ---------------------------------------------------------------------------
// Database insertion
// ---------------------------------------------------------------------------

function insertProvisions(
  db: Database.Database,
  provisions: ScrapedProvision[],
  existingRefs: Set<string>,
): number {
  const stmt = db.prepare(`
    INSERT INTO provisions (sourcebook_id, reference, title, text, type, status, effective_date, chapter, section)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let inserted = 0;
  const insertBatch = db.transaction((batch: ScrapedProvision[]) => {
    for (const p of batch) {
      if (resume && existingRefs.has(p.reference)) {
        continue;
      }
      stmt.run(
        p.sourcebook_id,
        p.reference,
        p.title,
        p.text,
        p.type,
        p.status,
        p.effective_date,
        p.chapter,
        p.section,
      );
      inserted++;
    }
  });

  insertBatch(provisions);
  return inserted;
}

function insertEnforcements(
  db: Database.Database,
  enforcements: ScrapedEnforcement[],
  existingRefs: Set<string>,
): number {
  const stmt = db.prepare(`
    INSERT INTO enforcement_actions (firm_name, reference_number, action_type, amount, date, summary, sourcebook_references)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  let inserted = 0;
  const insertBatch = db.transaction((batch: ScrapedEnforcement[]) => {
    for (const e of batch) {
      if (resume && e.reference_number && existingRefs.has(e.reference_number)) {
        continue;
      }
      stmt.run(
        e.firm_name,
        e.reference_number,
        e.action_type,
        e.amount,
        e.date,
        e.summary,
        e.sourcebook_references,
      );
      inserted++;
    }
  });

  insertBatch(enforcements);
  return inserted;
}

// ---------------------------------------------------------------------------
// Main pipeline
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  log("CNMV Ingestion Crawler starting");
  log(`  DB path:  ${DB_PATH}`);
  log(`  Dry run:  ${dryRun}`);
  log(`  Resume:   ${resume}`);
  log(`  Force:    ${force}`);
  log("");

  // --- Phase 0: Initialise database ----------------------------------------
  let db: Database.Database | null = null;
  let existingProvisionRefs = new Set<string>();
  let existingEnforcementRefs = new Set<string>();

  if (!dryRun) {
    db = initDb();
    seedSourcebooks(db);

    if (resume) {
      existingProvisionRefs = loadExistingReferences(db);
      existingEnforcementRefs = loadExistingEnforcementRefs(db);
      log(`Resume mode: ${existingProvisionRefs.size} existing provisions, ${existingEnforcementRefs.size} existing enforcements`);
    }
  } else {
    log("Dry-run mode — no database writes");
  }

  const allProvisions: ScrapedProvision[] = [];
  const allEnforcements: ScrapedEnforcement[] = [];

  // --- Phase 1: Scrape CNMV Circulares -------------------------------------
  log("");
  log("=== Phase 1: CNMV Circulares ===");

  for (const slug of CIRCULAR_PAGES) {
    try {
      const provisions = await scrapeCircularPage(slug);
      allProvisions.push(...provisions);

      // Attempt to enrich with full BOE text for non-PDF links
      try {
        const links = await collectCircularLinks(slug);
        await enrichCircularText(provisions, links);
      } catch (err) {
        warn(`Could not enrich circular text for ${slug}: ${err instanceof Error ? err.message : String(err)}`);
      }
    } catch (err) {
      error(`Failed to scrape ${slug}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  log(`Total circulares scraped: ${allProvisions.filter((p) => p.sourcebook_id === "CNMV_CIRCULARES").length}`);

  // --- Phase 2: Scrape CNMV Guias Tecnicas ---------------------------------
  log("");
  log("=== Phase 2: CNMV Guias Tecnicas ===");

  try {
    const guias = await scrapeGuiasTecnicas();
    allProvisions.push(...guias);
    log(`Total guias tecnicas scraped: ${guias.length}`);
  } catch (err) {
    error(`Failed to scrape guias tecnicas: ${err instanceof Error ? err.message : String(err)}`);
  }

  // --- Phase 3: Scrape CNMV Sanctions Registry -----------------------------
  log("");
  log("=== Phase 3: CNMV Sanctions ===");

  try {
    const sanctions = await scrapeSanctions();
    allEnforcements.push(...sanctions);
    log(`Total enforcement actions scraped: ${sanctions.length}`);
  } catch (err) {
    error(`Failed to scrape sanctions: ${err instanceof Error ? err.message : String(err)}`);
  }

  // --- Phase 4: Insert into database ---------------------------------------
  log("");
  log("=== Phase 4: Database insertion ===");

  if (dryRun) {
    log(`Dry run — would insert ${allProvisions.length} provisions and ${allEnforcements.length} enforcement actions`);
    log("");
    log("Sample provisions:");
    for (const p of allProvisions.slice(0, 5)) {
      log(`  ${p.reference} | ${p.sourcebook_id} | ${p.type} | ${(p.text ?? "").slice(0, 80)}...`);
    }
    log("");
    log("Sample enforcements:");
    for (const e of allEnforcements.slice(0, 5)) {
      log(`  ${e.firm_name} | ${e.action_type} | ${e.date} | ${(e.summary ?? "").slice(0, 80)}...`);
    }
  } else if (db) {
    const provInserted = insertProvisions(db, allProvisions, existingProvisionRefs);
    const enfInserted = insertEnforcements(db, allEnforcements, existingEnforcementRefs);

    log(`Inserted ${provInserted} provisions (${allProvisions.length - provInserted} skipped)`);
    log(`Inserted ${enfInserted} enforcement actions (${allEnforcements.length - enfInserted} skipped)`);

    // --- Summary -----------------------------------------------------------
    log("");
    log("=== Database summary ===");

    const provCount = (
      db.prepare("SELECT count(*) as cnt FROM provisions").get() as { cnt: number }
    ).cnt;
    const sbCount = (
      db.prepare("SELECT count(*) as cnt FROM sourcebooks").get() as { cnt: number }
    ).cnt;
    const enfCount = (
      db.prepare("SELECT count(*) as cnt FROM enforcement_actions").get() as { cnt: number }
    ).cnt;
    const ftsCount = (
      db.prepare("SELECT count(*) as cnt FROM provisions_fts").get() as { cnt: number }
    ).cnt;

    log(`  Sourcebooks:          ${sbCount}`);
    log(`  Provisions:           ${provCount}`);
    log(`  Enforcement actions:  ${enfCount}`);
    log(`  FTS entries:          ${ftsCount}`);

    db.close();
    log(`Database closed: ${DB_PATH}`);
  }

  log("");
  log("CNMV ingestion complete");
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

main().catch((err) => {
  error(`Fatal: ${err instanceof Error ? err.message : String(err)}`);
  if (err instanceof Error && err.stack) {
    console.error(err.stack);
  }
  process.exit(1);
});

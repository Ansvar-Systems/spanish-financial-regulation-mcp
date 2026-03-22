/**
 * Seed the CNMV/BdE database with sample provisions for testing.
 *
 * Inserts representative circulares and guias tecnicas from CNMV and
 * Banco de Espana so MCP tools can be tested without a full ingestion run.
 *
 * Usage:
 *   npx tsx scripts/seed-sample.ts
 *   npx tsx scripts/seed-sample.ts --force   # drop and recreate
 */

import Database from "better-sqlite3";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { SCHEMA_SQL } from "../src/db.js";

const DB_PATH = process.env["CNMV_DB_PATH"] ?? "data/cnmv.db";
const force = process.argv.includes("--force");

// -- Bootstrap database -------------------------------------------------------

const dir = dirname(DB_PATH);
if (!existsSync(dir)) {
  mkdirSync(dir, { recursive: true });
}

if (force && existsSync(DB_PATH)) {
  unlinkSync(DB_PATH);
  console.log(`Deleted existing database at ${DB_PATH}`);
}

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(SCHEMA_SQL);

console.log(`Database initialised at ${DB_PATH}`);

// -- Sourcebooks --------------------------------------------------------------

interface SourcebookRow {
  id: string;
  name: string;
  description: string;
}

const sourcebooks: SourcebookRow[] = [
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

const insertSourcebook = db.prepare(
  "INSERT OR IGNORE INTO sourcebooks (id, name, description) VALUES (?, ?, ?)",
);

for (const sb of sourcebooks) {
  insertSourcebook.run(sb.id, sb.name, sb.description);
}

console.log(`Inserted ${sourcebooks.length} sourcebooks`);

// -- Sample provisions --------------------------------------------------------

interface ProvisionRow {
  sourcebook_id: string;
  reference: string;
  title: string;
  text: string;
  type: string;
  status: string;
  effective_date: string;
  chapter: string;
  section: string;
}

const provisions: ProvisionRow[] = [
  // -- CNMV Circular 1/2022 -- Obligaciones de informacion -------------------
  {
    sourcebook_id: "CNMV_CIRCULARES",
    reference: "Circular 1/2022",
    title: "Circular 1/2022, de 19 de enero, de la CNMV, sobre obligaciones de informacion de los emisores con valores admitidos a negociacion en mercados regulados",
    text: "La presente Circular tiene por objeto desarrollar las obligaciones de informacion periodica y continuada de los emisores cuyos valores esten admitidos a negociacion en mercados regulados domiciliados en Espana, en aplicacion del Reglamento (UE) 2017/1129 del Parlamento Europeo y del Consejo y del texto refundido de la Ley del Mercado de Valores. Los emisores deberan publicar un informe financiero anual auditado dentro de los cuatro meses siguientes al cierre del ejercicio, un informe financiero semestral dentro de los tres meses siguientes al final del primer semestre del ejercicio, y deberan comunicar informacion privilegiada de forma inmediata.",
    type: "circular",
    status: "en_vigor",
    effective_date: "2022-02-09",
    chapter: "1",
    section: "Capitulo I",
  },
  {
    sourcebook_id: "CNMV_CIRCULARES",
    reference: "Circular 1/2022 Art. 3",
    title: "Circular 1/2022 -- Articulo 3. Contenido del informe financiero anual",
    text: "El informe financiero anual de los emisores incluira: a) Los estados financieros anuales auditados; b) El informe de gestion; c) Las declaraciones de responsabilidad de los miembros del organo de administracion; d) El informe de auditoria. Para los emisores que formulen cuentas consolidadas, el informe financiero anual incluira ademas los estados financieros consolidados auditados de conformidad con las Normas Internacionales de Informacion Financiera adoptadas por la Union Europea.",
    type: "articulo",
    status: "en_vigor",
    effective_date: "2022-02-09",
    chapter: "1",
    section: "Capitulo II",
  },

  // -- CNMV Circular 3/2013 -- Fondos de inversion alternativos ---------------
  {
    sourcebook_id: "CNMV_CIRCULARES",
    reference: "Circular 3/2013",
    title: "Circular 3/2013, de 12 de junio, de la CNMV, sobre el reglamento interno de conducta en materias relativas al mercado de valores y registro de operaciones",
    text: "Esta Circular desarrolla las obligaciones de las entidades sujetas a supervision de la CNMV en materia de reglamento interno de conducta. Las entidades deben adoptar un reglamento interno de conducta que regule las pautas de actuacion de sus empleados y directivos en relacion con los mercados de valores, prevenga los conflictos de interes, y establezca procedimientos para la gestion de informacion privilegiada y lista de personas con acceso a informacion privilegiada.",
    type: "circular",
    status: "en_vigor",
    effective_date: "2013-07-15",
    chapter: "1",
    section: "Capitulo I",
  },
  {
    sourcebook_id: "CNMV_CIRCULARES",
    reference: "Circular 3/2013 Art. 4",
    title: "Circular 3/2013 -- Articulo 4. Contenido minimo del reglamento interno de conducta",
    text: "El reglamento interno de conducta de las entidades sujetas a supervision de la CNMV debera contener, al menos: a) Normas de conducta aplicables a las personas sujetas al reglamento; b) Reglas para la prevencion y gestion de conflictos de interes; c) Procedimientos para la identificacion y tratamiento de informacion privilegiada; d) Normas sobre operaciones personales de los empleados; e) Mecanismos para la deteccion y comunicacion de posibles infracciones. La entidad designara un responsable del cumplimiento del reglamento con acceso directo al organo de administracion.",
    type: "articulo",
    status: "en_vigor",
    effective_date: "2013-07-15",
    chapter: "1",
    section: "Capitulo II",
  },

  // -- CNMV Guia Tecnica sobre resiliencia cibernetica ------------------------
  {
    sourcebook_id: "CNMV_GUIAS_TECNICAS",
    reference: "Guia Tecnica Ciberseguridad 1/2021",
    title: "Guia tecnica de la CNMV sobre resiliencia cibernetica de las infraestructuras de mercado",
    text: "Esta guia tecnica establece los criterios que la CNMV aplicara en la supervision de la resiliencia cibernetica de las infraestructuras de mercado sometidas a su supervision, en consonancia con los requisitos del Reglamento DORA (Digital Operational Resilience Act). Las entidades supervisadas deben implementar: marcos de gestion del riesgo TIC, procedimientos de notificacion de incidentes de seguridad relevantes dentro de las 4 horas posteriores al incidente, estrategias de continuidad de negocio, y pruebas de penetracion avanzadas (TLPT) al menos cada tres anos. La guia desarrolla los criterios para la clasificacion de incidentes por impacto, los requisitos de pruebas de resiliencia operativa digital, y los estandares minimos de seguridad para proveedores TIC criticos.",
    type: "guia_tecnica",
    status: "en_vigor",
    effective_date: "2021-11-01",
    chapter: "1",
    section: "Seccion I",
  },

  // -- BdE Circular 2/2016 -- Informacion supervisora -------------------------
  {
    sourcebook_id: "BDE_CIRCULARES",
    reference: "BdE Circular 2/2016",
    title: "Circular 2/2016, de 2 de febrero, del Banco de Espana, a las entidades de credito, sobre supervision e informacion de las operaciones de riesgo de credito y activos dudosos",
    text: "Esta Circular desarrolla los criterios que deben seguir las entidades de credito en la clasificacion y cobertura de operaciones de riesgo de credito, en especial las operaciones refinanciadas y reestructuradas, y en la declaracion de informacion supervisora al Banco de Espana. Las entidades clasificaran las operaciones como normales, en seguimiento especial, dudosas o fallidas, conforme a criterios objetivos y subjetivos. Las operaciones en seguimiento especial requieren un seguimiento reforzado por presentar debilidades que requieren atencion especial aunque sin que la entidad considere que existan dudas razonables sobre su reembolso total.",
    type: "circular",
    status: "en_vigor",
    effective_date: "2016-03-01",
    chapter: "1",
    section: "Capitulo I",
  },
  {
    sourcebook_id: "BDE_CIRCULARES",
    reference: "BdE Circular 2/2016 Norma 3",
    title: "BdE Circular 2/2016 -- Norma 3. Clasificacion del riesgo de credito por razon de la morosidad del titular",
    text: "Las entidades clasificaran en la categoria de riesgo dudoso por razon de la morosidad del titular las operaciones que tengan importes vencidos con una antiguedad superior a 90 dias, salvo que proceda clasificarlas como fallidas. Esta clasificacion se aplicara a todas las operaciones del titular cuando los importes clasificados como dudosos por razon de morosidad superen el 20 por ciento de los importes pendientes de cobro de las operaciones del titular. Las entidades podran clasificar una operacion como riesgo normal en vigilancia especial cuando la situacion del titular o de las condiciones de la operacion asi lo aconseje.",
    type: "norma",
    status: "en_vigor",
    effective_date: "2016-03-01",
    chapter: "1",
    section: "Capitulo II",
  },

  // -- BdE Circular 4/2017 -- Entidades de credito ---------------------------
  {
    sourcebook_id: "BDE_CIRCULARES",
    reference: "BdE Circular 4/2017",
    title: "Circular 4/2017, de 27 de noviembre, del Banco de Espana, a entidades de credito, sobre normas de informacion financiera publica y reservada, y modelos de estados financieros",
    text: "Esta Circular establece las normas de informacion financiera que deben seguir las entidades de credito en la elaboracion de sus cuentas anuales individuales y consolidadas, adaptando el marco contable espanol a las Normas Internacionales de Informacion Financiera (NIIF), y en particular a la NIIF 9 sobre instrumentos financieros. La Circular desarrolla los criterios para la clasificacion y valoracion de activos financieros, el reconocimiento y medicion de las perdidas por deterioro de valor mediante un modelo de perdida esperada, y los requisitos de informacion a revelar en los estados financieros.",
    type: "circular",
    status: "en_vigor",
    effective_date: "2018-01-01",
    chapter: "1",
    section: "Capitulo I",
  },
  {
    sourcebook_id: "BDE_CIRCULARES",
    reference: "BdE Circular 4/2017 Norma 29",
    title: "BdE Circular 4/2017 -- Norma 29. Deterioro del valor de los activos financieros",
    text: "Las entidades reconoceran una correccion de valor por perdidas para los activos financieros valorados al coste amortizado y los valorados a valor razonable con cambios en otro resultado global. La estimacion de las perdidas por riesgo de credito esperadas se realizara de forma que refleje una estimacion imparcial y ponderada en funcion de la probabilidad de las posibles resultados, el valor temporal del dinero, y la informacion razonable y sustentada disponible sobre sucesos pasados, condiciones actuales y previsiones de condiciones economicas futuras.",
    type: "norma",
    status: "en_vigor",
    effective_date: "2018-01-01",
    chapter: "2",
    section: "Seccion 3",
  },
];

const insertProvision = db.prepare(`
  INSERT INTO provisions (sourcebook_id, reference, title, text, type, status, effective_date, chapter, section)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertAll = db.transaction(() => {
  for (const p of provisions) {
    insertProvision.run(
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
  }
});

insertAll();

console.log(`Inserted ${provisions.length} sample provisions`);

// -- Sample enforcement actions -----------------------------------------------

interface EnforcementRow {
  firm_name: string;
  reference_number: string;
  action_type: string;
  amount: number;
  date: string;
  summary: string;
  sourcebook_references: string;
}

const enforcements: EnforcementRow[] = [
  {
    firm_name: "Banco Popular Espanol, S.A.",
    reference_number: "CNMV-SAN-2017-0001",
    action_type: "resolucion",
    amount: 0,
    date: "2017-06-07",
    summary:
      "Resolucion del Consejo de la CNMV y el Banco de Espana en el marco del mecanismo de resolucion bancaria. El Banco Popular fue objeto de resolucion por el Fondo Unico de Resolucion (FUR) al determinarse que era inviable y no existia perspectiva razonable de que medidas alternativas del sector privado pudieran impedir su inviabilidad en un plazo de tiempo razonable. La entidad fue vendida al Banco Santander por un precio simbolico de un euro tras la amortizacion de instrumentos de capital y la conversion de instrumentos de deuda relevantes.",
    sourcebook_references: "Reglamento (UE) 806/2014, Ley 11/2015",
  },
  {
    firm_name: "Bankia, S.A. y accionistas fundadores de la OPS",
    reference_number: "CNMV-EXP-2014-0087",
    action_type: "multa",
    amount: 7_000_000,
    date: "2017-03-24",
    summary:
      "Expediente sancionador de la CNMV relacionado con la oferta publica de suscripcion (OPS) de Bankia de 2011. La CNMV determino que el folleto de la OPS contenia informacion inexacta y enganiosa sobre la situacion financiera de la entidad, en particular respecto a las necesidades de capital y la calidad de los activos inmobiliarios. Se impusieron multas a la entidad y a los administradores responsables de la aprobacion del folleto. El Tribunal Supremo posteriormente ordeno la devolucion de la inversion a los accionistas minoristas.",
    sourcebook_references: "Circular 1/2022, Ley 24/1988 Art. 99",
  },
  {
    firm_name: "Deutsche Bank, S.A.E.",
    reference_number: "BDE-SAN-2019-0023",
    action_type: "multa",
    amount: 3_500_000,
    date: "2019-10-15",
    summary:
      "Sancion impuesta por el Banco de Espana a Deutsche Bank S.A.E. por incumplimiento de los requisitos de informacion de operaciones de credito y deficiencias en los procedimientos de clasificacion de riesgo de credito exigidos por la Circular 2/2016. La entidad no aplico correctamente los criterios de clasificacion de operaciones refinanciadas y reestructuradas, resultando en una subestimacion de las provisiones necesarias.",
    sourcebook_references: "BdE Circular 2/2016 Norma 3, BdE Circular 4/2017 Norma 29",
  },
];

const insertEnforcement = db.prepare(`
  INSERT INTO enforcement_actions (firm_name, reference_number, action_type, amount, date, summary, sourcebook_references)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

const insertEnforcementsAll = db.transaction(() => {
  for (const e of enforcements) {
    insertEnforcement.run(
      e.firm_name,
      e.reference_number,
      e.action_type,
      e.amount,
      e.date,
      e.summary,
      e.sourcebook_references,
    );
  }
});

insertEnforcementsAll();

console.log(`Inserted ${enforcements.length} sample enforcement actions`);

// -- Summary ------------------------------------------------------------------

const provisionCount = (
  db.prepare("SELECT count(*) as cnt FROM provisions").get() as {
    cnt: number;
  }
).cnt;
const sourcebookCount = (
  db.prepare("SELECT count(*) as cnt FROM sourcebooks").get() as {
    cnt: number;
  }
).cnt;
const enforcementCount = (
  db.prepare("SELECT count(*) as cnt FROM enforcement_actions").get() as {
    cnt: number;
  }
).cnt;
const ftsCount = (
  db.prepare("SELECT count(*) as cnt FROM provisions_fts").get() as {
    cnt: number;
  }
).cnt;

console.log(`\nDatabase summary:`);
console.log(`  Sourcebooks:          ${sourcebookCount}`);
console.log(`  Provisions:           ${provisionCount}`);
console.log(`  Enforcement actions:  ${enforcementCount}`);
console.log(`  FTS entries:          ${ftsCount}`);
console.log(`\nDone. Database ready at ${DB_PATH}`);

db.close();

/**
 * Reads for hospital-prices (fleet #3036).
 *
 * The data is the CMS hospital price transparency standard charges files that
 * US hospitals publish under 45 CFR 180, filtered to the CMS 70 shoppable
 * services plus every MS-DRG and loaded into a D1 database the gateway hands
 * this pack as `_d1` (pack-manifest "d1Binding": "HPT_DB"). The ingest, the
 * schema and the refresh are scripts/hospital-prices/ (fleet #3035); column
 * names here must match scripts/hospital-prices/schema.sql. Design of record:
 * docs/hospital-price-transparency-plan.md.
 */

export interface D1Like {
  prepare(sql: string): D1StmtLike;
}
export interface D1StmtLike {
  bind(...values: unknown[]): D1StmtLike;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
}

export const SOURCE = 'CMS hospital price transparency standard charges files, as published by each hospital';

export const LICENCE_NOTE =
  'Hospitals publish these files under a federal transparency mandate (45 CFR 180) for public use, but the files carry no reuse licence. ' +
  'This is a filtered copy of them: only the CMS 70 shoppable services and MS-DRGs are kept.';

export const PRICE_TYPES = {
  gross_charge: 'The hospital\'s list price (chargemaster). Almost nobody pays it; it is NOT what a service costs.',
  discounted_cash: 'The self-pay price for a patient paying without insurance.',
  negotiated: 'What one named payer and plan has agreed to pay this hospital. Only the rows in `negotiated_rates` are negotiated rates; when `dollar_available` is false the hospital published a percentage or a formula instead of a dollar figure, and no dollar figure is invented.',
  deidentified_min_max: 'The lowest and highest negotiated dollar amounts across ALL payers for the service, per the hospital. Not specific to any one payer.',
};

/** The 69 CPT/HCPCS codes of 84 FR 65524 Table 3. Must equal
 *  scripts/hospital-prices/data/cms-70-shoppable.json (a test compares them). */
export const SHOPPABLE_CODES: ReadonlySet<string> = new Set(
  (
    '19120 29826 29881 42820 43235 43239 45378 45380 45385 45391 47562 49505 55700 55866 59400 59510 59610 62322 62323 64483 ' +
    '66821 66984 70450 70553 72110 72148 72193 73721 74177 76700 76805 76830 77065 77066 77067 80048 80053 80055 80061 80069 ' +
    '80076 81000 81001 81002 81003 84153 84154 84443 85025 85027 85610 85730 90832 90834 90837 90846 90847 90853 93000 93452 ' +
    '95810 97110 99203 99204 99205 99243 99244 99385 99386'
  ).split(' '),
);

export const CODE_SCOPE =
  'CMS 70 shoppable services (69 CPT/HCPCS codes, 45 CFR 180.60 / 84 FR 65524 Table 3) plus every MS-DRG. Other codes are not held.';

export class StoreUnavailableError extends Error {
  constructor() {
    super('hospital-prices: the price store is not bound in this runtime (no _d1). These tools only answer through the Pipeworx gateway; a standalone install has no data to read.');
    this.name = 'StoreUnavailableError';
  }
}
export function requireDb(d1: unknown): D1Like {
  if (!d1 || typeof (d1 as D1Like).prepare !== 'function') throw new StoreUnavailableError();
  return d1 as D1Like;
}

export interface CodeSpec {
  code: string;
  codeType: 'MS-DRG' | 'CPT/HCPCS';
  /** code_type values stored for it. */
  storedTypes: string[];
}

export type CodeParse = { ok: true; spec: CodeSpec } | { ok: false; error: string; message: string; hint?: string };

/** Resolve a caller's code + optional type to what the store keys on. */
export function parseCode(codeIn: unknown, typeIn: unknown): CodeParse {
  const raw = String(codeIn ?? '').trim().toUpperCase().replace(/\s+/g, '');
  if (!raw) return { ok: false, error: 'missing_code', message: 'code is required, e.g. "70450" (CPT) or "470" (MS-DRG).' };
  const t = String(typeIn ?? '').trim().toUpperCase().replace(/[\s_]+/g, '-');
  let kind: 'MS-DRG' | 'CPT/HCPCS' | null = null;
  if (t) {
    if (/^(MS-?DRG|DRG|MSDRG)$/.test(t)) kind = 'MS-DRG';
    else if (/^(CPT|CPT-4|CPT4|HCPCS|CPT\/HCPCS)$/.test(t)) kind = 'CPT/HCPCS';
    else {
      return {
        ok: false,
        error: 'unsupported_code_type',
        message: `code_type "${String(typeIn)}" is not held. Held: CPT, HCPCS, MS-DRG.`,
        hint: 'APR-DRG, revenue codes and NDC codes are not kept in this store.',
      };
    }
  } else {
    kind = /^\d{1,3}$/.test(raw) ? 'MS-DRG' : 'CPT/HCPCS';
  }
  if (kind === 'MS-DRG') {
    const m = /^0*(\d{1,3})$/.exec(raw);
    if (!m || m[1] === '') return { ok: false, error: 'invalid_code', message: `"${raw}" is not an MS-DRG number (1-3 digits, e.g. 470).` };
    return { ok: true, spec: { code: m[1], codeType: 'MS-DRG', storedTypes: ['MS-DRG'] } };
  }
  if (!/^[A-Z0-9]{5}$/.test(raw)) return { ok: false, error: 'invalid_code', message: `"${raw}" is not a 5-character CPT/HCPCS code.` };
  if (!SHOPPABLE_CODES.has(raw)) {
    return {
      ok: false,
      error: 'code_not_in_scope',
      message: `CPT/HCPCS ${raw} is not one of the 69 codes this store keeps, so "no prices" here would mean "not collected", not "no hospital publishes it".`,
      hint: `Held: ${CODE_SCOPE} Use medicare_physician_payment / medicare_opps_rate for Medicare's rate for other codes.`,
    };
  }
  return { ok: true, spec: { code: raw, codeType: 'CPT/HCPCS', storedTypes: ['CPT', 'HCPCS', 'CPT/HCPCS'] } };
}

export async function storeMeta(db: D1Like): Promise<Record<string, string>> {
  const r = await db.prepare(`SELECT key, value FROM meta`).all<{ key: string; value: string }>();
  return Object.fromEntries(r.results.map((x) => [x.key, x.value]));
}

export class NotLoadedError extends Error {
  constructor() {
    super('hospital-prices: error hpt_not_loaded -- the price store has no completed load (no data_as_of). Refusing to answer from a store that may be half-loaded.');
    this.name = 'NotLoadedError';
  }
}

export interface HospitalRow {
  ccn: string;
  name: string;
  system: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  lat: number | null;
  lon: number | null;
  status: string;
  status_reason: string | null;
  last_updated_on: string | null;
  rate_rows: number;
}

export const HOSPITAL_COLS = 'ccn,name,system,city,state,zip,lat,lon,status,status_reason,last_updated_on,rate_rows';

/** Caller-facing reason per status; mirrors scripts/hospital-prices/lib/status.mjs. */
export const STATUS_TEXT: Record<string, string> = {
  ok: 'Prices loaded from the hospital\'s own standard charges file.',
  blocked: 'The hospital\'s website refuses our requests (HTTP 403 or a bot challenge). We do not evade blocks, so we hold no prices for it.',
  not_found: 'No cms-hpt.txt could be found on any domain we know for this hospital.',
  invalid_pointer: 'The hospital publishes a cms-hpt.txt but the file it points at could not be retrieved.',
  soft_404: 'The hospital\'s cms-hpt.txt URL answers 200 with a web page rather than the required text file.',
  unsupported_version: 'The hospital\'s file uses a CMS template version this ingest does not parse yet.',
  too_large: 'The hospital\'s file is larger than this ingest downloads (over 5 GB).',
  parse_error: 'The hospital\'s file was retrieved but could not be parsed.',
  no_matching_codes: 'The hospital\'s file parsed, but contained none of the shoppable codes or MS-DRGs this store keeps.',
  not_fetched: 'We found this hospital\'s standard charges file but have not downloaded it yet, so we hold no prices for it.',
};

export function statusReason(h: { status: string; status_reason: string | null }): string {
  return h.status_reason?.trim() || STATUS_TEXT[h.status] || `status ${h.status}`;
}

export function haversineMiles(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 3958.8;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function chunk<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

/** Aggregate of one hospital's rows for a code, per setting. */
export interface AggRow {
  ccn: string;
  setting: string | null;
  n: number;
  n_dollar: number;
  gross_min: number | null;
  gross_max: number | null;
  cash_min: number | null;
  cash_max: number | null;
  min_neg: number | null;
  max_neg: number | null;
  dollar_low: number | null;
  dollar_high: number | null;
  description: string | null;
}

export interface RateRow {
  ccn: string;
  code: string;
  code_type: string;
  description: string | null;
  setting: string | null;
  billing_class: string | null;
  modifiers: string | null;
  payer_name: string | null;
  plan_name: string | null;
  negotiated_dollar: number | null;
  negotiated_percentage: number | null;
  negotiated_algorithm: string | null;
  estimated_amount: number | null;
  methodology: string | null;
  notes: string | null;
  dollar_available: number;
}

const ccnPlaceholders = (n: number) => Array.from({ length: n }, () => '?').join(',');

export async function aggregateForCode(db: D1Like, spec: CodeSpec, ccns: string[]): Promise<AggRow[]> {
  const out: AggRow[] = [];
  const typePh = ccnPlaceholders(spec.storedTypes.length);
  for (const part of chunk(ccns, 60)) {
    const r = await db
      .prepare(
        `SELECT ccn, setting, COUNT(*) AS n, SUM(dollar_available) AS n_dollar,
                MIN(gross) AS gross_min, MAX(gross) AS gross_max, MIN(cash) AS cash_min, MAX(cash) AS cash_max,
                MIN(min_neg) AS min_neg, MAX(max_neg) AS max_neg,
                MIN(CASE WHEN dollar_available = 1 THEN negotiated_dollar END) AS dollar_low,
                MAX(CASE WHEN dollar_available = 1 THEN negotiated_dollar END) AS dollar_high,
                MAX(description) AS description
         FROM rate WHERE code_type IN (${typePh}) AND code = ? AND ccn IN (${ccnPlaceholders(part.length)})
         GROUP BY ccn, setting`,
      )
      .bind(...spec.storedTypes, spec.code, ...part)
      .all<AggRow>();
    out.push(...r.results);
  }
  return out;
}

export interface RateFilter {
  payer?: string;
  plan?: string;
}

export async function ratesForCode(
  db: D1Like,
  spec: CodeSpec,
  ccns: string[],
  filter: RateFilter,
  cap: number,
): Promise<{ rows: RateRow[]; capped: boolean }> {
  const rows: RateRow[] = [];
  const typePh = ccnPlaceholders(spec.storedTypes.length);
  const like = (s: string) => `%${s.toLowerCase().replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
  for (const part of chunk(ccns, 60)) {
    const where = [`code_type IN (${typePh})`, 'code = ?', `ccn IN (${ccnPlaceholders(part.length)})`];
    const binds: unknown[] = [...spec.storedTypes, spec.code, ...part];
    if (filter.payer) {
      where.push(`LOWER(payer_name) LIKE ? ESCAPE '\\'`);
      binds.push(like(filter.payer));
    }
    if (filter.plan) {
      where.push(`LOWER(plan_name) LIKE ? ESCAPE '\\'`);
      binds.push(like(filter.plan));
    }
    const left = cap - rows.length + 1;
    if (left <= 0) break;
    const r = await db
      .prepare(
        `SELECT ccn, code, code_type, description, setting, billing_class, modifiers, payer_name, plan_name,
                negotiated_dollar, negotiated_percentage, negotiated_algorithm, estimated_amount, methodology, notes, dollar_available
         FROM rate WHERE ${where.join(' AND ')}
         ORDER BY ccn, setting, payer_name, plan_name LIMIT ${left}`,
      )
      .bind(...binds)
      .all<RateRow>();
    rows.push(...r.results);
  }
  const capped = rows.length > cap;
  return { rows: capped ? rows.slice(0, cap) : rows, capped };
}

/** Payer names a hospital lists for a code, for the "payer not listed" answer. */
export async function payersFor(db: D1Like, spec: CodeSpec, ccn: string, limit: number): Promise<string[]> {
  const typePh = ccnPlaceholders(spec.storedTypes.length);
  const r = await db
    .prepare(
      `SELECT DISTINCT payer_name FROM rate WHERE code_type IN (${typePh}) AND code = ? AND ccn = ? AND payer_name IS NOT NULL ORDER BY payer_name LIMIT ${limit}`,
    )
    .bind(...spec.storedTypes, spec.code, ccn)
    .all<{ payer_name: string }>();
  return r.results.map((x) => x.payer_name);
}

export async function hospitalsByCcn(db: D1Like, ccns: string[]): Promise<HospitalRow[]> {
  const out: HospitalRow[] = [];
  for (const part of chunk(ccns, 80)) {
    const r = await db
      .prepare(`SELECT ${HOSPITAL_COLS} FROM hospital WHERE ccn IN (${ccnPlaceholders(part.length)})`)
      .bind(...part)
      .all<HospitalRow>();
    out.push(...r.results);
  }
  return out;
}

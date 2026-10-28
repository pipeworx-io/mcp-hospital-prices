interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}${responseHints(res)}`,
    res.url,
    res.status,
  );
}

/**
 * Facts about a FAILED response that live in its headers, not its body, appended
 * so the gateway's classifier (which only ever sees this string) can tell a limit
 * from a wall from a refusal (fleet #3477). Both are standard, both are absent on
 * almost every response, and neither is invented: `Retry-After` is the server
 * saying "come back later" (the one thing that makes a 403 a throttle), and
 * Cloudflare marks a bot challenge with `cf-mitigated: challenge`.
 */
function responseHints(res: Response): string {
  const hints: string[] = [];
  const retryAfter = res.headers.get('retry-after');
  if (retryAfter) hints.push(`retry-after: ${retryAfter.slice(0, 40)}`);
  if ((res.headers.get('cf-mitigated') ?? '').toLowerCase() === 'challenge') hints.push('Cloudflare bot challenge (cf-mitigated: challenge)');
  return hints.length ? ` (${hints.join('; ')})` : '';
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    // Fleet #2382. Everything that isn't a timeout/abort here is a genuine
    // NETWORK-LEVEL failure — DNS resolution, connection refused, TLS handshake,
    // Cloudflare's own "Network connection lost." — meaning `fetch()` itself
    // threw and no HTTP response of any kind was ever received. Until this fix
    // that raw exception was rethrown VERBATIM: a bare `TypeError: fetch failed`
    // (or the Workers-runtime equivalent) names no upstream, carries no class
    // token, and reads exactly like a defect in OUR code — because it says
    // nothing about the call at all. It landed in `error`, the tier that means
    // "Pipeworx has a defect", for every one of the (at the time of writing)
    // ~470 packs that call this helper directly with no wrapper of their own.
    //
    // `dexscreener` hit this independently (fleet #1579) and fixed it with a
    // bespoke per-pack try/catch around `fetchWithTimeout`. That fix is correct
    // but only covers one pack; every other caller of this shared helper still
    // leaked the raw exception. Moving the same fix HERE — the one place that
    // already carries the timeout case — covers every pack that uses
    // `fetchWithTimeout` without a wrapper, for free, and without widening
    // `classifyToolError`'s regex list: the fix is giving the message a proper
    // `upstream_down:` token at the point the two facts (no response was ever
    // received, and which host we were trying to reach) are actually in hand,
    // not teaching the classifier to guess from prose after the fact.
    //
    // Safe on the same grounds as the timeout branch above: no argument a
    // caller passes can make `fetch()` itself throw a connection-level error,
    // so this is always an availability failure, never a caller mistake. Same
    // `markInternalOrigin` treatment — an origin we run that never answered is
    // still ours, not a third party's outage.
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(
      markInternalOrigin(
        `upstream_down: could not reach ${name} at all (${raw.slice(0, 160)}). ` +
          `No request reached ${name}, so this says NOTHING about whether the arguments you passed ` +
          'are valid — do not re-check them on the strength of this error. Retry shortly.',
        url,
      ),
    );
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

// ── Bounded readers — peak memory, not just wall time (fleet #3322) ──────
//
// `parseJson` above does `await res.text()` then `JSON.parse(raw)`, so a
// multi-megabyte upstream body is held TWICE at peak: once as the raw string
// and once as the object graph (which for an array of small objects runs
// several times the byte size). Nothing in `workers/gateway` can see that
// peak — it happens inside the pack, before any gateway code holds a payload —
// which is why the gateway-side payload caps of #3293 and #3320 did not move
// the 503/1102 rate at all.
//
// Measured on the live gateway, 2026-10-19, sha fa5de5c34, direct tools/call:
//   statcan_list_cubes  8,049,566 B   <- one upstream array, no limit argument
//   gnomad_gene BRCA1   2,732,706 B
// Five of those in flight at the quality runner's width is ~40 MB of parse
// peak against a 128 MB isolate; Cloudflare kills the isolate and every
// request in flight returns 503/1102, which is why the victims look random.
//
// `readJsonArrayPrefix` is the fix for the dominant shape: an upstream that
// returns one enormous top-level JSON array with no server-side paging. It
// parses elements off the stream and DISCARDS the consumed bytes, so peak
// retained memory is one element plus one chunk rather than the whole body,
// and it cancels the body as soon as it has what it was asked for.

/** Default ceiling for a single upstream JSON body read into an isolate.
 *  Chosen so the known tail (statcan 8.0 MB, gnomad 2.7 MB) is bounded well
 *  below the point where a handful of concurrent reads exhausts 128 MB. */
const DEFAULT_MAX_JSON_BYTES = 1_500_000;

interface JsonArrayPrefix<T> {
  /** The decoded elements, at most `maxItems` of them. */
  items: T[];
  /** True when the upstream array had more elements than we read. */
  truncated: boolean;
  /** Bytes actually pulled off the socket — the number that bounds memory. */
  bytesRead: number;
  /** `Content-Length` if the upstream declared one, else null. */
  declaredBytes: number | null;
}

/**
 * Read the FIRST `maxItems` elements of a top-level JSON array off a response
 * stream without ever materialising the whole body.
 *
 * Use this instead of `parseJson` when the upstream returns one big array and
 * offers no `limit`/`offset` of its own. Peak retained memory is one element
 * plus the current chunk; the body is cancelled as soon as `maxItems` is
 * reached, so the remaining megabytes are never transferred at all.
 *
 *     const { items, truncated } = await readJsonArrayPrefix<Cube>(
 *       res, 'StatCan WDS', { maxItems: limit + offset });
 *
 * `maxBytes` is a second, independent backstop for a pathological element (a
 * single 50 MB object): hitting it stops the read and sets `truncated`, rather
 * than throwing, because a partial answer plus an explicit truncated flag is
 * more useful to a caller than an error.
 */
async function readJsonArrayPrefix<T>(
  res: Response,
  name: string,
  opts: { maxItems: number; maxBytes?: number },
): Promise<JsonArrayPrefix<T>> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_JSON_BYTES;
  const declaredRaw = Number(res.headers.get('content-length'));
  const declaredBytes = Number.isFinite(declaredRaw) && declaredRaw > 0 ? declaredRaw : null;

  // No streaming body available (a mock, or an already-buffered response):
  // fall back to the whole-text path so behaviour stays correct, just unbounded.
  if (!res.body) {
    const all = await parseJson<T[]>(res, name);
    if (!Array.isArray(all)) throw new Error(`upstream_down: ${name} returned ${typeof all} where a JSON array was expected.`);
    return {
      items: all.slice(0, opts.maxItems),
      truncated: all.length > opts.maxItems,
      bytesRead: declaredBytes ?? 0,
      declaredBytes,
    };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const items: T[] = [];

  let buf = '';
  let scan = 0;
  let bytesRead = 0;
  let started = false; // consumed the opening '['
  let arrayEnded = false;
  let depth = 0;
  let inStr = false;
  let esc = false;
  let elemStart = -1;
  let truncated = false;

  const push = (text: string) => {
    const t = text.trim();
    if (!t) return;
    items.push(JSON.parse(t) as T);
  };

  try {
    outer: while (items.length < opts.maxItems && !arrayEnded) {
      const { value, done } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      buf += decoder.decode(value, { stream: true });
      if (bytesRead > maxBytes) { truncated = true; break; }

      for (; scan < buf.length; scan++) {
        const ch = buf[scan];

        if (inStr) {
          if (esc) { esc = false; continue; }
          if (ch === '\\') { esc = true; continue; }
          if (ch === '"') inStr = false;
          continue;
        }

        if (!started) {
          if (ch === '[') { started = true; continue; }
          if (ch.trim() === '') continue;
          throw new Error(
            `upstream_down: ${name} returned a body that does not begin with a JSON array (saw ${JSON.stringify(ch)}). ` +
              'This reader is only for upstreams that answer with one top-level array.',
          );
        }

        if (ch === '"') { if (depth === 0 && elemStart < 0) elemStart = scan; inStr = true; continue; }

        if (ch === '{' || ch === '[') {
          if (depth === 0 && elemStart < 0) elemStart = scan;
          depth++;
          continue;
        }

        if (ch === '}' || ch === ']') {
          if (depth > 0) {
            depth--;
            if (depth === 0 && elemStart >= 0) {
              push(buf.slice(elemStart, scan + 1));
              elemStart = -1;
              if (items.length >= opts.maxItems) { truncated = true; scan++; break outer; }
            }
            continue;
          }
          // depth 0 and a closing bracket: the end of the top-level array.
          if (elemStart >= 0) { push(buf.slice(elemStart, scan)); elemStart = -1; }
          arrayEnded = true;
          break outer;
        }

        if (ch === ',' && depth === 0) {
          if (elemStart >= 0) {
            push(buf.slice(elemStart, scan));
            elemStart = -1;
            if (items.length >= opts.maxItems) { truncated = true; scan++; break outer; }
          }
          continue;
        }

        // A bare scalar element (number / true / false / null).
        if (depth === 0 && elemStart < 0 && ch.trim() !== '') elemStart = scan;
      }

      // Drop everything already consumed. THIS is what bounds memory: without
      // it `buf` grows to the full body and the reader is streaming in name only.
      if (elemStart >= 0) {
        buf = buf.slice(elemStart);
        scan -= elemStart;
        elemStart = 0;
      } else {
        buf = buf.slice(scan);
        scan = 0;
      }
    }
  } finally {
    // Cancel rather than drain: the point is that the remaining megabytes are
    // never transferred. A cancel on an already-finished body is a no-op.
    await reader.cancel().catch(() => {});
  }

  return { items, truncated, bytesRead, declaredBytes };
}

/**
 * `parseJson`, with a hard ceiling on how many bytes are read.
 *
 * For an upstream whose body is not a single array (so `readJsonArrayPrefix`
 * does not apply) but which can still answer with megabytes. Unlike the array
 * reader this one THROWS when the cap is hit, because a truncated prefix of an
 * arbitrary JSON document is not parseable and there is no partial answer to
 * hand back. A declared `Content-Length` over the cap is refused before a
 * single chunk is read.
 */
async function parseJsonBounded<T>(
  res: Response,
  name: string,
  maxBytes: number = DEFAULT_MAX_JSON_BYTES,
): Promise<T> {
  const declaredRaw = Number(res.headers.get('content-length'));
  const declared = Number.isFinite(declaredRaw) && declaredRaw > 0 ? declaredRaw : null;

  const tooBig = (n: number) =>
    new Error(
      `upstream_down: ${name} answered with ${n.toLocaleString()} bytes, over this pack's ${maxBytes.toLocaleString()}-byte ceiling. ` +
        'The body is not read past the ceiling on purpose — a few concurrent reads of a body that size exhaust the ' +
        'Worker isolate and take every other in-flight request down with them. Narrow the request (a smaller range, ' +
        'a specific id, or a lower limit) and retry.',
    );

  if (declared !== null && declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw tooBig(declared);
  }
  if (!res.body) return parseJson<T>(res, name);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let raw = '';
  let bytesRead = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > maxBytes) throw tooBig(bytesRead);
      raw += decoder.decode(value, { stream: true });
    }
    raw += decoder.decode();
  } finally {
    await reader.cancel().catch(() => {});
  }

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected. ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON. ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}
/**
 * hospital-prices -- what US hospitals charge for a service: gross charge, self-pay price and payer-negotiated rates near a ZIP, from the standard charges files hospitals publish under the CMS price transparency rule (45 CFR 180).
 *
 * Coverage is NOT national and every response says so: the files are
 * decentralised, one per hospital, and the store holds only the hospitals whose
 * file could be reached honestly (hospitals that refuse our requests are
 * reported as such, never worked around), and only the CMS 70 shoppable
 * services plus MS-DRGs. A lookup therefore distinguishes four different
 * answers that an empty list would collapse into one:
 *   - no hospital in range            (`no_hospital_in_range`)
 *   - hospital in range, no prices held for it, and WHY (`not_held`)
 *   - hospital held, but it published no row for the code (`code_absent`)
 *   - code present, but not for the payer/plan/setting asked (`payer_not_listed`)
 * Gross charge, self-pay cash price and negotiated rate are always labelled as
 * what they are; a negotiated rate the hospital published without a dollar
 * figure carries `dollar_available: false` and its own text, never a number.
 *
 * Reuse basis: hospitals publish these files under a federal mandate for
 * public use; the files carry no reuse licence. This is a filtered copy, built
 * and flagged under Bruce's 2026-09-23 build-the-copy ruling. See README.
 */
import {
  type AggRow,
  type CodeSpec,
  type D1Like,
  type HospitalRow,
  type RateRow,
  CODE_SCOPE,
  HOSPITAL_COLS,
  LICENCE_NOTE,
  NotLoadedError,
  PRICE_TYPES,
  SOURCE,
  aggregateForCode,
  haversineMiles,
  hospitalsByCcn,
  parseCode,
  payersFor,
  ratesForCode,
  requireDb,
  statusReason,
  storeMeta,
} from './store.js';

const UA = 'pipeworx-mcp-hospital-prices/1.0 (+https://pipeworx.io)';

const CODE_PROPS = {
  code: { type: 'string', description: 'The service code: a CPT/HCPCS code from the CMS 70 shoppable services (e.g. "70450" head CT, "45378" colonoscopy, "99213"-style E&M codes only where on that list) or an MS-DRG number (e.g. "470" major joint replacement).' },
  code_type: { type: 'string', enum: ['CPT', 'HCPCS', 'MS-DRG'], description: 'Optional. Inferred when omitted: 1-3 digits is an MS-DRG, a 5-character code is CPT/HCPCS.' },
} as const;

const tools: McpToolExport['tools'] = [
  {
    name: 'hospital_price_search',
    description:
      'What hospitals near a US ZIP charge for one service, from the standard charges files each hospital publishes under the CMS price transparency rule. Per hospital: gross charge (list price, not what anyone pays), self-pay discounted cash price, the de-identified min/max negotiated amounts, and a summary of payer-specific negotiated dollar rates; pass payer and/or plan to get that payer\'s negotiated rate rows. Each rate carries dollar_available: when a hospital published a percentage or formula instead of a dollar amount it says so and gives the hospital\'s own text rather than a number. COVERAGE IS PARTIAL AND STATED (the store is loaded state by state; each response lists the states loaded): every response says how many hospitals in range have prices loaded, why others do not (the hospital\'s site blocks us, no file found, ...), and distinguishes "no hospital in range", "hospital held but code absent" and "code present but payer not listed". Holds only the CMS 70 shoppable CPT/HCPCS services and MS-DRGs. Use for "what does a head CT cost near 02139", "MS-DRG 470 near 10016 for Aetna".',
    summary: 'Hospital prices for a CPT/HCPCS or MS-DRG code near a ZIP: gross, cash, negotiated by payer, with explicit coverage and absence reasons.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        ...CODE_PROPS,
        near: { type: 'string', description: 'A 5-digit US ZIP ("10016") or "lat,lon" ("40.7459,-73.9780").' },
        radius_mi: { type: 'number', description: 'Search radius in miles (1-150, default 25). Straight-line, from ZIP centroid to the hospital\'s ZIP centroid.' },
        payer: { type: 'string', description: 'Case-insensitive substring of the payer name (e.g. "aetna", "blue cross"). Returns that payer\'s negotiated rows.' },
        plan: { type: 'string', description: 'Case-insensitive substring of the plan name (e.g. "ppo", "medicare advantage").' },
        setting: { type: 'string', enum: ['inpatient', 'outpatient'], description: 'Restrict to inpatient or outpatient pricing. Default: both.' },
        limit: { type: 'number', description: 'Hospitals to return (1-50, default 20), nearest first.' },
        rates_per_hospital: { type: 'number', description: 'With payer/plan: negotiated rows per hospital (1-25, default 5).' },
      },
      required: ['code', 'near'],
    },
  },
  {
    name: 'hospital_price_compare',
    description:
      'Side-by-side prices for one service at up to 10 named hospitals (by CMS Certification Number, CCN, from hospital_price_search or hospital_price_coverage). Same fields and same labelling as hospital_price_search: gross charge vs self-pay cash vs payer-negotiated rates, dollar_available on every negotiated rate, and for each hospital that has no price a stated reason (not held and why / code absent / payer not listed). Use for "compare MS-DRG 470 at these three hospitals for Blue Cross".',
    summary: 'Compare one service\'s prices across up to 10 hospitals by CCN, with absence reasons.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        ...CODE_PROPS,
        ccns: { type: 'array', items: { type: 'string' }, description: 'CMS Certification Numbers (6 characters, e.g. "330101"), 1-10.' },
        payer: { type: 'string', description: 'Case-insensitive substring of the payer name.' },
        plan: { type: 'string', description: 'Case-insensitive substring of the plan name.' },
        setting: { type: 'string', enum: ['inpatient', 'outpatient'], description: 'Restrict to inpatient or outpatient pricing.' },
        rates_per_hospital: { type: 'number', description: 'Negotiated rows per hospital (1-25, default 25).' },
      },
      required: ['code', 'ccns'],
    },
  },
  {
    name: 'hospital_price_coverage',
    description:
      'Whether this store holds a hospital\'s prices and, if not, WHY. Look up one hospital by CCN or by name (partial match), or summarise a state, or (no arguments) the whole store, including which states are loaded (the store is loaded state by state, so a hospital in an unloaded state is simply absent). Every hospital in a loaded state has a status: ok (prices held), blocked (its website refuses our requests; we do not evade blocks), not_found (no machine-readable file found), invalid_pointer, soft_404, unsupported_version, too_large, parse_error, no_matching_codes, not_fetched. Use before trusting an empty hospital_price_search, or to answer "does this tool cover Mayo Clinic".',
    summary: 'Is a hospital (by CCN or name), a state, or the whole store covered by hospital price data, and why not if not.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        ccn: { type: 'string', description: 'CMS Certification Number, e.g. "330101".' },
        name: { type: 'string', description: 'Hospital name or part of it, e.g. "Mayo Clinic". Up to 25 matches are returned.' },
        state: { type: 'string', description: 'Two-letter state code, e.g. "MN": counts by status for that state.' },
        status: { type: 'string', description: 'With state: list hospitals having this status (e.g. "blocked").' },
      },
    },
  },
];

function clamp(v: unknown, lo: number, hi: number, dflt: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, Math.floor(n)));
}

const round2 = (n: number | null | undefined) => (n == null ? null : Math.round(n * 100) / 100);

interface Loaded {
  m: Record<string, string>;
  /** States present in the hospital table, with hospitals held / on file. */
  states: Array<{ state: string; hospitals: number; with_prices: number }>;
}

async function loadedMeta(db: D1Like): Promise<Loaded> {
  const m = await storeMeta(db);
  if (!m.data_as_of) throw new NotLoadedError();
  const r = await db
    .prepare(`SELECT state, COUNT(*) AS hospitals, SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) AS with_prices FROM hospital GROUP BY state ORDER BY state`)
    .all<{ state: string | null; hospitals: number; with_prices: number }>();
  const states = r.results.filter((x) => x.state).map((x) => ({ state: x.state as string, hospitals: x.hospitals, with_prices: x.with_prices ?? 0 }));
  return { m, states };
}

/** The store is loaded state by state, so "no hospital here" must never read as "no prices exist". */
function coverageStatement(l: Loaded): Record<string, unknown> {
  const { m, states } = l;
  const held = states.reduce((s, x) => s + x.with_prices, 0);
  const onFile = states.reduce((s, x) => s + x.hospitals, 0);
  const names = states.map((x) => x.state).join(', ') || 'none';
  return {
    scope:
      `Not national. The store currently covers hospitals in: ${names} (${onFile.toLocaleString('en-US')} hospitals on file, ${held.toLocaleString('en-US')} with prices loaded). ` +
      `A search outside those states finds nothing because they are not loaded yet, not because no prices exist. Within them, hospitals without prices are reported with a reason. ${CODE_SCOPE}`,
    states_loaded: states,
    hospitals_with_prices: held,
    hospitals_on_file: onFile,
    code_scope: CODE_SCOPE,
    store_cycle: m.data_as_of,
    store_loaded_at: m.loaded_at ?? null,
  };
}

// ── location ────────────────────────────────────────────────────────────────

interface Centre {
  lat: number;
  lon: number;
  label: string;
  state: string | null;
}

async function resolveCentre(db: D1Like, args: Record<string, unknown>): Promise<Centre | { error: string; message: string; hint?: string }> {
  const near = String(args.near ?? '').trim();
  const latArg = args.lat != null ? Number(args.lat) : NaN;
  const lonArg = args.lon != null ? Number(args.lon) : NaN;
  if (Number.isFinite(latArg) && Number.isFinite(lonArg)) {
    return { lat: latArg, lon: lonArg, label: `${latArg},${lonArg}`, state: null };
  }
  const ll = /^\s*(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$/.exec(near);
  if (ll) return { lat: Number(ll[1]), lon: Number(ll[2]), label: `${ll[1]},${ll[2]}`, state: null };
  const zm = /^(\d{5})(?:-\d{4})?$/.exec(near);
  if (!zm) {
    return { error: 'invalid_near', message: `near must be a 5-digit US ZIP or "lat,lon"; got "${near}".` };
  }
  const zip = zm[1];
  const url = typeof args._supabaseUrl === 'string' ? args._supabaseUrl : '';
  const key = typeof args._supabaseKey === 'string' ? args._supabaseKey : '';
  if (url && key) {
    try {
      const res = await fetchWithTimeout(
        `${url}/rest/v1/us_zip_centroids?zip=eq.${zip}&select=zip,city,state,latitude,longitude&limit=1`,
        { headers: { 'User-Agent': UA, apikey: key, Authorization: `Bearer ${key}` } },
        'ZIP centroid lookup',
        25000,
      );
      if (res.ok) {
        const rows = (await res.json()) as Array<{ city: string | null; state: string | null; latitude: number; longitude: number }>;
        if (rows.length) {
          const r = rows[0];
          return { lat: r.latitude, lon: r.longitude, label: `${zip}${r.city ? ` (${r.city}, ${r.state})` : ''}`, state: r.state };
        }
      }
    } catch {
      // fall through to the hospital-table fallback
    }
  }
  // Fallback: the centroid of held hospitals that share this ZIP.
  const h = await db
    .prepare(`SELECT AVG(lat) AS lat, AVG(lon) AS lon, MAX(state) AS state FROM hospital WHERE zip = ? AND lat IS NOT NULL`)
    .bind(zip)
    .first<{ lat: number | null; lon: number | null; state: string | null }>();
  if (h && h.lat != null && h.lon != null) return { lat: h.lat, lon: h.lon, label: zip, state: h.state };
  return {
    error: 'unknown_zip',
    message: `${zip} is not a US ZIP we hold a centroid for. This is a lookup failure, not "no hospitals nearby".`,
    hint: 'Check the ZIP, or pass near as "lat,lon".',
  };
}

// ── shaping ─────────────────────────────────────────────────────────────────

function settingOk(rowSetting: string | null, want: string | null): boolean {
  if (!want) return true;
  const s = (rowSetting ?? '').toLowerCase();
  return s === want || s === 'both' || s === '';
}

function shapeRate(r: RateRow): Record<string, unknown> {
  const dollar = r.dollar_available === 1 && r.negotiated_dollar != null;
  return {
    rate_type: 'negotiated',
    payer: r.payer_name,
    plan: r.plan_name,
    setting: r.setting,
    billing_class: r.billing_class,
    modifiers: r.modifiers || undefined,
    dollar_available: dollar,
    negotiated_dollar: dollar ? round2(r.negotiated_dollar) : null,
    negotiated_percentage: r.negotiated_percentage ?? null,
    negotiated_methodology: r.methodology ?? null,
    negotiated_algorithm: r.negotiated_algorithm ?? null,
    estimated_allowed_amount: r.estimated_amount ?? null,
    notes: r.notes || undefined,
    ...(dollar
      ? {}
      : {
          why_no_dollar:
            'The hospital published no dollar figure for this payer and plan; the percentage, methodology and algorithm text above is what it published instead. No number has been inferred.',
        }),
  };
}

function settingBlock(a: AggRow): Record<string, unknown> {
  const single = (lo: number | null, hi: number | null) => (lo != null && hi != null && lo === hi ? round2(lo) : null);
  const range = (lo: number | null, hi: number | null) => (lo != null && hi != null && lo !== hi ? [round2(lo), round2(hi)] : undefined);
  return {
    setting: a.setting,
    gross_charge: single(a.gross_min, a.gross_max),
    gross_charge_range: range(a.gross_min, a.gross_max),
    discounted_cash: single(a.cash_min, a.cash_max),
    discounted_cash_range: range(a.cash_min, a.cash_max),
    ...(a.gross_min == null && a.cash_min == null
      ? { gross_cash_note: 'This hospital published no gross charge and no self-pay price for this code in this setting (common for MS-DRG bundles); only negotiated rates are given. Nothing has been inferred.' }
      : {}),
    deidentified_min_negotiated: round2(a.min_neg),
    deidentified_max_negotiated: round2(a.max_neg),
    negotiated_summary: {
      payer_plan_rows_listed: a.n,
      rows_with_dollar_rate: a.n_dollar ?? 0,
      rows_without_dollar_rate: a.n - (a.n_dollar ?? 0),
      dollar_rate_low: round2(a.dollar_low),
      dollar_rate_high: round2(a.dollar_high),
    },
  };
}

type Verdict =
  | { kind: 'priced'; h: HospitalRow; dist: number | null; aggs: AggRow[] }
  | { kind: 'not_held'; h: HospitalRow; dist: number | null }
  | { kind: 'code_absent'; h: HospitalRow; dist: number | null }
  | { kind: 'setting_absent'; h: HospitalRow; dist: number | null; settings: string[] }
  | { kind: 'payer_not_listed'; h: HospitalRow; dist: number | null; aggs: AggRow[] };

function ident(h: HospitalRow, dist: number | null): Record<string, unknown> {
  return {
    ccn: h.ccn,
    name: h.name,
    system: h.system || undefined,
    city: h.city,
    state: h.state,
    zip: h.zip,
    ...(dist != null ? { distance_miles: Math.round(dist * 10) / 10 } : {}),
  };
}

interface Query {
  spec: CodeSpec;
  payer: string;
  plan: string;
  setting: string | null;
}

/** Decide, for each hospital, which of the distinct answers applies. */
async function classify(
  db: D1Like,
  q: Query,
  hospitals: Array<{ h: HospitalRow; dist: number | null }>,
): Promise<{ verdicts: Verdict[]; payerRowsByCcn: Map<string, RateRow[]>; ratesCapped: boolean }> {
  const okCcns = hospitals.filter((x) => x.h.status === 'ok').map((x) => x.h.ccn);
  const aggs = okCcns.length ? await aggregateForCode(db, q.spec, okCcns) : [];
  const aggByCcn = new Map<string, AggRow[]>();
  for (const a of aggs) (aggByCcn.get(a.ccn) ?? aggByCcn.set(a.ccn, []).get(a.ccn)!).push(a);

  const wantRates = Boolean(q.payer || q.plan);
  const withCode = okCcns.filter((c) => (aggByCcn.get(c) ?? []).some((a) => settingOk(a.setting, q.setting)));
  const payerRowsByCcn = new Map<string, RateRow[]>();
  let ratesCapped = false;
  if (wantRates && withCode.length) {
    const { rows, capped } = await ratesForCode(db, q.spec, withCode, { payer: q.payer, plan: q.plan }, 3000);
    ratesCapped = capped;
    for (const r of rows) {
      if (!settingOk(r.setting, q.setting)) continue;
      (payerRowsByCcn.get(r.ccn) ?? payerRowsByCcn.set(r.ccn, []).get(r.ccn)!).push(r);
    }
  }

  const verdicts: Verdict[] = [];
  for (const { h, dist } of hospitals) {
    if (h.status !== 'ok') {
      verdicts.push({ kind: 'not_held', h, dist });
      continue;
    }
    const mine = aggByCcn.get(h.ccn) ?? [];
    if (!mine.length) {
      verdicts.push({ kind: 'code_absent', h, dist });
      continue;
    }
    const inSetting = mine.filter((a) => settingOk(a.setting, q.setting));
    if (!inSetting.length) {
      verdicts.push({ kind: 'setting_absent', h, dist, settings: [...new Set(mine.map((a) => a.setting ?? 'unspecified'))] });
      continue;
    }
    if (wantRates && !(payerRowsByCcn.get(h.ccn)?.length)) {
      verdicts.push({ kind: 'payer_not_listed', h, dist, aggs: inSetting });
      continue;
    }
    verdicts.push({ kind: 'priced', h, dist, aggs: inSetting });
  }
  return { verdicts, payerRowsByCcn, ratesCapped };
}

function pricedEntry(v: Extract<Verdict, { kind: 'priced' }>, rows: RateRow[] | undefined, perHospital: number): Record<string, unknown> {
  const desc = v.aggs.find((a) => a.description)?.description ?? null;
  const entry: Record<string, unknown> = {
    ...ident(v.h, v.dist),
    data_as_of: v.h.last_updated_on,
    service_description: desc,
    prices: v.aggs.map(settingBlock),
  };
  if (rows) {
    entry.negotiated_rates = rows.slice(0, perHospital).map(shapeRate);
    entry.negotiated_rates_total = rows.length;
    if (rows.length > perHospital) entry.negotiated_rates_truncated = true;
  }
  return entry;
}

async function absenceDetail(db: D1Like, q: Query, vs: Verdict[], cap: number): Promise<Record<string, unknown>> {
  const notHeld = vs.filter((v): v is Extract<Verdict, { kind: 'not_held' }> => v.kind === 'not_held');
  const byStatus: Record<string, number> = {};
  for (const v of notHeld) byStatus[v.h.status] = (byStatus[v.h.status] ?? 0) + 1;
  const codeAbsent = vs.filter((v) => v.kind === 'code_absent');
  const settingAbsent = vs.filter((v): v is Extract<Verdict, { kind: 'setting_absent' }> => v.kind === 'setting_absent');
  const payerAbsent = vs.filter((v): v is Extract<Verdict, { kind: 'payer_not_listed' }> => v.kind === 'payer_not_listed');
  const payerList: Array<Record<string, unknown>> = [];
  for (const v of payerAbsent.slice(0, cap)) {
    payerList.push({
      ...ident(v.h, v.dist),
      reason: 'payer_not_listed',
      message: `${v.h.name} published a price for this code but no row matching ${[q.payer && `payer "${q.payer}"`, q.plan && `plan "${q.plan}"`].filter(Boolean).join(' and ')}.`,
      payers_it_lists_for_this_code: await payersFor(db, q.spec, v.h.ccn, 12),
    });
  }
  return {
    not_held_by_status: byStatus,
    not_held: notHeld.slice(0, cap).map((v) => ({
      ...ident(v.h, v.dist),
      reason: 'not_held',
      status: v.h.status,
      message: statusReason(v.h),
    })),
    code_absent: codeAbsent.slice(0, cap).map((v) => ({
      ...ident(v.h, v.dist),
      reason: 'code_absent',
      message: `${v.h.name}'s file is loaded (${v.h.rate_rows.toLocaleString('en-US')} rows) but contains no row for ${q.spec.codeType} ${q.spec.code}: the hospital did not publish this service as a standard charge.`,
    })),
    setting_absent: settingAbsent.slice(0, cap).map((v) => ({
      ...ident(v.h, v.dist),
      reason: 'setting_not_published',
      message: `${v.h.name} publishes this code only for setting: ${v.settings.join(', ')}.`,
    })),
    payer_not_listed: payerList,
    absence_counts: {
      not_held: notHeld.length,
      code_absent: codeAbsent.length,
      setting_not_published: settingAbsent.length,
      payer_not_listed: payerAbsent.length,
    },
  };
}

const COMMON_NOTE =
  'Prices are what each hospital published in its own file. gross_charge is a list price, discounted_cash is the self-pay price, and negotiated rates are payer-specific; none of them is what a particular patient will owe.';

// ── tools ───────────────────────────────────────────────────────────────────

function readQuery(args: Record<string, unknown>): { q: Query } | { err: Record<string, unknown> } {
  const p = parseCode(args.code, args.code_type);
  if (!p.ok) return { err: { found: false, reason: p.error, message: p.message, ...(p.hint ? { hint: p.hint } : {}) } };
  const setting = args.setting ? String(args.setting).toLowerCase() : null;
  if (setting && setting !== 'inpatient' && setting !== 'outpatient') {
    return { err: { found: false, reason: 'invalid_setting', message: 'setting must be "inpatient" or "outpatient".' } };
  }
  return { q: { spec: p.spec, payer: String(args.payer ?? '').trim(), plan: String(args.plan ?? '').trim(), setting } };
}

async function searchTool(db: D1Like, args: Record<string, unknown>) {
  const parsed = readQuery(args);
  if ('err' in parsed) return parsed.err;
  const { q } = parsed;
  const L = await loadedMeta(db);
  const m = L.m;
  const centre = await resolveCentre(db, args);
  if ('error' in centre) return { found: false, reason: centre.error, message: centre.message, ...(centre.hint ? { hint: centre.hint } : {}) };

  const radius = clamp(args.radius_mi ?? args.radius, 1, 150, 25);
  const limit = clamp(args.limit, 1, 50, 20);
  const perHospital = clamp(args.rates_per_hospital, 1, 25, 5);
  const dLat = radius / 69;
  const dLon = radius / (69 * Math.max(0.2, Math.cos((centre.lat * Math.PI) / 180)));
  const cand = await db
    .prepare(`SELECT ${HOSPITAL_COLS} FROM hospital WHERE lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?`)
    .bind(centre.lat - dLat, centre.lat + dLat, centre.lon - dLon, centre.lon + dLon)
    .all<HospitalRow>();
  const inRange = cand.results
    .map((h) => ({ h, dist: haversineMiles(centre.lat, centre.lon, h.lat as number, h.lon as number) }))
    .filter((x) => x.dist <= radius)
    .sort((a, b) => a.dist - b.dist);

  let unlocated: number | null = null;
  if (centre.state) {
    const u = await db
      .prepare(`SELECT COUNT(*) AS n FROM hospital WHERE state = ? AND status = 'ok' AND lat IS NULL`)
      .bind(centre.state)
      .first<{ n: number }>();
    unlocated = u?.n ?? 0;
  }

  const searched = {
    near: centre.label,
    radius_mi: radius,
    distance_basis: 'Straight-line miles between ZIP centroids (town-level, not street-level).',
    code: q.spec.code,
    code_type: q.spec.codeType,
    ...(q.payer ? { payer_filter: q.payer } : {}),
    ...(q.plan ? { plan_filter: q.plan } : {}),
    ...(q.setting ? { setting_filter: q.setting } : {}),
  };
  const coverage = coverageStatement(L);
  const base = { source: SOURCE, price_types: PRICE_TYPES, note: COMMON_NOTE, coverage, searched, licence_note: LICENCE_NOTE };

  if (!inRange.length) {
    return {
      found: false,
      reason: 'no_hospital_in_range',
      message: `No hospital in the loaded store lies within ${radius} miles of ${centre.label}. States loaded: ${L.states.map((x) => x.state).join(', ') || 'none'}. This means the area is not loaded, not that no prices exist for the service.`,
      hint: 'Widen radius_mi (max 150), or call hospital_price_coverage to see which states are loaded.',
      ...(unlocated ? { hospitals_unlocated_in_state: unlocated, unlocated_note: `${unlocated} hospitals with prices held in ${centre.state} have no ZIP centroid and cannot be placed by distance.` } : {}),
      data_as_of: m.data_as_of,
      ...base,
    };
  }

  const { verdicts, payerRowsByCcn, ratesCapped } = await classify(db, q, inRange);
  const priced = verdicts.filter((v): v is Extract<Verdict, { kind: 'priced' }> => v.kind === 'priced');
  const shown = priced.slice(0, limit);
  const absence = await absenceDetail(db, q, verdicts, 12);
  const haveFiles = verdicts.filter((v) => v.h.status === 'ok').length;
  const dates = priced.map((v) => v.h.last_updated_on).filter(Boolean) as string[];
  const hospitalsSearched = {
    in_range: inRange.length,
    with_prices_loaded: haveFiles,
    priced_for_this_query: priced.length,
    ...(unlocated ? { unlocated_in_state: unlocated } : {}),
  };

  if (!priced.length) {
    const c = absence.absence_counts as Record<string, number>;
    let reason: string;
    let message: string;
    if (haveFiles === 0) {
      reason = 'no_hospital_with_prices_in_range';
      message = `${inRange.length} hospital(s) lie within ${radius} miles of ${centre.label}, but none has prices loaded, so there is no answer here, not an answer of "no prices". Reasons are listed per hospital under not_held.`;
    } else if (c.payer_not_listed > 0) {
      reason = 'payer_not_listed_in_range';
      message = `${c.payer_not_listed} hospital(s) in range publish ${q.spec.codeType} ${q.spec.code} but none lists a row for the payer/plan asked.`;
    } else if (c.setting_not_published > 0 && c.code_absent === 0) {
      reason = 'setting_not_published_in_range';
      message = `Hospitals in range publish this code only for a setting other than "${q.setting}".`;
    } else {
      reason = 'code_absent_in_range';
      message = `${haveFiles} hospital(s) in range have files loaded, but none published a row for ${q.spec.codeType} ${q.spec.code}.`;
    }
    return { found: false, reason, message, hospitals_searched: hospitalsSearched, ...absence, data_as_of: m.data_as_of, ...base };
  }

  const hint =
    priced.length > limit
      ? `Showing the nearest ${limit} of ${priced.length} hospitals. Narrow with radius_mi, payer, plan or setting, or raise limit (max 50).`
      : undefined;
  return {
    found: true,
    total: priced.length,
    returned: shown.length,
    truncated: priced.length > limit,
    ...(hint ? { narrowing_hint: hint } : {}),
    ...(ratesCapped ? { warning: 'Rate rows were capped at 3,000 across the search; narrow the area or payer.' } : {}),
    hospitals: shown.map((v) => pricedEntry(v, q.payer || q.plan ? payerRowsByCcn.get(v.h.ccn) : undefined, perHospital)),
    hospitals_searched: hospitalsSearched,
    ...(Object.values(absence.absence_counts as Record<string, number>).some((n) => n > 0) ? { not_priced: absence } : {}),
    data_as_of: dates.length ? dates.sort()[0] : m.data_as_of,
    data_as_of_note: 'Oldest file date among the hospitals returned; each hospital carries its own data_as_of (the file\'s last_updated_on).',
    ...base,
  };
}

async function compareTool(db: D1Like, args: Record<string, unknown>) {
  const parsed = readQuery(args);
  if ('err' in parsed) return parsed.err;
  const { q } = parsed;
  const ccns = Array.isArray(args.ccns) ? [...new Set(args.ccns.map((c) => String(c).trim()).filter(Boolean))] : [];
  if (!ccns.length) return { found: false, reason: 'missing_ccns', message: 'ccns is required: 1-10 CMS Certification Numbers.' };
  if (ccns.length > 10) return { found: false, reason: 'too_many_ccns', message: `ccns takes at most 10; got ${ccns.length}.` };
  const L = await loadedMeta(db);
  const m = L.m;
  const perHospital = clamp(args.rates_per_hospital, 1, 25, 25);
  const found = await hospitalsByCcn(db, ccns);
  const byCcn = new Map(found.map((h) => [h.ccn, h]));
  const unknown = ccns.filter((c) => !byCcn.has(c));
  const ordered = ccns.filter((c) => byCcn.has(c)).map((c) => ({ h: byCcn.get(c) as HospitalRow, dist: null as number | null }));
  const { verdicts, payerRowsByCcn } = ordered.length
    ? await classify(db, q, ordered)
    : { verdicts: [] as Verdict[], payerRowsByCcn: new Map<string, RateRow[]>() };

  const wantRates = Boolean(q.payer || q.plan);
  const results: Array<Record<string, unknown>> = [];
  const detail = await absenceDetail(db, q, verdicts, 10);
  const absentByCcn = new Map<string, Record<string, unknown>>();
  for (const key of ['not_held', 'code_absent', 'setting_absent', 'payer_not_listed'] as const) {
    for (const e of detail[key] as Array<Record<string, unknown>>) absentByCcn.set(String(e.ccn), e);
  }
  for (const v of verdicts) {
    if (v.kind === 'priced') {
      results.push({ outcome: 'priced', ...pricedEntry(v, wantRates ? payerRowsByCcn.get(v.h.ccn) : undefined, perHospital) });
    } else {
      results.push({ outcome: 'no_price', ...(absentByCcn.get(v.h.ccn) ?? ident(v.h, null)) });
    }
  }
  for (const c of unknown) {
    results.push({
      outcome: 'no_price',
      ccn: c,
      reason: 'unknown_ccn',
      message: `${c} is not a hospital in the loaded store (CCNs are 6 characters, e.g. "330101"). This is not a hospital with no prices; the identifier is unrecognised.`,
    });
  }
  const pricedN = results.filter((r) => r.outcome === 'priced').length;
  return {
    found: pricedN > 0,
    ...(pricedN === 0 ? { reason: 'no_requested_hospital_priced', message: 'None of the requested hospitals has a price for this query; see each result for why.' } : {}),
    code: q.spec.code,
    code_type: q.spec.codeType,
    ...(q.payer ? { payer_filter: q.payer } : {}),
    ...(q.plan ? { plan_filter: q.plan } : {}),
    ...(q.setting ? { setting_filter: q.setting } : {}),
    requested: ccns.length,
    priced: pricedN,
    hospitals: results,
    data_as_of: m.data_as_of,
    data_as_of_note: 'Store cycle; each priced hospital carries its own data_as_of (the file\'s last_updated_on).',
    coverage: coverageStatement(L),
    source: SOURCE,
    price_types: PRICE_TYPES,
    note: COMMON_NOTE,
    licence_note: LICENCE_NOTE,
  };
}

function hospitalCoverageEntry(h: HospitalRow): Record<string, unknown> {
  const held = h.status === 'ok';
  return {
    ...ident(h, null),
    prices_held: held,
    status: h.status,
    reason: held
      ? `Prices loaded from ${h.name}'s own standard charges file (${h.rate_rows.toLocaleString('en-US')} rows for the shoppable services and MS-DRGs).`
      : statusReason(h),
    rate_rows: h.rate_rows,
    data_as_of: h.last_updated_on,
  };
}

async function coverageTool(db: D1Like, args: Record<string, unknown>) {
  const L = await loadedMeta(db);
  const m = L.m;
  const ccn = String(args.ccn ?? '').trim();
  const name = String(args.name ?? '').trim();
  const state = String(args.state ?? '').trim().toUpperCase();
  const statusArg = String(args.status ?? '').trim().toLowerCase();
  const tail = { store_cycle: m.data_as_of, source: SOURCE, licence_note: LICENCE_NOTE };

  if (ccn) {
    const [h] = await hospitalsByCcn(db, [ccn]);
    if (!h) {
      return { found: false, reason: 'unknown_ccn', message: `${ccn} is not a hospital in the loaded store (states loaded: ${L.states.map((x) => x.state).join(', ')}). Try name=.`, ...tail };
    }
    return { found: true, hospital: hospitalCoverageEntry(h), code_scope: CODE_SCOPE, ...tail };
  }
  if (name) {
    const esc = name.toLowerCase().replace(/[%_\\]/g, (c) => `\\${c}`);
    const r = await db
      .prepare(`SELECT ${HOSPITAL_COLS} FROM hospital WHERE LOWER(name) LIKE ? ESCAPE '\\' OR LOWER(system) LIKE ? ESCAPE '\\' ORDER BY (status = 'ok') DESC, name LIMIT 26`)
      .bind(`%${esc}%`, `%${esc}%`)
      .all<HospitalRow>();
    if (!r.results.length) {
      return {
        found: false,
        reason: 'no_hospital_named',
        message: `No hospital in the loaded store (states: ${L.states.map((x) => x.state).join(', ')}) matches "${name}". It may be outside the loaded states, or a spelling mismatch; this is not a statement about prices.`,
        hint: 'Try a shorter or differently spelled name, or search by state.',
        ...tail,
      };
    }
    const shown = r.results.slice(0, 25);
    return {
      found: true,
      matches: shown.length,
      truncated: r.results.length > 25,
      hospitals: shown.map(hospitalCoverageEntry),
      code_scope: CODE_SCOPE,
      ...tail,
    };
  }
  if (state) {
    if (!/^[A-Z]{2}$/.test(state)) return { found: false, reason: 'invalid_state', message: 'state must be a two-letter code, e.g. "MN".' };
    const c = await db
      .prepare(`SELECT status, COUNT(*) AS hospitals, SUM(rate_rows) AS rate_rows FROM hospital WHERE state = ? GROUP BY status`)
      .bind(state)
      .all<{ status: string; hospitals: number; rate_rows: number }>();
    if (!c.results.length) {
      return { found: false, reason: 'no_hospitals_in_state', message: `State "${state}" is not loaded in the store yet (loaded: ${L.states.map((x) => x.state).join(', ')}). That means no data, not that its hospitals publish nothing.`, ...tail };
    }
    const total = c.results.reduce((s, x) => s + x.hospitals, 0);
    const out: Record<string, unknown> = {
      found: true,
      state,
      hospitals_on_file: total,
      hospitals_with_prices: c.results.find((x) => x.status === 'ok')?.hospitals ?? 0,
      by_status: Object.fromEntries(c.results.map((x) => [x.status, x.hospitals])),
      status_meanings: Object.fromEntries(c.results.map((x) => [x.status, x.status === 'ok' ? 'Prices held.' : statusReason({ status: x.status, status_reason: null })])),
      code_scope: CODE_SCOPE,
      ...tail,
    };
    if (statusArg) {
      const l = await db
        .prepare(`SELECT ${HOSPITAL_COLS} FROM hospital WHERE state = ? AND status = ? ORDER BY name LIMIT 100`)
        .bind(state, statusArg)
        .all<HospitalRow>();
      out.listed_status = statusArg;
      out.hospitals = l.results.map(hospitalCoverageEntry);
      out.list_truncated = l.results.length >= 100;
    } else {
      out.hint = 'Pass status (e.g. "blocked") with state to list those hospitals by name.';
    }
    return out;
  }
  const c = await db
    .prepare(`SELECT status, hospitals, rate_rows FROM coverage WHERE cycle = ? ORDER BY hospitals DESC`)
    .bind(m.data_as_of)
    .all<{ status: string; hospitals: number; rate_rows: number }>();
  return {
    found: true,
    ...coverageStatement(L),
    by_status: Object.fromEntries(c.results.map((x) => [x.status, { hospitals: x.hospitals, rate_rows: x.rate_rows }])),
    status_meanings: Object.fromEntries(c.results.map((x) => [x.status, x.status === 'ok' ? 'Prices held.' : statusReason({ status: x.status, status_reason: null })])),
    total_rate_rows: Number(m.rate_rows),
    rate_rows_with_dollar_figure: Number(m.dollar_rows),
    hint: 'Pass ccn, name or state for a specific answer.',
    ...tail,
  };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const db = requireDb(args._d1);
  switch (name) {
    case 'hospital_price_search':
      return searchTool(db, args);
    case 'hospital_price_compare':
      return compareTool(db, args);
    case 'hospital_price_coverage':
      return coverageTool(db, args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;

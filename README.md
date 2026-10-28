# @pipeworx/hospital-prices

What US hospitals say a service costs: gross charge, self-pay cash price and payer-negotiated rates for a CPT/HCPCS or MS-DRG code at hospitals near a ZIP, from the standard charges files hospitals publish under the CMS hospital price transparency rule.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1856+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

## Tools

- `hospital_price_search(code, near, radius_mi?, payer?, plan?, setting?, limit?)` — hospitals within a radius of a ZIP (or `lat,lon`), nearest first, each with gross charge, discounted cash price, de-identified min/max negotiated amounts and a summary of payer rates. With `payer`/`plan` it returns that payer's negotiated rate rows.
- `hospital_price_compare(code, ccns[])` — the same fields side by side for up to 10 named hospitals (by CMS Certification Number).
- `hospital_price_coverage(ccn? | name? | state?)` — whether the store holds a hospital's prices and, if not, why (blocked, no file found, unsupported version, ...).

Every negotiated rate carries `dollar_available`. When a hospital published a percentage or a formula instead of a dollar figure it is `false`, the hospital's own methodology/algorithm text is returned, and no number is invented. Responses carry `data_as_of` (the file's own last-updated date), `total` / `truncated` / a narrowing hint, and a loud, specific reason instead of an empty list: no hospital in range, hospitals in range but none with prices held (and why), file loaded but code not published, code published but payer not listed.

## Auth

Keyless. The data is read from Pipeworx's own store (a D1 database bound to the gateway); the pack answers only through the Pipeworx gateway. A standalone install has no store and reports that plainly.

## Data sources

- Each hospital's CMS hospital price transparency standard charges file (45 CFR 180), as published by the hospital. Responses name the hospital and that file type, never a download route.

## Coverage is partial, and says so

- Hospitals whose site refuses our requests (HTTP 403 / bot challenge) are reported `blocked`; we do not evade blocks. Others have no findable or parseable file. Each hospital has a status; `hospital_price_coverage` gives it.
- Only the CMS 70 shoppable services (69 CPT/HCPCS codes) and MS-DRGs are kept. Other codes return `code_not_in_scope`, not "no prices".
- The store is loaded in scoped cycles. Check `coverage` in any response for how many hospitals currently have prices held.
- ZIP distances are between ZIP centroids (town level), not street level.

## Licence

The files are published under a federal transparency mandate for public use, but **they carry no reuse licence**. This pack serves a filtered copy of them, built and flagged under the 2026-09-23 "build the copy when live access does not serve" ruling; every response carries `licence_note`. The ingest, schema and refresh live in `scripts/hospital-prices/` (fleet #3035). Design of record: `docs/hospital-price-transparency-plan.md`.

No personal data: the min/max negotiated amounts in the files are de-identified by rule.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "hospital-prices": {
      "url": "https://gateway.pipeworx.io/hospital-prices/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/hospital-prices/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1856+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/hospital_price_search \
  -H 'Content-Type: application/json' \
  -d '{"code":"470","near":"60453","radius_mi":10,"limit":4}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/hospital_price_search`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "hospital-prices": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-hospital-prices"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-hospital-prices
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Hospital Prices data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT

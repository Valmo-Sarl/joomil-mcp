# joomil-mcp

> MCP server for [Joomil.ch](https://www.joomil.ch), a French-speaking Swiss classifieds marketplace active since 2007.

Browse and search 45,000+ active listings across 34 categories: real estate, vehicles, jobs, animals, electronics, fashion and more — all from Switzerland's French-speaking regions (Romandie).

## Tools

| Tool | Description |
|------|-------------|
| `suggest_filters` | Infer `search_classifieds` filters from a natural-language query |
| `search_classifieds` | Search listings with filters: keyword, category, canton (strict enum), location, price range, sort, pagination |
| `get_classified` | Get full details of a listing by ID: description, images, vendor, expiry date |
| `get_categories` | List active categories with hierarchy via `parent_id` |
| `get_cantons` | List the canton values supported by the `canton` filter (API-specific spellings) |

## Quick Start

This is a **remote MCP server** — no local installation required.

**Endpoint:** `https://joomil-mcp.snowy-surf-deec.workers.dev/mcp`

### Claude Desktop

Add to `~/.claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "joomil": {
      "command": "npx",
      "args": ["mcp-remote", "https://joomil-mcp.snowy-surf-deec.workers.dev/mcp"]
    }
  }
}
```

### Cursor

Add to your MCP settings:

```json
{
  "joomil": {
    "url": "https://joomil-mcp.snowy-surf-deec.workers.dev/mcp"
  }
}
```

## Example Prompts

- *"Trouve-moi une voiture automatique à moins de 10'000 CHF dans le canton de Vaud."*
- *"Cherche un appartement 3 pièces à Sion."*
- *"Quelles catégories d'électronique propose Joomil ?"*
- *"Montre-moi les annonces de canapés vintage en Valais."*
- *"Cherche des offres d'emploi dans l'hôtellerie à Neuchâtel."*

> **Tip for agents**: call `get_cantons` before filtering by canton — the API uses
> non-obvious spellings (e.g. `Bern` not `Berne`, `Geneve` not `Genève`/`Geneva`).
> For free-text user requests, call `suggest_filters` first, then pass the returned
> `filters` object to `search_classifieds`.

## API Reference

### `suggest_filters`

| Parameter | Type | Description |
|-----------|------|-------------|
| `query` | string | Natural-language search request, e.g. `appartement 3 pièces à Sion` |

Returns a ready-to-use `filters` object for `search_classifieds`, plus a category confidence score and warnings when matching is uncertain. Category metadata is cached briefly by the MCP layer to avoid refetching the category tree for every suggestion.

Useful examples:

| User request | Typical suggested filters |
|--------------|---------------------------|
| `Tesla Model 3 moins de 25'000 CHF` | `q: "Tesla Model 3"`, `cat_id: 101`, `price_max: 25000`, `sort: "price_asc"` |
| `vélo budget 1.5k CHF` | `q: null`, category in sport/leisure, `price_max: 1500`, `sort: "price_asc"` |
| `appartement 3 pièces à Sion` | `q: "3 pièces"`, `cat_id: 10255`, `location: "Sion"` |
| `voiture entre 10'000 et 20'000 CHF` | `cat_id: 101`, `price_min: 10000`, `price_max: 20000` |
| `Golf GTI dans le canton de Vaud` | `q: "Golf GTI"`, `cat_id: 101`, `canton: "Vaud"` |
| `canapé vintage à Lausanne` | `q: "vintage"`, `cat_id: 10022`, `location: "Lausanne"` |
| `iPhone 14 à Genève` | `q: "iPhone 14"`, `cat_id: 10127`, `location: "Genève"` |

```json
{
  "query": "appartement 3 pièces à Sion",
  "filters": {
    "q": "3 pièces",
    "cat_id": 10255,
    "canton": null,
    "location": "Sion",
    "price_min": null,
    "price_max": null,
    "sort": "recent",
    "limit": 20
  },
  "category": {
    "id": 10255,
    "name": "Appartements",
    "url": "https://www.joomil.ch/annonces/immobilier/locations/appartements/10255",
    "parent_id": 339,
    "confidence": 0.82,
    "reason": "requête immobilière appartement"
  },
  "confidence": 0.74,
  "warnings": [],
  "next_step": "Call search_classifieds with the filters object. Adjust q or cat_id if the result set is too broad."
}
```

### `search_classifieds`

| Parameter | Type | Description |
|-----------|------|-------------|
| `q` | string | Full-text search (title + description) |
| `cat_id` | number | Category ID — includes subcategories |
| `canton` | enum | Strict enum — see `get_cantons`. `Geneve`, `Vaud`, `Valais`, `Fribourg`, `Neuchatel`, `Jura`, `Bern`, `Argovie`, `Zurich`, `Lucerne`, `Bale-Ville`, `Etranger` |
| `location` | string | City name or postal code (partial match) |
| `price_min` | number | Minimum price in CHF |
| `price_max` | number | Maximum price in CHF |
| `sort` | enum | `recent` (default, newest first), `price_asc`, `price_desc`, `views` (most viewed) |
| `limit` | number | Results per page (1–50, default 20) |
| `offset` | number | Pagination offset — use `next_offset` from previous response |

Tool responses include a short human-readable summary followed by compact serialized JSON in `content` for MCP backward compatibility. Full data is also returned in `structuredContent` with `results`, `total`, `limit`, `offset`, `has_more`, `next_offset`, and `filtered_out` (items removed from the current page by MCP-side category restrictions).

**Result shape** (each item):
```json
{
  "id": 366872, "title": "Maison avec étangs",
  "price": { "amount": 237977.5, "currency": "CHF" },
  "location": { "city": "Saint Eugène", "postal_code": "71320", "canton": "Geneve", "country": "FR" },
  "category": { "id": 10261, "name": "Maisons & Villas", "url": "https://..." },
  "url": "https://www.joomil.ch/annonce/.../366872",
  "created_at": "2026-06-26T22:17:11+02:00",
  "has_picture": true,
  "seller": { "name": "jpclair", "certified": false }
}
```

### `get_classified`

| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | number | Listing ID (from search results or listing URL) |

Returns full listing details, including complete description, images, category path, expiry date, boost level, and seller details.

### `get_categories`

| Parameter | Type | Description |
|-----------|------|-------------|
| `parent_id` | number | Optional — omit for all, `0` for root categories, or any category ID for its children |

### `get_cantons`

No parameters. Returns the canton values accepted by `search_classifieds`' `canton` filter, with their French labels:

```json
{
  "cantons": [
    { "name": "Geneve", "label_fr": "Genève", "code": "GE", "region": "Romandie" },
    { "name": "Bern", "label_fr": "Berne", "code": "BE", "region": "Suisse alémanique" }
  ],
  "total": 12
}
```

Always pass the `name` field (not `label_fr` nor `code`) to the `canton` filter.

## Data

- **Source**: Joomil.ch public REST API
- **Coverage**: public classifieds in supported general-audience categories; no member-account access
- **Location**: Switzerland (French-speaking regions — Romandie)
- **Language**: French
- **Update frequency**: Real-time
- **Authentication**: None required

## Limitations

This MCP server is **read-only** and uses **public data only**.

- **No write operations**: cannot create, edit, or delete listings; cannot contact sellers.
- **No member login**: no user accounts, no messages, no favorites, no saved searches.
  A private worker-to-origin service credential does not grant access to private data.
- **No seller contact fields**: the API does not expose account phone or email fields. User-written listing text is not a verified contact channel; open the listing `url` on Joomil.ch.
- **No posting**: publishing an ad must be done on joomil.ch.
- **Restricted categories**: Erotique (28), Rencontres & Amitié (14000), Voyance & Astrologie (651), and their descendants are filtered out by the MCP layer per content policy. The underlying PHP API remains available for direct use.
- **Canton filter is strict**: only the values returned by `get_cantons` are accepted. Other spellings (`Berne`, `Genève`, `Geneva`, `GE`, `VD`...) are silently ignored by the upstream API and would return all listings instead of a filtered set — the strict enum here prevents that.
- **Currency**: all prices are in CHF. Listings may have `price.amount: null` (price on request) or `0` (free).
- **Upstream errors**: Joomil API failures are returned as MCP tool errors with `isError: true`.

## v1.3.3 — budget phrase parsing (deployed 2026-11-27)

`suggest_filters` now consumes the full `à moins de` / `à plus de` price phrase.
In v1.3.2, removing only `moins de CHF 500` could leave a stray `à` and make
`dans le` look like a locality. The exact ChatGPT test query now keeps
`cat_id: 78`, `canton: "Vaud"`, `price_max: 500`, and `location: null`.
Explicit towns and postal codes still work alongside a price comparison.
No PHP origin or Cloudflare binding changes were made.
Cloudflare version `8433fcd8-7616-4bac-8b3b-3743fab21202` took 100% of
traffic at 22:15:51 UTC, deployment `7d175d83-c8c4-4130-82a6-be4a93226f21`.
At 22:16:33 UTC the exact query and all five read-only tools passed on both
session-based Streamable HTTP and `2026-07-28`. The previous Worker version
`26b184d1-cae0-48ad-92a5-ca7fd7865934` remains the rollback point.

## v1.3.2 — active inventory and taxonomy (deployed 2026-11-27)

- Search and listing details use the origin's explicit `scope=active_general_v1`.
  Eligible listings have status `1` or `2`, are not past an explicit expiry
  date, and are in an active general-audience category. No expiry is allowed
  for active listings that have no deadline (such as gateway listings).
  The origin applies this before counting and paginating. The default website
  and unscoped REST inventory remain unchanged. A readable listing is not
  proof that the item is still available.
- The Worker rejects responses that do not confirm the scope; it won't fall
  back to old unfiltered data. Roll out and verify the backwards-compatible
  PHP origin first, then deploy the Worker. On rollback, revert the Worker
  before withdrawing scoped origin support.
- `get_categories`, category suggestions, search and details share the active
  taxonomy. In addition to the origin filter, the Worker excludes roots
  `28`, `651`, `14000` and all descendants by parent IDs. Unknown, orphaned,
  cyclic or duplicated IDs are not exposed. The category cache contains
  taxonomy metadata, not listing availability; `ad_count` from the catalog
  is not a count of currently available listings.
- Explicit breadcrumbs (e.g. `Immobilier > Locations > Appartements`) or
  category IDs disambiguate repeated labels. Free-text suggestions use actual
  category labels and scoped aliases; ties leave the category unset. `vélo`
  maps to `Vélos` (`78`), not to an unrelated Sport & Loisirs child. The
  condition “used” is not a structured search filter.
- To repeat the full taxonomy audit without network calls during tests, save
  the public `/api/categories` response's `categories` array and run
  `JOOMIL_PUBLIC_CATEGORY_SNAPSHOT=/path/to/categories.json npm test`.
  Snapshot 2026-11-27: 521 categories reconciled, 491 allowed, 30 excluded.
- The scoped PHP origin was verified at 21:44:31 UTC. Three known expired
  listings return 404 with the scope and remain readable at their unscoped
  URLs. The Worker took 100% of traffic at 21:46:01 UTC (Cloudflare version
  `26b184d1-cae0-48ad-92a5-ca7fd7865934`; deployment
  `17886f36-9746-472a-a7c9-2d715eeaab16`). At 21:46:15 UTC all five tools
  passed on `2025-03-26`, `2025-11-25` and `2026-07-28`. Live tests compared
  the full taxonomy, checked category exclusion, pagination, and chained
  the bike suggestion into search and detail. Bindings and limits did not change.
  The previous Worker `409f14f4-58d8-481b-bd75-7cf671a429b5` remains the
  rollback point. The changed PHP files are backed up at
  `data/backups/mcp-active-v132-20261127-odlbj9` within the origin app root.

## v1.3.1 — deployed and verified on 2026-11-24

The same `/mcp` endpoint serves both session-based Streamable HTTP
(`2025-03-26` through `2025-11-25`) and the current `2026-07-28` stateless
protocol. Both expose the same five read-only tools. Modern clients use
the MCP v2 negotiation and metadata, not a session header. Existing clients
can continue using legacy sessions. No OAuth, accounts, writes or new routes
were added.

- `suggest_filters.filters` works directly with `search_classifieds`;
  absent/null filters never reach REST. A four-digit number needs explicit
  postal context, and reversed price bounds fail before contacting REST.
  Pass a standalone search query of at most 500 characters to `suggest_filters`.
- Listing details use the origin's `boost` values (`star`, `flash`, or null).
  A record without a usable category is not exposed. Category responses keep
  only documented fields. Upstream requests have an eight-second timeout;
  failures don't echo search URLs or upstream error bodies.
- The 64 KiB POST body bound is checked during protocol routing. Both protocols
  share the existing 600-request/minute ingress bound and atomic origin
  budget. Legacy tools retain 60 calls/minute per SDK session; stateless
  tools get a distinct 60 calls/minute key per Cloudflare ingress peer,
  not per person. Shared IPs can share that allowance. The native namespaces,
  limits, service secret binding and Durable Object namespace were preserved.
- TypeScript and 13 tests passed, including the real Worker with fictitious
  origin, both protocol families and legacy batches. The npm lockfile audit
  reported zero known advisories. After deployment all five tools succeeded
  on the live endpoint under `2025-03-26`, `2025-11-25` and `2026-07-28`;
  no production quota stress test was run. Individual host apps have not
  been verified end-to-end.

Cloudflare version `409f14f4-58d8-481b-bd75-7cf671a429b5`, 100% from
15:08:41 UTC; checks completed at 15:08:55 UTC. The v1.3.0 version
`0b412245-e585-4e35-9bc9-761bdbf537e2` is the compatible rollback point.
No PHP origin, Worker triggers or custom domain changed.

## Directory readiness

The [local submission dossier](distribution/README.md) tracks the Claude
submission to recover, the ChatGPT/Codex package draft, and the outstanding
review gates. It is preparation only, not a directory submission.

Before applying to the [Claude Connectors Directory](https://claude.com/docs/connectors/building/submission)
or [ChatGPT Plugin Directory](https://developers.openai.com/plugins/deploy/submission):

- Review the public scope and content restrictions for all five tools, including
  single-listing access and user-written titles/descriptions. Category filtering
  alone does not guarantee that free text has no personal or restricted content.
- Document MCP-specific data handling and retention before relying on the
  [website privacy policy](https://www.joomil.ch/petitesannonces/protection-donnees/cms/85)
  as the submission's privacy URL. Use [Joomil support](https://support.joomil.ch/)
  for the support link. Prefer an endpoint under a Joomil-owned domain for
  publisher identification and OpenAI domain verification.
- Test the five real tools in both clients with sample searches before
  submitting. Wire tests don't prove catalogue approval or in-client tool
  exposure. Claude conversation tests on v1.3.2 confirmed bike-category
  suggestion, active searches and detail access: ID `396429` returned its
  details, while expired ID `387721` returned a scoped 404. That 404 does
  not imply the listing was deleted or is no longer visible on the website.
  The same Claude test run also confirmed `get_categories` (`73` → Vélos `78`)
  and `get_cantons` (`Vaud`, code `VD`). ChatGPT exercised the same five
  tools again on v1.3.3: the budget query worked without the workaround for
  the bogus `dans le` locality seen on v1.3.2; ID `396429` returned its
  details and ID `387721` returned a scoped 404. ChatGPT treated the
  category's 13 active results as accessories, not complete bikes. These
  are conversation checks, not a claim about all inventory or queries.
  Directory submission is separate from the release and from a ChatGPT
  Business Hub company profile.

**Claude troubleshooting (observed 2026-11-27):** a connected custom connector
can list all five read-only tools in **Overview** even when some are **Blocked**
under **Authorizations**. If a chat can't find an advertised tool, check that
setting first and choose **Needs approval** for any tool you intend to test.
In this run, removing and re-adding the connector left all five at **Needs
approval**; the reason for the original mixed permissions wasn't established.

## Deploy Your Own

### v1.3.0 — origin-quota baseline, deployed on 2026-11-19

v1.3.0 separated MCP and direct REST quotas. Its five tools were
verified before and after the coordinated PHP origin rollout. Clients still
connect anonymously; the operator must provision
`JOOMIL_API_TOKEN` as a **Worker secret**, with the matching SHA-256 and an
explicit service limit at the Joomil origin. A self-hosted copy does not
automatically obtain a privileged origin service budget.

- Active: 60 **tool calls/session/minute**, plus 600 ingress GET/POST/IP/minute.
  Tool checks use the initialized SDK Durable Object, including batched calls.
- These native limits are **approximate per Cloudflare location**, not strict
  global limits or authenticated-person allowances. Sessions can be recreated;
  NATs/AI providers may share ingress IPs. A separate atomic origin service cap
  bounds aggregate upstream traffic.
- `MCP_SESSION_LIMITER` / `MCP_IP_LIMITER` use namespaces `2026111901` /
  `2026111902`, checked unused before deployment and now reserved to these uses.
  Verify account-wide uniqueness before assigning new namespaces.
- Missing service secret/bindings fail closed (503), exceeded budgets give429.
  No User-Agent/IP-header exemption. No origin redirect follows the secret.
- `.dev.vars.example` is empty by design. Do not commit a real `.dev.vars`,
  put a secret in `[vars]`, paste it in chat, or send it in a URL.
- Use the project's pinned Wrangler version. Run `npm run typecheck` and
  `npm test` offline before deployment. Tests use fictitious credentials and intercept all origin calls;
  the protocol test runs the real SDK/DO transport in Miniflare/workerd.
- No deployment, registry publication or secret provisioning is performed by
  tests. Coordinate worker-first rollout with the origin; rolling back blindly
  to v1.2.1 afterwards would lose the service credential and re-share direct quotas.

Operator's canonical plan in the workspace:
`../joomil/docs/operations/explicit-schema-preparation-2026-11-19/MCP-QUOTAS.md`.
Deployment evidence and safe recovery:
`../joomil/docs/operations/explicit-schema-preparation-2026-11-19/DEPLOYMENT-STATUS.md`.
Cloudflare version `0b412245-e585-4e35-9bc9-761bdbf537e2`, 100% traffic;
existing Durable Object/storage preserved. Not published to the MCP registry by
this rollout. Christophe subsequently requested a dedicated commit, tag and push
of this release in both repositories.

## License

MIT

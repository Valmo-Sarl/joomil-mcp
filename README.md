# joomil-mcp

> MCP server for [Joomil.ch](https://www.joomil.ch) — Switzerland's leading French-speaking classifieds marketplace, active since 2007.

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
- **Coverage**: 45,000+ active listings, 34 top-level categories, 190,000+ registered users
- **Location**: Switzerland (French-speaking regions — Romandie)
- **Language**: French
- **Update frequency**: Real-time
- **Authentication**: None required

## Limitations

This MCP server is **read-only** and uses **public data only**.

- **No write operations**: cannot create, edit, or delete listings; cannot contact sellers.
- **No authentication**: no user accounts, no messages, no favorites, no saved searches.
- **No seller contact**: phone numbers and email addresses are not exposed — use the listing `url` to open Joomil.ch directly.
- **No posting**: publishing an ad must be done on joomil.ch.
- **Restricted categories**: Erotique (28), Rencontres & Amitié (14000), Voyance & Astrologie (651), and their descendants are filtered out by the MCP layer per content policy. The underlying PHP API remains available for direct use.
- **Canton filter is strict**: only the values returned by `get_cantons` are accepted. Other spellings (`Berne`, `Genève`, `Geneva`, `GE`, `VD`...) are silently ignored by the upstream API and would return all listings instead of a filtered set — the strict enum here prevents that.
- **Currency**: all prices are in CHF. Listings may have `price.amount: null` (price on request) or `0` (free).
- **Upstream errors**: Joomil API failures are returned as MCP tool errors with `isError: true`.

## Deploy Your Own

```bash
git clone https://github.com/Valmo-Sarl/joomil-mcp
cd joomil-mcp
npm install
npx wrangler login
npm run deploy
```

## License

MIT

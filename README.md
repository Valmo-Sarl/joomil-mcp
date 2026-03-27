# joomil-mcp

> MCP server for [Joomil.ch](https://www.joomil.ch) — Switzerland's leading French-speaking classifieds marketplace, active since 2007.

Browse and search 45,000+ active listings across 34 categories: real estate, vehicles, jobs, animals, electronics, fashion and more — all from Switzerland's French-speaking regions (Romandie).

## Tools

| Tool | Description |
|------|-------------|
| `search_classifieds` | Search listings with filters: keyword, category, canton, location, price range, sort, pagination |
| `get_classified` | Get full details of a listing by ID: description, images, vendor, expiry date |
| `get_categories` | List active categories with hierarchy via `parent_id` |

## Quick Start

This is a **remote MCP server** — no local installation required.

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

- *"Find used road bikes under 500 CHF in Geneva on Joomil"*
- *"Show me apartments for rent in Vaud canton"*
- *"What electronics categories does Joomil have?"*
- *"Find a vintage sofa in the Valais region"*
- *"Search for job offers in hospitality in Neuchatel"*

## API Reference

### `search_classifieds`

| Parameter | Type | Description |
|-----------|------|-------------|
| `q` | string | Full-text search (title + description) |
| `cat_id` | number | Category ID — includes subcategories |
| `canton` | string | Swiss canton: `Geneve`, `Vaud`, `Valais`, `Fribourg`, `Neuchatel`, `Berne`, `Jura`... |
| `location` | string | City name or postal code (partial match) |
| `price_min` | number | Minimum price in CHF |
| `price_max` | number | Maximum price in CHF |
| `sort` | string | `recent` (default), `price_asc`, `price_desc`, `views` |
| `limit` | number | Results per page (1–50, default 20) |
| `offset` | number | Pagination offset — use `next_offset` from previous response |

### `get_classified`

| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | number | Listing ID (from search results or listing URL) |

### `get_categories`

| Parameter | Type | Description |
|-----------|------|-------------|
| `parent_id` | number | Optional — omit for all, `0` for root categories, or any category ID for its children |

## Data

- **Source**: Joomil.ch public REST API
- **Coverage**: 45,000+ active listings, 34 top-level categories, 190,000+ registered users
- **Location**: Switzerland (French-speaking regions — Romandie)
- **Language**: French
- **Update frequency**: Real-time
- **Authentication**: None required

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

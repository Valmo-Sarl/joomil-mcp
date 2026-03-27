# Joomil MCP Server

Search and browse classified ads from [Joomil.ch](https://www.joomil.ch) — Switzerland's leading French-speaking classifieds marketplace, active since 2007.

## Tools

| Tool | Description |
|------|-------------|
| `search_classifieds` | Search listings with filters: keyword, category, canton, location, price range, sort order, pagination |
| `get_classified` | Get full details of a listing by ID (description, images, vendor, expiry) |
| `get_categories` | List active categories with hierarchy via parent_id |

## Example Prompts

- "Find used bikes under 500 CHF in Geneva on Joomil"
- "Show me apartments for rent in Vaud canton"
- "What categories does Joomil have for electronics?"
- "Find a vintage sofa in the Valais region"

## Usage

This is a **remote MCP server** — no installation required. Connect directly via the endpoint URL.

### Connect via Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "joomil": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "https://joomil-mcp.YOUR_ACCOUNT.workers.dev/mcp"
      ]
    }
  }
}
```

### Connect via Cursor

Add to your MCP settings:

```json
{
  "joomil": {
    "url": "https://joomil-mcp.YOUR_ACCOUNT.workers.dev/mcp"
  }
}
```

## Data

- **Source**: Joomil.ch public API
- **Coverage**: ~2,000+ active listings across 34 top-level categories
- **Location**: Switzerland (French-speaking regions)
- **Language**: French
- **Update frequency**: Real-time (no cache on MCP layer)

## Categories

Animaux, Art & Antiquités, Automobiles, Bébés & Enfants, Bijouterie, Bricolage & Jardinage, Camping, Electroménager, Emplois & Services, Immobilier, Informatique, Jeux vidéos, Mobilier & Décoration, Motos, Musique, Sport & Loisirs, Téléphonie, Vêtements & Mode, Vins & Gastronomie, and more.

## Authentication

No authentication required — all data is publicly available on Joomil.ch.

## Rate Limiting

60 requests/minute per IP. Please implement reasonable caching on your side for high-volume use cases.

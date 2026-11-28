# Joomil MCP Server

Search and browse classified ads from [Joomil.ch](https://www.joomil.ch), a French-speaking Swiss classifieds marketplace active since 2007.

For submission readiness and the current production contract, see the
[README](README.md). This guide is not a directory listing or an approval.

## Tools

| Tool | Description |
|------|-------------|
| `suggest_filters` | Infer search filters from a natural-language query |
| `search_classifieds` | Search listings with filters: keyword, category, canton (strict enum), location, price range, sort order, pagination |
| `get_classified` | Get full details of a listing by ID (description, images, vendor, expiry) |
| `get_categories` | List active categories with hierarchy via parent_id |
| `get_cantons` | List the canton values supported by the canton filter |

## Example Prompts

- "Find used bikes under 500 CHF in Geneva on Joomil"
- "Show me apartments for rent in Vaud canton"
- "What categories does Joomil have for electronics?"
- "Find a vintage sofa in the Valais region"
- "Which canton values can I use with the Joomil MCP?"
- "Suggest filters for: Tesla Model 3 under 25,000 CHF"

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
        "https://joomil-mcp.snowy-surf-deec.workers.dev/mcp"
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
    "url": "https://joomil-mcp.snowy-surf-deec.workers.dev/mcp"
  }
}
```

## Data

- **Source**: Joomil.ch public API
- **Coverage**: available public listings, subject to the MCP content restrictions
- **Location**: Switzerland (French-speaking regions)
- **Language**: French
- **Update frequency**: live listing reads; filter suggestions cache category metadata briefly

## Categories

Animaux, Art & Antiquités, Automobiles, Bébés & Enfants, Bijouterie, Bricolage & Jardinage, Camping, Electroménager, Emplois & Services, Immobilier, Informatique, Jeux vidéos, Mobilier & Décoration, Motos, Musique, Sport & Loisirs, Téléphonie, Vêtements & Mode, Vins & Gastronomie, and more.

## Authentication

No authentication required — all data is publicly available on Joomil.ch.

## Rate Limiting

The current worker applies 60 tool calls/minute per legacy MCP session or per
stateless ingress IP (separate keys), and 600 incoming GET/POST requests/minute
per IP across both protocols, with separate origin limits. See the
[README](README.md) for details and limitations.

import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

/**
 * Joomil MCP Server
 *
 * Exposes the Joomil.ch classifieds marketplace as MCP tools.
 * Three read-only tools:
 *   - search_classifieds : search listings with filters
 *   - get_classified     : get a single listing by ID
 *   - get_categories     : list categories (optionally by parent)
 *
 * Data source: Joomil public REST API (www.joomil.ch/api/*)
 */

interface Env {
  JOOMIL_API_BASE: string;
}

/**
 * Performs a GET request to the Joomil API and returns parsed JSON.
 * Throws a descriptive error on HTTP failure.
 */
async function joomilFetch(
  baseUrl: string,
  path: string,
  params: Record<string, string | number | undefined> = {}
): Promise<unknown> {
  const url = new URL(`${baseUrl}${path}`);

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }

  const response = await fetch(url.toString(), {
    headers: { "User-Agent": "joomil-mcp/1.0" },
  });

  if (!response.ok) {
    throw new Error(
      `Joomil API error ${response.status}: ${response.statusText} — ${url.toString()}`
    );
  }

  return response.json();
}

/**
 * Wraps API data as MCP text content.
 */
function toText(data: unknown): { content: [{ type: "text"; text: string }] } {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  };
}

export class JoomilMCP extends McpAgent<Env> {
  server = new McpServer({
    name: "joomil-mcp",
    version: "1.0.0",
  });

  async init(): Promise<void> {
    const base = this.env.JOOMIL_API_BASE ?? "https://www.joomil.ch";

    // ============================================================================
    // Tool : search_classifieds
    // ============================================================================

    this.server.registerTool(
      "search_classifieds",
      {
        description:
          "Search classified ads on Joomil.ch — Switzerland's leading French-speaking classifieds marketplace (since 2007). " +
          "Returns a paginated list of public listings with title, description (truncated to 300 chars), price, location, category and vendor info. " +
          "All parameters are optional — call with no arguments to browse the latest listings. " +
          "Use get_classified to fetch full details of a specific listing.",
        annotations: {
          title: "Search Classifieds",
          readOnlyHint: true,
          destructiveHint: false,
        },
        inputSchema: {
          q: z
            .string()
            .optional()
            .describe("Full-text search query (searches title and description)"),
          cat_id: z
            .number()
            .int()
            .positive()
            .optional()
            .describe(
              "Category ID filter — includes subcategories automatically. Use get_categories to browse available categories."
            ),
          canton: z
            .string()
            .optional()
            .describe(
              "Swiss canton filter. Examples: Geneve, Vaud, Valais, Fribourg, Neuchatel, Berne, Jura"
            ),
          location: z
            .string()
            .optional()
            .describe("City name or postal code (NPA) — partial match"),
          price_min: z
            .number()
            .nonnegative()
            .optional()
            .describe("Minimum price in CHF (inclusive)"),
          price_max: z
            .number()
            .nonnegative()
            .optional()
            .describe("Maximum price in CHF (inclusive)"),
          sort: z
            .enum(["recent", "price_asc", "price_desc", "views"])
            .optional()
            .describe(
              "Sort order: recent (newest first, default), price_asc, price_desc, views"
            ),
          limit: z
            .number()
            .int()
            .min(1)
            .max(50)
            .optional()
            .describe("Results per page (1–50, default 20)"),
          offset: z
            .number()
            .int()
            .nonnegative()
            .optional()
            .describe(
              "Pagination offset. Use next_offset from previous response to get next page."
            ),
        },
      },
      async ({ q, cat_id, canton, location, price_min, price_max, sort, limit, offset }) => {
        const data = await joomilFetch(base, "/api/classifieds", {
          q,
          cat_id,
          canton,
          location,
          price_min,
          price_max,
          sort,
          limit,
          offset,
        });
        return toText(data);
      }
    );

    // ============================================================================
    // Tool : get_classified
    // ============================================================================

    this.server.registerTool(
      "get_classified",
      {
        description:
          "Get full details of a single classified ad on Joomil.ch by its numeric ID. " +
          "Returns complete description, all images URLs, category breadcrumb (full_path), " +
          "vendor info (name, certified status, pro company), expiry date and boost level. " +
          "Use search_classifieds first to find relevant listing IDs.",
        annotations: {
          title: "Get Classified",
          readOnlyHint: true,
          destructiveHint: false,
        },
        inputSchema: {
          id: z
            .number()
            .int()
            .positive()
            .describe(
              "Numeric listing ID — visible in the URL and in search_classifieds results"
            ),
        },
      },
      async ({ id }) => {
        const data = await joomilFetch(base, `/api/classifieds/${id}`);
        return toText(data);
      }
    );

    // ============================================================================
    // Tool : get_categories
    // ============================================================================

    this.server.registerTool(
      "get_categories",
      {
        description:
          "List active categories of the Joomil.ch marketplace. " +
          "Returns a flat list with parent_id for hierarchy reconstruction. " +
          "Omit parent_id for all categories, use parent_id=0 for root categories only, " +
          "or pass a specific ID to get direct children of that category.",
        annotations: {
          title: "Get Categories",
          readOnlyHint: true,
          destructiveHint: false,
        },
        inputSchema: {
          parent_id: z
            .number()
            .int()
            .nonnegative()
            .optional()
            .describe(
              "Filter to direct children of this category ID. " +
              "Omit for all categories. Use 0 for root categories only."
            ),
        },
      },
      async ({ parent_id }) => {
        const data = await joomilFetch(base, "/api/categories", { parent_id });
        return toText(data);
      }
    );
  }
}

export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) => {
    return JoomilMCP.serve("/mcp").fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;

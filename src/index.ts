import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

/**
 * Joomil MCP Server
 *
 * Exposes the Joomil.ch classifieds marketplace as MCP tools.
 * Four read-only tools:
 *   - search_classifieds : search listings with filters
 *   - get_classified     : get a single listing by ID
 *   - get_categories     : list categories (optionally by parent)
 *   - get_cantons        : list supported canton filter values
 *
 * Data source: Joomil public REST API (www.joomil.ch/api/*)
 */

interface Env {
  JOOMIL_API_BASE: string;
}

/**
 * Restricted categories — excluded from the MCP layer per content policy.
 * The underlying PHP API remains fully accessible for direct use.
 *
 * Root IDs:
 *   28    = Erotique
 *   14000 = Rencontres & Amitié
 *   651   = Voyance & Astrologie
 *
 * Descendant IDs are included because the upstream API accepts them directly.
 * URL/path slug checks provide a second guard if the upstream tree changes.
 */
const RESTRICTED_CATEGORY_IDS = new Set([
  28, 14000, 651,
  14250, 14100, 11024, 11025, 14200,
  657, 656, 14350, 14300, 663,
  658, 659, 660, 661, 16035,
  662, 11027, 650,
  246, 245, 243, 242, 649, 655,
  653, 652, 654,
]);

const RESTRICTED_CATEGORY_SLUGS = [
  "erotique",
  "rencontres-amitie",
  "voyance-astrologie",
];

interface CategoryLike {
  id?: number;
  parent_id?: number;
  name?: string;
  url?: string;
  full_path?: string;
}

function containsRestrictedSlug(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.toLowerCase();
  return RESTRICTED_CATEGORY_SLUGS.some(
    (slug) =>
      normalized.includes(`/${slug}/`) ||
      normalized.startsWith(`${slug}/`) ||
      normalized.startsWith(`${slug}-`) ||
      normalized.includes(`-${slug}-`)
  );
}

function isRestrictedCategory(category: CategoryLike | null | undefined): boolean {
  if (!category) return false;
  return (
    (category.id !== undefined && RESTRICTED_CATEGORY_IDS.has(category.id)) ||
    (category.parent_id !== undefined && RESTRICTED_CATEGORY_IDS.has(category.parent_id)) ||
    containsRestrictedSlug(category.url) ||
    containsRestrictedSlug(category.full_path)
  );
}

function restrictedCategoryError() {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ error: "This category is not available through this API." }),
      },
    ],
    isError: true,
  };
}

/**
 * Cantons supportés par le filtre `canton` de l'API Joomil.
 *
 * IMPORTANT : les valeurs `name` ci-dessous sont les formes EXACTES attendues
 * par l'API. Elles ne correspondent pas toujours au nom français usuel :
 *   - "Bern"    (forme allemande) — PAS "Berne"
 *   - "Geneve"  (sans accent)     — PAS "Genève" ni "Geneva"
 *   - "Neuchatel" (sans accent)   — PAS "Neuchâtel"
 * Les codes courts (GE, VD, VS...) et les formes accentuées NE filtrent PAS
 * l'API (silencieusement ignorés -> retourne l'ensemble des annonces).
 * D'où l'enum strict + l'outil get_cantons pour éviter l'hallucination.
 */
interface CantonDef {
  name: string;
  label_fr: string;
  code: string | null;
  region: string;
}

const SUPPORTED_CANTONS: readonly CantonDef[] = [
  { name: "Geneve",    label_fr: "Genève",            code: "GE", region: "Romandie" },
  { name: "Vaud",      label_fr: "Vaud",              code: "VD", region: "Romandie" },
  { name: "Valais",    label_fr: "Valais",            code: "VS", region: "Romandie" },
  { name: "Fribourg",  label_fr: "Fribourg",          code: "FR", region: "Romandie" },
  { name: "Neuchatel", label_fr: "Neuchâtel",         code: "NE", region: "Romandie" },
  { name: "Jura",      label_fr: "Jura",              code: "JU", region: "Romandie" },
  { name: "Bern",      label_fr: "Berne",             code: "BE", region: "Suisse alémanique" },
  { name: "Argovie",   label_fr: "Argovie",           code: "AG", region: "Suisse alémanique" },
  { name: "Zurich",    label_fr: "Zurich",            code: "ZH", region: "Suisse alémanique" },
  { name: "Lucerne",   label_fr: "Lucerne",           code: "LU", region: "Suisse alémanique" },
  { name: "Bale-Ville",label_fr: "Bâle-Ville",        code: "BS", region: "Suisse alémanique" },
  { name: "Etranger",  label_fr: "Étranger (hors CH)",code: null, region: "Hors Suisse" },
] as const;

const CANTON_NAMES = SUPPORTED_CANTONS.map((c) => c.name) as [string, ...string[]];

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
    headers: { "User-Agent": "joomil-mcp/1.1" },
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
function toText(data: unknown): {
  content: [{ type: "text"; text: string }];
  structuredContent?: Record<string, unknown>;
} {
  const result: {
    content: [{ type: "text"; text: string }];
    structuredContent?: Record<string, unknown>;
  } = {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  };

  if (data !== null && typeof data === "object" && !Array.isArray(data)) {
    result.structuredContent = data as Record<string, unknown>;
  }

  return result;
}

const PriceOutputSchema = z.object({
  amount: z.number().nullable(),
  currency: z.literal("CHF"),
});

const LocationOutputSchema = z.object({
  city: z.string().nullable(),
  postal_code: z.string().nullable(),
  canton: z.string().nullable(),
  country: z.string().nullable(),
});

const CategoryOutputSchema = z.object({
  id: z.number(),
  name: z.string(),
  url: z.string(),
});

const SearchAdOutputSchema = z.object({
  id: z.number(),
  title: z.string(),
  description: z.string().optional(),
  price: PriceOutputSchema,
  location: LocationOutputSchema,
  category: CategoryOutputSchema.nullable(),
  url: z.string(),
  created_at: z.string().nullable(),
  has_picture: z.boolean(),
  seller: z.object({
    name: z.string().nullable(),
    certified: z.boolean(),
  }),
});

const ClassifiedOutputSchema = SearchAdOutputSchema.extend({
  description: z.string().nullable(),
  category: CategoryOutputSchema.extend({
    path: z.string().nullable(),
  }).nullable(),
  images: z.array(z.string()),
  expires_at: z.string().nullable(),
  boost: z.number().nullable(),
  seller: z.object({
    name: z.string().nullable(),
    certified: z.boolean(),
    type: z.enum(["pro", "private"]),
    company: z.string().nullable(),
  }),
});

const ApiCategoryOutputSchema = z.object({
  id: z.number(),
  name: z.string(),
  url: z.string(),
  parent_id: z.number(),
  ad_count: z.number().optional(),
  allow_ads: z.boolean().optional(),
}).passthrough();

const CantonOutputSchema = z.object({
  name: z.string(),
  label_fr: z.string(),
  code: z.string().nullable(),
  region: z.string(),
});

const SearchClassifiedsOutputSchema = {
  results: z.array(SearchAdOutputSchema),
  total: z.number(),
  limit: z.number(),
  offset: z.number(),
  has_more: z.boolean(),
  next_offset: z.number().nullable(),
  filtered_out: z.number(),
};

const GetClassifiedOutputSchema = ClassifiedOutputSchema.shape;

const GetCategoriesOutputSchema = {
  categories: z.array(ApiCategoryOutputSchema),
  total: z.number(),
};

const GetCantonsOutputSchema = {
  cantons: z.array(CantonOutputSchema),
  total: z.number(),
};

/**
 * Projection d'une annonce (niveau liste / search).
 *
 * Normalise la sortie pour qu'elle soit déterministe et allégée en tokens :
 *   - price  -> objet { amount, currency } (CHF, marché suisse)
 *   - seller -> { name, certified } (le type pro/particulier n'est pas
 *     disponible au niveau liste, seulement sur get_classified)
 *   - created_at depuis date_published
 * Les champs non documentés de l'API sont écartés pour réduire le bruit.
 */
interface SearchAd {
  id: number;
  title: string;
  description?: string;
  url: string;
  price: number | null;
  location?: { city?: string; postal_code?: string; canton?: string; country?: string };
  category?: CategoryLike & { id: number; name: string; url: string };
  has_picture?: boolean;
  boost?: number | null;
  date_published?: string;
  vendor?: { name?: string; certified?: boolean };
}

function projectSearchAd(ad: SearchAd) {
  return {
    id: ad.id,
    title: ad.title,
    description: ad.description,
    price: {
      amount: ad.price ?? null,
      currency: "CHF",
    },
    location: {
      city: ad.location?.city ?? null,
      postal_code: ad.location?.postal_code ?? null,
      canton: ad.location?.canton ?? null,
      country: ad.location?.country ?? null,
    },
    category: ad.category
      ? { id: ad.category.id, name: ad.category.name, url: ad.category.url }
      : null,
    url: ad.url,
    created_at: ad.date_published ?? null,
    has_picture: ad.has_picture ?? false,
    seller: {
      name: ad.vendor?.name ?? null,
      certified: ad.vendor?.certified ?? false,
    },
  };
}

function projectSearchResult(data: unknown) {
  const d = data as { ads?: SearchAd[]; total?: number; limit?: number; offset?: number; has_more?: boolean; next_offset?: number };
  const ads = (d.ads ?? []).filter((ad) => !isRestrictedCategory(ad.category));
  return {
    results: ads.map(projectSearchAd),
    total: d.total ?? 0,
    limit: d.limit ?? 0,
    offset: d.offset ?? 0,
    has_more: d.has_more ?? false,
    next_offset: d.next_offset ?? null,
    filtered_out: (d.ads ?? []).length - ads.length,
  };
}

/**
 * Projection d'une annonce (détail / get_classified).
 *
 * Ajoute par rapport à la liste :
 *   - description complète (non tronquée)
 *   - category.path (breadcrumb full_path)
 *   - images (tableau d'URLs)
 *   - expires_at (date_expire)
 *   - boost
 *   - seller.type ("pro" | "private") et seller.company
 */
interface DetailAd extends SearchAd {
  images?: string[];
  date_expire?: string;
  vendor?: { name?: string; certified?: boolean; is_pro?: boolean; company_name?: string | null };
}

function projectClassified(data: unknown) {
  const ad = (data as { ad?: DetailAd }).ad;
  if (!ad) return data;
  const vendor = ad.vendor ?? {};
  return {
    id: ad.id,
    title: ad.title,
    description: ad.description ?? null,
    price: {
      amount: ad.price ?? null,
      currency: "CHF",
    },
    location: {
      city: ad.location?.city ?? null,
      postal_code: ad.location?.postal_code ?? null,
      canton: ad.location?.canton ?? null,
      country: ad.location?.country ?? null,
    },
    category: ad.category
      ? {
          id: ad.category.id,
          name: ad.category.name,
          url: ad.category.url,
          path: (ad.category as { full_path?: string }).full_path ?? null,
        }
      : null,
    images: ad.images ?? [],
    url: ad.url,
    created_at: ad.date_published ?? null,
    expires_at: ad.date_expire ?? null,
    has_picture: ad.has_picture ?? false,
    boost: ad.boost ?? null,
    seller: {
      name: vendor.name ?? null,
      certified: vendor.certified ?? false,
      type: vendor.is_pro ? "pro" : "private",
      company: vendor.company_name ?? null,
    },
  };
}

export class JoomilMCP extends McpAgent<Env> {
  server = new McpServer({
    name: "joomil-mcp",
    version: "1.1.0",
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
            .enum(CANTON_NAMES)
            .optional()
            .describe(
              "Swiss canton filter — strict enum. Use get_cantons for the official list. " +
              "WARNING: values are API-specific (e.g. 'Bern' not 'Berne', 'Geneve' not 'Genève'/'Geneva'). " +
              "Supported: Geneve, Vaud, Valais, Fribourg, Neuchatel, Jura, Bern, Argovie, Zurich, Lucerne, Bale-Ville, Etranger."
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
        outputSchema: SearchClassifiedsOutputSchema,
      },
      async ({ q, cat_id, canton, location, price_min, price_max, sort, limit, offset }) => {
        if (cat_id !== undefined && isRestrictedCategory({ id: cat_id })) {
          return restrictedCategoryError();
        }
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
        return toText(projectSearchResult(data));
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
        outputSchema: GetClassifiedOutputSchema,
      },
      async ({ id }) => {
        const data = await joomilFetch(base, `/api/classifieds/${id}`);
        const ad = (data as { ad?: DetailAd }).ad;
        if (isRestrictedCategory(ad?.category)) {
          return restrictedCategoryError();
        }
        return toText(projectClassified(data));
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
        outputSchema: GetCategoriesOutputSchema,
      },
      async ({ parent_id }) => {
        if (parent_id !== undefined && isRestrictedCategory({ id: parent_id })) {
          return toText({ categories: [], total: 0 });
        }
        const data = await joomilFetch(base, "/api/categories", { parent_id }) as { categories: Array<{ id: number; [key: string]: unknown }>; total: number };
        const categories = data.categories.filter((cat) => !isRestrictedCategory(cat));
        const filtered = {
          ...data,
          categories,
          total: categories.length,
        };
        return toText(filtered);
      }
    );

    // ============================================================================
    // Tool : get_cantons
    // ============================================================================
    //
    // L'API Joomil n'expose pas d'endpoint de liste des cantons. Les valeurs
    // attendues par le filtre `canton` sont spécifiques (formes non accentuées,
    // parfois alémaniques : "Bern" et non "Berne") et les variantes invalides
    // sont ignorées silencieusement -> l'agent croit filtrer mais reçoit tout.
    // Cet outil fige la liste officielle pour empêcher l'hallucination.

    this.server.registerTool(
      "get_cantons",
      {
        description:
          "List the Swiss cantons supported by Joomil's `canton` filter. " +
          "Returns the exact `name` value to pass to search_classifieds, plus a readable French label. " +
          "Call this before filtering by canton — the API values are non-obvious " +
          "(e.g. 'Bern' not 'Berne', 'Geneve' not 'Genève' or 'Geneva').",
        annotations: {
          title: "Get Cantons",
          readOnlyHint: true,
          destructiveHint: false,
        },
        inputSchema: {},
        outputSchema: GetCantonsOutputSchema,
      },
      async () => {
        return toText({ cantons: SUPPORTED_CANTONS, total: SUPPORTED_CANTONS.length });
      }
    );
  }
}

export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) => {
    return JoomilMCP.serve("/mcp").fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;

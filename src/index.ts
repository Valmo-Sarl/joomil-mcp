import { McpAgent } from "agents/mcp";
import { createMcpHandler } from "agents/mcp/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpServer as ModernMcpServer, isLegacyRequest } from "@modelcontextprotocol/server";
import { z } from "zod";
import { apiRequest, guardMcpRequest, guardMcpTool, guardStatelessMcpTool, type AccessEnv } from "./access";
import { buildTaxonomy, hasRestrictedPath, restrictedRoots, suggestCategory,
  type CategorySuggestion, type Taxonomy } from "./taxonomy";

/**
 * Joomil MCP Server
 *
 * Exposes the Joomil.ch classifieds marketplace as MCP tools.
 * Five read-only tools:
 *   - search_classifieds : search listings with filters
 *   - get_classified     : get a single listing by ID
 *   - get_categories     : list categories (optionally by parent)
 *   - get_cantons        : list supported canton filter values
 *   - suggest_filters    : infer search filters from a natural-language query
 *
 * Data source: Joomil public REST API (www.joomil.ch/api/*)
 */

interface Env extends AccessEnv {
  JOOMIL_API_BASE: string;
}

interface CategoryLike {
  id?: number;
  name?: string;
  url?: string;
  full_path?: string;
}

function isAllowedCategory(taxonomy: Taxonomy, category?: CategoryLike | null, parent?: number | null): boolean {
  const path = category?.id === undefined ? undefined : taxonomy.paths.get(category.id);
  return !!path && !hasRestrictedPath(category?.url) && !hasRestrictedPath(category?.full_path)
    && (parent == null || path.some((item) => item.id === parent));
}

function restrictedCategoryError() {
  return toError({ error: "This category is not available through this API.", status: 404 });
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
const DEFAULT_SEARCH_LIMIT = 20;
const CATEGORY_CACHE_TTL_MS = 10 * 60 * 1000;
const MCP_REQUEST_MAX_BYTES = 64 * 1024;
const SERVER_INFO = { name: "joomil-mcp", version: "1.3.3" };
const ACTIVE_SCOPE = "active_general_v1";

class JoomilApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

/**
 * Performs a GET request to the Joomil API and returns parsed JSON.
 * Throws a descriptive error on HTTP failure.
 */
async function joomilFetch(
  baseUrl: string,
  path: string,
  params: Record<string, string | number | undefined>,
  token: string
): Promise<unknown> {
  const request = apiRequest(baseUrl, path, params, token);
  const signal = AbortSignal.timeout(8000);
  try {
    const response = await fetch(request, { signal });

    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw new JoomilApiError(response.status, response.status === 404
        ? "Joomil listing was not found or is no longer public."
        : "Joomil API request failed.");
    }

    return await response.json();
  } catch (error) {
    if (error instanceof JoomilApiError) throw error;
    throw new JoomilApiError(signal.aborted ? 504 : 502, signal.aborted
      ? "Joomil API timed out. Try again later."
      : "Joomil API returned an invalid or unavailable response.");
  }
}

async function fetchActiveInventory(base: string, path: string, params: Record<string, string | number | undefined>, token: string) {
  const payload = await joomilFetch(base, path, { ...params, scope: ACTIVE_SCOPE }, token);
  // Older origins ignore unknown query parameters. Do not silently serve their unfiltered inventory.
  if ((payload as { scope?: unknown } | null)?.scope !== ACTIVE_SCOPE) {
    throw new JoomilApiError(503, "Joomil active inventory is temporarily unavailable.");
  }
  return payload;
}

function toError(data: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
    isError: true,
  };
}

function toToolError(error: unknown) {
  if (error instanceof JoomilApiError) {
    return toError({
      error: error.message,
      status: error.status,
    });
  }

  return toError({
    error: "Joomil MCP could not process the request.",
    status: 502,
  });
}

/**
 * Wraps API data as MCP text content.
 */
function toText(data: unknown, summary?: string): {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
} {
  const serialized = JSON.stringify(data) ?? String(data);
  const result: {
    content: Array<{ type: "text"; text: string }>;
    structuredContent?: Record<string, unknown>;
  } = {
    content: summary
      ? [
          { type: "text", text: summary },
          { type: "text", text: serialized },
        ]
      : [{ type: "text", text: serialized }],
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
  boost: z.enum(["star", "flash"]).nullable(),
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
});

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

const SearchFiltersOutputSchema = z.object({
  q: z.string().nullable(),
  cat_id: z.number().nullable(),
  canton: z.enum(CANTON_NAMES).nullable(),
  location: z.string().nullable(),
  price_min: z.number().nullable(),
  price_max: z.number().nullable(),
  sort: z.enum(["recent", "price_asc", "price_desc", "views"]),
  limit: z.number(),
});

const SuggestedCategoryOutputSchema = z.object({
  id: z.number(),
  name: z.string(),
  url: z.string(),
  parent_id: z.number(),
  confidence: z.number(),
  reason: z.string(),
}).nullable();

const SuggestFiltersOutputSchema = {
  query: z.string(),
  filters: SearchFiltersOutputSchema,
  category: SuggestedCategoryOutputSchema,
  confidence: z.number(),
  warnings: z.array(z.string()),
  next_step: z.string(),
};

let categoryCache: {
  baseUrl: string;
  expiresAt: number;
  taxonomy: Taxonomy;
} | null = null;

async function getCachedTaxonomy(baseUrl: string, token: string): Promise<Taxonomy> {
  const now = Date.now();
  if (categoryCache && categoryCache.baseUrl === baseUrl && categoryCache.expiresAt > now) {
    return categoryCache.taxonomy;
  }

  const parsed = z.object(GetCategoriesOutputSchema).parse(await joomilFetch(baseUrl, "/api/categories", {}, token));
  const taxonomy = buildTaxonomy(parsed.categories);
  if (parsed.total !== parsed.categories.length || !taxonomy.categories.length) {
    throw new JoomilApiError(503, "Joomil category catalog is temporarily unavailable.");
  }
  categoryCache = { baseUrl, expiresAt: now + CATEGORY_CACHE_TTL_MS, taxonomy };
  return taxonomy;
}

interface PriceExtraction {
  price_min: number | null;
  price_max: number | null;
}

interface CantonMatch {
  canton: (typeof CANTON_NAMES)[number] | null;
  matched: string | null;
}

const COMMON_LOCATIONS = [
  "Genève",
  "Lausanne",
  "Sion",
  "Fribourg",
  "Neuchâtel",
  "Yverdon",
  "Yverdon-les-Bains",
  "Montreux",
  "Vevey",
  "Nyon",
  "Morges",
  "Martigny",
  "Monthey",
  "Bulle",
  "Renens",
  "Bienne",
  "Delémont",
  "La Chaux-de-Fonds",
  "Sierre",
];

const STOPWORDS = new Set([
  "a", "au", "aux", "avec", "budget", "canton", "ch", "chf", "chez", "dans", "de", "des", "du", "en", "et",
  "franc", "francs",
  "la", "le", "les", "me", "moi", "mon", "ma", "mes", "pour", "sur", "un",
  "une", "romande", "romandie", "suisse", "the", "in", "on", "under", "with",
]);

const CATEGORY_REMOVE_TERMS = new Set([
  "annonce", "annonces", "achat", "acheter", "appartement", "appartements",
  "appart", "auto", "automobile", "automobiles", "camion", "canape",
  "categorie", "emploi", "emplois", "immobilier", "job", "jobs", "location",
  "louer", "maison", "maisons", "meuble", "meubles", "moto", "motos",
  "scooter", "service", "services", "studio", "vente", "vendre", "vehicule",
  "vehicules", "villa", "villas", "voiture", "voitures",
]);

function normalizeText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[’`]/g, "'")
    .toLowerCase()
    .replace(/[^a-z0-9' -]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stemToken(token: string): string {
  if (token.length > 4 && token.endsWith("s")) {
    return token.slice(0, -1);
  }
  return token;
}

function tokenize(value: string): string[] {
  return normalizeText(value)
    .split(" ")
    .map(stemToken)
    .filter((token) => token.length >= 2 && !STOPWORDS.has(token));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseAmount(value: string): number | null {
  let normalized = value.replace(/[\s'’]/g, "");
  if (/^\d{1,3}([,.]\d{3})+$/.test(normalized)) {
    normalized = normalized.replace(/[,.]/g, "");
  } else if (/^\d+,\d{1,2}$/.test(normalized)) {
    normalized = normalized.replace(",", ".");
  } else {
    normalized = normalized.replace(/,/g, "");
  }
  const amount = Number(normalized);
  return Number.isFinite(amount) ? amount : null;
}

const AMOUNT_PATTERN = String.raw`(?:CHF\s*)?(\d+(?:[\s'’.,]\d{3})*(?:[,.]\d{1,2})?|\d+(?:[,.]\d+)?)(?:\s*([kK]))?(?:\s*(?:CHF|francs?))?`;
// In "à moins de", the à belongs to the price comparison, not the place that
// follows it. Require a word boundary so a product name ending in a survives.
const BUDGET_PREPOSITION = String.raw`(?:(?<![\p{L}\p{N}])[aà]\s+)?`;
const MAX_PRICE_PATTERN = String.raw`(?:${BUDGET_PREPOSITION}moins\s+(?:de|que)|sous|budget(?:\s+de)?|max(?:imum)?|jusqu['’]?a|jusqu'a|jusqu’à|<=|<)\s*${AMOUNT_PATTERN}`;
const MIN_PRICE_PATTERN = String.raw`(?:${BUDGET_PREPOSITION}plus\s+(?:de|que)|min(?:imum)?|dès|des|from|a\s+partir\s+de|à\s+partir\s+de|>=|>)\s*${AMOUNT_PATTERN}`;

function amountFromCaptures(amountText: string | undefined, suffix: string | undefined): number | null {
  if (!amountText) return null;
  const amount = parseAmount(amountText);
  if (amount === null) return null;
  return suffix?.toLowerCase() === "k" ? amount * 1000 : amount;
}

function extractPrices(query: string): PriceExtraction {
  const betweenPattern = new RegExp(
    String.raw`(?:entre|between)\s+${AMOUNT_PATTERN}\s+(?:et|and|a|à|-|–|—)\s+${AMOUNT_PATTERN}`,
    "i"
  );
  const rangePattern = new RegExp(String.raw`\b${AMOUNT_PATTERN}\s*(?:-|–|—)\s*${AMOUNT_PATTERN}\b`, "i");
  const maxPattern = new RegExp(MAX_PRICE_PATTERN, "iu");
  const minPattern = new RegExp(MIN_PRICE_PATTERN, "iu");
  const prefixedCurrencyPattern = /\bCHF\s*(\d+(?:[\s'’.,]\d{3})*(?:[,.]\d{1,2})?|\d+(?:[,.]\d+)?)(?:\s*([kK]))?\b/i;
  const suffixedCurrencyPattern = /\b(\d+(?:[\s'’.,]\d{3})*(?:[,.]\d{1,2})?|\d+(?:[,.]\d+)?)(?:\s*([kK]))?\s*(?:CHF|francs?)\b/i;
  const standaloneKPattern = /\b(\d+(?:[,.]\d+)?)\s*k\b/i;
  const price: PriceExtraction = { price_min: null, price_max: null };

  const betweenMatch = query.match(betweenPattern);
  if (betweenMatch) {
    price.price_min = amountFromCaptures(betweenMatch[1], betweenMatch[2]);
    price.price_max = amountFromCaptures(betweenMatch[3], betweenMatch[4]);
    return price;
  }

  const rangeMatch = query.match(rangePattern);
  if (rangeMatch) {
    price.price_min = amountFromCaptures(rangeMatch[1], rangeMatch[2]);
    price.price_max = amountFromCaptures(rangeMatch[3], rangeMatch[4]);
    return price;
  }

  const maxMatch = query.match(maxPattern);
  if (maxMatch) {
    price.price_max = amountFromCaptures(maxMatch[1], maxMatch[2]);
  }

  const minMatch = query.match(minPattern);
  if (minMatch) {
    price.price_min = amountFromCaptures(minMatch[1], minMatch[2]);
  }

  if (price.price_min === null && price.price_max === null) {
    const currencyMatch = query.match(prefixedCurrencyPattern) ?? query.match(suffixedCurrencyPattern);
    const kMatch = query.match(standaloneKPattern);
    if (currencyMatch) price.price_max = amountFromCaptures(currencyMatch[1], currencyMatch[2]);
    else if (kMatch) price.price_max = amountFromCaptures(kMatch[1], "k");
  }

  return price;
}

function removePricePhrases(query: string): string {
  const betweenPattern = new RegExp(
    String.raw`(?:entre|between)\s+${AMOUNT_PATTERN}\s+(?:et|and|a|à|-|–|—)\s+${AMOUNT_PATTERN}`,
    "gi"
  );
  const rangePattern = new RegExp(String.raw`\b${AMOUNT_PATTERN}\s*(?:-|–|—)\s*${AMOUNT_PATTERN}\b`, "gi");
  const maxPattern = new RegExp(MAX_PRICE_PATTERN, "giu");
  const minPattern = new RegExp(MIN_PRICE_PATTERN, "giu");
  const prefixedCurrencyPattern = /\bCHF\s*\d+(?:[\s'’.,]\d{3})*(?:[,.]\d{1,2})?(?:\s*[kK])?\b/gi;
  const suffixedCurrencyPattern = /\b\d+(?:[\s'’.,]\d{3})*(?:[,.]\d{1,2})?(?:\s*[kK])?\s*(?:CHF|francs?)\b/gi;
  const standaloneKPattern = /\b\d+(?:[,.]\d+)?\s*k\b/gi;

  return query
    .replace(betweenPattern, " ")
    .replace(rangePattern, " ")
    .replace(maxPattern, " ")
    .replace(minPattern, " ")
    .replace(prefixedCurrencyPattern, " ")
    .replace(suffixedCurrencyPattern, " ")
    .replace(standaloneKPattern, " ");
}

function cantonAliases(canton: CantonDef): string[] {
  const aliases = [canton.name, canton.label_fr];
  if (canton.code) aliases.push(canton.code);

  if (canton.name === "Geneve") aliases.push("Genève", "Geneva");
  if (canton.name === "Bern") aliases.push("Berne");
  if (canton.name === "Bale-Ville") aliases.push("Bâle-Ville", "Bale Ville", "Bâle Ville", "Basel");
  if (canton.name === "Etranger") aliases.push("Étranger", "Hors Suisse");

  return aliases;
}

function findCanton(query: string): CantonMatch {
  const normalizedQuery = normalizeText(query);
  const queryTokens = new Set(tokenize(query));

  for (const canton of SUPPORTED_CANTONS) {
    const aliases = cantonAliases(canton).sort((a, b) => b.length - a.length);
    for (const alias of aliases) {
      const normalizedAlias = normalizeText(alias);
      if (!normalizedAlias) continue;

      if (normalizedAlias.length <= 2) {
        if (queryTokens.has(normalizedAlias)) {
          return { canton: canton.name, matched: alias };
        }
      } else if (normalizedQuery.includes(normalizedAlias)) {
        return { canton: canton.name, matched: alias };
      }
    }
  }

  return { canton: null, matched: null };
}

const POSTAL_LOCATION = /(?:^|\s)(?:[aà]|in|sur|vers|npa|code(?:\s+postal)?|pr[eè]s\s+de|proche\s+de)\s+(\d{4})\b/i;
const LOCATION_PREPOSITION = "(?:[aà]|sur|in|près\\s+de|pres\\s+de|proche\\s+de)";

function findLocation(query: string, canton: CantonMatch): string | null {
  const normalizedQuery = normalizeText(query);

  for (const location of [...COMMON_LOCATIONS].sort((a, b) => b.length - a.length)) {
    const normalizedLocation = normalizeText(location);
    const isCantonPhrase =
      normalizedQuery.includes(`canton de ${normalizedLocation}`) ||
      normalizedQuery.includes(`canton ${normalizedLocation}`);

    if (!isCantonPhrase && new RegExp(`\\b${escapeRegExp(normalizedLocation)}\\b`).test(normalizedQuery)) {
      return location;
    }
  }

  // A bare four-digit token can be a model year or a price, not a postal code.
  const postalCode = query.match(POSTAL_LOCATION);
  if (postalCode?.[1]) return postalCode[1];

  const genericMatch = query.match(/(?:^|\s)(?:à|a|sur|in|près de|pres de|proche de)\s+([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ' -]{1,40})/i);
  if (!genericMatch?.[1]) return null;

  const candidate = genericMatch[1]
    .split(/\s+(?:dans|canton|moins|sous|avec|pour|max|min|chf|francs?|tri|sort)\b/i)[0]
    .trim();
  const normalizedCandidate = normalizeText(candidate);
  const excluded = new Set(["moins", "vendre", "louer", "partir"]);

  if (
    !candidate ||
    excluded.has(normalizedCandidate) ||
    normalizedCandidate.split(" ").length > 3 ||
    (canton.matched && normalizedCandidate === normalizeText(canton.matched))
  ) {
    return null;
  }

  return candidate;
}

function removeCantonPhrase(query: string, canton: CantonMatch): string {
  if (!canton.matched) return query;
  const alias = escapeRegExp(canton.matched);
  return query
    .replace(new RegExp(`\\b(?:dans\\s+le\\s+)?canton\\s+(?:de\\s+)?${alias}\\b`, "gi"), " ")
    .replace(new RegExp(`\\b${alias}\\b`, "gi"), " ");
}

function removeLocationPhrase(query: string, location: string | null): string {
  if (!location) return query;
  if (/^\d{4}$/.test(location)) {
    return query.replace(POSTAL_LOCATION, (match, postalCode) => postalCode === location ? " " : match);
  }
  const escaped = escapeRegExp(location);
  return query
    .replace(new RegExp(`(^|\\s)${LOCATION_PREPOSITION}\\s+${escaped}(?=$|[^\\p{L}\\p{N}-])`, "giu"), " ")
    .replace(new RegExp(`(^|[^\\p{L}\\p{N}-])${escaped}(?=$|[^\\p{L}\\p{N}-])`, "giu"), "$1 ");
}

function buildCleanQuery(
  queryWithoutPrice: string,
  canton: CantonMatch,
  location: string | null,
  category: CategorySuggestion | null
): string | null {
  let cleaned = removeCantonPhrase(queryWithoutPrice, canton);
  cleaned = removeLocationPhrase(cleaned, location);

  // Without a category filter, dropping product words can silently broaden the search.
  const removableTerms = new Set(category?.matchedTerms.filter((term) => CATEGORY_REMOVE_TERMS.has(term)));

  const remaining = cleaned
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean)
    .filter((token) => {
      const normalized = stemToken(normalizeText(token));
      return normalized && !removableTerms.has(normalized) && !STOPWORDS.has(normalized);
    })
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  return remaining || null;
}

function buildFilterSuggestion(query: string, taxonomy: Taxonomy) {
  const prices = extractPrices(query);
  const withoutPrice = removePricePhrases(query);
  const canton = findCanton(withoutPrice);
  const location = findLocation(withoutPrice, canton);
  const category = suggestCategory(taxonomy, withoutPrice);
  const hasUsedCondition = /\bd['’]occasion\b/i.test(withoutPrice);
  const q = category?.categoryOnly ? null
    : buildCleanQuery(withoutPrice.replace(/\bd['’]occasion\b/gi, " "), canton, location, category);
  const sort = prices.price_max !== null ? "price_asc" : "recent";
  const warnings: string[] = [];

  if (!category) {
    warnings.push("No confident category match. Use get_categories if category precision matters.");
  }
  if (hasUsedCondition) {
    warnings.push("Used condition is not a structured filter; check the listing title and description.");
  }

  if (!q && !category && !location && !canton.canton) {
    warnings.push("The query is broad. Search will browse recent listings unless you add filters.");
  }

  const confidenceSignals = [
    category?.confidence,
    canton.canton ? 0.9 : undefined,
    location ? 0.75 : undefined,
    prices.price_min !== null || prices.price_max !== null ? 0.85 : undefined,
    q ? 0.65 : undefined,
  ].filter((value): value is number => value !== undefined);
  const confidence = confidenceSignals.length > 0
    ? confidenceSignals.reduce((sum, value) => sum + value, 0) / confidenceSignals.length
    : 0.35;

  const filters = {
    q,
    cat_id: category?.category.id ?? null,
    canton: canton.canton,
    location,
    price_min: prices.price_min,
    price_max: prices.price_max,
    sort,
    limit: DEFAULT_SEARCH_LIMIT,
  };

  return {
    query,
    filters,
    category: category
      ? {
          id: category.category.id,
          name: category.category.name,
          url: category.category.url,
          parent_id: category.category.parent_id,
          confidence: category.confidence,
          reason: category.reason,
        }
      : null,
    confidence: Number(confidence.toFixed(2)),
    warnings,
    next_step: "The filters object can be passed unchanged to search_classifieds.",
  };
}

function summarizeSuggestion(result: ReturnType<typeof buildFilterSuggestion>): string {
  const parts = [
    result.filters.cat_id !== null ? `cat_id=${result.filters.cat_id}` : null,
    result.filters.q ? `q="${result.filters.q}"` : null,
    result.filters.location ? `location="${result.filters.location}"` : null,
    result.filters.canton ? `canton=${result.filters.canton}` : null,
    result.filters.price_min !== null ? `price_min=${result.filters.price_min}` : null,
    result.filters.price_max !== null ? `price_max=${result.filters.price_max}` : null,
    `sort=${result.filters.sort}`,
  ].filter(Boolean);

  const warning = result.warnings.length > 0 ? ` ${result.warnings.join(" ")}` : "";
  return `Filtres suggérés pour "${result.query}": ${parts.join(", ")}. Confiance ${result.confidence}.${warning}`;
}

function summarizeSearchResult(result: ReturnType<typeof projectSearchResult>): string {
  const count = result.results.length;
  const filtered = result.filtered_out > 0 ? ` ${result.filtered_out} annonce(s) filtrée(s) par restrictions MCP.` : "";
  const next = result.has_more && result.next_offset !== null
    ? ` Utilise offset=${result.next_offset} pour la suite.`
    : "";
  return `${count} annonce(s) retournée(s) sur ${result.total}.${filtered}${next}`;
}

function summarizeClassified(result: ReturnType<typeof projectClassified>): string {
  if (result === null || typeof result !== "object" || !("title" in result)) {
    return "Détail d'annonce retourné.";
  }

  const ad = result as { title?: string; price?: { amount?: number | null; currency?: string }; location?: { city?: string | null } };
  const price = ad.price?.amount !== null && ad.price?.amount !== undefined
    ? `${ad.price.amount} ${ad.price.currency ?? "CHF"}`
    : "prix sur demande";
  const location = ad.location?.city ? ` à ${ad.location.city}` : "";
  return `${ad.title ?? "Annonce"}: ${price}${location}.`;
}

function summarizeCategories(total: number): string {
  return `${total} catégorie(s) retournée(s).`;
}

function summarizeCantons(total: number): string {
  return `${total} valeur(s) de canton disponibles. Utilise le champ name avec search_classifieds.`;
}

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
  boost?: "star" | "flash" | null;
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

function projectSearchResult(data: unknown, taxonomy: Taxonomy, catId?: number | null) {
  const d = data as { ads?: SearchAd[]; total?: number; limit?: number; offset?: number; has_more?: boolean; next_offset?: number } | null;
  if (!Array.isArray(d?.ads)) throw new JoomilApiError(502, "Joomil API did not return a usable listing page.");
  const ads = d.ads.filter((ad) => isAllowedCategory(taxonomy, ad?.category, catId));
  return {
    results: ads.map(projectSearchAd),
    total: d.total ?? 0,
    limit: d.limit ?? 0,
    offset: d.offset ?? 0,
    has_more: d.has_more ?? false,
    next_offset: d.next_offset ?? null,
    filtered_out: d.ads.length - ads.length,
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

function projectClassified(ad: DetailAd) {
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

type RegisterJoomilTool = <I extends z.ZodRawShape, O extends z.ZodRawShape>(
  name: string,
  config: {
    title: string; description: string;
    annotations: { title: string; readOnlyHint: true; destructiveHint: false; openWorldHint: boolean };
    inputSchema: I; outputSchema: O;
  },
  callback: (args: z.output<z.ZodObject<I>>) => Promise<ReturnType<typeof toText> | ReturnType<typeof toError>>,
) => void;

function registerJoomilTools(
  register: RegisterJoomilTool,
  env: Env,
  checkQuota: () => Promise<429 | 503 | null>,
): void {
  const checkToolQuota = async () => {
    const status = await checkQuota().catch(() => 503 as const);
    return status === null ? null : toError({
      error: status === 429 ? "Too many tool calls" : "Service temporarily unavailable",
      status, retry_after: status === 429 ? 60 : 5,
    });
  };
    const base = env.JOOMIL_API_BASE ?? "https://www.joomil.ch";
    const token = env.JOOMIL_API_TOKEN;

    // ============================================================================
    // Tool : suggest_filters
    // ============================================================================

    register(
      "suggest_filters",
      {
        title: "Suggest Filters",
        description:
          "Suggest Joomil listing filters from a short free-text query about a category, place or budget. " +
          "Returns filters, a category confidence score and warnings, not matching listings.",
        annotations: {
          title: "Suggest Filters",
          readOnlyHint: true,
          destructiveHint: false,
          openWorldHint: true,
        },
        inputSchema: {
          query: z
            .string()
            .trim()
            .min(1)
            .max(500)
            .describe("Natural-language search request, e.g. 'appartement 3 pièces à Sion' or 'Tesla Model 3 moins de 25000 CHF'."),
        },
        outputSchema: SuggestFiltersOutputSchema,
      },
      async ({ query }) => {
        const denied = await checkToolQuota();
        if (denied) return denied;
        try {
          const taxonomy = await getCachedTaxonomy(base, token);
          const suggestion = buildFilterSuggestion(query, taxonomy);
          return toText(suggestion, summarizeSuggestion(suggestion));
        } catch (error) {
          return toToolError(error);
        }
      }
    );

    // ============================================================================
    // Tool : search_classifieds
    // ============================================================================

    register(
      "search_classifieds",
      {
        title: "Search Classifieds",
        description:
          "Search active, unexpired public Joomil.ch classified ads in general-audience categories by keyword, category, place or budget. " +
          "Returns a paginated list with titles, short descriptions, prices in CHF, locations and listing URLs. " +
          "With no filters, returns recent listings. No seller contact details or transactions.",
        annotations: {
          title: "Search Classifieds",
          readOnlyHint: true,
          destructiveHint: false,
          openWorldHint: true,
        },
        inputSchema: {
          q: z
            .string()
            .nullish()
            .describe("Full-text search query (searches title and description)"),
          cat_id: z
            .number()
            .int()
            .positive()
            .nullish()
            .describe(
              "Category ID filter — includes subcategories automatically. Use get_categories to browse available categories."
            ),
          canton: z
            .enum(CANTON_NAMES)
            .nullish()
            .describe(
              "Swiss canton filter — strict enum. Use get_cantons for the official list. " +
              "WARNING: values are API-specific (e.g. 'Bern' not 'Berne', 'Geneve' not 'Genève'/'Geneva'). " +
              "Supported: Geneve, Vaud, Valais, Fribourg, Neuchatel, Jura, Bern, Argovie, Zurich, Lucerne, Bale-Ville, Etranger."
            ),
          location: z
            .string()
            .nullish()
            .describe("City name or postal code (NPA) — partial match"),
          price_min: z
            .number()
            .nonnegative()
            .nullish()
            .describe("Minimum price in CHF (inclusive)"),
          price_max: z
            .number()
            .nonnegative()
            .nullish()
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
        const denied = await checkToolQuota();
        if (denied) return denied;
        try {
          if (cat_id != null && restrictedRoots.has(cat_id)) {
            return restrictedCategoryError();
          }
          if (price_min != null && price_max != null && price_min > price_max) {
            return toError({ error: "Minimum price must not exceed maximum price.", status: 400 });
          }
          const taxonomy = await getCachedTaxonomy(base, token);
          if (cat_id != null && !taxonomy.paths.has(cat_id)) return restrictedCategoryError();
          const data = await fetchActiveInventory(base, "/api/classifieds", {
            q: q ?? undefined,
            cat_id: cat_id ?? undefined,
            canton: canton ?? undefined,
            location: location ?? undefined,
            price_min: price_min ?? undefined,
            price_max: price_max ?? undefined,
            sort,
            limit,
            offset,
          }, token);
          const result = projectSearchResult(data, taxonomy, cat_id);
          return toText(result, summarizeSearchResult(result));
        } catch (error) {
          return toToolError(error);
        }
      }
    );

    // ============================================================================
    // Tool : get_classified
    // ============================================================================

    register(
      "get_classified",
      {
        title: "Get Classified",
        description:
          "Get full details of a single classified ad on Joomil.ch by its numeric ID. " +
          "Returns complete description, all images URLs, category breadcrumb (full_path), " +
          "public seller info (name, certified status, pro company), expiry date and boost level.",
        annotations: {
          title: "Get Classified",
          readOnlyHint: true,
          destructiveHint: false,
          openWorldHint: true,
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
        const denied = await checkToolQuota();
        if (denied) return denied;
        try {
          const taxonomy = await getCachedTaxonomy(base, token);
          const data = await fetchActiveInventory(base, `/api/classifieds/${id}`, {}, token);
          const ad = (data as { ad?: DetailAd } | null)?.ad;
          if (!ad || ad.id !== id || !ad.category || !(ad.category.id > 0)) {
            return toError({ error: "Joomil API did not return a usable public listing.", status: 502 });
          }
          if (!isAllowedCategory(taxonomy, ad.category)) {
            return toError({ error: "Joomil listing was not found or is no longer public.", status: 404 });
          }
          const result = projectClassified(ad);
          return toText(result, summarizeClassified(result));
        } catch (error) {
          return toToolError(error);
        }
      }
    );

    // ============================================================================
    // Tool : get_categories
    // ============================================================================

    register(
      "get_categories",
      {
        title: "Get Categories",
        description:
          "List active categories of the Joomil.ch marketplace. " +
          "Returns a flat list with parent_id for hierarchy reconstruction. " +
          "Omit parent_id for all categories, use parent_id=0 for root categories only, " +
          "or pass a specific ID to get direct children of that category.",
        annotations: {
          title: "Get Categories",
          readOnlyHint: true,
          destructiveHint: false,
          openWorldHint: true,
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
        const denied = await checkToolQuota();
        if (denied) return denied;
        try {
          if (parent_id !== undefined && restrictedRoots.has(parent_id)) {
            return toText({ categories: [], total: 0 }, summarizeCategories(0));
          }
          const taxonomy = await getCachedTaxonomy(base, token);
          const categories = parent_id === undefined
            ? taxonomy.categories : taxonomy.categories.filter((cat) => cat.parent_id === parent_id);
          const filtered = { categories, total: categories.length };
          return toText(filtered, summarizeCategories(filtered.total));
        } catch (error) {
          return toToolError(error);
        }
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

    register(
      "get_cantons",
      {
        title: "Get Cantons",
        description:
          "List the Swiss cantons supported by Joomil's `canton` filter. " +
          "Returns the exact `name` value accepted by search_classifieds, plus a readable French label " +
          "(e.g. 'Bern' rather than 'Berne').",
        annotations: {
          title: "Get Cantons",
          readOnlyHint: true,
          destructiveHint: false,
          openWorldHint: false,
        },
        inputSchema: {},
        outputSchema: GetCantonsOutputSchema,
      },
      async () => {
        const denied = await checkToolQuota();
        if (denied) return denied;
        const result = { cantons: SUPPORTED_CANTONS, total: SUPPORTED_CANTONS.length };
        return toText(result, summarizeCantons(result.total));
      }
    );
}

export class JoomilMCP extends McpAgent<Env> {
  server = new McpServer(SERVER_INFO);

  async init(): Promise<void> {
    registerJoomilTools((name, config, callback) => {
      const inputSchema = z.object(config.inputSchema);
      const outputSchema = z.object(config.outputSchema);
      this.server.registerTool<typeof outputSchema, typeof inputSchema>(
        name, { ...config, inputSchema, outputSchema }, (args) => callback(inputSchema.parse(args)),
      );
    }, this.env, () => guardMcpTool(this.env, this.ctx.id.toString()));
  }
}

export default {
  fetch: async (request: Request, env: Env, ctx: ExecutionContext) => {
    const failure = await guardMcpRequest(request, env);
    if (failure) return failure;
    if (new URL(request.url).pathname !== "/mcp" || request.method !== "POST" ||
      await isLegacyRequest(request, undefined, { maxRequestBodySize: MCP_REQUEST_MAX_BYTES })) {
      return JoomilMCP.serve("/mcp").fetch(request, env, ctx);
    }
    return createMcpHandler(() => {
      const server = new ModernMcpServer(SERVER_INFO);
      registerJoomilTools((name, config, callback) => {
        server.registerTool(name, {
          ...config, inputSchema: z.object(config.inputSchema), outputSchema: z.object(config.outputSchema),
        }, callback);
      }, env, () => guardStatelessMcpTool(env, request));
      return server;
    }, { route: "/mcp", legacy: "reject", maxRequestBodySize: MCP_REQUEST_MAX_BYTES, maxSubscriptions: 0 })(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;

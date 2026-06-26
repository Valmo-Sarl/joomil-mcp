import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

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
  return toError({ error: "This category is not available through this API." });
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

class JoomilApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly statusText: string,
    public readonly url: string
  ) {
    super(`Joomil API error ${status}: ${statusText}`);
  }
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
    headers: { "User-Agent": "joomil-mcp/1.2.1" },
  });

  if (!response.ok) {
    throw new JoomilApiError(response.status, response.statusText, url.toString());
  }

  return response.json();
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
      error: "Joomil API request failed",
      status: error.status,
      status_text: error.statusText,
      url: error.url,
    });
  }

  return toError({
    error: "Unexpected MCP error",
    message: error instanceof Error ? error.message : String(error),
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

interface ApiCategory extends CategoryLike {
  id: number;
  name: string;
  url: string;
  parent_id: number;
  ad_count?: number;
  allow_ads?: boolean;
}

let categoryCache: {
  baseUrl: string;
  expiresAt: number;
  categories: ApiCategory[];
} | null = null;

async function getCachedCategories(baseUrl: string): Promise<ApiCategory[]> {
  const now = Date.now();
  if (categoryCache && categoryCache.baseUrl === baseUrl && categoryCache.expiresAt > now) {
    return categoryCache.categories;
  }

  const data = await joomilFetch(baseUrl, "/api/categories") as { categories: ApiCategory[] };
  categoryCache = {
    baseUrl,
    expiresAt: now + CATEGORY_CACHE_TTL_MS,
    categories: data.categories,
  };
  return data.categories;
}

interface PriceExtraction {
  price_min: number | null;
  price_max: number | null;
}

interface CantonMatch {
  canton: (typeof CANTON_NAMES)[number] | null;
  matched: string | null;
}

interface CategorySuggestion {
  category: ApiCategory;
  confidence: number;
  reason: string;
  matchedTerms: string[];
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
  "vehicules", "velo", "velos", "villa", "villas", "voiture", "voitures",
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
  const maxPattern = new RegExp(
    String.raw`(?:moins\s+de|moins\s+que|sous|budget(?:\s+de)?|max(?:imum)?|jusqu['’]?a|jusqu'a|jusqu’à|<=|<)\s*${AMOUNT_PATTERN}`,
    "i"
  );
  const minPattern = new RegExp(
    String.raw`(?:plus\s+de|plus\s+que|min(?:imum)?|dès|des|from|a\s+partir\s+de|à\s+partir\s+de|>=|>)\s*${AMOUNT_PATTERN}`,
    "i"
  );
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
  const maxPattern = new RegExp(
    String.raw`(?:moins\s+de|moins\s+que|sous|budget(?:\s+de)?|max(?:imum)?|jusqu['’]?a|jusqu'a|jusqu’à|<=|<)\s*${AMOUNT_PATTERN}`,
    "gi"
  );
  const minPattern = new RegExp(
    String.raw`(?:plus\s+de|plus\s+que|min(?:imum)?|dès|des|from|a\s+partir\s+de|à\s+partir\s+de|>=|>)\s*${AMOUNT_PATTERN}`,
    "gi"
  );
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

function findLocation(query: string, canton: CantonMatch): string | null {
  const normalizedQuery = normalizeText(query);

  for (const location of COMMON_LOCATIONS) {
    const normalizedLocation = normalizeText(location);
    const isCantonPhrase =
      normalizedQuery.includes(`canton de ${normalizedLocation}`) ||
      normalizedQuery.includes(`canton ${normalizedLocation}`);

    if (!isCantonPhrase && normalizedQuery.includes(normalizedLocation)) {
      return location;
    }
  }

  const postalCode = query.match(/\b\d{4}\b/);
  if (postalCode?.[0]) return postalCode[0];

  const genericMatch = query.match(/\b(?:à|a|sur|in|près de|pres de|proche de)\s+([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ' -]{1,40}|\d{4,5})/i);
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
  const escaped = escapeRegExp(location);
  return query
    .replace(new RegExp(`\\b(?:à|a|sur|in|près\\s+de|pres\\s+de|proche\\s+de)\\s+${escaped}\\b`, "gi"), " ")
    .replace(new RegExp(`\\b${escaped}\\b`, "gi"), " ");
}

function includesAll(value: string, required: string[]): boolean {
  return required.every((part) => value.includes(part));
}

function categoryHintScore(category: ApiCategory, normalizedQuery: string, queryTokens: Set<string>) {
  const normalizedUrl = normalizeText(category.url);
  const hints: Array<{ terms: string[]; urlParts: string[]; score: number; reason: string }> = [
    { terms: ["appartement", "appart", "studio", "logement"], urlParts: ["immobilier", "appartements"], score: 24, reason: "requête immobilière appartement" },
    { terms: ["maison", "villa"], urlParts: ["immobilier", "maisons-villas"], score: 24, reason: "requête immobilière maison" },
    { terms: ["terrain", "parcelle"], urlParts: ["immobilier", "terrains"], score: 22, reason: "requête immobilière terrain" },
    { terms: ["voiture", "auto", "automobile", "vehicule", "golf", "tesla", "bmw", "audi", "mercedes", "renault", "peugeot", "toyota"], urlParts: ["automobiles", "voitures-de-tourisme"], score: 24, reason: "requête automobile" },
    { terms: ["moto", "scooter"], urlParts: ["motos-deux-roues"], score: 20, reason: "requête moto/deux-roues" },
    { terms: ["emploi", "job", "travail", "poste"], urlParts: ["emplois-services"], score: 18, reason: "requête emploi/service" },
    { terms: ["canape", "sofa", "fauteuil", "table", "chaise", "lit", "armoire", "meuble"], urlParts: ["mobilier-decoration"], score: 20, reason: "requête mobilier" },
    { terms: ["iphone", "telephone", "smartphone", "natel"], urlParts: ["telephonie-natels"], score: 20, reason: "requête téléphonie" },
    { terms: ["ordinateur", "pc", "macbook", "imac", "laptop"], urlParts: ["informatique"], score: 18, reason: "requête informatique" },
    { terms: ["velo", "vtt", "bike"], urlParts: ["sport-loisirs"], score: 14, reason: "requête sport/vélo" },
  ];

  for (const hint of hints) {
    const matched = hint.terms.filter((term) => normalizedQuery.includes(term) || queryTokens.has(stemToken(term)));
    if (matched.length > 0 && includesAll(normalizedUrl, hint.urlParts)) {
      return { score: hint.score + matched.length * 2, reason: hint.reason, terms: matched };
    }
  }

  return { score: 0, reason: "", terms: [] };
}

function scoreCategory(category: ApiCategory, query: string): CategorySuggestion | null {
  const normalizedQuery = normalizeText(query);
  const queryTokens = new Set(tokenize(query));
  const categoryTokens = new Set(tokenize(`${category.name} ${category.url}`));
  const matchedTerms: string[] = [];
  let score = 0;
  let reason = "";

  for (const token of queryTokens) {
    if (categoryTokens.has(token)) {
      matchedTerms.push(token);
      score += 4;
    }
  }

  const hint = categoryHintScore(category, normalizedQuery, queryTokens);
  if (hint.score > 0) {
    score += hint.score;
    reason = hint.reason;
    matchedTerms.push(...hint.terms);
  }

  if (normalizedQuery.match(/\b(location|louer|loyer)\b/) && category.url.includes("/locations/")) score += 8;
  if (normalizedQuery.match(/\b(vente|vendre|acheter|achat)\b/) && category.url.includes("/ventes/")) score += 8;
  if (category.url.includes("cherche-a-")) score -= 6;
  if (category.allow_ads) score += 1;
  if (category.ad_count) score += Math.min(4, Math.log10(category.ad_count + 1));

  if (score < 8) return null;

  const confidence = Math.min(0.95, Math.max(0.45, score / 40));
  return {
    category,
    confidence: Number(confidence.toFixed(2)),
    reason: reason || `mots-clés proches de "${category.name}"`,
    matchedTerms: Array.from(new Set(matchedTerms)),
  };
}

function suggestCategory(categories: ApiCategory[], query: string): CategorySuggestion | null {
  const suggestions = categories
    .filter((category) => !isRestrictedCategory(category))
    .map((category) => scoreCategory(category, query))
    .filter((suggestion): suggestion is CategorySuggestion => suggestion !== null)
    .sort((a, b) => {
      if (b.confidence !== a.confidence) return b.confidence - a.confidence;
      return (b.category.ad_count ?? 0) - (a.category.ad_count ?? 0);
    });

  return suggestions[0] ?? null;
}

function buildCleanQuery(
  query: string,
  canton: CantonMatch,
  location: string | null,
  category: CategorySuggestion | null
): string | null {
  let cleaned = removePricePhrases(query);
  cleaned = removeCantonPhrase(cleaned, canton);
  cleaned = removeLocationPhrase(cleaned, location);

  const removableTerms = new Set(CATEGORY_REMOVE_TERMS);
  for (const term of category?.matchedTerms ?? []) {
    if (CATEGORY_REMOVE_TERMS.has(term)) removableTerms.add(term);
  }

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

function buildFilterSuggestion(query: string, categories: ApiCategory[]) {
  const prices = extractPrices(query);
  const canton = findCanton(query);
  const location = findLocation(query, canton);
  const category = suggestCategory(categories, query);
  const q = buildCleanQuery(query, canton, location, category);
  const sort = prices.price_max !== null ? "price_asc" : "recent";
  const warnings: string[] = [];

  if (!category) {
    warnings.push("No confident category match. Use get_categories if category precision matters.");
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
    next_step: "Call search_classifieds with the filters object. Adjust q or cat_id if the result set is too broad.",
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
    version: "1.2.1",
  });

  async init(): Promise<void> {
    const base = this.env.JOOMIL_API_BASE ?? "https://www.joomil.ch";

    // ============================================================================
    // Tool : suggest_filters
    // ============================================================================

    this.server.registerTool(
      "suggest_filters",
      {
        description:
          "Infer search_classifieds filters from a natural-language query. " +
          "Use this before search_classifieds when the user mentions a category, location, canton or price in free text. " +
          "Returns a ready-to-use filters object, a category confidence score and warnings for uncertain matches.",
        annotations: {
          title: "Suggest Filters",
          readOnlyHint: true,
          destructiveHint: false,
        },
        inputSchema: {
          query: z
            .string()
            .min(1)
            .describe("Natural-language search request, e.g. 'appartement 3 pièces à Sion' or 'Tesla Model 3 moins de 25000 CHF'."),
        },
        outputSchema: SuggestFiltersOutputSchema,
      },
      async ({ query }) => {
        try {
          const categories = await getCachedCategories(base);
          const suggestion = buildFilterSuggestion(query, categories);
          return toText(suggestion, summarizeSuggestion(suggestion));
        } catch (error) {
          return toToolError(error);
        }
      }
    );

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
        try {
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
          const result = projectSearchResult(data);
          return toText(result, summarizeSearchResult(result));
        } catch (error) {
          return toToolError(error);
        }
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
        try {
          const data = await joomilFetch(base, `/api/classifieds/${id}`);
          const ad = (data as { ad?: DetailAd }).ad;
          if (isRestrictedCategory(ad?.category)) {
            return restrictedCategoryError();
          }
          const result = projectClassified(data);
          return toText(result, summarizeClassified(result));
        } catch (error) {
          return toToolError(error);
        }
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
        try {
          if (parent_id !== undefined && isRestrictedCategory({ id: parent_id })) {
            return toText({ categories: [], total: 0 }, summarizeCategories(0));
          }
          const data = await joomilFetch(base, "/api/categories", { parent_id }) as { categories: Array<{ id: number; [key: string]: unknown }>; total: number };
          const categories = data.categories.filter((cat) => !isRestrictedCategory(cat));
          const filtered = {
            ...data,
            categories,
            total: categories.length,
          };
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
        const result = { cantons: SUPPORTED_CANTONS, total: SUPPORTED_CANTONS.length };
        return toText(result, summarizeCantons(result.total));
      }
    );
  }
}

export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) => {
    return JoomilMCP.serve("/mcp").fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;

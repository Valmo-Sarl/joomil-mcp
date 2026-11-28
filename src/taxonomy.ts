/** Use the live active taxonomy, not a frozen list of descendants or URL slugs. */
export interface ApiCategory {
  id: number;
  parent_id: number;
  name: string;
  url: string;
  ad_count?: number;
  allow_ads?: boolean;
}

export const restrictedRoots = new Set([28, 651, 14000]);

export function hasRestrictedPath(value?: string): boolean {
  if (!value) return false;
  let decoded: string;
  try { decoded = decodeURIComponent(value); } catch { return true; }
  return /(?:^|[\/>\s])(?:annonces-erotiques|annonces-rencontres|erotique|rencontres-amitie|voyance-astrologie)(?=$|[\/>\s?#-])/.test(
    decoded.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase(),
  );
}

export function buildTaxonomy(categories: ApiCategory[]) {
  const source = new Map<number, ApiCategory>();
  const duplicateIds = new Set<number>();
  for (const item of categories) {
    if (source.has(item.id)) duplicateIds.add(item.id);
    source.set(item.id, item);
  }
  const paths = new Map<number, ApiCategory[]>();
  const rejected = new Set<number>();
  function resolve(id: number, visiting: Set<number>): ApiCategory[] | undefined {
    if (paths.has(id)) return paths.get(id);
    if (rejected.has(id) || visiting.has(id)) return undefined;
    const item = source.get(id);
    let validUrl = false;
    try {
      const url = new URL(item?.url ?? "");
      validUrl = url.origin === "https://www.joomil.ch" && !url.username && !url.password
        && url.pathname.split("/").pop() === String(id);
    } catch { /* An unverified category cannot pass the boundary. */ }
    if (!item || !validUrl || !Number.isSafeInteger(id) || id <= 0 || !item.name.trim()
      || duplicateIds.has(id) || restrictedRoots.has(id) || hasRestrictedPath(item.url)) {
      rejected.add(id);
      return undefined;
    }
    visiting.add(id);
    const parent = item.parent_id === 0 ? [] : resolve(item.parent_id, visiting);
    visiting.delete(id);
    if (!parent) {
      rejected.add(id);
      return undefined;
    }
    const path = [...parent, item];
    paths.set(id, path);
    return path;
  }
  for (const id of source.keys()) resolve(id, new Set());
  return { categories: categories.filter((item) => paths.has(item.id)), paths };
}

export type Taxonomy = ReturnType<typeof buildTaxonomy>;

const smallWords = new Set(["a", "d", "de", "des", "du", "en", "et", "l", "la", "le", "les"]);
const genericNames = new Set(["autre", "accessoire", "diver", "service professionnel", "piece accessoire"]);
function words(text: string, foldPlural = true): string[] {
  return (text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().match(/[a-z0-9]+/g) ?? [])
    .filter((part) => !smallWords.has(part))
    .map((part) => foldPlural && part.length > 4 && part.endsWith("s") ? part.slice(0, -1) : part);
}

// Stable upstream IDs for high-value synonyms that are not exact category names.
// No alias can match a sibling, and a nonexistent/restricted ID is never suggested.
const aliases: [number, string[]][] = [
  [78, ["vélo", "VTT", "bike", "bicyclette"]],
  [123, ["porte vélo", "porte vélos"]],
  [10111, ["cyclisme"]],
  [101, ["voiture", "auto", "automobile", "VW Golf", "Volkswagen Golf", "Tesla", "BMW", "Audi", "Mercedes", "Renault", "Peugeot", "Toyota"]],
  [74, ["moto", "motocyclette"]],
  [75, ["scooter"]],
  [14, ["emploi", "job", "poste"]],
  [20, ["livre", "bouquin", "roman", "BD"]],
  [10022, ["canapé", "sofa", "fauteuil"]],
  [21, ["mobilier", "meuble"]],
  [31, ["iPhone", "téléphone", "smartphone", "natel"]],
  [17, ["ordinateur", "MacBook", "iMac", "laptop"]],
];

function matchPhrases(query: string, phrase: string[]): boolean {
  return !!phrase.length && query.includes(` ${phrase.join(" ")} `);
}

export interface CategorySuggestion {
  category: ApiCategory;
  confidence: number;
  reason: string;
  matchedTerms: string[];
  categoryOnly?: true;
}

export function suggestCategory(taxonomy: Taxonomy, input: string): CategorySuggestion | null {
  const normalizedInput = words(input).join(" ");
  const query = ` ${normalizedInput} `;
  const labelKey = (value: string) => words(value, false).join(" ");
  const breadcrumb = input.split(/[>›]/u).map(labelKey);
  if (breadcrumb.length > 1) {
    const matches = taxonomy.categories.filter(({ id }) => {
      const path = taxonomy.paths.get(id)!;
      return path.length === breadcrumb.length && path.every((item, i) => labelKey(item.name) === breadcrumb[i]);
    });
    if (matches.length === 1) return { category: matches[0], confidence: 0.95,
      reason: `chemin exact « ${matches[0].name} »`, matchedTerms: [], categoryOnly: true };
    // An explicitly supplied hierarchy is not a request to select a different branch.
    return null;
  }
  const exactKey = labelKey(input);
  const wordForWord = taxonomy.categories.filter((item) => labelKey(item.name) === exactKey);
  const exact = wordForWord.length ? wordForWord
    : taxonomy.categories.filter((item) => words(item.name).join(" ") === normalizedInput);
  if (exact.length && !genericNames.has(normalizedInput)) {
    // Identical labels on one branch can safely select its common category;
    // an identical label on an unrelated branch must not pick a winner.
    const common = exact.find(({ id }) => exact.every((item) =>
      taxonomy.paths.get(item.id)!.some((ancestor) => ancestor.id === id)));
    if (!common) return null;
    return { category: common, confidence: 0.95, reason: `libellé exact « ${common.name} »`,
      matchedTerms: [], categoryOnly: true };
  }
  const candidates = new Map<number, { score: number; terms: string[]; explicit: boolean }>();
  function add(id: number, score: number, terms: string[], explicit: boolean) {
    if (!taxonomy.paths.has(id) || (candidates.get(id)?.score ?? 0) >= score) return;
    candidates.set(id, { score, terms, explicit });
  }

  for (const [id, path] of taxonomy.paths) {
    const label = words(path[path.length - 1].name);
    if (!matchPhrases(query, label)) continue;
    const context = new Set(path.slice(0, -1).flatMap((item) => words(item.name)));
    for (const term of label) context.delete(term);
    const contextual = [...context].filter((term) => matchPhrases(query, [term])).length;
    if (genericNames.has(label.join(" ")) && !contextual) continue;
    add(id, 12 + 4 * label.length + Math.min(3, contextual) * 3, label, true);
  }
  for (const [id, phrases] of aliases) {
    for (const phrase of phrases) {
      const terms = words(phrase);
      if (matchPhrases(query, terms)) add(id, 14 + 4 * terms.length, terms, false);
    }
  }

  // Transaction intent disambiguates duplicated property labels. Bare
  // "appartement"/"maison" stays text-only rather than guessing rent vs sale.
  const intent = /\b(?:location|louer|loyer)\b/.test(query) ? "rent" :
    /\b(?:vente|vend(?:re)?|acheter|achat)\b/.test(query) ? "sale" : null;
  const residential: [string[], number, number][] = [
    [["appartement", "appart", "studio"], 10255, 10260],
    [["maison", "villa"], 10256, 10261],
  ];
  if (intent) for (const [phrases, rent, sale] of residential) {
    for (const phrase of phrases) {
      const terms = words(phrase);
      if (matchPhrases(query, terms)) add(intent === "rent" ? rent : sale, 32, terms, false);
    }
  }

  const ranked = [...candidates].sort((a, b) => b[1].score - a[1].score);
  const first = ranked[0];
  if (!first || ranked[1]?.[1].score === first[1].score) return null;
  const [id, match] = first;
  const path = taxonomy.paths.get(id)!;
  const category = path[path.length - 1];
  return { category, confidence: Math.min(0.95, match.score / 30),
    reason: match.explicit ? `libellé « ${category.name} »` : `alias vers « ${category.name} »`, matchedTerms: match.terms };
}

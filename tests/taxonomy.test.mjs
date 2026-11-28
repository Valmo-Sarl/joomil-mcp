import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { build } from "esbuild";

const { outputFiles } = await build({ entryPoints: ["src/taxonomy.ts"], format: "esm", platform: "node", write: false });
const { buildTaxonomy, suggestCategory, restrictedRoots } =
  await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString("base64")}`);
const cat = (id, parent_id, name, url = `https://www.joomil.ch/annonces/fixture/${id}`) =>
  ({ id, parent_id, name, url });

test("category scope uses ancestors, not just numeric root IDs or readable URL slugs", () => {
  const categories = [cat(4, 0, "Automobiles"), cat(101, 4, "Voitures de tourisme"),
    cat(28, 0, "Restricted A"), cat(1001, 28, "New child"), cat(1002, 1001, "New grandchild"),
    cat(651, 0, "Restricted B"), cat(1003, 651, "Other child"),
    cat(14000, 0, "Restricted C"), cat(1004, 14000, "Other child"),
    cat(1005, 7777, "Missing parent"), cat(1006, 1007, "Cycle start"), cat(1007, 1006, "Cycle end"),
    cat(1008, 0, "Duplicate ID"), cat(1008, 4, "Duplicate ID"),
    cat(1009, 0, "Wrong host", "https://fixture.invalid/annonces/1009"),
    cat(1010, 0, "Old restricted URL", "https://www.joomil.ch/erotique/subcategory/1010")];
  const taxonomy = buildTaxonomy(categories);
  assert.deepEqual(taxonomy.categories.map(({ id }) => id), [4, 101]);
  assert.deepEqual(taxonomy.paths.get(101).map(({ id }) => id), [4, 101]);
});

test("aliases never select unrelated siblings; duplicate names need disambiguation", () => {
  const taxonomy = buildTaxonomy([
    cat(73, 0, "Motos & Deux-Roues"), cat(78, 73, "Vélos"), cat(75, 73, "Scooters"), cat(90, 75, "Scooters"),
    cat(4, 0, "Automobiles"), cat(123, 4, "Porte-vélos"), cat(101, 4, "Voitures de tourisme"),
    cat(16040, 0, "Sport & Loisirs"), cat(500, 16040, "Figurines"), cat(10114, 16040, "Golf"),
    cat(16, 0, "Immobilier"), cat(339, 16, "Locations"), cat(340, 16, "Ventes"),
    cat(10255, 339, "Appartements"), cat(10260, 340, "Appartements"),
    cat(7001, 4, "Accessoires"), cat(7002, 73, "Accessoires"),
  ]);
  for (const [query, expected] of [
    ["vélo d'occasion canton de Vaud", 78], ["porte vélo", 123], ["Golf", 10114], ["VW Golf 2018", 101],
    ["Figurines", 500], ["Automobiles", 4], ["scooter", 75], ["appartement à louer à Sion", 10255],
    ["appartement à vendre à Sion", 10260], ["appartement à Sion", undefined],
    ["Accessoires", undefined], ["rien qui corresponde", undefined],
    ["Automobiles > Accessoires", 7001], ["Motos & Deux-Roues > Accessoires", 7002],
    ["Immobilier › Ventes › Appartements", 10260], ["Automobiles > Vélos", undefined],
    ["Motos & Deux-Roues > Scooters > Scooters", 90],
  ]) assert.equal(suggestCategory(taxonomy, query)?.category.id, expected, query);
});

// Replay a saved public GET /api/categories response; never contacts the network from npm test.
const snapshot = process.env.JOOMIL_PUBLIC_CATEGORY_SNAPSHOT;
test("all categories in the public inventory reconcile and resolve by breadcrumb", { skip: !snapshot }, async (t) => {
  const categories = JSON.parse(await readFile(snapshot, "utf8"));
  const source = new Map(categories.map((item) => [item.id, item]));
  assert.equal(source.size, categories.length, "unique upstream IDs");
  const actual = buildTaxonomy(categories);
  let restricted = 0, resolved = 0, ambiguous = 0;
  const names = new Map();
  for (const item of categories) {
    const path = [item];
    const seen = new Set([item.id]);
    while (path[0].parent_id) {
      const parent = source.get(path[0].parent_id);
      assert.ok(parent && !seen.has(parent.id), `invalid ancestry: ${item.id}`);
      seen.add(parent.id);
      path.unshift(parent);
    }
    if (restrictedRoots.has(path[0].id)) {
      assert.equal(actual.paths.has(item.id), false, item.id);
      restricted++;
    } else {
      assert.deepEqual(actual.paths.get(item.id).map(({ id }) => id), path.map(({ id }) => id));
      const label = path.map(({ name }) => name).join(" > ");
      if (!names.has(label)) names.set(label, []);
      names.get(label).push(item.id);
    }
  }
  for (const [label, ids] of names) {
    // Explicit breadcrumbs disambiguate repeated labels; root names use the ID
    // if also used by another category (e.g. Bébés & Enfants).
    const actualId = suggestCategory(actual, label)?.category.id;
    if (actualId === undefined && (ids.length > 1 || !label.includes(" > "))) {
      ambiguous += ids.length;
      continue;
    }
    assert.deepEqual(ids, [actualId], label);
    resolved++;
  }
  t.diagnostic(JSON.stringify({ total: categories.length, allowed: actual.categories.length,
    restricted, resolved, ambiguous }));
  assert.equal(actual.categories.length, categories.length - restricted);
});

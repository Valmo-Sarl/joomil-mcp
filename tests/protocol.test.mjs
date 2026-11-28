import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Miniflare, convertV4MiniflareOptions, Response as WorkerResponse, Log, LogLevel } from "miniflare";

const exec = promisify(execFile);
const TOKEN = "M".repeat(43); // Isolated fixture, no secret loaded from user configuration.

test("real MCP SDK/DO transport, five tools and authenticated fictitious upstream", { timeout: 90000 }, async () => {
  const root = await mkdtemp("/tmp/opencode/joomil-mcp-protocol-");
  let mf;
  try {
    await exec(process.execPath, ["node_modules/wrangler/bin/wrangler.js", "deploy", "--dry-run",
      "--outdir", `${root}/bundle`], {
      env: { PATH: process.env.PATH, HOME: root, XDG_CONFIG_HOME: `${root}/config`,
        WRANGLER_SEND_METRICS: "false", WRANGLER_LOG_PATH: `${root}/wrangler.log` },
      timeout: 45000,
    });
    const calls = [];
    const searches = [];
    const category = { id: 20, name: "Livres", url: "https://www.joomil.ch/annonces/livres/20",
      parent_id: 0, unexpected_field: "never-exposed@fixture.invalid" };
    const cat = (id, parent_id, name, slug) =>
      ({ id, parent_id, name, url: `https://www.joomil.ch/annonces/${slug}/${id}` });
    const categories = [category, cat(16041, 0, "Maison & Jardin", "maison-jardin"),
      cat(21, 16041, "Mobilier & Décoration", "maison-jardin/mobilier-decoration"),
      cat(10022, 21, "Canapés & Fauteuils", "maison-jardin/mobilier-decoration/canapes-fauteuils"),
      cat(73, 0, "Motos & Deux-Roues", "motos-deux-roues"),
      cat(78, 73, "Vélos", "motos-deux-roues/velos"),
      cat(16040, 0, "Sport & Loisirs", "sport-loisirs"),
      cat(500, 16040, "Figurines", "sport-loisirs/jeux-jouets/figurines"),
      cat(28, 0, "Branche restreinte", "annonces-erotiques"),
      cat(99901, 28, "Nouveau descendant", "flat-new-child"),
      cat(99902, 99901, "Nouveau petit-enfant", "flat-new-grandchild"),
      cat(99903, 99904, "Parent inconnu", "unknown-tree")];
    const scope = "active_general_v1";
    const ad = { id: 123, title: "Livre fictif", description: "Texte fictif", price: 12,
      url: "https://www.joomil.ch/annonce/livre/123", category,
      location: { city: "Sion", postal_code: "1950", canton: "Valais", country: "CH" },
      date_published: "2026-11-19T10:00:00+01:00", has_picture: false, boost: "star",
      vendor: { name: "Vendeur fictif", certified: false }, user_email: "never-exposed@fixture.invalid" };
    const blockedAd = { ...ad, id: 125, title: "never-exposed@fixture.invalid", category: categories[10] };
    mf = new Miniflare(convertV4MiniflareOptions({
      rootPath: root, modulesRoot: `${root}/bundle`,
      scriptPath: `${root}/bundle/index.js`, modules: true,
      compatibilityDate: "2025-03-27", compatibilityFlags: ["nodejs_compat"],
      log: new Log(LogLevel.ERROR),
      durableObjects: { MCP_OBJECT: { className: "JoomilMCP", useSQLite: true } },
      bindings: { JOOMIL_API_BASE: "https://www.joomil.ch", JOOMIL_API_TOKEN: TOKEN },
      ratelimits: {
        MCP_SESSION_LIMITER: { namespace_id: "1", simple: { limit: 60, period: 60 } },
        MCP_IP_LIMITER: { namespace_id: "2", simple: { limit: 600, period: 60 } },
      },
      // Intercepts ALL outbound traffic. No live origin or third-party access.
      outboundService: async (request) => {
        const url = new URL(request.url);
        assert.equal(url.origin, "https://www.joomil.ch");
        assert.equal(request.headers.get("X-Joomil-MCP-Token"), TOKEN);
        assert.equal(request.headers.get("Mcp-Session-Id"), null);
        assert.ok(!request.url.includes(TOKEN));
        calls.push(url.pathname);
        if (url.searchParams.get("q") === "fixture-service-error") {
          return WorkerResponse.json({ error: "Invalid service credentials." }, { status: 401 });
        }
        if (url.searchParams.get("q") === "fixture-redirect") {
          return new WorkerResponse(null, { status: 302, headers: { Location: "https://never-contact.invalid/" } });
        }
        if (url.pathname === "/api/categories") {
          assert.equal(url.searchParams.size, 0, "Always read the full ancestry");
          return WorkerResponse.json({ categories, total: categories.length });
        }
        assert.equal(url.searchParams.get("scope"), scope);
        if (url.pathname === "/api/classifieds/123") return WorkerResponse.json({ scope, ad });
        if (url.pathname === "/api/classifieds/124") return WorkerResponse.json({ scope, ad: { ...ad, id: 124, category: null } });
        if (url.pathname === "/api/classifieds/125") return WorkerResponse.json({ scope, ad: blockedAd });
        if (url.pathname === "/api/classifieds/126") return WorkerResponse.json({ ad: { ...ad, id: 126 } });
        if (url.pathname === "/api/classifieds/127") return WorkerResponse.json({ error: "Not available" }, { status: 404 });
        assert.equal(url.pathname, "/api/classifieds");
        searches.push(Object.fromEntries(url.searchParams));
        const mixed = url.searchParams.get("q") === "fixture-mixed-inventory";
        return WorkerResponse.json({ ...(url.searchParams.get("q") === "fixture-old-origin" ? {} : { scope }),
          ads: mixed ? [ad, blockedAd, { ...blockedAd, category: { id: 99999 } }] : [ad],
          total: mixed ? 3 : 1, limit: mixed ? 3 : 1, offset: 0,
          has_more: false, next_offset: null });
      },
    }));
    let identity = 0;
    async function rpc(client, method, params, notification = false) {
      identity++;
      const body = { jsonrpc: "2.0", method, ...(params ? { params } : {}),
        ...(!notification ? { id: identity } : {}) };
      const response = await mf.dispatchFetch("http://localhost/mcp", { method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream",
          "CF-Connecting-IP": "192.0.2.1", "MCP-Protocol-Version": "2025-03-26",
          ...(client.session ? { "Mcp-Session-Id": client.session } : {}) },
        body: JSON.stringify(body) });
      client.session = response.headers.get("Mcp-Session-Id") ?? client.session;
      assert.ok(response.status < 400, `MCP HTTP ${response.status}`);
      if (notification) { await response.text(); return; }
      let raw = "", message;
      if (response.headers.get("Content-Type")?.startsWith("text/event-stream")) {
        // A real MCP client consumes the response event, not the lifetime of the
        // SDK's SSE/WebSocket close handshake.
        const reader = response.body.getReader(), decoder = new TextDecoder();
        try {
          while (!message) {
            const part = await reader.read();
            if (part.done) break;
            raw += decoder.decode(part.value, { stream: true });
            assert.ok(raw.length < 65536, "Fictitious RPC response bounded");
            const events = raw.split("\n\n").slice(0, -1);
            const messages = events.flatMap((event) => event.split("\n")
              .filter((line) => line.startsWith("data:")).map((line) => JSON.parse(line.slice(5))));
            message = messages.find((value) => value.id === identity);
          }
        } finally { void reader.cancel().catch(() => {}); }
      } else {
        raw = await response.text();
        message = JSON.parse(raw);
      }
      assert.ok(message && !message.error, raw);
      assert.ok(!raw.includes(TOKEN) && !raw.includes("never-exposed@fixture.invalid"));
      return message.result;
    }
    async function initialize() {
      const client = {};
      const result = await rpc(client, "initialize", { protocolVersion: "2025-03-26", capabilities: {},
        clientInfo: { name: "isolated-fixture", version: "1" } });
      assert.equal(result.serverInfo.name, "joomil-mcp");
      assert.equal(result.serverInfo.version, "1.3.3");
      assert.ok(client.session);
      await rpc(client, "notifications/initialized", undefined, true);
      return client;
    }
    const a = await initialize();
    const b = await initialize();
    assert.notEqual(a.session, b.session);
    const tools = await rpc(a, "tools/list");
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(),
      ["get_cantons", "get_categories", "get_classified", "search_classifieds", "suggest_filters"]);
    for (const listed of tools.tools) {
      assert.ok(listed.title);
      assert.equal(listed.annotations.readOnlyHint, true);
      assert.equal(listed.annotations.destructiveHint, false);
      assert.equal(listed.annotations.openWorldHint, listed.name !== "get_cantons");
    }
    async function tool(client, name, args) {
      const result = await rpc(client, "tools/call", { name, arguments: args });
      assert.ok(!result.isError, JSON.stringify(result));
      return result.structuredContent ?? JSON.parse(result.content.at(-1).text);
    }
    assert.equal((await tool(a, "get_categories", { parent_id: 0 })).total, 4);
    const search = await tool(a, "search_classifieds", { q: "livre", limit: 1 });
    assert.equal(search.results[0].id, 123);
    assert.equal(search.results[0].price.currency, "CHF");
    const detail = await tool(a, "get_classified", { id: 123 });
    assert.equal(detail.id, 123);
    assert.equal(detail.boost, "star", "Schema matches real public REST boost labels");
    assert.equal((await rpc(a, "tools/call", { name: "get_classified", arguments: { id: 124 } })).isError, true,
      "A listing without a usable category is not exposed");
    for (const [id, status] of [[125, 404], [126, 503], [127, 404]]) {
      const res = await rpc(a, "tools/call", { name: "get_classified", arguments: { id } });
      assert.equal(res.isError, true);
      assert.equal(JSON.parse(res.content[0].text).status, status);
    }
    const mixed = await tool(a, "search_classifieds", { q: "fixture-mixed-inventory" });
    assert.deepEqual(mixed.results.map((listing) => listing.id), [123]);
    assert.equal(mixed.filtered_out, 2, "Unknown categories and new restricted descendants cannot leak");
    const old = await rpc(a, "tools/call", { name: "search_classifieds", arguments: { q: "fixture-old-origin" } });
    assert.equal(old.isError, true);
    assert.equal(JSON.parse(old.content[0].text).status, 503);
    assert.equal((await tool(a, "search_classifieds", { cat_id: 78 })).results.length, 0,
      "A result outside the explicitly requested branch is ignored");
    assert.equal((await tool(b, "get_cantons", {})).total, 12);
    const { filters } = await tool(b, "suggest_filters", { query: "livre à Sion moins de 20 CHF" });
    assert.equal(filters.price_max, 20);
    await tool(b, "search_classifieds", filters);
    assert.deepEqual(searches.at(-1), {
      q: "livre", cat_id: "20", location: "Sion", price_max: "20", sort: "price_asc", limit: "20", scope,
    }, "Suggested filters are accepted verbatim; null filters never reach REST");
    for (const [query, location, price, q] of [
      ["VW Golf 2018 sous 9000 CHF", null, 9000, "VW Golf 2018"],
      ["scooter sous CHF 1000", null, 1000, "scooter"],
      ["canapé sous CHF 1000", null, 1000, null],
      ["canapé à 1950 sous CHF 1000", "1950", 1000, null],
      ["canapé NPA 1950 sous CHF 1000", "1950", 1000, null],
      ["canapé à La Chaux-de-Fonds sous 1000 CHF", "La Chaux-de-Fonds", 1000, null],
    ]) {
      const suggestion = (await tool(b, "suggest_filters", { query })).filters;
      assert.equal(suggestion.location, location, query);
      assert.equal(suggestion.price_max, price, query);
      assert.equal(suggestion.q, q, query);
    }
    const bike = await tool(b, "suggest_filters", { query: "vélo d'occasion moins de 500 CHF canton de Vaud" });
    assert.equal(bike.filters.cat_id, 78);
    assert.equal(bike.filters.q, "vélo");
    assert.equal(bike.filters.canton, "Vaud");
    assert.equal(bike.filters.price_max, 500);
    const budgetQueries = [
      ["vélo complet d’occasion à moins de CHF 500 dans le canton de Vaud", null, null, 500, "vélo complet"],
      ["vélo complet d'occasion à moins de 500 CHF dans le canton de Vaud", null, null, 500, "vélo complet"],
      ["vélo a moins de CHF 500 dans le canton de Vaud", null, null, 500, "vélo"],
      ["vélo à Pully à moins de CHF 500 dans le canton de Vaud", "Pully", null, 500, "vélo"],
      ["vélo à moins de CHF 500 à 1009 dans le canton de Vaud", "1009", null, 500, "vélo"],
      ["vélo à plus de CHF 100 dans le canton de Vaud", null, 100, null, "vélo"],
      ["Yamaha moins de CHF 500 dans le canton de Vaud", null, null, 500, "Yamaha"],
    ];
    for (const [query, location, priceMin, priceMax, q] of budgetQueries) {
      const { filters: result } = await tool(b, "suggest_filters", { query });
      assert.deepEqual(
        [result.location, result.price_min, result.price_max, result.q, result.canton],
        [location, priceMin, priceMax, q, "Vaud"], query,
      );
      if (query === budgetQueries[0][0]) {
        assert.equal(result.cat_id, 78);
        await tool(b, "search_classifieds", result);
        assert.equal(searches.at(-1).cat_id, "78");
        assert.equal(searches.at(-1).location, undefined);
      }
    }
    const before = calls.length;
    const reversedBudget = await rpc(b, "tools/call", {
      name: "search_classifieds", arguments: { price_min: 1000, price_max: 500 },
    });
    assert.equal(reversedBudget.isError, true);
    assert.equal(JSON.parse(reversedBudget.content[0].text).status, 400);
    assert.equal(calls.length, before, "Contradictory budget does not consume origin quota");
    assert.equal((await tool(b, "get_categories", { parent_id: 28 })).total, 0);
    assert.equal((await tool(b, "get_categories", { parent_id: 99901 })).total, 0);
    const restricted = await rpc(b, "tools/call", { name: "search_classifieds", arguments: { cat_id: 99902 } });
    assert.equal(restricted.isError, true);
    assert.equal(calls.length, before, "Restricted category is rejected before origin call");
    const failure = await rpc(b, "tools/call", {
      name: "search_classifieds", arguments: { q: "fixture-service-error", limit: 1 },
    });
    assert.equal(failure.isError, true);
    assert.equal(JSON.parse(failure.content[0].text).status, 401);
    assert.ok(!JSON.stringify(failure).includes("fixture-service-error"), "Errors do not echo query URLs");
    const redirected = await rpc(b, "tools/call", {
      name: "search_classifieds", arguments: { q: "fixture-redirect", limit: 1 },
    });
    assert.equal(redirected.isError, true);
    assert.equal(JSON.parse(redirected.content[0].text).status, 302,
      "Origin redirect refused without forwarding credential to its destination");
    assert.ok(calls.length >= 5);
    // Supplied unknown session identifiers must never authenticate a transport.
    const unknown = await mf.dispatchFetch("http://localhost/mcp", { method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream",
        "CF-Connecting-IP": "192.0.2.1", "Mcp-Session-Id": "not-a-real-session" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 99, method: "tools/list" }) });
    assert.ok(unknown.status >= 400, "SDK validates session before serving tools");
    // One HTTP batch must still consume one session unit PER TOOL.
    const upstreamBeforeBatch = calls.length;
    const batch = Array.from({ length: 80 }, (_, i) => ({ jsonrpc: "2.0", id: 1000 + i,
      method: "tools/call", params: { name: "get_cantons", arguments: {} } }));
    const batched = await mf.dispatchFetch("http://localhost/mcp", { method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream",
        "CF-Connecting-IP": "192.0.2.1", "Mcp-Session-Id": a.session },
      body: JSON.stringify(batch) });
    assert.equal(batched.status, 200);
    const reader = batched.body.getReader(), decoder = new TextDecoder();
    const answers = new Map();
    let raw = "";
    try {
      while (answers.size < batch.length) {
        const part = await reader.read();
        if (part.done) break;
        raw += decoder.decode(part.value, { stream: true });
        assert.ok(raw.length < 262144, "Synthetic batch response bounded");
        for (const event of raw.split("\n\n").slice(0, -1)) {
          for (const line of event.split("\n").filter((value) => value.startsWith("data:"))) {
            const message = JSON.parse(line.slice(5));
            if (message.id >= 1000 && message.id < 1080) answers.set(message.id, message.result);
          }
        }
      }
    } finally { void reader.cancel().catch(() => {}); }
    assert.equal(answers.size, 80);
    assert.ok([...answers.values()].some((result) =>
      result?.isError && JSON.parse(result.content[0].text).status === 429),
    "Native LOCAL binding eventually rejects an oversized tool batch (not a global accuracy promise)");
    assert.ok([...answers.values()].some((result) => result && !result.isError));
    assert.equal((await tool(b, "get_cantons", {})).total, 12,
      "Other SDK session at same peer retains its own allowance");
    assert.equal(calls.length, upstreamBeforeBatch, "Local canton tools never consume origin budget");

    // Published 2026 transport: no initialize, session ID or legacy fallback.
    const modernRevision = "2026-07-28";
    async function modern(method, args = {}, headerOverrides = {}) {
      const { name } = args;
      const response = await mf.dispatchFetch("http://localhost/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json", Accept: "application/json, text/event-stream",
          "CF-Connecting-IP": "192.0.2.1", "MCP-Protocol-Version": modernRevision, "Mcp-Method": method,
          ...(name ? { "Mcp-Name": name } : {}), ...headerOverrides,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++identity, method, params: {
          ...args, _meta: { "io.modelcontextprotocol/protocolVersion": modernRevision,
            "io.modelcontextprotocol/clientCapabilities": {} },
        } }),
      });
      assert.equal(response.headers.get("Mcp-Session-Id"), null);
      const text = await response.text();
      assert.ok(!text.includes(TOKEN) && !text.includes("never-exposed@fixture.invalid"));
      return { status: response.status, message: JSON.parse(text) };
    }
    const discovery = await modern("server/discover");
    assert.equal(discovery.status, 200, JSON.stringify(discovery.message));
    assert.ok(discovery.message.result.supportedVersions.includes(modernRevision));
    assert.equal(discovery.message.result._meta["io.modelcontextprotocol/serverInfo"].version, "1.3.3");
    const modernList = await modern("tools/list");
    assert.equal(modernList.status, 200);
    assert.deepEqual(modernList.message.result.tools.map(({ name, annotations }) => ({ name, annotations })),
      tools.tools.map(({ name, annotations }) => ({ name, annotations })));
    const modernFilters = await modern("tools/call", { name: "suggest_filters", arguments: {
      query: "livre à moins de CHF 20 dans le canton de Vaud",
    } });
    assert.equal(modernFilters.status, 200);
    assert.equal(modernFilters.message.result.resultType, "complete");
    assert.equal(modernFilters.message.result.structuredContent.filters.location, null);
    const modernSearch = await modern("tools/call", { name: "search_classifieds",
      arguments: modernFilters.message.result.structuredContent.filters });
    assert.equal(modernSearch.status, 200);
    assert.equal(modernSearch.message.result.structuredContent.results[0].id, 123);
    for (const [name, args, key, value] of [
      ["get_classified", { id: 123 }, "boost", "star"],
      ["get_categories", { parent_id: 0 }, "total", 4],
      ["get_cantons", {}, "total", 12],
    ]) {
      const result = await modern("tools/call", { name, arguments: args });
      assert.equal(result.status, 200, JSON.stringify(result.message));
      assert.equal(result.message.result.structuredContent[key], value, name);
    }
    const rejected = await modern("tools/list", {}, { Origin: "https://not-joomil.invalid" });
    assert.equal(rejected.status, 403, "Reject an untrusted browser origin");
    const mismatched = await modern("tools/list", {}, { "Mcp-Method": "server/discover" });
    assert.equal(mismatched.status, 400, "Do not silently accept a mismatched modern routing header");
    const beforeOversize = calls.length;
    const oversized = await modern("tools/call", { name: "suggest_filters", arguments: { query: "x".repeat(65536) } });
    assert.equal(oversized.status, 413, "Bound POST body before tool parsing");
    assert.equal(calls.length, beforeOversize);
  } finally {
    if (mf) await mf.dispose();
    await rm(root, { recursive: true });
  }
});

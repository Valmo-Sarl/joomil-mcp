import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Miniflare, Response as WorkerResponse, Log, LogLevel } from "miniflare";

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
    const category = { id: 20, name: "Livres", url: "https://www.joomil.ch/annonces/livres/20",
      parent_id: 0 };
    const ad = { id: 123, title: "Livre fictif", description: "Texte fictif", price: 12,
      url: "https://www.joomil.ch/annonce/livre/123", category,
      location: { city: "Sion", postal_code: "1950", canton: "Valais", country: "CH" },
      date_published: "2026-11-19T10:00:00+01:00", has_picture: false,
      vendor: { name: "Vendeur fictif", certified: false }, user_email: "never-exposed@fixture.invalid" };
    mf = new Miniflare({
      rootPath: root, modulesRoot: `${root}/bundle`,
      scriptPath: `${root}/bundle/index.js`, modules: true,
      compatibilityDate: "2025-03-27", compatibilityFlags: ["nodejs_compat"],
      log: new Log(LogLevel.ERROR),
      durableObjects: { MCP_OBJECT: { className: "JoomilMCP", useSQLite: true } },
      bindings: { JOOMIL_API_BASE: "https://www.joomil.ch", JOOMIL_API_TOKEN: TOKEN },
      ratelimits: {
        MCP_SESSION_LIMITER: { simple: { limit: 60, period: 60 } },
        MCP_IP_LIMITER: { simple: { limit: 600, period: 60 } },
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
          return WorkerResponse.json({ categories: [category,
            { id: 28, name: "Erotique", url: "/annonces/erotique/28", parent_id: 0 }], total: 2 });
        }
        if (url.pathname === "/api/classifieds/123") return WorkerResponse.json({ ad });
        assert.equal(url.pathname, "/api/classifieds");
        return WorkerResponse.json({ ads: [ad], total: 1, limit: 1, offset: 0,
          has_more: false, next_offset: null });
      },
    });
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
      assert.equal(result.serverInfo.version, "1.3.0");
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
    async function tool(client, name, args) {
      const result = await rpc(client, "tools/call", { name, arguments: args });
      assert.ok(!result.isError, JSON.stringify(result));
      return result.structuredContent ?? JSON.parse(result.content.at(-1).text);
    }
    assert.equal((await tool(a, "get_categories", { parent_id: 0 })).total, 1);
    const search = await tool(a, "search_classifieds", { q: "livre", limit: 1 });
    assert.equal(search.results[0].id, 123);
    assert.equal(search.results[0].price.currency, "CHF");
    assert.equal((await tool(a, "get_classified", { id: 123 })).id, 123);
    assert.equal((await tool(b, "get_cantons", {})).total, 12);
    assert.equal((await tool(b, "suggest_filters", { query: "livre à Sion moins de 20 CHF" }))
      .filters.price_max, 20);
    const before = calls.length;
    assert.equal((await tool(b, "get_categories", { parent_id: 28 })).total, 0);
    assert.equal(calls.length, before, "Restricted category is rejected before origin call");
    const failure = await rpc(b, "tools/call", {
      name: "search_classifieds", arguments: { q: "fixture-service-error", limit: 1 },
    });
    assert.equal(failure.isError, true);
    assert.equal(JSON.parse(failure.content[0].text).status, 401);
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
  } finally {
    if (mf) await mf.dispose();
    await rm(root, { recursive: true });
  }
});

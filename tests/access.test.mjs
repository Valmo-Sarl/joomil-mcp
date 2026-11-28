import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const dir = await mkdtemp("/tmp/opencode/joomil-mcp-access-");
let access;
try {
  await build({ entryPoints: ["src/access.ts"], outfile: `${dir}/access.mjs`, format: "esm", platform: "node" });
  access = await import(pathToFileURL(`${dir}/access.mjs`));
} finally {
  await rm(dir, { recursive: true });
}
const TOKEN = "M".repeat(43); // Explicitly fictitious; no live variables are loaded.
const { apiRequest, guardMcpRequest, guardMcpTool, guardStatelessMcpTool } = access;
function limiter(max) {
  const keys = [], counts = new Map();
  return { keys, async limit({ key }) {
    keys.push(key);
    const count = counts.get(key) ?? 0;
    if (count >= max) return { success: false };
    counts.set(key, count + 1);
    return { success: true };
  } };
}
function environment(sessionLimit = 2, ipLimit = 10) {
  return { JOOMIL_API_TOKEN: TOKEN, MCP_IP_LIMITER: limiter(ipLimit),
    MCP_SESSION_LIMITER: limiter(sessionLimit) };
}
function request(session, options = {}) {
  return new Request(`https://fixture.invalid${options.path ?? "/mcp"}`, {
    method: options.method ?? "POST", headers: {
      "CF-Connecting-IP": options.peer ?? "192.0.2.1",
      ...(session ? { "Mcp-Session-Id": session } : {}),
      ...(options.headers ?? {}),
    },
  });
}

test("two sessions at the same ingress peer have independent allowances", async () => {
  const env = environment();
  assert.equal(await guardMcpRequest(request("session-a"), env), null);
  assert.equal(await guardMcpTool(env, "sdk-session-a"), null);
  assert.equal(await guardMcpTool(env, "sdk-session-a"), null);
  assert.equal(await guardMcpTool(env, "sdk-session-a"), 429);
  assert.equal(await guardMcpRequest(request("session-b"), env), null);
  assert.equal(await guardMcpTool(env, "sdk-session-b"), null);
  assert.notEqual(env.MCP_SESSION_LIMITER.keys[0], env.MCP_SESSION_LIMITER.keys.at(-1));
});

test("IP churn cannot reset the session budget", async () => {
  const env = environment(1);
  assert.equal(await guardMcpTool(env, "sdk-session-a"), null);
  assert.equal(await guardMcpRequest(request("session-a", { peer: "192.0.2.2" }), env), null);
  assert.equal(await guardMcpTool(env, "sdk-session-a"), 429);
});

test("stateless tool quotas use the trusted peer without affecting legacy session quotas", async () => {
  const env = environment(1);
  assert.equal(await guardStatelessMcpTool(env, request("unused-a")), null);
  assert.equal(await guardStatelessMcpTool(env, request("unused-b", {
    headers: { "X-Forwarded-For": "198.51.100.2" },
  })), 429);
  assert.equal(await guardMcpTool(env, "192.0.2.1"), null, "Separate HMAC scopes");
  assert.equal(await guardStatelessMcpTool(env, request(null, { peer: "192.0.2.2" })), null);
  assert.equal(await guardStatelessMcpTool(env, request(null, { peer: "" })), 503);
});

test("aggregate bounds new-session churn; no claim of per-person identity", async () => {
  const env = environment(10, 2);
  assert.equal(await guardMcpRequest(request(null), env), null);
  assert.equal(await guardMcpRequest(request("a"), env), null);
  assert.equal((await guardMcpRequest(request("b"), env)).status, 429);
  const blocked = await guardMcpRequest(request("c"), env);
  assert.equal(blocked.headers.get("Retry-After"), "60");
  assert.equal(blocked.headers.get("Cache-Control"), "no-store");
  assert.equal(await guardMcpRequest(request("b", { peer: "192.0.2.2" }), env), null);
});

test("forwarded headers and user agent cannot choose an ingress identity", async () => {
  const env = environment(10);
  await guardMcpRequest(request("a"), env);
  await guardMcpRequest(request("b", { headers: { "X-Forwarded-For": "198.51.100.99",
    "X-Real-IP": "198.51.100.99", "User-Agent": "arbitrary" } }), env);
  assert.equal(env.MCP_IP_LIMITER.keys[0], env.MCP_IP_LIMITER.keys[1]);
});

test("IPv6 is canonicalized and keys contain no raw peer/session/secret", async () => {
  const env = environment(10);
  await guardMcpRequest(request("session-opaque", { peer: "2001:db8::1" }), env);
  await guardMcpRequest(request("session-opaque", { peer: "2001:0db8:0:0:0:0:0:1" }), env);
  await guardMcpTool(env, "sdk-session-opaque");
  assert.equal(env.MCP_IP_LIMITER.keys[0], env.MCP_IP_LIMITER.keys[1]);
  for (const key of [...env.MCP_IP_LIMITER.keys, ...env.MCP_SESSION_LIMITER.keys]) {
    assert.match(key, /^[a-f0-9]{64}$/);
    assert.ok(!key.includes(TOKEN) && !key.includes("session") && !key.includes("2001:"));
  }
});

test("each tool consumes a unit even when transport messages are batched", async () => {
  const env = environment(2);
  const outcomes = await Promise.all([1, 2, 3].map(() => guardMcpTool(env, "sdk-session-a")));
  // Concurrent HMACs can reach the limiter in a different order.
  assert.equal(outcomes.filter((status) => status === null).length, 2);
  assert.equal(outcomes.filter((status) => status === 429).length, 1);
  assert.equal(env.MCP_SESSION_LIMITER.keys.length, 3);
  assert.equal(await guardMcpTool(env, "sdk-session-b"), null);
  assert.equal(await guardMcpTool(env, ""), 503);
  assert.equal(await guardMcpTool({ ...env, MCP_SESSION_LIMITER: undefined }, "sdk-session"), 503);
});
test("missing/invalid ingress, token, binding or failed binding gives 503", async () => {
  for (const peer of ["", "999.0.0.1", "1.2.3", "01.2.3.4", "[2001:db8::1]", "invalid"]) {
    assert.equal((await guardMcpRequest(request("a", { peer }), environment())).status, 503);
  }
  for (const patch of [{ JOOMIL_API_TOKEN: "" }, { MCP_IP_LIMITER: undefined },
    { MCP_SESSION_LIMITER: undefined }, { MCP_IP_LIMITER: { limit() { throw Error("fixture"); } } },
    { MCP_IP_LIMITER: { limit() { return {}; } } }]) {
    assert.equal((await guardMcpRequest(request("a"), { ...environment(), ...patch })).status, 503);
  }
});

test("preflight/teardown and unrelated routes remain SDK decisions", async () => {
  for (const method of ["OPTIONS", "DELETE", "HEAD"]) {
    assert.equal(await guardMcpRequest(request("a", { method }), {}), null);
  }
  assert.equal(await guardMcpRequest(request("a", { path: "/unknown" }), {}), null);
});

test("GET transport is aggregate-limited, not a session tool call", async () => {
  const env = environment();
  assert.equal(await guardMcpRequest(request("a", { method: "GET" }), env), null);
  assert.equal(env.MCP_SESSION_LIMITER.keys.length, 0);
  assert.equal(env.MCP_IP_LIMITER.keys.length, 1);
});

test("upstream request has only the service credential, not client headers", () => {
  const req = apiRequest("https://www.joomil.ch", "/api/classifieds",
    { q: "objet fictif", limit: 1, offset: 0, unused: undefined, empty: "" }, TOKEN);
  assert.equal(req.headers.get("X-Joomil-MCP-Token"), TOKEN);
  assert.equal(req.headers.get("CF-Connecting-IP"), null);
  assert.equal(req.headers.get("Mcp-Session-Id"), null);
  assert.equal(req.redirect, "manual");
  assert.equal(new URL(req.url).searchParams.get("q"), "objet fictif");
  assert.ok(!req.url.includes(TOKEN));
  assert.equal(new URL(req.url).searchParams.has("unused"), false);
});

test("no credential leak to other hosts, userinfo, redirects or arbitrary routes", () => {
  for (const base of ["http://www.joomil.ch", "https://www.joomil.ch.evil.invalid",
    "https://other.invalid", "https://user@www.joomil.ch", "https://www.joomil.ch/?q=x",
    "https://www.joomil.ch/path", "https://www.joomil.ch/#fragment"]) {
    assert.throws(() => apiRequest(base, "/api/categories", {}, TOKEN), /configuration/);
  }
  for (const path of ["//evil.invalid/api/categories", "/admin", "/api/classifieds/../private"]) {
    assert.throws(() => apiRequest("https://www.joomil.ch", path, {}, TOKEN), /configuration/);
  }
  assert.throws(() => apiRequest("https://www.joomil.ch", "/api/categories", {}, ""), /configuration/);
});

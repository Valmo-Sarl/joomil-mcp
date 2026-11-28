/** Quota isolation, not user authentication. No raw IP/session forwarded upstream. */
export interface AccessEnv {
  JOOMIL_API_TOKEN: string;
  MCP_IP_LIMITER: RateLimit;
  MCP_SESSION_LIMITER: RateLimit;
}

const MCP_PATH = new URLPattern({ pathname: "/mcp" });

export function validServiceToken(token: unknown): token is string {
  return typeof token === "string" && /^[A-Za-z0-9_-]{43,128}$/.test(token);
}

function normalizedIp(raw: string | null): string | null {
  if (!raw || raw.length > 45) return null;
  if (raw.includes(":")) {
    if (!/^[a-fA-F0-9:.]+$/.test(raw)) return null;
    try {
      return new URL(`http://[${raw}]/`).hostname;
    } catch {
      return null;
    }
  }
  const octets = raw.split(".");
  if (octets.length !== 4 || octets.some((part) => !/^(0|[1-9]\d{0,2})$/.test(part) || Number(part) > 255)) {
    return null;
  }
  return octets.join(".");
}

async function limiterKey(token: string, scope: string, value: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(token),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(`joomil:mcp:${scope}:v1:${value}`));
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function denied(status: 429 | 503): Response {
  return new Response(JSON.stringify({
    jsonrpc: "2.0", id: null,
    error: { code: -32000, message: status === 429 ? "Too many requests" : "Service temporarily unavailable" },
  }), { status, headers: {
    "Content-Type": "application/json", "Cache-Control": "no-store",
    "Retry-After": status === 429 ? "60" : "5",
  } });
}

/**
 * Before McpAgent/DO, where Cloudflare's ingress peer is still available.
 * Only an ingress aggregate is checked here. Tool quotas run inside the
 * initialized SDK Durable Object, once PER TOOL, including JSON-RPC batches.
 * Native bindings are approximate per Cloudflare location, not global accounting.
 */
export async function guardMcpRequest(request: Request, env: AccessEnv): Promise<Response | null> {
  // Same URLPattern contract as McpAgent.serve("/mcp"), not a second router.
  if (!MCP_PATH.test(request.url)) return null;
  // Keep preflight and session teardown usable even under quota/storage failures.
  if (request.method !== "POST" && request.method !== "GET") return null;
  if (!validServiceToken(env.JOOMIL_API_TOKEN)) return denied(503);
  const peer = normalizedIp(request.headers.get("CF-Connecting-IP"));
  if (!peer || !env.MCP_IP_LIMITER || !env.MCP_SESSION_LIMITER) return denied(503);
  try {
    const aggregate = await env.MCP_IP_LIMITER.limit({
      key: await limiterKey(env.JOOMIL_API_TOKEN, "ingress", peer),
    });
    if (typeof aggregate?.success !== "boolean") return denied(503);
    if (!aggregate.success) return denied(429);
    return null;
  } catch {
    return denied(503);
  }
}

/** SDK/DO ID, not an unverified caller header. Still a session, NOT an account. */
export async function guardMcpTool(env: AccessEnv, sessionName: string): Promise<429 | 503 | null> {
  return guardToolScope(env, "session", sessionName);
}

/** Modern MCP has no session; separately bound tool calls by the trusted ingress peer. */
export async function guardStatelessMcpTool(env: AccessEnv, request: Request): Promise<429 | 503 | null> {
  const peer = normalizedIp(request.headers.get("CF-Connecting-IP"));
  return peer ? guardToolScope(env, "stateless-peer", peer) : 503;
}

async function guardToolScope(env: AccessEnv, scope: string, identity: string): Promise<429 | 503 | null> {
  if (!validServiceToken(env.JOOMIL_API_TOKEN) || !env.MCP_SESSION_LIMITER
    || typeof identity !== "string" || !identity || identity.length > 512) return 503;
  try {
    const result = await env.MCP_SESSION_LIMITER.limit({
      key: await limiterKey(env.JOOMIL_API_TOKEN, scope, identity),
    });
    if (typeof result?.success !== "boolean") return 503;
    return result.success ? null : 429;
  } catch {
    return 503;
  }
}

/** Credential is only sent to the fixed HTTPS Joomil origin, never redirects. */
export function apiRequest(
  base: string, path: string, params: Record<string, string | number | undefined>, token: string,
): Request {
  const upstream = new URL(base);
  if (upstream.origin !== "https://www.joomil.ch" || upstream.username || upstream.password
    || upstream.pathname !== "/" || upstream.search || upstream.hash
    || !/^\/api\/(?:categories|classifieds(?:\/[1-9]\d*)?)$/.test(path)
    || !validServiceToken(token)) {
    throw new Error("Invalid upstream service configuration");
  }
  const url = new URL(path, upstream);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
  }
  // Workers supports follow/manual, not the browser's "error" mode.
  // joomilFetch rejects every non-2xx response, including redirects.
  return new Request(url, { redirect: "manual", headers: {
    "User-Agent": "joomil-mcp/1.3.3",
    "X-Joomil-MCP-Token": token,
  } });
}

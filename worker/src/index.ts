/**
 * Nature Risk CORS Proxy — Cloudflare Worker
 *
 * Proxies UK government data API requests, injecting API keys from secrets
 * and adding CORS headers so the GitHub Pages SPA can call them.
 *
 * Zero persistent state. Rate-limited to 100 req/min per IP.
 */

export interface Env {
  ALLOWED_ORIGIN: string;
  OS_DATA_HUB_KEY?: string;
  MET_OFFICE_KEY?: string;
  UKHO_KEY?: string;
  ANTHROPIC_KEY?: string;
}

/* ------------------------------------------------------------------ */
/*  Rate limiter — sliding window per IP, 100 req/min                 */
/* ------------------------------------------------------------------ */

interface RateEntry {
  count: number;
  resetAt: number;
}

const rateLimitMap = new Map<string, RateEntry>();
const RATE_LIMIT = 100;
const RATE_WINDOW_MS = 60_000;

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);

  if (!entry || now >= entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return false;
  }

  entry.count++;
  if (entry.count > RATE_LIMIT) {
    return true;
  }
  return false;
}

/** Periodically prune expired entries to bound memory */
function pruneRateMap(): void {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap) {
    if (now >= entry.resetAt) {
      rateLimitMap.delete(ip);
    }
  }
}

/* ------------------------------------------------------------------ */
/*  Route definitions                                                  */
/* ------------------------------------------------------------------ */

interface Route {
  prefix: string;
  upstream: string;
  /** Header name to inject the API key as */
  keyHeader?: string;
  /** Env field that holds the secret */
  keyEnvField?: keyof Env;
  /** For Anthropic-style "x-api-key" vs query-param injection */
  keyInjection?: 'header' | 'query';
  keyQueryParam?: string;
}

const ROUTES: Route[] = [
  {
    prefix: '/api/ea/',
    upstream: 'https://environment.data.gov.uk/',
  },
  {
    prefix: '/api/os/',
    upstream: 'https://api.os.uk/',
    keyEnvField: 'OS_DATA_HUB_KEY',
    keyInjection: 'query',
    keyQueryParam: 'key',
  },
  {
    prefix: '/api/bgs/',
    upstream: 'https://www.bgs.ac.uk/',
  },
  {
    prefix: '/api/met/',
    upstream: 'https://data.hub.api.metoffice.gov.uk/',
    keyEnvField: 'MET_OFFICE_KEY',
    keyInjection: 'header',
    keyHeader: 'apikey',
  },
  {
    prefix: '/api/ukho/',
    upstream: 'https://datahub.admiralty.co.uk/',
    keyEnvField: 'UKHO_KEY',
    keyInjection: 'header',
    keyHeader: 'Ocp-Apim-Subscription-Key',
  },
  {
    prefix: '/api/ntslf/',
    upstream: 'https://www.ntslf.org/',
  },
  {
    prefix: '/api/claude/',
    upstream: 'https://api.anthropic.com/v1/',
    keyEnvField: 'ANTHROPIC_KEY',
    keyInjection: 'header',
    keyHeader: 'x-api-key',
  },
  {
    prefix: '/api/natural-england/',
    upstream: 'https://services.arcgis.com/JJzESW51TqeY9uat/arcgis/rest/services/',
  },
];

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

const MAX_REQUEST_BODY = 1_048_576; // 1 MB

const SENSITIVE_RESPONSE_HEADERS = new Set([
  'set-cookie',
  'x-powered-by',
  'server',
  'x-aspnet-version',
  'x-aspnetmvc-version',
]);

function jsonError(status: number, message: string): Response {
  return new Response(
    JSON.stringify({ error: message, status }),
    {
      status,
      headers: { 'Content-Type': 'application/json' },
    },
  );
}

function getAllowedOrigins(env: Env): string[] {
  const origins = [env.ALLOWED_ORIGIN];
  // Allow localhost for local development
  origins.push('http://localhost:3000');
  origins.push('http://localhost:5173');
  return origins;
}

function corsHeaders(origin: string): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key, anthropic-version',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function matchRoute(pathname: string): { route: Route; suffix: string } | null {
  for (const route of ROUTES) {
    if (pathname.startsWith(route.prefix)) {
      return { route, suffix: pathname.slice(route.prefix.length) };
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/*  Main handler                                                       */
/* ------------------------------------------------------------------ */

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const start = Date.now();
    const url = new URL(request.url);
    const method = request.method;
    const clientIp = request.headers.get('cf-connecting-ip') ?? '0.0.0.0';

    // --- Prune rate map occasionally (1-in-50 requests) ---
    if (Math.random() < 0.02) {
      pruneRateMap();
    }

    // --- Determine origin ---
    const origin = request.headers.get('Origin') ?? '';
    const allowedOrigins = getAllowedOrigins(env);
    const originAllowed = allowedOrigins.includes(origin);
    const effectiveOrigin = originAllowed ? origin : env.ALLOWED_ORIGIN;

    // --- Health check ---
    if (url.pathname === '/' || url.pathname === '/health') {
      return new Response(
        JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }),
        {
          headers: {
            'Content-Type': 'application/json',
            ...corsHeaders(effectiveOrigin),
          },
        },
      );
    }

    // --- Preflight ---
    if (method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(effectiveOrigin),
      });
    }

    // --- Origin check (non-OPTIONS) ---
    if (origin && !originAllowed) {
      return jsonError(403, 'Origin not allowed');
    }

    // --- Rate limiting ---
    if (isRateLimited(clientIp)) {
      return jsonError(429, 'Rate limit exceeded — 100 requests per minute');
    }

    // --- Route matching ---
    const match = matchRoute(url.pathname);
    if (!match) {
      return jsonError(404, `No route matched for path: ${url.pathname}`);
    }

    const { route, suffix } = match;

    // --- Request validation ---
    if (method === 'POST' || method === 'PUT') {
      const contentType = request.headers.get('Content-Type');
      if (!contentType) {
        return jsonError(400, 'Content-Type header required for POST/PUT requests');
      }

      const contentLength = request.headers.get('Content-Length');
      if (contentLength && parseInt(contentLength, 10) > MAX_REQUEST_BODY) {
        return jsonError(413, 'Request body exceeds 1 MB limit');
      }
    }

    // --- Build upstream URL ---
    const upstreamUrl = new URL(suffix, route.upstream);
    // Preserve query parameters from original request
    url.searchParams.forEach((value, key) => {
      upstreamUrl.searchParams.set(key, value);
    });

    // Inject API key as query param if configured
    if (route.keyInjection === 'query' && route.keyQueryParam && route.keyEnvField) {
      const key = env[route.keyEnvField];
      if (key && typeof key === 'string') {
        upstreamUrl.searchParams.set(route.keyQueryParam, key);
      }
    }

    // --- Build upstream headers ---
    const upstreamHeaders = new Headers();
    // Forward safe headers from original request
    const forwardHeaders = ['Content-Type', 'Accept', 'Accept-Language', 'anthropic-version'];
    for (const h of forwardHeaders) {
      const val = request.headers.get(h);
      if (val) {
        upstreamHeaders.set(h, val);
      }
    }

    // Inject API key: client-supplied key takes priority over server secret,
    // so users can authenticate with their own Anthropic key.
    if (route.keyInjection === 'header' && route.keyHeader) {
      const clientKey = route.keyHeader ? request.headers.get(route.keyHeader) : null;
      const serverKey = route.keyEnvField ? env[route.keyEnvField] : undefined;
      const resolvedKey = clientKey || (typeof serverKey === 'string' ? serverKey : null);
      if (resolvedKey) {
        upstreamHeaders.set(route.keyHeader, resolvedKey);
      }
    }

    // Inject required Anthropic headers server-side for /api/claude/ route
    // (clients in proxy-only mode never send these headers themselves)
    if (url.pathname.startsWith('/api/claude/')) {
      if (!upstreamHeaders.has('anthropic-version')) {
        upstreamHeaders.set('anthropic-version', '2023-06-01');
      }
    }

    // --- Proxy the request ---
    let body: ReadableStream | null = null;
    if (method !== 'GET' && method !== 'HEAD') {
      body = request.body;
    }

    let upstreamResponse: Response;
    try {
      upstreamResponse = await fetch(upstreamUrl.toString(), {
        method,
        headers: upstreamHeaders,
        body,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Upstream request failed';
      console.error(`[proxy] Upstream error for ${route.prefix}: ${message}`);
      return jsonError(502, `Upstream error: ${message}`);
    }

    // --- Build response with CORS and cache headers ---
    const responseHeaders = new Headers();

    // Copy upstream headers, stripping sensitive ones
    upstreamResponse.headers.forEach((value, key) => {
      if (!SENSITIVE_RESPONSE_HEADERS.has(key.toLowerCase())) {
        responseHeaders.set(key, value);
      }
    });

    // CORS
    const cors = corsHeaders(effectiveOrigin);
    for (const [k, v] of Object.entries(cors)) {
      responseHeaders.set(k, v);
    }

    // Cache headers for GET data API responses (not Claude)
    if (method === 'GET' && !url.pathname.startsWith('/api/claude/')) {
      if (!responseHeaders.has('Cache-Control')) {
        responseHeaders.set('Cache-Control', 'public, max-age=3600');
      }
    }

    // --- Logging ---
    const latency = Date.now() - start;
    console.log(
      `[proxy] ${method} ${url.pathname} -> ${upstreamUrl.origin} | ${upstreamResponse.status} | ${latency}ms | ${clientIp}`,
    );

    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers: responseHeaders,
    });
  },
} satisfies ExportedHandler<Env>;

// ─── Claude AI Advisory Service ─────────────────────────────────────────────
// Typed TypeScript port of docs/app/advisor.js. Routes through a configurable
// proxy URL for CORS compliance. Falls back to deterministic demo mode when
// no API key or proxy is configured.
//
// Referenced decisions: ADR-003 (proxy), ADR-005 (LLM guardrails), PRD §8, §9

import type {
  AnalysisMode,
  UserIntent,
  InterventionType,
  PhysicsResult,
  InlandPhysicsResult,
  CoastalPhysicsResult,
  AdvisoryResult,
  Coordinates,
} from '@/types';
import { DISCLAIMER_TEXT } from '@/types';

// ─── Constants ──────────────────────────────────────────────────────────────

const WORKER_PROXY_BASE = import.meta.env.VITE_PROXY_URL ?? '';
const ANTHROPIC_DIRECT_URL = WORKER_PROXY_BASE
  ? `${WORKER_PROXY_BASE}/api/claude/messages`
  : 'https://api.anthropic.com/v1/messages';
const CLAUDE_MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS = 1500;
const SESSION_KEY_API_KEY = 'nature_risk_advisor_api_key';
const SESSION_KEY_PROXY_URL = 'nature_risk_advisor_proxy_url';

const SYSTEM_PROMPT = `You are the Nature Risk Advisory Engine — a UK geospatial AI assistant that synthesises physics engine results into plain-English investment narratives.

HARD RULES (never violate):
1. You NEVER perform, estimate, or modify any numerical calculations. All numbers come from the physics engine only.
2. You NEVER fabricate geospatial, topographical, or bathymetric data.
3. You ALWAYS cite the data source for every factual claim using the format [Source: {name}].
4. You ALWAYS include the standard disclaimer in every analysis response.
5. You NEVER provide regulated financial advice, guarantee insurance premium reductions, or certify carbon credit yields.
6. You NEVER claim results are suitable for planning submissions, regulatory filings, or certified flood risk assessments.

STANDARD DISCLAIMER (include at end of every response):
"${DISCLAIMER_TEXT}"

YOUR SCOPE (only these three tasks):
A. SPATIAL VALIDATION: Check if an intervention placement is ecologically and hydrologically plausible given the coordinates and soil/substrate type.
B. NARRATIVE SYNTHESIS: Convert physics engine numbers into a clear, plain-English investment narrative suitable for a Board paper.
C. SCALE WARNINGS: If the physics engine flags a scale warning, amplify it with context about why the project size matters.

OUTPUT FORMAT (respond with valid JSON only — no markdown fences, no prose outside the JSON):
{
  "narrative": "<full markdown narrative for the chat pane>",
  "spatialValidation": {
    "valid": <boolean>,
    "message": "<plain-English validation message>",
    "suggestions": ["<suggestion 1>", "<suggestion 2>"]
  },
  "scaleWarnings": ["<warning 1>"],
  "confidenceSummary": "<one-sentence confidence summary>",
  "disclaimer": "${DISCLAIMER_TEXT}"
}`;

// ─── Internal State ─────────────────────────────────────────────────────────

interface AdvisorConfig {
  apiKey: string | null;
  proxyUrl: string | null;
}

let _config: AdvisorConfig = {
  apiKey: null,
  proxyUrl: null,
};

// Seed defaults from Vite env vars (set at build time)
if (WORKER_PROXY_BASE) _config.proxyUrl = WORKER_PROXY_BASE;
if (import.meta.env.VITE_ANTHROPIC_KEY) _config.apiKey = import.meta.env.VITE_ANTHROPIC_KEY;

// Rehydrate from sessionStorage (overrides env defaults if user has configured manually)
try {
  const savedKey = sessionStorage.getItem(SESSION_KEY_API_KEY);
  const savedProxy = sessionStorage.getItem(SESSION_KEY_PROXY_URL);
  if (savedKey) _config.apiKey = savedKey;
  if (savedProxy) _config.proxyUrl = savedProxy;
} catch {
  // sessionStorage unavailable
}

// ─── Input Sanitisation ─────────────────────────────────────────────────────

function sanitise(input: string, maxLen = 2000): string {
  if (typeof input !== 'string') return '';
  return input
    .replace(/\0/g, '')            // null bytes
    .replace(/[<>]/g, '')          // angle brackets
    .replace(/\r\n|\r/g, '\n')    // normalise line endings
    .replace(/\n{4,}/g, '\n\n\n') // collapse excessive blank lines
    .slice(0, maxLen)
    .trim();
}

// ─── API Parameters ─────────────────────────────────────────────────────────

export interface AnalyseParams {
  mode: AnalysisMode;
  userIntent: UserIntent;
  interventionType: InterventionType | string;
  interventionAreaHa: number;
  assetDescription: string;
  physicsResult: PhysicsResult;
  coordinates: Coordinates;
  userMessage?: string;
}

// ─── API Call ───────────────────────────────────────────────────────────────

function buildUserMessage(params: AnalyseParams): string {
  const safeAsset = sanitise(params.assetDescription, 500);
  const safeIntent = sanitise(params.userMessage ?? '', 1000);
  const coordStr = `${params.coordinates.lat.toFixed(6)}, ${params.coordinates.lng.toFixed(6)}`;

  return [
    `## Analysis Request`,
    ``,
    `**Mode:** ${params.mode}`,
    `**User Intent:** ${params.userIntent}`,
    `**Intervention Type:** ${sanitise(String(params.interventionType), 200)}`,
    `**Intervention Area:** ${params.interventionAreaHa} ha`,
    `**Asset Description:** ${safeAsset}`,
    `**Coordinates (lat, lng):** ${coordStr}`,
    ``,
    `## User Message`,
    safeIntent || '(No additional user message)',
    ``,
    `## Physics Engine Results (authoritative — do not modify these values)`,
    '```json',
    JSON.stringify(params.physicsResult, null, 2),
    '```',
    ``,
    `Please perform spatial validation, generate the narrative, surface any scale warnings, and return the structured JSON response as specified in your instructions.`,
  ].join('\n');
}

interface ClaudeError extends Error {
  userMessage: string;
  fallback?: boolean;
}

function createClaudeError(message: string, userMessage: string, fallback = false): ClaudeError {
  const err = new Error(message) as ClaudeError;
  err.userMessage = userMessage;
  err.fallback = fallback;
  return err;
}

async function callClaude(userMessage: string): Promise<string> {
  const endpointUrl = _config.proxyUrl || ANTHROPIC_DIRECT_URL;

  const requestBody = {
    model: CLAUDE_MODEL,
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userMessage }],
  };

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (_config.apiKey) {
    headers['x-api-key'] = _config.apiKey;
    headers['anthropic-version'] = '2023-06-01';
  }

  let response: Response;
  try {
    response = await fetch(endpointUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody),
    });
  } catch {
    throw createClaudeError(
      'Network error',
      'Network error — could not reach the advisory service. Falling back to demo mode.',
      true,
    );
  }

  if (response.status === 429) {
    throw createClaudeError('Rate limited', 'Rate limited — please wait 60 seconds before retrying.');
  }

  if (response.status === 401) {
    throw createClaudeError('Unauthorised', 'Invalid API key — check your advisory service configuration.');
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw createClaudeError(
      `API error ${response.status}: ${body.slice(0, 200)}`,
      `Advisory service error (${response.status}) — falling back to demo mode.`,
      true,
    );
  }

  const data = await response.json();
  const firstBlock = Array.isArray(data.content) && data.content[0];
  if (!firstBlock || firstBlock.type !== 'text') {
    throw createClaudeError(
      'Unexpected response shape',
      'Unexpected response from advisory service — falling back to demo mode.',
      true,
    );
  }

  return firstBlock.text;
}

// ─── Response Parsing ───────────────────────────────────────────────────────

function parseModelResponse(rawText: string): AdvisoryResult {
  const stripped = rawText
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();

  try {
    const parsed = JSON.parse(stripped);
    return {
      narrative: typeof parsed.narrative === 'string' ? parsed.narrative : rawText,
      spatialValidation: parsed.spatialValidation ?? {
        valid: true,
        message: 'No spatial validation data returned.',
        suggestions: [],
      },
      scaleWarnings: Array.isArray(parsed.scaleWarnings) ? parsed.scaleWarnings : [],
      confidenceSummary: typeof parsed.confidenceSummary === 'string'
        ? parsed.confidenceSummary
        : 'Confidence summary unavailable.',
      disclaimer: DISCLAIMER_TEXT,
      rawResponse: rawText,
    };
  } catch {
    return {
      narrative: rawText,
      spatialValidation: {
        valid: true,
        message: 'Spatial validation could not be parsed from model response.',
        suggestions: [],
      },
      scaleWarnings: [],
      confidenceSummary: 'Confidence summary unavailable.',
      disclaimer: DISCLAIMER_TEXT,
      rawResponse: rawText,
    };
  }
}

// ─── Demo Mode ──────────────────────────────────────────────────────────────

function isInlandResult(result: PhysicsResult): result is InlandPhysicsResult {
  return 'peakFlowReductionPct' in result;
}

function isCoastalResult(result: PhysicsResult): result is CoastalPhysicsResult {
  return 'waveEnergyReductionPct' in result;
}

function buildDemoResult(params: AnalyseParams, warningPrefix?: string): AdvisoryResult {
  const physics = params.physicsResult;
  const mode = params.mode;
  const interventionType = params.interventionType;
  const areaHa = params.interventionAreaHa;
  const coordStr = `${params.coordinates.lat.toFixed(4)} N, ${params.coordinates.lng.toFixed(4)} E`;

  let narrative = '';

  if (mode === 'inland' || mode === 'mixed') {
    const floodHeight = isInlandResult(physics) ? `${physics.floodHeightReductionM} m` : 'data pending';
    const peakFlow = isInlandResult(physics) ? `${physics.peakFlowReductionPct}%` : 'data pending';
    const peakDelay = isInlandResult(physics) ? `${physics.peakDelayHrs} hrs` : 'data pending';
    const confidence = physics.confidence.level;
    const uncertainty = `+/- ${physics.confidence.uncertaintyPct}%`;

    narrative = [
      `## Pre-Feasibility Advisory -- ${interventionType} (Inland Hydrology)`,
      ``,
      `**Site:** ${coordStr}`,
      `**Intervention Area:** ${areaHa} ha`,
      `**Confidence Level:** ${confidence} ${uncertainty} [Source: Physics Engine v1 -- ADR-004]`,
      ``,
      `### Summary`,
      ``,
      `The proposed ${interventionType} of ${areaHa} ha has been assessed against the contributing catchment ` +
        `hydrology at this location. The deterministic physics engine estimates a peak flood height reduction of ` +
        `**${floodHeight}** at the downstream asset, with an associated peak flow rate reduction of ` +
        `**${peakFlow}** [Source: EA LIDAR Composite 1m, BGS Soilscapes] and a flood peak delay of ` +
        `**${peakDelay}** [Source: OS Open Rivers, EA RoFRS].`,
      ``,
      `These results are directional pre-feasibility proxies suitable for informing early-stage investment scoping ` +
        `and Board paper preparation. They are not a certified hydrological model.`,
      ``,
      `### Data Provenance`,
      ``,
      `| Dataset | Source | Resolution | Licence |`,
      `|---------|--------|------------|---------|`,
      `| Elevation model | EA LIDAR Composite | 1-2 m | Open Government Licence |`,
      `| River network | OS Open Rivers | Vector | OS OpenData |`,
      `| Soil classification | BGS Soilscapes | Polygon | OGL / BGS Licence |`,
      `| Flood zones | EA RoFRS | Polygon | Open Government Licence |`,
      `| Climate projections | UKCP18 (Met Office) | Grid | Open Government Licence |`,
      ``,
      `---`,
      ``,
      DISCLAIMER_TEXT,
    ].join('\n');
  } else {
    const waveReduction = isCoastalResult(physics) ? `${physics.waveEnergyReductionPct}%` : 'data pending';
    const surgeReduction = isCoastalResult(physics) ? `${physics.stormSurgeReductionM} m` : 'data pending';
    const erosionDelta = isCoastalResult(physics) ? `${physics.erosionDelta25yrM} m` : 'data pending';
    const confidence = physics.confidence.level;
    const uncertainty = `+/- ${physics.confidence.uncertaintyPct}%`;

    narrative = [
      `## Pre-Feasibility Advisory -- ${interventionType} (Coastal / Marine)`,
      ``,
      `**Site:** ${coordStr}`,
      `**Intervention Area:** ${areaHa} ha`,
      `**Confidence Level:** ${confidence} ${uncertainty} [Source: Physics Engine v1 -- ADR-004]`,
      ``,
      `### Summary`,
      ``,
      `The proposed ${interventionType} of ${areaHa} ha has been assessed against the local bathymetric profile ` +
        `and dominant wave climate. The deterministic physics engine estimates a wave energy reduction of ` +
        `**${waveReduction}** at the onshore asset [Source: UKHO ADMIRALTY Bathymetry, Met Office WaveNet], ` +
        `a storm surge height reduction of **${surgeReduction}** [Source: NTSLF tidal gauge network], and ` +
        `a 25-year shoreline retreat avoided of **${erosionDelta}** [Source: EA NCERM].`,
      ``,
      `### Data Provenance`,
      ``,
      `| Dataset | Source | Licence |`,
      `|---------|--------|---------|`,
      `| Bathymetry | UKHO ADMIRALTY Marine Data Portal | Commercial |`,
      `| Coastal erosion risk | EA NCERM | Open Government Licence |`,
      `| Tidal gauge data | NTSLF / BODC | Open |`,
      `| Wave climate | Met Office CS3X/WaveNet | Registration / API key |`,
      `| Sea-level rise | UKCP18 (Met Office) | Open Government Licence |`,
      ``,
      `---`,
      ``,
      DISCLAIMER_TEXT,
    ].join('\n');
  }

  const demoPrefix = warningPrefix
    ? `> **Demo Mode:** ${warningPrefix}\n>\n> *The narrative below is generated from your physics engine values and demonstrates what a live Claude advisory response looks like.*\n\n`
    : `> **Demo Mode Active** -- configure an API key to enable live Claude advisory.\n>\n> *The narrative below is generated from your physics engine values.*\n\n`;

  const spatialValid = areaHa >= 0.5;

  return {
    narrative: demoPrefix + narrative,
    spatialValidation: {
      valid: spatialValid,
      message: spatialValid
        ? `Intervention placement at ${coordStr} appears spatially plausible for ${interventionType}.`
        : `Intervention area (${areaHa} ha) is below the recommended minimum of 0.5 ha for ${interventionType}.`,
      suggestions: spatialValid
        ? []
        : [
            'Increase intervention area to at least 0.5 ha to achieve meaningful attenuation.',
            'Consider combining multiple smaller parcels within the same sub-catchment.',
          ],
    },
    scaleWarnings: spatialValid
      ? []
      : [`The proposed area of ${areaHa} ha is below minimum effective threshold for ${interventionType}.`],
    confidenceSummary: `${physics.confidence.level} confidence based on physics engine outputs with +/- ${physics.confidence.uncertaintyPct}% uncertainty.`,
    disclaimer: DISCLAIMER_TEXT,
    rawResponse: '[Demo mode -- no live API call made]',
  };
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Configure the advisor with an API key and/or proxy URL.
 * Key is stored in sessionStorage (tab-scoped, never persisted across sessions).
 */
export function configure(options: { apiKey?: string; proxyUrl?: string }): void {
  if (!options || typeof options !== 'object') return;

  if (typeof options.apiKey === 'string' && options.apiKey.trim().length > 0) {
    _config.apiKey = options.apiKey.trim();
    try {
      sessionStorage.setItem(SESSION_KEY_API_KEY, _config.apiKey);
    } catch { /* sessionStorage unavailable */ }
  }

  if (typeof options.proxyUrl === 'string' && options.proxyUrl.trim().length > 0) {
    _config.proxyUrl = options.proxyUrl.trim();
    try {
      sessionStorage.setItem(SESSION_KEY_PROXY_URL, _config.proxyUrl);
    } catch { /* sessionStorage unavailable */ }
  }
}

/**
 * Returns true when the advisor has sufficient configuration for a live API call.
 */
export function isConfigured(): boolean {
  return Boolean(_config.apiKey || _config.proxyUrl);
}

/**
 * Returns the current configuration status.
 */
export function getStatus(): { configured: boolean; mode: 'live' | 'demo' } {
  const configured = isConfigured();
  return { configured, mode: configured ? 'live' : 'demo' };
}

/**
 * Main analysis function. Calls Claude with assembled physics context and
 * returns a structured AdvisoryResult. Falls back to demo mode gracefully.
 */
export async function analyse(params: AnalyseParams): Promise<AdvisoryResult> {
  if (!params || typeof params !== 'object') {
    return buildDemoResult({
      mode: 'inland',
      userIntent: 'asset_manager',
      interventionType: 'tree_planting',
      interventionAreaHa: 1,
      assetDescription: '',
      physicsResult: {} as PhysicsResult,
      coordinates: { lat: 0, lng: 0 },
    }, 'Invalid parameters passed to analyse().');
  }

  if (!isConfigured()) {
    return buildDemoResult(params);
  }

  const userMessage = buildUserMessage(params);

  try {
    const rawResponse = await callClaude(userMessage);
    return parseModelResponse(rawResponse);
  } catch (err) {
    const claudeErr = err as ClaudeError;
    if (claudeErr.fallback) {
      return buildDemoResult(params, claudeErr.userMessage ?? 'Advisory service temporarily unavailable.');
    }
    return {
      narrative: `**Advisory Error:** ${claudeErr.userMessage ?? 'An unexpected error occurred.'}`,
      spatialValidation: { valid: false, message: claudeErr.userMessage ?? '', suggestions: [] },
      scaleWarnings: [],
      confidenceSummary: 'Not available -- advisory error.',
      disclaimer: DISCLAIMER_TEXT,
      rawResponse: claudeErr.message ?? '',
    };
  }
}

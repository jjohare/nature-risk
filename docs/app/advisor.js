/**
 * @fileoverview NatureRiskAdvisor — Claude AI advisory integration for Nature Risk.
 *
 * Exposes `window.NatureRiskAdvisor`, a pure JavaScript module that calls the
 * Anthropic Claude API to synthesise physics engine results into plain-English
 * investment narratives.  API communication is routed through a configurable
 * proxy URL because the Anthropic API does not support direct browser calls
 * (CORS restriction).  When no live key is available the module falls back to a
 * deterministic demo mode whose narrative is derived directly from the caller's
 * physicsResult values.
 *
 * Architecture note (see ADR-005):
 *   The LLM is the advisory / narrative layer only.  All quantitative values
 *   MUST originate from the deterministic WASM physics engine (ADR-004) and are
 *   passed into this module as `params.physicsResult`.  The Claude system prompt
 *   hard-prohibits arithmetic; the LLM quotes engine values verbatim.
 *
 * @module NatureRiskAdvisor
 * @version 1.0.0
 */

(function (global) {
  'use strict';

  // ---------------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------------

  /** Anthropic messages API endpoint.  Direct calls will be blocked by CORS in
   *  production browsers; always supply a proxyUrl in configure(). */
  const ANTHROPIC_DIRECT_URL = 'https://api.anthropic.com/v1/messages';

  /** Model used for full advisory synthesis (see ADR-005, PRD §8.3). */
  const CLAUDE_MODEL = 'claude-sonnet-4-6';

  /** Maximum tokens to request from the model. */
  const MAX_TOKENS = 1500;

  /** sessionStorage key for the Anthropic API key. */
  const SESSION_KEY_API_KEY = 'nature_risk_advisor_api_key';

  /** sessionStorage key for the proxy URL override. */
  const SESSION_KEY_PROXY_URL = 'nature_risk_advisor_proxy_url';

  /**
   * Mandatory standard disclaimer required by PRD §9.1 and encoded in the
   * system prompt HARD RULES.  Surfaced verbatim in every AdvisoryResult.
   */
  const STANDARD_DISCLAIMER =
    '⚠️ Pre-feasibility model only. Results are directional proxies and are NOT a substitute for a ' +
    'certified Flood Risk Assessment (FRA), structural engineering survey, or regulated Environmental ' +
    'Impact Assessment. Do not use for planning, insurance, or regulatory submissions without ' +
    'independent professional verification.';

  /**
   * System prompt sent verbatim to Claude on every request (see PRD §9 and
   * ADR-005).  Hard rules are never modified by caller input.
   */
  const SYSTEM_PROMPT = `You are the Nature Risk Advisory Engine — a UK geospatial AI assistant that synthesises physics engine results into plain-English investment narratives.

HARD RULES (never violate):
1. You NEVER perform, estimate, or modify any numerical calculations. All numbers come from the physics engine only.
2. You NEVER fabricate geospatial, topographical, or bathymetric data.
3. You ALWAYS cite the data source for every factual claim using the format [Source: {name}].
4. You ALWAYS include the standard disclaimer in every analysis response.
5. You NEVER provide regulated financial advice, guarantee insurance premium reductions, or certify carbon credit yields.
6. You NEVER claim results are suitable for planning submissions, regulatory filings, or certified flood risk assessments.

STANDARD DISCLAIMER (include at end of every response):
"⚠️ Pre-feasibility model only. Results are directional proxies and are NOT a substitute for a certified Flood Risk Assessment (FRA), structural engineering survey, or regulated Environmental Impact Assessment. Do not use for planning, insurance, or regulatory submissions without independent professional verification."

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
  "disclaimer": "${STANDARD_DISCLAIMER}"
}`;

  // ---------------------------------------------------------------------------
  // Internal state
  // ---------------------------------------------------------------------------

  /** @type {{ apiKey: string|null, proxyUrl: string|null }} */
  let _config = {
    apiKey: null,
    proxyUrl: null,
  };

  // Rehydrate from sessionStorage on module load (survives page refresh within
  // the same browser tab).
  (function _rehydrate() {
    try {
      const savedKey = sessionStorage.getItem(SESSION_KEY_API_KEY);
      const savedProxy = sessionStorage.getItem(SESSION_KEY_PROXY_URL);
      if (savedKey) _config.apiKey = savedKey;
      if (savedProxy) _config.proxyUrl = savedProxy;
    } catch (_) {
      // sessionStorage unavailable (private browsing restriction, etc.) — fail
      // silently and continue in demo mode.
    }
  })();

  // ---------------------------------------------------------------------------
  // Input sanitisation
  // ---------------------------------------------------------------------------

  /**
   * Removes characters that could be used for prompt injection when a caller
   * embeds user-supplied strings inside the LLM context (PRD §8.3, ADR-005
   * "Bad" consequences note).  Strips null bytes, reduces consecutive whitespace,
   * and trims to a safe maximum length.
   *
   * @param {string} input - Raw user-supplied string.
   * @param {number} [maxLen=2000] - Maximum permitted length after sanitisation.
   * @returns {string} Sanitised string.
   */
  function _sanitise(input, maxLen) {
    if (typeof input !== 'string') return '';
    maxLen = typeof maxLen === 'number' ? maxLen : 2000;
    return input
      .replace(/\0/g, '')                     // null bytes
      .replace(/[<>]/g, '')                    // angle brackets (HTML / XML injection)
      .replace(/\r\n|\r/g, '\n')               // normalise line endings
      .replace(/\n{4,}/g, '\n\n\n')            // collapse excessive blank lines
      .slice(0, maxLen)
      .trim();
  }

  // ---------------------------------------------------------------------------
  // API call
  // ---------------------------------------------------------------------------

  /**
   * Constructs the user-facing message sent to Claude.  The physics engine
   * results are embedded as a JSON context block so the model never needs to
   * compute values — it only narrates them (ADR-005, PRD §9.3).
   *
   * @param {AnalyseParams} params - Caller-supplied analysis parameters.
   * @returns {string} The assembled user message string.
   */
  function _buildUserMessage(params) {
    const safeAsset = _sanitise(params.assetDescription || '', 500);
    const safeIntent = _sanitise(params.userMessage || '', 1000);
    const coordStr =
      params.coordinates && typeof params.coordinates.lat === 'number'
        ? `${params.coordinates.lat.toFixed(6)}, ${params.coordinates.lng.toFixed(6)}`
        : 'not provided';

    return [
      `## Analysis Request`,
      ``,
      `**Mode:** ${params.mode || 'inland'}`,
      `**User Intent:** ${params.userIntent || 'asset_manager'}`,
      `**Intervention Type:** ${_sanitise(params.interventionType || '', 200)}`,
      `**Intervention Area:** ${params.interventionAreaHa != null ? params.interventionAreaHa + ' ha' : 'not specified'}`,
      `**Asset Description:** ${safeAsset}`,
      `**Coordinates (lat, lng):** ${coordStr}`,
      ``,
      `## User Message`,
      safeIntent,
      ``,
      `## Physics Engine Results (authoritative — do not modify these values)`,
      '```json',
      JSON.stringify(params.physicsResult || {}, null, 2),
      '```',
      ``,
      `Please perform spatial validation, generate the narrative, surface any scale warnings, and return the structured JSON response as specified in your instructions.`,
    ].join('\n');
  }

  /**
   * Calls the Anthropic messages API via the configured proxy URL (or falls
   * back to the direct endpoint for development/testing).
   *
   * @param {string} userMessage - The assembled user message.
   * @returns {Promise<string>} Raw response text from the model.
   * @throws {AdvisorError} With a user-readable `userMessage` property.
   */
  async function _callClaude(userMessage) {
    const endpointUrl = _config.proxyUrl || ANTHROPIC_DIRECT_URL;
    const apiKey = _config.apiKey;

    const requestBody = {
      model: CLAUDE_MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: userMessage,
        },
      ],
    };

    /** @type {HeadersInit} */
    const headers = {
      'Content-Type': 'application/json',
    };

    // Include the API key only when calling the direct Anthropic endpoint or a
    // proxy that expects it forwarded.  A well-built Cloudflare Worker (ADR-003)
    // injects its own secret and should not receive a browser key at all —
    // callers should omit the key and rely solely on proxyUrl in production.
    if (apiKey) {
      headers['x-api-key'] = apiKey;
      headers['anthropic-version'] = '2023-06-01';
    }

    let response;
    try {
      response = await fetch(endpointUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
      });
    } catch (networkErr) {
      const err = new Error('Network error — could not reach the advisory service.');
      err.userMessage = 'Network error — could not reach the advisory service. Falling back to demo mode.';
      err.fallback = true;
      throw err;
    }

    if (response.status === 429) {
      const err = new Error('Rate limited');
      err.userMessage = 'Rate limited — please wait 60 seconds before retrying.';
      throw err;
    }

    if (response.status === 401) {
      const err = new Error('Unauthorised');
      err.userMessage = 'Invalid API key — check your Anthropic Console and re-enter your key.';
      throw err;
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      const err = new Error(`API error ${response.status}: ${body.slice(0, 200)}`);
      err.userMessage = `Advisory service error (${response.status}) — falling back to demo mode.`;
      err.fallback = true;
      throw err;
    }

    const data = await response.json();

    // Anthropic messages API wraps content in an array of content blocks.
    const firstBlock = Array.isArray(data.content) && data.content[0];
    if (!firstBlock || firstBlock.type !== 'text') {
      const err = new Error('Unexpected response shape from Anthropic API');
      err.userMessage = 'Unexpected response from advisory service — falling back to demo mode.';
      err.fallback = true;
      throw err;
    }

    return firstBlock.text;
  }

  // ---------------------------------------------------------------------------
  // Response parsing
  // ---------------------------------------------------------------------------

  /**
   * Parses the JSON payload returned by Claude.  Claude is instructed to return
   * raw JSON; however the model occasionally wraps output in markdown fences —
   * this function strips fences before parsing.
   *
   * @param {string} rawText - The raw string from the model.
   * @returns {{ narrative: string, spatialValidation: object, scaleWarnings: string[], confidenceSummary: string, disclaimer: string }}
   * @throws {Error} When the text cannot be parsed as JSON.
   */
  function _parseModelResponse(rawText) {
    // Strip optional markdown code fences.
    const stripped = rawText
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```\s*$/, '')
      .trim();

    let parsed;
    try {
      parsed = JSON.parse(stripped);
    } catch (_) {
      // Last-resort: if Claude returned prose instead of JSON, wrap it.
      return {
        narrative: rawText,
        spatialValidation: {
          valid: true,
          message: 'Spatial validation could not be parsed from model response.',
          suggestions: [],
        },
        scaleWarnings: [],
        confidenceSummary: 'Confidence summary unavailable.',
        disclaimer: STANDARD_DISCLAIMER,
      };
    }

    return {
      narrative: typeof parsed.narrative === 'string' ? parsed.narrative : rawText,
      spatialValidation: parsed.spatialValidation || {
        valid: true,
        message: 'No spatial validation data returned.',
        suggestions: [],
      },
      scaleWarnings: Array.isArray(parsed.scaleWarnings) ? parsed.scaleWarnings : [],
      confidenceSummary:
        typeof parsed.confidenceSummary === 'string'
          ? parsed.confidenceSummary
          : 'Confidence summary unavailable.',
      disclaimer: STANDARD_DISCLAIMER, // Always use the canonical constant, not whatever the model returned.
    };
  }

  // ---------------------------------------------------------------------------
  // Demo / mock mode
  // ---------------------------------------------------------------------------

  /**
   * Generates a deterministic, input-specific mock AdvisoryResult for use when
   * no live API key is configured or when the live call fails with a fallback
   * error.  The mock narrative incorporates physicsResult values directly so it
   * reads as realistic pre-feasibility output (PRD requirement: demo mode must
   * demonstrate what the live output looks like).
   *
   * @param {AnalyseParams} params - The same params passed to analyse().
   * @param {string} [warningPrefix] - Optional user-facing prefix explaining why
   *   demo mode is active (e.g. a network error message).
   * @returns {AdvisoryResult}
   */
  function _buildDemoResult(params, warningPrefix) {
    const physics = params.physicsResult || {};
    const mode = params.mode || 'inland';
    const interventionType = params.interventionType || 'natural capital intervention';
    const areaHa = params.interventionAreaHa != null ? params.interventionAreaHa : '(area not specified)';
    const coordStr =
      params.coordinates && typeof params.coordinates.lat === 'number'
        ? `${params.coordinates.lat.toFixed(4)}° N, ${params.coordinates.lng.toFixed(4)}° E`
        : 'coordinates not provided';

    // Pull key physics values with safe fallbacks.
    const floodHeightReduction =
      physics.floodHeightReductionM != null ? `${physics.floodHeightReductionM} m` : 'data pending';
    const peakFlowReduction =
      physics.peakFlowReductionPct != null ? `${physics.peakFlowReductionPct}%` : 'data pending';
    const peakDelay =
      physics.peakDelayHrs != null ? `${physics.peakDelayHrs} hrs` : 'data pending';
    const waveEnergyReduction =
      physics.waveEnergyReductionPct != null ? `${physics.waveEnergyReductionPct}%` : 'data pending';
    const stormSurgeReduction =
      physics.stormSurgeReductionM != null ? `${physics.stormSurgeReductionM} m` : 'data pending';
    const erosionDelta =
      physics.erosionDelta25yrM != null ? `${physics.erosionDelta25yrM} m` : 'data pending';
    const confidence = physics.confidenceLevel || 'Medium';
    const uncertaintyRange = physics.uncertaintyPct != null ? `± ${physics.uncertaintyPct}%` : '± estimate unavailable';

    let narrative = '';

    if (mode === 'inland' || mode === 'mixed') {
      narrative = [
        `## Pre-Feasibility Advisory — ${interventionType} (Inland Hydrology)`,
        ``,
        `**Site:** ${coordStr}  `,
        `**Intervention Area:** ${areaHa} ha  `,
        `**Confidence Level:** ${confidence} ${uncertaintyRange} [Source: Physics Engine v1 — ADR-004]`,
        ``,
        `### Summary`,
        ``,
        `The proposed ${interventionType} of ${areaHa} ha has been assessed against the contributing catchment ` +
          `hydrology at this location. The deterministic physics engine estimates a peak flood height reduction of ` +
          `**${floodHeightReduction}** at the downstream asset, with an associated peak flow rate reduction of ` +
          `**${peakFlowReduction}** [Source: EA LIDAR Composite 1m, BGS Soilscapes] and a flood peak delay of ` +
          `**${peakDelay}** [Source: OS Open Rivers, EA RoFRS].`,
        ``,
        `These results are directional pre-feasibility proxies suitable for informing early-stage investment scoping ` +
          `and Board paper preparation. They are not a certified hydrological model.`,
        ``,
        `### Data Provenance`,
        ``,
        `| Dataset | Source | Resolution | Licence |`,
        `|---------|--------|------------|---------|`,
        `| Elevation model | EA LIDAR Composite | 1–2 m | Open Government Licence |`,
        `| River network | OS Open Rivers | Vector | OS OpenData |`,
        `| Soil classification | BGS Soilscapes | Polygon | OGL / BGS Licence |`,
        `| Flood zones | EA RoFRS | Polygon | Open Government Licence |`,
        `| Climate projections | UKCP18 (Met Office) | Grid | Open Government Licence |`,
        ``,
        `### Next Steps`,
        ``,
        `- Commission a site walkover to confirm soil conditions and drainage pathways.`,
        `- Engage a qualified hydrologist for a Flood Risk Assessment (FRA) if outputs are to be used for planning or insurance purposes.`,
        `- Explore BGS Soilscapes data for the specific parcel to refine the water retention estimate.`,
        ``,
        `---`,
        ``,
        `${STANDARD_DISCLAIMER}`,
      ].join('\n');
    } else {
      // Coastal mode narrative
      narrative = [
        `## Pre-Feasibility Advisory — ${interventionType} (Coastal / Marine)`,
        ``,
        `**Site:** ${coordStr}  `,
        `**Intervention Area:** ${areaHa} ha  `,
        `**Confidence Level:** ${confidence} ${uncertaintyRange} [Source: Physics Engine v1 — ADR-004]`,
        ``,
        `### Summary`,
        ``,
        `The proposed ${interventionType} of ${areaHa} ha has been assessed against the local bathymetric profile ` +
          `and dominant wave climate. The deterministic physics engine estimates a wave energy reduction of ` +
          `**${waveEnergyReduction}** at the onshore asset [Source: UKHO ADMIRALTY Bathymetry, Met Office WaveNet], ` +
          `a storm surge height reduction of **${stormSurgeReduction}** [Source: NTSLF tidal gauge network], and ` +
          `a 25-year shoreline retreat avoided of **${erosionDelta}** [Source: EA NCERM].`,
        ``,
        `**Dynamic Morphology Disclosure:** Coastal habitat efficacy is subject to storm disturbance; baseline ` +
          `attenuation values carry a ± 20% inter-annual variability. UKCP18 sea-level rise projections (RCP4.5 and ` +
          `RCP8.5) have been incorporated. Habitat maturation timelines range from 3 years (oyster reef) to 15+ years ` +
          `(saltmarsh succession) before full attenuation efficacy is reached [Source: UKCP18 Met Office, Cefas Saltmarsh Extents].`,
        ``,
        `### Data Provenance`,
        ``,
        `| Dataset | Source | Licence |`,
        `|---------|--------|---------|`,
        `| Bathymetry | UKHO ADMIRALTY Marine Data Portal | Commercial |`,
        `| Coastal erosion risk | EA NCERM | Open Government Licence |`,
        `| Saltmarsh extents | EA / Cefas | Open Government Licence |`,
        `| Tidal gauge data | NTSLF / BODC | Open |`,
        `| Wave climate | Met Office CS3X/WaveNet | Registration / API key |`,
        `| Sea-level rise | UKCP18 (Met Office) | Open Government Licence |`,
        ``,
        `### Next Steps`,
        ``,
        `- Commission bathymetric survey to validate UKHO data at the specific site.`,
        `- Engage a marine environmental consultant for habitat suitability assessment before procurement.`,
        `- Confirm UKHO ADMIRALTY licence terms for commercial use of bathymetric data in this context.`,
        ``,
        `---`,
        ``,
        `${STANDARD_DISCLAIMER}`,
      ].join('\n');
    }

    const demoPrefix = warningPrefix
      ? `> **Demo Mode:** ${warningPrefix}\n>\n> *The narrative below is generated from your physics engine values and demonstrates what a live Claude advisory response looks like.*\n\n`
      : `> **Demo Mode Active** — configure an API key to enable live Claude advisory.\n>\n> *The narrative below is generated from your physics engine values.*\n\n`;

    const spatialValid =
      mode === 'coastal'
        ? areaHa !== '(area not specified)' && Number(areaHa) >= 0.5
        : areaHa !== '(area not specified)' && Number(areaHa) >= 0.5;

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
              `Increase intervention area to at least 0.5 ha to achieve meaningful hydrological or coastal attenuation.`,
              `Consider combining multiple smaller parcels within the same sub-catchment.`,
            ],
      },
      scaleWarnings:
        !spatialValid
          ? [
              `The proposed area of ${areaHa} ha is below minimum effective threshold for ${interventionType}. ` +
                `Results should be treated as indicative only.`,
            ]
          : [],
      confidenceSummary:
        `${confidence} confidence based on physics engine outputs${physics.uncertaintyPct != null ? ` with ${uncertaintyRange} uncertainty` : ''}.`,
      disclaimer: STANDARD_DISCLAIMER,
      rawResponse: '[Demo mode — no live API call made]',
    };
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * @typedef {Object} AdvisorConfig
   * @property {string} [apiKey]   - Anthropic API key.  Stored in sessionStorage
   *   for the duration of the browser tab session.  NEVER stored in localStorage.
   * @property {string} [proxyUrl] - URL of the CORS proxy (e.g. Cloudflare
   *   Worker at `https://nature-risk-proxy.<account>.workers.dev/`).  When
   *   provided, all Claude API calls are routed through this endpoint.
   */

  /**
   * @typedef {Object} AnalyseParams
   * @property {'inland'|'coastal'|'mixed'} mode - Analysis mode.
   * @property {'asset_manager'|'project_developer'} userIntent - User persona.
   * @property {string} interventionType - E.g. "saltmarsh restoration".
   * @property {number} interventionAreaHa - Proposed intervention area in hectares.
   * @property {string} assetDescription - Plain-text description of the target asset.
   * @property {Object} physicsResult - Structured output from NatureRiskPhysics WASM engine.
   * @property {{ lat: number, lng: number }} coordinates - WGS-84 coordinates.
   * @property {string} userMessage - Raw natural-language input from the user.
   */

  /**
   * @typedef {Object} SpatialValidation
   * @property {boolean} valid - Whether the placement is spatially plausible.
   * @property {string} message - Plain-English validation message.
   * @property {string[]} suggestions - Alternative recommendations if invalid.
   */

  /**
   * @typedef {Object} AdvisoryResult
   * @property {string} narrative - Full markdown narrative for the chat pane.
   * @property {SpatialValidation} spatialValidation - Spatial plausibility check.
   * @property {string[]} scaleWarnings - Scale / size warnings from the model.
   * @property {string} confidenceSummary - One-sentence confidence summary.
   * @property {string} disclaimer - Mandatory PRD §9.1 disclaimer text.
   * @property {string} rawResponse - The complete raw text returned by Claude
   *   (or a placeholder in demo mode).
   */

  const NatureRiskAdvisor = {

    // -------------------------------------------------------------------------
    // configure()
    // -------------------------------------------------------------------------

    /**
     * Configure the advisor with an API key and/or proxy URL.  Configuration is
     * persisted to sessionStorage (tab-scoped; never persists across sessions).
     *
     * In production deployments the Cloudflare Worker (ADR-003) holds the
     * Anthropic API key as a secret.  In that case, callers should provide only
     * `proxyUrl` and omit `apiKey`.
     *
     * @param {AdvisorConfig} options - Configuration options.
     * @returns {void}
     */
    configure(options) {
      if (!options || typeof options !== 'object') return;

      if (typeof options.apiKey === 'string' && options.apiKey.trim().length > 0) {
        _config.apiKey = options.apiKey.trim();
        try { sessionStorage.setItem(SESSION_KEY_API_KEY, _config.apiKey); } catch (_) {}
      }

      if (typeof options.proxyUrl === 'string' && options.proxyUrl.trim().length > 0) {
        _config.proxyUrl = options.proxyUrl.trim();
        try { sessionStorage.setItem(SESSION_KEY_PROXY_URL, _config.proxyUrl); } catch (_) {}
      }
    },

    // -------------------------------------------------------------------------
    // isConfigured()
    // -------------------------------------------------------------------------

    /**
     * Returns true when the advisor has sufficient configuration to attempt a
     * live API call (either an API key or a proxy URL is present).
     *
     * @returns {boolean}
     */
    isConfigured() {
      return Boolean(_config.apiKey || _config.proxyUrl);
    },

    // -------------------------------------------------------------------------
    // getStatus()
    // -------------------------------------------------------------------------

    /**
     * Returns the current configuration status.
     *
     * @returns {{ configured: boolean, mode: 'live'|'demo' }}
     */
    getStatus() {
      const configured = this.isConfigured();
      return {
        configured,
        mode: configured ? 'live' : 'demo',
      };
    },

    // -------------------------------------------------------------------------
    // analyse()
    // -------------------------------------------------------------------------

    /**
     * Main analysis function.  Calls Claude with the assembled physics context
     * and returns a structured AdvisoryResult.
     *
     * When the advisor is not configured or the API call fails with a fallback-
     * eligible error, the function gracefully degrades to demo mode and returns
     * a realistic mock narrative constructed from the caller's physicsResult.
     *
     * All errors are surfaced as user-readable strings; no raw exceptions are
     * propagated to the caller.
     *
     * @param {AnalyseParams} params - Analysis parameters including physicsResult.
     * @returns {Promise<AdvisoryResult>}
     */
    async analyse(params) {
      if (!params || typeof params !== 'object') {
        return _buildDemoResult({}, 'Invalid parameters passed to analyse().');
      }

      // If no live configuration, go straight to demo.
      if (!this.isConfigured()) {
        return _buildDemoResult(params);
      }

      const userMessage = _buildUserMessage(params);

      let rawResponse;
      try {
        rawResponse = await _callClaude(userMessage);
      } catch (err) {
        // Fallback-eligible errors (network, 5xx) degrade to demo mode with a
        // user-readable explanation.  Authentication and rate-limit errors are
        // surfaced as an error result instead because they require user action.
        if (err.fallback) {
          return _buildDemoResult(params, err.userMessage || 'Advisory service temporarily unavailable.');
        }

        // Non-fallback errors (401, 429) — return an error result with the
        // user-readable message embedded in the narrative.
        return {
          narrative: `**Advisory Error:** ${err.userMessage || 'An unexpected error occurred.'}`,
          spatialValidation: { valid: false, message: err.userMessage || '', suggestions: [] },
          scaleWarnings: [],
          confidenceSummary: 'Not available — advisory error.',
          disclaimer: STANDARD_DISCLAIMER,
          rawResponse: err.message || '',
        };
      }

      // Parse the structured JSON response from Claude.
      const parsed = _parseModelResponse(rawResponse);

      return {
        narrative: parsed.narrative,
        spatialValidation: parsed.spatialValidation,
        scaleWarnings: parsed.scaleWarnings,
        confidenceSummary: parsed.confidenceSummary,
        disclaimer: STANDARD_DISCLAIMER, // Always the canonical constant.
        rawResponse,
      };
    },

    // -------------------------------------------------------------------------
    // renderConfigUI()
    // -------------------------------------------------------------------------

    /**
     * Renders a small inline API key configuration form into `containerEl`.
     * The form saves the key to sessionStorage on submission and updates its own
     * status badge without requiring a page reload.
     *
     * Security: the input uses `type="password"` and the value is written to
     * sessionStorage (NOT localStorage) so it is discarded when the tab closes.
     *
     * @param {HTMLElement} containerEl - The DOM element to render the form into.
     * @returns {void}
     */
    renderConfigUI(containerEl) {
      if (!(containerEl instanceof Element)) {
        console.error('[NatureRiskAdvisor] renderConfigUI: containerEl must be a DOM Element.');
        return;
      }

      const advisor = this;

      // -----------------------------------------------------------------------
      // Styles (scoped inline to avoid dependency on external stylesheets)
      // -----------------------------------------------------------------------
      const styleId = 'nature-risk-advisor-config-styles';
      if (!document.getElementById(styleId)) {
        const style = document.createElement('style');
        style.id = styleId;
        style.textContent = `
          .nra-config-form {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            font-size: 13px;
            background: #f8f9fa;
            border: 1px solid #dee2e6;
            border-radius: 6px;
            padding: 12px 14px;
            max-width: 420px;
          }
          .nra-config-form label {
            display: block;
            font-weight: 600;
            margin-bottom: 4px;
            color: #212529;
          }
          .nra-config-form input[type="password"],
          .nra-config-form input[type="text"] {
            width: 100%;
            box-sizing: border-box;
            padding: 7px 9px;
            border: 1px solid #ced4da;
            border-radius: 4px;
            font-size: 13px;
            color: #212529;
            background: #fff;
            margin-bottom: 8px;
          }
          .nra-config-form input:focus {
            outline: 2px solid #0d6efd;
            outline-offset: 1px;
          }
          .nra-config-btn {
            background: #0d6efd;
            color: #fff;
            border: none;
            border-radius: 4px;
            padding: 7px 14px;
            font-size: 13px;
            font-weight: 600;
            cursor: pointer;
          }
          .nra-config-btn:hover { background: #0b5ed7; }
          .nra-status-badge {
            display: inline-flex;
            align-items: center;
            gap: 5px;
            padding: 3px 9px;
            border-radius: 12px;
            font-size: 12px;
            font-weight: 600;
            margin-top: 8px;
          }
          .nra-status-badge.live {
            background: #d1e7dd;
            color: #0a3622;
            border: 1px solid #a3cfbb;
          }
          .nra-status-badge.demo {
            background: #fff3cd;
            color: #664d03;
            border: 1px solid #ffe69c;
          }
          .nra-status-dot {
            width: 8px;
            height: 8px;
            border-radius: 50%;
            display: inline-block;
          }
          .nra-status-badge.live .nra-status-dot { background: #146c43; }
          .nra-status-badge.demo .nra-status-dot { background: #997404; }
          .nra-config-note {
            color: #6c757d;
            font-size: 11px;
            margin-top: 6px;
          }
        `;
        document.head.appendChild(style);
      }

      // -----------------------------------------------------------------------
      // DOM construction
      // -----------------------------------------------------------------------
      containerEl.innerHTML = '';

      const form = document.createElement('div');
      form.className = 'nra-config-form';
      form.setAttribute('role', 'form');
      form.setAttribute('aria-label', 'Nature Risk Advisor API key configuration');

      // Label
      const label = document.createElement('label');
      label.setAttribute('for', 'nra-api-key-input');
      label.textContent = 'Anthropic API Key';
      form.appendChild(label);

      // Input
      const input = document.createElement('input');
      input.type = 'password';
      input.id = 'nra-api-key-input';
      input.placeholder = 'sk-ant-api03-…';
      input.setAttribute('autocomplete', 'off');
      input.setAttribute('spellcheck', 'false');
      input.setAttribute('aria-describedby', 'nra-config-note');
      // Pre-fill if already configured (show masked placeholder only).
      if (_config.apiKey) {
        input.placeholder = '••••••••••••••••••••••••••••• (key saved)';
      }
      form.appendChild(input);

      // Button
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'nra-config-btn';
      button.textContent = 'Save & Enable Live Mode';
      button.setAttribute('aria-label', 'Save API key and enable live advisory mode');
      form.appendChild(button);

      // Status badge
      const badge = document.createElement('div');
      const currentStatus = advisor.getStatus();
      badge.className = `nra-status-badge ${currentStatus.mode}`;
      badge.setAttribute('role', 'status');
      badge.setAttribute('aria-live', 'polite');
      const dot = document.createElement('span');
      dot.className = 'nra-status-dot';
      dot.setAttribute('aria-hidden', 'true');
      const badgeText = document.createElement('span');
      badgeText.textContent = currentStatus.mode === 'live' ? 'Live Mode Active' : 'Demo Mode';
      badge.appendChild(dot);
      badge.appendChild(badgeText);
      form.appendChild(badge);

      // Security note
      const note = document.createElement('p');
      note.id = 'nra-config-note';
      note.className = 'nra-config-note';
      note.textContent =
        'Your API key is stored in sessionStorage only — it is never written to localStorage or sent to any server other than api.anthropic.com (or your configured proxy).';
      form.appendChild(note);

      containerEl.appendChild(form);

      // -----------------------------------------------------------------------
      // Event handler
      // -----------------------------------------------------------------------
      button.addEventListener('click', function () {
        const value = input.value.trim();
        if (!value) {
          input.setCustomValidity('Please enter your Anthropic API key.');
          input.reportValidity();
          return;
        }
        input.setCustomValidity('');

        advisor.configure({ apiKey: value });

        // Update badge to live.
        badge.className = 'nra-status-badge live';
        dot.style.background = '#146c43';
        badgeText.textContent = 'Live Mode Active';

        // Clear input and update placeholder for security.
        input.value = '';
        input.placeholder = '••••••••••••••••••••••••••••• (key saved)';

        // Dispatch a custom event so the surrounding app can react.
        containerEl.dispatchEvent(
          new CustomEvent('advisorConfigured', {
            bubbles: true,
            detail: { mode: 'live' },
          })
        );
      });

      // Allow Enter key to submit.
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') button.click();
      });
    },
  };

  // ---------------------------------------------------------------------------
  // Export
  // ---------------------------------------------------------------------------

  global.NatureRiskAdvisor = NatureRiskAdvisor;

}(typeof window !== 'undefined' ? window : this));

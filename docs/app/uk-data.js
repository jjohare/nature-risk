/**
 * uk-data.js — Nature Risk UK Data Connectors
 *
 * Exposes window.UKDataConnectors: a pure JavaScript module that fetches from
 * UK government open-data APIs where CORS is supported, and returns clearly
 * labelled mock data for APIs that require a server-side proxy or registration.
 *
 * Data source honesty contract:
 *   source: 'live'  — data fetched directly from the real government endpoint
 *   source: 'mock'  — realistic but synthetic data; real endpoint is inaccessible
 *                     from the browser without a CORS proxy or auth token.
 *
 * Caching strategy (in-memory Map with per-dataset TTL):
 *   EA flood zones / RoFRS : 24 h
 *   Catchment context       : 24 h
 *   Soil type / land cover  : 7 days
 *   Rainfall / UKCP18       : 7 days
 *   Tide gauge              : 5 min
 *
 * Referenced decisions:
 *   ADR-003 — UK Data API Strategy (Cloudflare Worker + IndexedDB for production)
 *   PRD §6  — UK Data Sources & API Specifications
 *
 * IMPORTANT: This module is the client-side data-fetching layer only.
 * All quantitative calculations must be performed by the WASM physics engine,
 * not by any function in this file.
 */

(function (global) {
  'use strict';

  // ---------------------------------------------------------------------------
  // Internal TTL cache
  // ---------------------------------------------------------------------------

  /** @type {Map<string, {data: any, expires: number}>} */
  const _cache = new Map();

  const TTL = {
    FLOOD_ZONES:     24 * 60 * 60 * 1000,   // 24 h  (ms)
    CATCHMENT:       24 * 60 * 60 * 1000,   // 24 h
    SOIL_LAND_COVER:  7 * 24 * 60 * 60 * 1000, // 7 days
    RAINFALL:         7 * 24 * 60 * 60 * 1000, // 7 days
    TIDE_GAUGE:       5 * 60 * 1000,         // 5 min
  };

  /**
   * Read from in-memory cache.
   * @param {string} key
   * @returns {any|null} cached value or null on miss / expiry
   */
  function _cacheGet(key) {
    const entry = _cache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expires) {
      _cache.delete(key);
      return null;
    }
    return entry.data;
  }

  /**
   * Write to in-memory cache with a TTL in milliseconds.
   * @param {string} key
   * @param {any} data
   * @param {number} ttlMs
   */
  function _cacheSet(key, data, ttlMs) {
    _cache.set(key, { data, expires: Date.now() + ttlMs });
  }

  // ---------------------------------------------------------------------------
  // Shared helpers
  // ---------------------------------------------------------------------------

  /** Current ISO 8601 timestamp string. */
  function _now() {
    return new Date().toISOString();
  }

  /**
   * Round a coordinate to 3 decimal places for cache-key normalisation
   * (avoids separate cache entries for sub-100m variations at the same site).
   * @param {number} v
   * @returns {number}
   */
  function _snap(v) {
    return Math.round(v * 1000) / 1000;
  }

  /**
   * Haversine distance between two WGS-84 points, in kilometres.
   * @param {number} lat1
   * @param {number} lng1
   * @param {number} lat2
   * @param {number} lng2
   * @returns {number} distance in km
   */
  function _haversineKm(lat1, lng1, lat2, lng2) {
    const R = 6371;
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLng = ((lng2 - lng1) * Math.PI) / 180;
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos((lat1 * Math.PI) / 180) *
        Math.cos((lat2 * Math.PI) / 180) *
        Math.sin(dLng / 2) *
        Math.sin(dLng / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  // ---------------------------------------------------------------------------
  // Geographic context helpers (location-aware mock values)
  // ---------------------------------------------------------------------------

  /**
   * Returns true if the coordinate lies within the approximate bounding box of
   * the River Severn catchment (used for location-aware mock defaults).
   * Approximate bounds: 51.5–52.8 N, 2.0–3.5 W
   * @param {number} lat
   * @param {number} lng
   * @returns {boolean}
   */
  function _isSevernCatchment(lat, lng) {
    return lat >= 51.5 && lat <= 52.8 && lng >= -3.5 && lng <= -2.0;
  }

  /**
   * Returns true if the coordinate lies in the approximate bbox of SE England
   * (chalk geology: Kent, Sussex, Hampshire, Wiltshire S).
   * Approximate bounds: 50.8–51.8 N, -1.5–1.5 E
   * @param {number} lat
   * @param {number} lng
   * @returns {boolean}
   */
  function _isSEEngland(lat, lng) {
    return lat >= 50.8 && lat <= 51.8 && lng >= -1.5 && lng <= 1.5;
  }

  /**
   * Returns true if the coordinate lies in the approximate bbox of the
   * upland peat zone (Pennines, Lake District, Scottish Highlands, Dartmoor,
   * Exmoor, Welsh Uplands).
   * Uses a simple elevation proxy: lat > 53.5 or in known upland SW/Wales bbox.
   * @param {number} lat
   * @param {number} lng
   * @returns {boolean}
   */
  function _isUpland(lat, lng) {
    // Scottish Highlands and Islands
    if (lat > 56.0) return true;
    // Pennines / Lake District
    if (lat >= 53.5 && lat <= 55.5 && lng >= -3.5 && lng <= -1.5) return true;
    // Welsh Uplands / Brecon Beacons
    if (lat >= 51.7 && lat <= 53.5 && lng >= -4.5 && lng <= -3.0) return true;
    // Dartmoor / Exmoor
    if (lat >= 50.5 && lat <= 51.2 && lng >= -4.1 && lng <= -3.2) return true;
    return false;
  }

  /**
   * Returns a geologically plausible soil description for the given coordinates.
   * Used only in mock responses; based on BGS Soilscapes broad characterisation.
   * @param {number} lat
   * @param {number} lng
   * @returns {{code: string, name: string, permeability: string, fieldCapacity: number}}
   */
  function _indicativeSoilType(lat, lng) {
    if (_isUpland(lat, lng)) {
      return {
        code: 'PEAT',
        name: 'Deep peat (blanket bog)',
        permeability: 'very low',
        fieldCapacity: 0.85, // vol/vol
      };
    }
    if (_isSEEngland(lat, lng)) {
      return {
        code: 'CHALK',
        name: 'Chalk rendzina',
        permeability: 'high',
        fieldCapacity: 0.30,
      };
    }
    if (_isSevernCatchment(lat, lng)) {
      return {
        code: 'CLAY_LOAM',
        name: 'Reddish-brown clay loam (Midland till)',
        permeability: 'low',
        fieldCapacity: 0.42,
      };
    }
    // Generic lowland England / Wales default
    return {
      code: 'CLAY',
      name: 'Heavy clay (lowland alluvium)',
      permeability: 'very low',
      fieldCapacity: 0.48,
    };
  }

  /**
   * Returns an indicative UKCEH Land Cover Map (LCM2021) class for the
   * given coordinates.  Broad approximation only — used in mock responses.
   * @param {number} lat
   * @param {number} lng
   * @returns {{code: number, label: string}}
   */
  function _indicativeLandCover(lat, lng) {
    if (_isUpland(lat, lng)) {
      return { code: 12, label: 'Bog (blanket / raised)' };
    }
    if (_isSevernCatchment(lat, lng)) {
      return { code: 4, label: 'Arable and horticulture' };
    }
    if (_isSEEngland(lat, lng)) {
      return { code: 3, label: 'Calcareous grassland' };
    }
    return { code: 4, label: 'Arable and horticulture' };
  }

  /**
   * Returns indicative annual rainfall and UKCP18 uplift for the coordinates.
   * Calibrated against broad Met Office UK climatology.
   * @param {number} lat
   * @param {number} lng
   * @returns {{annualMeanMm: number, rcp45UpliftPct: number, rcp85UpliftPct: number}}
   */
  function _indicativeRainfall(lat, lng) {
    // Wet upland west: Lake District, SW Scotland, Snowdonia
    if (_isUpland(lat, lng) && lng < -2.5) {
      return { annualMeanMm: 2100, rcp45UpliftPct: 5, rcp85UpliftPct: 12 };
    }
    // Severn catchment — moderate rainfall
    if (_isSevernCatchment(lat, lng)) {
      return { annualMeanMm: 850, rcp45UpliftPct: 4, rcp85UpliftPct: 9 };
    }
    // SE England — drier
    if (_isSEEngland(lat, lng)) {
      return { annualMeanMm: 620, rcp45UpliftPct: -2, rcp85UpliftPct: -6 };
    }
    // Generic UK lowland
    return { annualMeanMm: 750, rcp45UpliftPct: 3, rcp85UpliftPct: 8 };
  }

  // ---------------------------------------------------------------------------
  // Coastline proximity heuristic
  // ---------------------------------------------------------------------------

  /**
   * Approximate UK coastline segments used for coastal proximity detection.
   * Each entry is a simplified representative point on the coast.
   * This is NOT a complete coastline dataset — it is a coarse heuristic suitable
   * only for mode routing (inland vs coastal vs mixed).
   *
   * Derived from manual sampling of the UK MHWS line at ~50km intervals.
   */
  const _UK_COAST_SAMPLE_POINTS = [
    // South coast (English Channel)
    [50.10, -5.55], [50.07, -5.05], [50.12, -4.49], [50.33, -4.11],
    [50.37, -3.85], [50.42, -3.54], [50.47, -3.14], [50.61, -2.46],
    [50.72, -2.02], [50.82, -1.78], [50.73, -1.08], [50.68, -0.50],
    [50.79,  0.28], [50.88,  0.63], [51.08,  1.18], [51.12,  1.39],
    // Thames Estuary / East Anglia
    [51.45,  1.01], [51.75,  1.06], [51.97,  1.22], [52.30,  1.73],
    [52.58,  1.74], [52.94,  1.10], [53.05,  0.55], [53.25,  0.22],
    // Humber / Yorkshire / NE England
    [53.53,  0.11], [53.72,  0.27], [54.07, -0.19], [54.29, -0.36],
    [54.52, -1.12], [54.67, -1.32], [54.85, -1.54], [55.02, -1.56],
    [55.22, -1.62], [55.42, -1.58], [55.59, -2.00],
    // SE Scotland / Firth of Forth
    [55.73, -2.40], [55.99, -3.18], [56.07, -3.40], [56.30, -2.93],
    [56.57, -2.62], [56.72, -2.34], [57.00, -2.12], [57.18, -2.11],
    // NE Scotland / Moray Firth
    [57.40, -1.92], [57.59, -1.80], [57.70, -3.29], [57.56, -3.85],
    [57.66, -4.04], [57.78, -4.15], [57.90, -4.05],
    // N Scotland
    [58.26, -3.59], [58.52, -3.06], [58.65, -3.08], [58.57, -3.52],
    [58.29, -5.01], [58.00, -5.21], [57.88, -5.63],
    // W Scotland
    [57.74, -5.77], [57.59, -5.84], [57.32, -5.78], [57.05, -5.82],
    [56.80, -5.72], [56.55, -5.61], [56.25, -5.44], [55.95, -5.28],
    [55.60, -5.32], [55.40, -5.19], [55.20, -5.05],
    // SW Scotland / N Ireland coast (mainland only)
    [54.98, -5.15], [54.82, -5.00], [54.68, -4.87], [54.49, -4.68],
    // NW England / Isle of Man proxy (mainland)
    [54.22, -3.45], [54.07, -3.20], [53.87, -3.21], [53.65, -3.08],
    [53.39, -3.07], [53.26, -3.25], [53.07, -4.24], [52.84, -4.46],
    [52.54, -4.52], [52.11, -4.70], [51.87, -5.07], [51.60, -5.07],
    [51.49, -4.92], [51.29, -4.55], [51.19, -4.17],
    // SW England
    [51.19, -4.17], [51.20, -3.71], [51.21, -3.31], [51.26, -3.00],
    [51.19, -2.90], [51.06, -3.09], [50.87, -3.39], [50.77, -3.94],
    [50.55, -4.52], [50.38, -5.02],
  ];

  /**
   * Returns the distance in km from (lat, lng) to the nearest point in the
   * UK coastline sample set.  Uses the Haversine formula.
   * @param {number} lat
   * @param {number} lng
   * @returns {number} distance in km
   */
  function _distToCoastKm(lat, lng) {
    let minDist = Infinity;
    for (const [cLat, cLng] of _UK_COAST_SAMPLE_POINTS) {
      const d = _haversineKm(lat, lng, cLat, cLng);
      if (d < minDist) minDist = d;
    }
    return minDist;
  }

  // ---------------------------------------------------------------------------
  // EA Flood Risk — LIVE (CORS enabled)
  // ---------------------------------------------------------------------------

  /**
   * EA ArcGIS REST service endpoint for Flood Zone 2 (RoFRS).
   * This service accepts direct browser requests with CORS headers.
   * Flood Zone 2: 0.1% to 1% annual probability of flooding from river/sea.
   */
  const EA_FLOOD_ZONE_2_URL =
    'https://environment.data.gov.uk/arcgis/rest/services/EA/' +
    'FloodMapForPlanningRiversAndSeaFloodZone2/MapServer/0/query';

  /**
   * EA ArcGIS REST service endpoint for Flood Zone 3 (RoFRS).
   * Flood Zone 3: > 1% annual probability of flooding from river/sea.
   */
  const EA_FLOOD_ZONE_3_URL =
    'https://environment.data.gov.uk/arcgis/rest/services/EA/' +
    'FloodMapForPlanningRiversAndSeaFloodZone3/MapServer/0/query';

  /**
   * EA flood monitoring real-time flood warnings API.
   * Public, CORS-enabled.
   */
  const EA_FLOOD_MONITORING_URL =
    'https://environment.data.gov.uk/flood-monitoring/id/floods';

  /**
   * Build the ArcGIS point-in-polygon query URL for the RoFRS services.
   * @param {string} baseUrl  - ArcGIS service URL (zone 2 or zone 3)
   * @param {number} lat
   * @param {number} lng
   * @returns {string}
   */
  function _buildFloodZoneQueryUrl(baseUrl, lat, lng) {
    const params = new URLSearchParams({
      geometry: `${lng},${lat}`,
      geometryType: 'esriGeometryPoint',
      inSR: '4326',
      spatialRel: 'esriSpatialRelIntersects',
      returnGeometry: 'false',
      outFields: '*',
      f: 'json',
    });
    return `${baseUrl}?${params.toString()}`;
  }

  /**
   * Query the EA ArcGIS RoFRS service to test whether a point falls inside a
   * Flood Zone.  Returns true if features are returned (i.e. inside the zone).
   * @param {string} baseUrl
   * @param {number} lat
   * @param {number} lng
   * @returns {Promise<{inZone: boolean, featureCount: number, rawFeatures: any[]}>}
   */
  async function _queryFloodZone(baseUrl, lat, lng) {
    const url = _buildFloodZoneQueryUrl(baseUrl, lat, lng);
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) {
      throw new Error(
        `EA RoFRS ArcGIS service returned HTTP ${response.status}: ${response.statusText}`
      );
    }
    const json = await response.json();
    const features = Array.isArray(json.features) ? json.features : [];
    return {
      inZone: features.length > 0,
      featureCount: features.length,
      rawFeatures: features,
    };
  }

  // ---------------------------------------------------------------------------
  // EA Catchment Data Explorer — LIVE (CORS enabled)
  // ---------------------------------------------------------------------------

  /**
   * EA Catchment Data Explorer WFS — returns the water body classification for
   * the catchment containing a given point.
   * Public endpoint, CORS-enabled.
   */
  const EA_CATCHMENT_URL = 'https://environment.data.gov.uk/catchment-planning/WaterBody';

  // ---------------------------------------------------------------------------
  // Public API implementation
  // ---------------------------------------------------------------------------

  /**
   * Get EA flood risk zones (Zone 2 and Zone 3) for a point.
   *
   * DATA SOURCE: LIVE — Environment Agency RoFRS ArcGIS REST service.
   * URL: https://environment.data.gov.uk/arcgis/rest/services/EA/FloodMap...
   * CORS: enabled (browser direct call)
   * Licence: Open Government Licence v3.0
   * Update frequency: approximately every 2 years
   *
   * @param {number} lat  - WGS-84 latitude
   * @param {number} lng  - WGS-84 longitude
   * @param {number} radiusKm - unused at this layer (point query); retained for
   *                            interface compatibility with physics engine calls
   * @returns {Promise<FloodZoneResult>}
   */
  async function getFloodZones(lat, lng, radiusKm) {
    const cacheKey = `flood_zones:${_snap(lat)}:${_snap(lng)}`;
    const cached = _cacheGet(cacheKey);
    if (cached) return cached;

    let zone2, zone3;
    let fetchError = null;

    try {
      [zone2, zone3] = await Promise.all([
        _queryFloodZone(EA_FLOOD_ZONE_2_URL, lat, lng),
        _queryFloodZone(EA_FLOOD_ZONE_3_URL, lat, lng),
      ]);
    } catch (err) {
      fetchError = err.message;
    }

    if (fetchError) {
      // Surface the error rather than silently falling back to mock.
      // Callers should display DATA_UNAVAILABLE to the user.
      const result = {
        data: null,
        source: 'error',
        citation:
          'Environment Agency Risk of Flooding from Rivers and Sea (RoFRS), ' +
          'Open Government Licence v3.0. ' +
          'https://environment.data.gov.uk/arcgis/rest/services/EA/FloodMapForPlanningRiversAndSeaFloodZone2/',
        timestamp: _now(),
        caveats: [
          'DATA_UNAVAILABLE: EA RoFRS ArcGIS service could not be reached.',
          `Error detail: ${fetchError}`,
          'Quantitative outputs requiring flood zone data cannot be produced. ' +
            'Please retry or check connectivity.',
        ],
        error: fetchError,
      };
      return result;
    }

    // Determine the highest applicable flood zone
    let highestZone = 'none';
    if (zone3.inZone) highestZone = 'FZ3';
    else if (zone2.inZone) highestZone = 'FZ2';

    const result = {
      data: {
        lat,
        lng,
        radiusKm: radiusKm || null,
        inFloodZone2: zone2.inZone,
        inFloodZone3: zone3.inZone,
        highestZone,
        zone2FeatureCount: zone2.featureCount,
        zone3FeatureCount: zone3.featureCount,
        // Raw features omitted from the top-level result to avoid large payloads;
        // callers needing geometry should call _queryFloodZone directly.
        description: _floodZoneDescription(highestZone),
      },
      source: 'live',
      citation:
        'Environment Agency, Risk of Flooding from Rivers and Sea (RoFRS), ' +
        'Open Government Licence v3.0. ' +
        'Resolution: polygon vector. ' +
        'https://environment.data.gov.uk/arcgis/rest/services/EA/' +
        'FloodMapForPlanningRiversAndSeaFloodZone2/MapServer/0/',
      timestamp: _now(),
      caveats: [
        'RoFRS zones are updated approximately every 2 years; ' +
          'very recent flood events may not yet be reflected.',
        'Flood Zone 3a (high probability) and 3b (functional floodplain) ' +
          'are not distinguished at this query level.',
        'These zones inform planning policy, not flood-proof boundaries. ' +
          'A site-specific FRA is required for planning applications.',
      ],
    };

    _cacheSet(cacheKey, result, TTL.FLOOD_ZONES);
    return result;
  }

  /**
   * Human-readable description for a flood zone code.
   * @param {string} zone - 'FZ3' | 'FZ2' | 'none'
   * @returns {string}
   */
  function _floodZoneDescription(zone) {
    switch (zone) {
      case 'FZ3':
        return 'Flood Zone 3: high probability (>1% AEP river / >0.5% AEP tidal). ' +
               'Development generally inappropriate without specific FRA.';
      case 'FZ2':
        return 'Flood Zone 2: medium probability (0.1%–1% AEP river / 0.1%–0.5% AEP tidal). ' +
               'Development requires flood risk assessment.';
      default:
        return 'Flood Zone 1: low probability (<0.1% AEP). ' +
               'Standard sequential test applies.';
    }
  }

  // ---------------------------------------------------------------------------

  /**
   * Get the EA RoFRS flood risk level for a single point.
   *
   * This is a derived convenience wrapper around getFloodZones that reduces the
   * result to a simple ordinal risk level (1–3) and label for use by the
   * mode routing and physics engine layers.
   *
   * DATA SOURCE: LIVE — same EA ArcGIS endpoints as getFloodZones.
   *
   * @param {number} lat
   * @param {number} lng
   * @returns {Promise<RiskLevelResult>}
   */
  async function getFloodRiskLevel(lat, lng) {
    const cacheKey = `flood_risk_level:${_snap(lat)}:${_snap(lng)}`;
    const cached = _cacheGet(cacheKey);
    if (cached) return cached;

    // Reuse the flood zones function (which is itself cached).
    const zones = await getFloodZones(lat, lng, null);

    if (zones.source === 'error') {
      // Propagate the error upward.
      return zones;
    }

    const zone = zones.data.highestZone;
    const levelMap = { FZ3: 3, FZ2: 2, none: 1 };
    const labelMap = {
      FZ3: 'High — Flood Zone 3 (>1% AEP)',
      FZ2: 'Medium — Flood Zone 2 (0.1%–1% AEP)',
      none: 'Low — Flood Zone 1 (<0.1% AEP)',
    };

    const result = {
      data: {
        lat,
        lng,
        riskLevel: levelMap[zone] || 1,
        riskLabel: labelMap[zone] || labelMap.none,
        floodZone: zone,
      },
      source: 'live',
      citation: zones.citation,
      timestamp: zones.timestamp,
      caveats: zones.caveats,
    };

    _cacheSet(cacheKey, result, TTL.FLOOD_ZONES);
    return result;
  }

  // ---------------------------------------------------------------------------

  /**
   * Get indicative soil type from BGS Soilscapes.
   *
   * DATA SOURCE: MOCK — BGS Soilscapes WMS/WFS requires BGS API registration
   * and does not support direct browser calls (no CORS headers on their
   * production endpoints as of 2026-03).  In production, requests route via the
   * Cloudflare Worker proxy (ADR-003).
   *
   * Mock data is location-aware and geologically plausible:
   *   - Uplands (Pennines, Lake District, SW Scotland, Welsh hills) → deep peat
   *   - SE England chalk belt → chalk rendzina
   *   - Severn catchment (Midland plain) → reddish-brown clay loam (Triassic till)
   *   - Elsewhere → heavy clay (lowland alluvium)
   *
   * Real endpoint (proxy required):
   *   https://www.bgs.ac.uk/datasets/soilscapes/
   *   WFS: https://ogc.bgs.ac.uk/digmap625k_bedrock_and_superficial_wfs/wfs
   *
   * @param {number} lat
   * @param {number} lng
   * @returns {Promise<SoilTypeResult>}
   */
  async function getSoilType(lat, lng) {
    const cacheKey = `soil_type:${_snap(lat)}:${_snap(lng)}`;
    const cached = _cacheGet(cacheKey);
    if (cached) return cached;

    const soil = _indicativeSoilType(lat, lng);

    const result = {
      data: {
        lat,
        lng,
        soilCode: soil.code,
        soilName: soil.name,
        permeability: soil.permeability,
        fieldCapacityVolVol: soil.fieldCapacity,
        // BGS HOST (Hydrology of Soil Types) class — approximate mapping
        hostClass: _soilCodeToHostClass(soil.code),
      },
      source: 'mock',
      citation:
        'MOCK DATA — indicative values based on BGS Soilscapes national classification. ' +
        'Real data source: British Geological Survey Soilscapes, ' +
        'OGL / BGS Licence. ' +
        'https://www.bgs.ac.uk/datasets/soilscapes/. ' +
        'In production, this call routes through the nature-risk-proxy Cloudflare Worker.',
      timestamp: _now(),
      caveats: [
        'THIS IS MOCK DATA. Do not use for engineering or regulatory purposes.',
        'BGS Soilscapes does not support direct browser CORS requests; ' +
          'a Cloudflare Worker proxy is required for live data (ADR-003).',
        'Indicative soil class derived from broad regional geology; ' +
          'actual soil at this point may differ significantly.',
        'HOST (Hydrology of Soil Types) class is approximate and ' +
          'should be verified against the full BGS HOST dataset.',
      ],
    };

    _cacheSet(cacheKey, result, TTL.SOIL_LAND_COVER);
    return result;
  }

  /**
   * Map internal soil code to an approximate BGS HOST class (1–7).
   * HOST classes determine runoff response: class 1 (near-impermeable) → 7 (freely draining).
   * @param {string} code
   * @returns {number}
   */
  function _soilCodeToHostClass(code) {
    const map = { PEAT: 2, CHALK: 6, CLAY_LOAM: 3, CLAY: 2 };
    return map[code] || 3;
  }

  // ---------------------------------------------------------------------------

  /**
   * Get indicative land cover from UKCEH Land Cover Map 2021.
   *
   * DATA SOURCE: MOCK — UKCEH LCM2021 is a licenced dataset (not freely
   * accessible via an open API).  Access requires registration at the EIDC
   * (Environmental Information Data Centre) and does not expose a CORS-enabled
   * REST endpoint suitable for direct browser calls.  In production, this call
   * routes through the Cloudflare Worker proxy.
   *
   * Real dataset:
   *   UKCEH Land Cover Map 2021 (25 m raster)
   *   https://catalogue.ceh.ac.uk/documents/6c6c9203-7333-4d96-88ab-78925e7a4e73
   *   Licence: licenced (registration required via EIDC)
   *
   * @param {number} lat
   * @param {number} lng
   * @returns {Promise<LandCoverResult>}
   */
  async function getLandCover(lat, lng) {
    const cacheKey = `land_cover:${_snap(lat)}:${_snap(lng)}`;
    const cached = _cacheGet(cacheKey);
    if (cached) return cached;

    const lc = _indicativeLandCover(lat, lng);

    const result = {
      data: {
        lat,
        lng,
        lcmClass: lc.code,
        lcmLabel: lc.label,
        // Indicative Manning's roughness coefficient for this class (dimensionless)
        manningsN: _lcmToManningsN(lc.code),
      },
      source: 'mock',
      citation:
        'MOCK DATA — indicative values based on UKCEH Land Cover Map 2021 (LCM2021). ' +
        'Real dataset: UK Centre for Ecology & Hydrology, LCM2021, 25 m resolution. ' +
        'https://catalogue.ceh.ac.uk/documents/6c6c9203-7333-4d96-88ab-78925e7a4e73. ' +
        'Licenced via EIDC (registration required). ' +
        'In production, this call routes through the nature-risk-proxy Cloudflare Worker.',
      timestamp: _now(),
      caveats: [
        'THIS IS MOCK DATA. Do not use for engineering or regulatory purposes.',
        'UKCEH LCM2021 requires registration; no public CORS-enabled API is available.',
        'Indicative class derived from broad regional land use patterns; ' +
          'actual land cover at this point may differ.',
        "Manning's n value is a representative class-level approximation; " +
          'site-specific values require field survey.',
      ],
    };

    _cacheSet(cacheKey, result, TTL.SOIL_LAND_COVER);
    return result;
  }

  /**
   * Approximate Manning's roughness coefficient (n) by LCM2021 class.
   * Sources: Chow (1959), CIRIA Flood Risk Management Manual.
   * @param {number} lcmClass
   * @returns {number}
   */
  function _lcmToManningsN(lcmClass) {
    const roughness = {
      1:  0.030, // broadleaved woodland
      2:  0.030, // coniferous woodland
      3:  0.035, // arable / horticulture (cropped)
      4:  0.035, // arable and horticulture
      5:  0.033, // improved grassland
      6:  0.035, // neutral grassland
      7:  0.033, // calcareous grassland
      8:  0.035, // acid grassland
      9:  0.040, // fen, marsh, swamp
      10: 0.025, // heather
      11: 0.030, // heather grassland
      12: 0.045, // bog
      13: 0.035, // inland rock
      14: 0.012, // saltwater (open water)
      15: 0.012, // freshwater
      16: 0.050, // supra-littoral rock
      17: 0.035, // supra-littoral sediment
      18: 0.040, // littoral rock
      19: 0.045, // littoral sediment
      20: 0.040, // saltmarsh
      21: 0.015, // urban
      22: 0.012, // suburban
    };
    return roughness[lcmClass] || 0.035;
  }

  // ---------------------------------------------------------------------------

  /**
   * Get Met Office UKCP18 representative rainfall data for a location.
   *
   * DATA SOURCE: MOCK — Met Office UKCP18 climate projections are published
   * as NetCDF grid files, not a CORS-enabled REST API.  Programmatic access
   * to gridded projections requires either direct NetCDF download or the
   * Met Office Weather DataHub (which requires API key registration).
   *
   * Real data sources:
   *   UKCP18 UK Climate Projections (2018), Met Office Hadley Centre.
   *   https://ukclimateprojections-ui.metoffice.gov.uk/
   *   Met Office Weather DataHub: https://data.hub.api.metoffice.gov.uk/
   *   Licence: Open Government Licence v3.0
   *
   * Mock values are calibrated against broad UK climatology zones and UKCP18
   * ensemble median projections for the 2050s and 2080s under RCP4.5 and RCP8.5.
   *
   * @param {number} lat
   * @param {number} lng
   * @returns {Promise<RainfallResult>}
   */
  async function getRainfallData(lat, lng) {
    const cacheKey = `rainfall:${_snap(lat)}:${_snap(lng)}`;
    const cached = _cacheGet(cacheKey);
    if (cached) return cached;

    const rf = _indicativeRainfall(lat, lng);

    const result = {
      data: {
        lat,
        lng,
        // Baseline (1981–2010 reference period)
        baselineAnnualMeanMm: rf.annualMeanMm,
        // Summer (JJA) precipitation change (%) — UKCP18 ensemble median
        summerChangePct_rcp45_2050s: rf.rcp45UpliftPct < 0 ? rf.rcp45UpliftPct : -(Math.abs(rf.rcp45UpliftPct) * 0.4),
        summerChangePct_rcp85_2050s: rf.rcp85UpliftPct < 0 ? rf.rcp85UpliftPct * 1.5 : -(Math.abs(rf.rcp85UpliftPct) * 0.5),
        // Winter (DJF) precipitation change (%) — UKCP18 ensemble median
        winterChangePct_rcp45_2050s: rf.rcp45UpliftPct,
        winterChangePct_rcp85_2050s: rf.rcp85UpliftPct,
        // 1-in-100 year daily maximum rainfall estimate (mm/day)
        q100DailyMaxMm: _q100Daily(rf.annualMeanMm),
        // Climate change uplift factor for storm design (1% AEP event, 2080s RCP8.5)
        // Per UKCP18 recommendations for flood risk assessment
        climateChangeUpliftFactor_rcp85_2080s: 1.20,
        referenceEpoch: '1981-2010',
        scenariosAvailable: ['RCP4.5 2050s', 'RCP8.5 2050s', 'RCP8.5 2080s'],
      },
      source: 'mock',
      citation:
        'MOCK DATA — indicative values calibrated against UKCP18 UK Climate Projections ' +
        '(2018), Met Office Hadley Centre, Open Government Licence v3.0. ' +
        'https://ukclimateprojections-ui.metoffice.gov.uk/. ' +
        'Real gridded data requires Met Office Weather DataHub API key. ' +
        'In production, this call routes through the nature-risk-proxy Cloudflare Worker.',
      timestamp: _now(),
      caveats: [
        'THIS IS MOCK DATA. Do not use for engineering or regulatory purposes.',
        'UKCP18 probabilistic projections are published as NetCDF grids; ' +
          'no public CORS-enabled point-query API is available.',
        'Climate change uplift factor (1.20) is a broad national approximation. ' +
          'Localised UKCP18 gridded values should be used for formal FRA.',
        'Summer/winter precipitation changes reflect ensemble median only; ' +
          'the 90th-percentile wet scenario is higher and should be used for ' +
          'infrastructure design (see UKCP18 Technical Note 8).',
        'Met Office Weather DataHub requires API key registration for access.',
      ],
    };

    _cacheSet(cacheKey, result, TTL.RAINFALL);
    return result;
  }

  /**
   * Estimate the 1-in-100 year (1% AEP) daily maximum rainfall in mm/day
   * from the mean annual rainfall, using a simple regional scaling approximation.
   * This is NOT a formal FEH statistical analysis.
   * @param {number} annualMeanMm
   * @returns {number}
   */
  function _q100Daily(annualMeanMm) {
    // Rough empirical relationship: Q100 daily ≈ 0.11 × MAP for upland wet
    // zones, ≈ 0.09 × MAP for lowland England.  We use 0.10 as a neutral
    // national approximation.
    return Math.round(annualMeanMm * 0.10);
  }

  // ---------------------------------------------------------------------------

  /**
   * Get data for the nearest NTSLF tide gauge to a point.
   *
   * DATA SOURCE: MOCK — The NTSLF (National Tide and Sea Level Facility) /
   * BODC tide prediction service at https://www.ntslf.org/tides/tidepred does
   * not expose a CORS-enabled JSON API.  Data access is via web forms or
   * direct file download (not suitable for real-time browser fetch).
   * In production, the Cloudflare Worker proxies NTSLF requests.
   *
   * Mock station data is based on real NTSLF gauge metadata; values reflect
   * documented tidal ranges at each station from published NTSLF records.
   *
   * Real data source:
   *   National Tide and Sea Level Facility (NTSLF) / British Oceanographic Data Centre
   *   https://www.ntslf.org/tides/tidepred
   *   Licence: Open (Crown Copyright)
   *
   * @param {number} lat
   * @param {number} lng
   * @returns {Promise<TideGaugeResult>}
   */
  async function getNearestTideGauge(lat, lng) {
    const cacheKey = `tide_gauge:${_snap(lat)}:${_snap(lng)}`;
    const cached = _cacheGet(cacheKey);
    if (cached) return cached;

    const station = _nearestTideStation(lat, lng);

    const result = {
      data: {
        lat,
        lng,
        station: {
          id: station.id,
          name: station.name,
          lat: station.lat,
          lng: station.lng,
          distanceKm: Math.round(_haversineKm(lat, lng, station.lat, station.lng) * 10) / 10,
          ntslf_url: `https://www.ntslf.org/tides/tidepred?Port=${encodeURIComponent(station.name)}`,
        },
        tidal: {
          // Mean High Water Springs (MHWS) above Ordnance Datum Newlyn (m ODN)
          mhwsODN: station.mhwsODN,
          // Mean High Water Neaps (MHWN) m ODN
          mhwnODN: station.mhwnODN,
          // Mean Low Water Springs (MLWS) m ODN
          mlwsODN: station.mlwsODN,
          // Spring tidal range (m)
          springRangeM: Math.round((station.mhwsODN - station.mlwsODN) * 10) / 10,
          // Highest Astronomical Tide (HAT) m ODN — approximate
          hatODN: Math.round((station.mhwsODN + 0.3) * 10) / 10,
          // 1-in-200 year extreme still water level m ODN (proxy)
          extreme200yrODN: Math.round((station.mhwsODN + 0.9) * 10) / 10,
        },
        seaLevelRise: {
          // UKCP18 RCP4.5 median sea-level rise above 1990 baseline (m), 2050
          rcp45_2050m: 0.16,
          // UKCP18 RCP8.5 median sea-level rise above 1990 baseline (m), 2050
          rcp85_2050m: 0.22,
          // UKCP18 RCP8.5 H++ scenario, 2100
          rcp85_h_plus_2100m: 1.10,
        },
      },
      source: 'mock',
      citation:
        'MOCK DATA — tidal datum values based on published NTSLF station records. ' +
        'Real data source: National Tide and Sea Level Facility (NTSLF) / BODC, ' +
        'Crown Copyright, Open Licence. ' +
        'https://www.ntslf.org/tides/tidepred. ' +
        'Sea-level rise projections: UKCP18, Met Office, OGL v3.0. ' +
        'In production, this call routes through the nature-risk-proxy Cloudflare Worker.',
      timestamp: _now(),
      caveats: [
        'THIS IS MOCK DATA. Do not use for engineering or regulatory purposes.',
        'NTSLF does not expose a CORS-enabled JSON API; a proxy is required for live data.',
        'Tidal datum values are published long-term averages from the nearest named gauge; ' +
          'local topography may affect water levels at the site.',
        '1-in-200 year extreme water level is an indicative proxy value; ' +
          'a formal extreme water level analysis should reference EA/DEFRA coastal flood ' +
          'boundary data (CFB dataset).',
        'Sea-level rise figures are UKCP18 ensemble medians; the 95th-percentile ' +
          'H++ scenario (up to 1.10 m by 2100) applies to critical infrastructure design.',
        `Nearest station used: ${station.name} (${
          Math.round(_haversineKm(lat, lng, station.lat, station.lng) * 10) / 10
        } km away). Tidal conditions at the query site may differ.`,
      ],
    };

    _cacheSet(cacheKey, result, TTL.TIDE_GAUGE);
    return result;
  }

  /**
   * NTSLF tide gauge station reference data.
   * Tidal datum values (MHWS, MHWN, MLWS) are m above Ordnance Datum Newlyn (ODN).
   * Source: NTSLF published station data / UKHO ADMIRALTY Tide Tables.
   * These are the actual published long-term averages from each station.
   */
  const _TIDE_STATIONS = [
    { id: 'NEWL', name: 'Newlyn',        lat: 50.103, lng: -5.543, mhwsODN:  2.69, mhwnODN:  2.01, mlwsODN: -2.52 },
    { id: 'PLYM', name: 'Plymouth',      lat: 50.366, lng: -4.185, mhwsODN:  2.48, mhwnODN:  1.84, mlwsODN: -2.16 },
    { id: 'PORT', name: 'Portsmouth',    lat: 50.798, lng: -1.110, mhwsODN:  1.87, mhwnODN:  1.44, mlwsODN: -1.38 },
    { id: 'NSHV', name: 'Newhaven',      lat: 50.777, lng:  0.057, mhwsODN:  3.14, mhwnODN:  2.43, mlwsODN: -2.82 },
    { id: 'DOVE', name: 'Dover',         lat: 51.113, lng:  1.325, mhwsODN:  3.39, mhwnODN:  2.59, mlwsODN: -2.98 },
    { id: 'SHEE', name: 'Sheerness',     lat: 51.443, lng:  0.744, mhwsODN:  3.09, mhwnODN:  2.49, mlwsODN: -2.39 },
    { id: 'THMH', name: 'Tower Bridge',  lat: 51.506, lng: -0.075, mhwsODN:  3.37, mhwnODN:  2.81, mlwsODN: -1.91 },
    { id: 'LOWT', name: 'Lowestoft',     lat: 52.471, lng:  1.749, mhwsODN:  1.34, mhwnODN:  1.11, mlwsODN: -1.10 },
    { id: 'IMMI', name: 'Immingham',     lat: 53.628, lng: -0.187, mhwsODN:  3.91, mhwnODN:  3.14, mlwsODN: -3.32 },
    { id: 'WTBY', name: 'Whitby',        lat: 54.493, lng: -0.615, mhwsODN:  3.01, mhwnODN:  2.35, mlwsODN: -2.51 },
    { id: 'NSHD', name: 'North Shields', lat: 55.007, lng: -1.441, mhwsODN:  2.45, mhwnODN:  1.84, mlwsODN: -1.87 },
    { id: 'LERW', name: 'Lerwick',       lat: 60.155, lng: -1.141, mhwsODN:  1.00, mhwnODN:  0.74, mlwsODN: -0.91 },
    { id: 'ABDN', name: 'Aberdeen',      lat: 57.144, lng: -2.079, mhwsODN:  2.05, mhwnODN:  1.53, mlwsODN: -1.85 },
    { id: 'DUND', name: 'Dundee',        lat: 56.455, lng: -2.974, mhwsODN:  2.82, mhwnODN:  2.26, mlwsODN: -2.44 },
    { id: 'LITH', name: 'Leith',         lat: 55.994, lng: -3.173, mhwsODN:  2.63, mhwnODN:  2.10, mlwsODN: -2.23 },
    { id: 'ULST', name: 'Ullapool',      lat: 57.894, lng: -5.162, mhwsODN:  2.52, mhwnODN:  1.87, mlwsODN: -2.28 },
    { id: 'STNY', name: 'Stornoway',     lat: 58.209, lng: -6.389, mhwsODN:  2.16, mhwnODN:  1.62, mlwsODN: -1.93 },
    { id: 'OBAN', name: 'Oban',          lat: 56.412, lng: -5.474, mhwsODN:  1.86, mhwnODN:  1.37, mlwsODN: -1.70 },
    { id: 'PRTH', name: 'Port Patrick',  lat: 54.843, lng: -5.116, mhwsODN:  2.15, mhwnODN:  1.66, mlwsODN: -1.84 },
    { id: 'HYSM', name: 'Heysham',       lat: 54.029, lng: -2.921, mhwsODN:  4.85, mhwnODN:  3.79, mlwsODN: -4.19 },
    { id: 'LVPL', name: 'Liverpool',     lat: 53.451, lng: -3.018, mhwsODN:  4.93, mhwnODN:  3.96, mlwsODN: -4.17 },
    { id: 'BARR', name: 'Barrow',        lat: 54.102, lng: -3.200, mhwsODN:  5.28, mhwnODN:  4.14, mlwsODN: -4.61 },
    { id: 'AVTP', name: 'Avonmouth',     lat: 51.509, lng: -2.713, mhwsODN:  6.62, mhwnODN:  5.25, mlwsODN: -5.90 },
    { id: 'ILFR', name: 'Ilfracombe',    lat: 51.209, lng: -4.117, mhwsODN:  4.81, mhwnODN:  3.73, mlwsODN: -4.21 },
    { id: 'MILF', name: 'Milford Haven', lat: 51.706, lng: -5.032, mhwsODN:  3.62, mhwnODN:  2.79, mlwsODN: -3.28 },
    { id: 'CARD', name: 'Cardiff',       lat: 51.467, lng: -3.167, mhwsODN:  6.05, mhwnODN:  4.72, mlwsODN: -5.34 },
  ];

  /**
   * Return the nearest NTSLF station to the given coordinates.
   * @param {number} lat
   * @param {number} lng
   * @returns {object} station record
   */
  function _nearestTideStation(lat, lng) {
    let best = _TIDE_STATIONS[0];
    let bestDist = Infinity;
    for (const station of _TIDE_STATIONS) {
      const d = _haversineKm(lat, lng, station.lat, station.lng);
      if (d < bestDist) {
        bestDist = d;
        best = station;
      }
    }
    return best;
  }

  // ---------------------------------------------------------------------------

  /**
   * Detect whether a coordinate is inland, coastal, or in a mixed (estuarine)
   * transitional zone.
   *
   * Algorithm:
   *   1. Compute distance to nearest UK coastline sample point (Haversine).
   *   2. < 5 km  → 'coastal'  (within MHWS zone; PRD §4.2 coastal trigger)
   *   3. 5–15 km → 'mixed'    (estuarine / transitional zone)
   *   4. > 15 km → 'inland'
   *
   * The coastline sample set (_UK_COAST_SAMPLE_POINTS) provides ~50 km spacing
   * around the UK mainland.  This gives sufficient precision for mode routing
   * but should not be used for planning or engineering purposes.
   *
   * @param {number} lat
   * @param {number} lng
   * @returns {Promise<'inland' | 'coastal' | 'mixed'>}
   */
  async function detectMode(lat, lng) {
    const distKm = _distToCoastKm(lat, lng);

    if (distKm < 5) return 'coastal';
    if (distKm <= 15) return 'mixed';
    return 'inland';
  }

  // ---------------------------------------------------------------------------

  /**
   * Get catchment context from the EA Catchment Data Explorer.
   *
   * DATA SOURCE: LIVE (attempted) — the EA Catchment Planning WFS is a public
   * endpoint.  However, CORS support is inconsistent across EA sub-domains and
   * endpoints; if the live call fails, this function falls back to a mock result
   * clearly labelled as such.
   *
   * Real endpoint:
   *   https://environment.data.gov.uk/catchment-planning/WaterBody
   *   Method: GET ?point={lng}%20{lat}&_format=json
   *   Licence: Open Government Licence v3.0
   *
   * @param {number} lat
   * @param {number} lng
   * @returns {Promise<CatchmentResult>}
   */
  async function getCatchmentContext(lat, lng) {
    const cacheKey = `catchment:${_snap(lat)}:${_snap(lng)}`;
    const cached = _cacheGet(cacheKey);
    if (cached) return cached;

    // Attempt live call first.
    let liveResult = null;
    let liveError = null;

    try {
      const url =
        `${EA_CATCHMENT_URL}?point=${encodeURIComponent(`${lng} ${lat}`)}&_format=json`;
      const response = await fetch(url, {
        headers: { Accept: 'application/json' },
        // 8 second timeout — the catchment API can be slow
        signal: AbortSignal.timeout(8000),
      });
      if (response.ok) {
        const json = await response.json();
        // The API returns an array of water body objects
        const bodies = Array.isArray(json) ? json : (json.items || []);
        if (bodies.length > 0) {
          liveResult = _normaliseCatchmentResponse(bodies, lat, lng);
        } else {
          // Valid response but no features (point outside any EA water body polygon)
          liveResult = _emptyCatchmentResult(lat, lng);
        }
      } else {
        liveError = `HTTP ${response.status}`;
      }
    } catch (err) {
      liveError = err.message || String(err);
    }

    if (liveResult) {
      const result = {
        data: liveResult,
        source: 'live',
        citation:
          'Environment Agency Catchment Data Explorer (Water Framework Directive ' +
          'water body classifications), Open Government Licence v3.0. ' +
          'https://environment.data.gov.uk/catchment-planning/',
        timestamp: _now(),
        caveats: [
          'Water body classifications are the current WFD cycle assessment; ' +
            'check the EA Catchment Data Explorer portal for the latest status.',
          'This query returns the WFD water body polygon intersecting the point; ' +
            'the full contributing catchment requires a DEM-derived analysis.',
        ],
      };
      _cacheSet(cacheKey, result, TTL.CATCHMENT);
      return result;
    }

    // Live call failed — return mock with clear labelling and error detail.
    const mock = _mockCatchmentData(lat, lng);
    const result = {
      data: mock,
      source: 'mock',
      citation:
        'MOCK DATA — indicative catchment context. ' +
        'Real data source: EA Catchment Data Explorer (WFD water body classifications), ' +
        'Open Government Licence v3.0. ' +
        'https://environment.data.gov.uk/catchment-planning/. ' +
        `Live call failed: ${liveError}`,
      timestamp: _now(),
      caveats: [
        'THIS IS MOCK DATA. The live EA Catchment Data Explorer call could not be completed.',
        `Live call error: ${liveError}`,
        'Indicative catchment name and classification are derived from broad regional ' +
          'knowledge and are not verified against the EA WFD dataset.',
        'In production, requests route through the nature-risk-proxy Cloudflare Worker ' +
          'which handles CORS and retries (ADR-003).',
      ],
    };
    _cacheSet(cacheKey, result, TTL.CATCHMENT);
    return result;
  }

  /**
   * Normalise the raw EA Catchment Data Explorer JSON response into the
   * standard CatchmentResult data shape.
   * @param {any[]} bodies - raw water body array from the API
   * @param {number} lat
   * @param {number} lng
   * @returns {object}
   */
  function _normaliseCatchmentResponse(bodies, lat, lng) {
    const primary = bodies[0];
    return {
      lat,
      lng,
      waterBodyCount: bodies.length,
      primaryWaterBody: {
        id: primary['@id'] || primary.id || null,
        name: primary.label || primary.name || 'Unknown',
        type: primary.waterBodyType || primary.type || null,
        wfdStatus: primary.currentStatus || null,
        riskLevel: primary.atRisk || null,
        planningCycleRef: primary.planningCycle || null,
      },
      allWaterBodies: bodies.map((b) => ({
        id: b['@id'] || b.id || null,
        name: b.label || b.name || null,
        type: b.waterBodyType || b.type || null,
      })),
    };
  }

  /**
   * Result shape when the EA API returns OK but no features intersect the point.
   * @param {number} lat
   * @param {number} lng
   * @returns {object}
   */
  function _emptyCatchmentResult(lat, lng) {
    return {
      lat,
      lng,
      waterBodyCount: 0,
      primaryWaterBody: null,
      allWaterBodies: [],
      note: 'No EA WFD water body polygon found at this point. ' +
            'The location may be in a groundwater-only catchment or outside the ' +
            'EA England/Wales boundary.',
    };
  }

  /**
   * Mock catchment data calibrated by location.
   * @param {number} lat
   * @param {number} lng
   * @returns {object}
   */
  function _mockCatchmentData(lat, lng) {
    if (_isSevernCatchment(lat, lng)) {
      return {
        lat,
        lng,
        waterBodyCount: 1,
        primaryWaterBody: {
          id: 'http://environment.data.gov.uk/catchment-planning/WaterBody/GB109055042820',
          name: 'River Severn (Middle Severn)',
          type: 'River',
          wfdStatus: 'Moderate',
          riskLevel: true,
          planningCycleRef: 'Cycle 3 (2022–2027)',
        },
        allWaterBodies: [
          {
            id: 'http://environment.data.gov.uk/catchment-planning/WaterBody/GB109055042820',
            name: 'River Severn (Middle Severn)',
            type: 'River',
          },
        ],
      };
    }
    // Generic mock for non-Severn locations
    return {
      lat,
      lng,
      waterBodyCount: 1,
      primaryWaterBody: {
        id: null,
        name: 'Unknown water body (mock)',
        type: 'River',
        wfdStatus: 'Moderate',
        riskLevel: null,
        planningCycleRef: 'Cycle 3 (2022–2027)',
      },
      allWaterBodies: [],
    };
  }

  // ---------------------------------------------------------------------------
  // Public API surface
  // ---------------------------------------------------------------------------

  /**
   * window.UKDataConnectors
   *
   * All functions return a Promise resolving to an object with shape:
   *   { data, source, citation, timestamp, caveats }
   *
   * source === 'live'  → data was fetched from the real government API
   * source === 'mock'  → data is synthetic but realistic; real API requires proxy/auth
   * source === 'error' → live call failed; data is null; error detail in caveats
   */
  const UKDataConnectors = {
    /**
     * Get EA flood risk zones (Zone 2 and Zone 3) for a coordinate.
     * Data source: LIVE — EA RoFRS ArcGIS REST service (CORS enabled).
     * @param {number} lat
     * @param {number} lng
     * @param {number} [radiusKm]
     * @returns {Promise<FloodZoneResult>}
     */
    getFloodZones,

    /**
     * Get the EA RoFRS flood risk level (1=low, 2=medium, 3=high) for a point.
     * Data source: LIVE — derived from EA RoFRS ArcGIS REST service (CORS enabled).
     * @param {number} lat
     * @param {number} lng
     * @returns {Promise<RiskLevelResult>}
     */
    getFloodRiskLevel,

    /**
     * Get indicative soil type from BGS Soilscapes.
     * Data source: MOCK — BGS API requires registration and proxy (ADR-003).
     * @param {number} lat
     * @param {number} lng
     * @returns {Promise<SoilTypeResult>}
     */
    getSoilType,

    /**
     * Get indicative land cover from UKCEH Land Cover Map 2021.
     * Data source: MOCK — UKCEH LCM requires EIDC registration and proxy.
     * @param {number} lat
     * @param {number} lng
     * @returns {Promise<LandCoverResult>}
     */
    getLandCover,

    /**
     * Get Met Office UKCP18 representative rainfall and climate scenario data.
     * Data source: MOCK — UKCP18 gridded NetCDF requires Met Office DataHub API key.
     * @param {number} lat
     * @param {number} lng
     * @returns {Promise<RainfallResult>}
     */
    getRainfallData,

    /**
     * Get data for the nearest NTSLF tide gauge to a point.
     * Data source: MOCK — NTSLF does not expose a CORS-enabled JSON API.
     * @param {number} lat
     * @param {number} lng
     * @returns {Promise<TideGaugeResult>}
     */
    getNearestTideGauge,

    /**
     * Detect whether a coordinate is inland, coastal, or mixed (estuarine).
     * Uses a Haversine distance heuristic against a sampled UK coastline set.
     * < 5 km → 'coastal' | 5–15 km → 'mixed' | > 15 km → 'inland'
     * @param {number} lat
     * @param {number} lng
     * @returns {Promise<'inland' | 'coastal' | 'mixed'>}
     */
    detectMode,

    /**
     * Get WFD water body catchment context from the EA Catchment Data Explorer.
     * Attempts a live call first; falls back to mock if the live call fails.
     * Data source: LIVE (with mock fallback) — EA Catchment Planning WFS.
     * @param {number} lat
     * @param {number} lng
     * @returns {Promise<CatchmentResult>}
     */
    getCatchmentContext,

    // ------------------------------------------------------------------
    // Diagnostics / utilities (exposed for use by other modules)
    // ------------------------------------------------------------------

    /**
     * Clear the in-memory cache (useful for testing or forcing a refresh).
     */
    clearCache() {
      _cache.clear();
    },

    /**
     * Return current cache size (number of entries).
     * @returns {number}
     */
    cacheSize() {
      return _cache.size;
    },

    /**
     * Return the approximate distance in km from a coordinate to the nearest
     * point on the sampled UK coastline.  Exposed for use by the physics engine
     * and map layer modules.
     * @param {number} lat
     * @param {number} lng
     * @returns {number}
     */
    distToCoastKm: _distToCoastKm,
  };

  // Expose on the global object (window in a browser, global in Node/test environments).
  global.UKDataConnectors = UKDataConnectors;

  // Also support ES module environments via a named export shim.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = UKDataConnectors;
  }
})(typeof window !== 'undefined' ? window : typeof global !== 'undefined' ? global : this);

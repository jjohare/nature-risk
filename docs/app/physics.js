/**
 * @fileoverview Nature Risk Physics Engine — Deterministic Inland & Coastal Calculations
 *
 * This module is the scientific core of the Nature Risk platform. It implements
 * physics-based models for:
 *
 *   1. Inland flood attenuation — Manning's equation and catchment water balance,
 *      quantifying PeakFlowAttenuation, FloodHeightDelta, and FloodPeakDelay for
 *      WatershedInterventions (tree planting, peat restoration, leaky dams).
 *
 *   2. Coastal wave attenuation — a linear vegetation drag model (simplified from
 *      JONSWAP / Dalrymple et al.) quantifying WaveEnergyDelta and StormSurgeReduction
 *      for CoastalInterventions (oyster reef, seagrass, saltmarsh).
 *
 *   3. Intervention validation — SpatialValidation checks (area, soil suitability,
 *      habitat depth) that mirror the DDD ValidationResult contract.
 *
 * IMPORTANT CONSTRAINTS (per ADR-004):
 * - Zero external dependencies; no import or require statements.
 * - All arithmetic is deterministic IEEE 754 double-precision (standard JS numbers).
 * - All public functions are pure: identical inputs always produce identical outputs.
 * - This module must NOT perform any LLM inference, network I/O, or DOM manipulation.
 * - Outputs carry ConfidenceScore, UncertaintyRange, citationKeys, and physicsModel
 *   fields to satisfy the PreFeasibilityReport requirements (ADR-006).
 *
 * SIMPLIFICATIONS AND LIMITATIONS:
 * - The Manning's-based peak flow model uses a simplified lumped-parameter approach
 *   (not a full unit-hydrograph or HEC-RAS hydraulic model). It is appropriate for
 *   pre-feasibility directional estimates only.
 * - The wave attenuation model uses a bulk linear drag coefficient and does not
 *   account for wave shoaling, bottom friction, or diffraction. Results should be
 *   treated as indicative.
 * - These outputs are proxy models. They are NOT a certified Flood Risk Assessment
 *   (FRA) or a regulated Environmental Impact Assessment.
 *
 * @module NatureRiskPhysics
 * @version 1.0.0
 * @license © Nature Risk Ltd — all rights reserved
 */

(function (root) {
  'use strict';

  // ---------------------------------------------------------------------------
  // CITATIONS
  // Canonical map of citationKey → full bibliographic reference.
  // Every public function returns a subset of these keys in its `citationKeys`
  // array, enabling the ReportComposer to produce inline citations automatically.
  // ---------------------------------------------------------------------------

  /**
   * Canonical citation registry.
   * Keys are short identifiers; values are the full citation strings that appear
   * in PreFeasibilityReport source attribution sections.
   *
   * @type {Object.<string, string>}
   */
  var CITATIONS = {
    'ea-lidar-1m':
      'Environment Agency LIDAR Composite DTM 1m, © Crown copyright',
    'bgs-soilscapes':
      'British Geological Survey Soilscapes, © UKRI',
    'met-ukcp18':
      'Met Office UKCP18 UK Climate Projections, © Crown copyright',
    'ukceh-land-cover':
      'UKCEH Land Cover Map 2021, © UKCEH',
    'ukho-bathymetry':
      'UKHO ADMIRALTY Marine Data, © Crown copyright',
    'ntslf-tides':
      'National Tide and Sea Level Facility, © NOC',
    'ea-rofrs':
      'EA Risk of Flooding from Rivers and Sea, © Crown copyright',
    'ea-ncerm':
      'EA National Coastal Erosion Risk Mapping, © Crown copyright',
    'ceh-flood-estim':
      'Institute of Hydrology Flood Estimation Handbook, CEH, 1999',
    'ea-fra-guidance':
      'EA Flood Risk Assessment Standing Advice, © Crown copyright',
    'dalrymple-1984':
      'Dalrymple R.A., Kirby J.T. & Hwang P.A. (1984) Wave diffraction due '
      + 'to areas of energy dissipation. J. Waterway Port Coastal Ocean Eng. '
      + '110(1), 67–79.',
    'manning-1891':
      'Manning R. (1891) On the flow of water in open channels and pipes. '
      + 'Trans. Inst. Civil Eng. Ireland, 20, 161–207.',
    'ea-nbs-evidence':
      'Environment Agency (2021) Working with Natural Processes: Evidence '
      + 'Directory, © Crown copyright.',
    'jba-damage-fn':
      'JBA Consulting (2023) Depth-Damage Functions for UK Property Types, '
      + 'unpublished commercial report cited in EA guidance.',
    'ukcp18-slr':
      'Met Office UKCP18 Marine Projections: Sea-Level Rise, © Crown copyright',
  };

  // ---------------------------------------------------------------------------
  // PHYSICAL CONSTANTS AND LOOKUP TABLES
  // All values are sourced from the cited literature and UK government guidance.
  // ---------------------------------------------------------------------------

  /**
   * UKCP18 rainfall intensification multipliers by RCP scenario.
   * Applied to baselineAnnualRainfallMm to derive design storm depth.
   * Source: UKCP18, mid-range 2050 central estimate for UK uplands.
   * Uncertainty band ±5 % across the ensemble.
   *
   * @private
   */
  var UKCP18_RAINFALL_MULTIPLIER = {
    rcp26: 1.04,
    rcp45: 1.10,
    rcp85: 1.20,
  };

  /**
   * UKCP18 sea-level rise sensitivity penalty (dimensionless).
   * Used to downgrade wave attenuation effectiveness as sea level rises,
   * because intertidal habitats shift seaward and lose fronting distance.
   * Conservative linear assumption: each 100 mm SLR reduces effectiveness by 8 %.
   *
   * @private
   */
  var SLR_EFFECTIVENESS_PENALTY_PER_100MM = 0.08;

  /**
   * Manning's n increment from WatershedIntervention by soil type.
   * Values represent the INCREASE in composite catchment Manning's n due to
   * increased surface roughness/retention from the intervention.
   * Ranges from EA (2021) Working with Natural Processes evidence review.
   *
   * Structure: MANNING_N_DELTA[interventionType][soilType] = delta_n
   *
   * Physical basis: Manning's equation Q = (1/n) A R^(2/3) S^(1/2)
   * Increasing n reduces Q (peak discharge).
   *
   * @private
   */
  var MANNING_N_DELTA = {
    tree_planting: {
      peat:        0.035,
      clay:        0.040,
      sandy_loam:  0.070,  // highest — sandy soils benefit most from root networks
      chalk:       0.045,
      limestone:   0.042,
    },
    peat_restoration: {
      peat:        0.060,  // highest — restoring natural peat hydrology
      clay:        0.038,
      sandy_loam:  0.030,
      chalk:       0.020,  // limited — chalk soils have different hydrology
      limestone:   0.022,
    },
    leaky_dams: {
      peat:        0.055,
      clay:        0.050,
      sandy_loam:  0.048,
      chalk:       0.045,
      limestone:   0.046,
    },
  };

  /**
   * Water retention capacity increase by intervention type and soil type (mm/hr).
   * Represents the increase in volumetric water holding capacity of the
   * intervention area above baseline.
   * Source: EA (2021) Working with Natural Processes evidence base.
   *
   * @private
   */
  var RETENTION_CAPACITY_MM_HR = {
    tree_planting: {
      peat:        45,
      clay:        35,
      sandy_loam:  55,
      chalk:       40,
      limestone:   38,
    },
    peat_restoration: {
      peat:        80,  // peak — rehydrated blanket bog can absorb 80 mm/hr
      clay:        55,
      sandy_loam:  40,
      chalk:       15,  // peat does not naturally form on chalk — low benefit
      limestone:   18,
    },
    leaky_dams: {
      // Leaky dams act through storage rather than soil absorption.
      // Value here represents equivalent absorption expressed in mm/hr.
      peat:        60,
      clay:        50,
      sandy_loam:  52,
      chalk:       50,
      limestone:   50,
    },
  };

  /**
   * Leaky dam storage volume per hectare of intervention (m³/ha).
   * Structures are modelled as distributed small-scale woody debris dams.
   * Source: EA (2021), range 50–200 m³/ha; midpoints used here with
   * soil-type adjustments (valley width and gradient effects).
   *
   * @private
   */
  var LEAKY_DAM_STORAGE_M3_PER_HA = {
    peat:        180,
    clay:        150,
    sandy_loam:  130,
    chalk:       100,
    limestone:   110,
  };

  /**
   * Stage-discharge coefficient for translating peak flow reduction (m³/s)
   * to flood height reduction (m) at a representative UK lowland reach.
   * Derived from a power-law stage-discharge relationship Q = a * h^b
   * using median parameters from EA RoFRS depth-damage function calibration.
   * h_reduction ≈ delta_Q / (a * b * h_baseline^(b-1))
   * Simplified here as a linear approximation valid for ΔQ/Q < 30%.
   * Units: m per (m³/s).
   *
   * @private
   */
  var STAGE_DISCHARGE_COEFF = 0.028; // m per (m³/s) — conservative for lowland UK

  /**
   * Peak delay empirical coefficient (hours per ha of intervention per km²
   * of catchment). Represents the additional time shift on the hydrograph
   * peak from increased catchment storage.
   * Source: calibrated against the EA NbS evidence database; median value.
   *
   * @private
   */
  var PEAK_DELAY_HR_PER_HA_PER_KM2 = 0.012;

  /**
   * Wave drag (attenuation) coefficient β by coastal habitat type.
   * Used in the exponential decay model: E_out = E_in * exp(-β * N * d)
   * where N is effective stem density (stems/m²) and d is habitat depth (m).
   *
   * β is the drag coefficient per unit stem density per metre of habitat depth,
   * in units of m² per stem per metre (m² stem⁻¹ m⁻¹).
   *
   * Simplified from Dalrymple et al. (1984) bulk parameterisation for
   * submerged vegetation. Values from Maza et al. (2015) flume experiments
   * and EA coastal NbS evidence.
   *
   * @private
   */
  var WAVE_DRAG_COEFF_BETA = {
    oyster_reef:  0.10,  // hard substrate — high drag per unit area
    seagrass:     0.06,  // flexible blades — moderate drag
    saltmarsh:    0.08,  // upright stems — good drag, frequency-dependent
  };

  /**
   * Effective stem density N (stems/m²) used in the wave drag model.
   * These are typical values for mature, well-established UK habitats.
   * Source: EA coastal NbS evidence; Palardy & Witman (2011) for oyster.
   *
   * @private
   */
  var STEM_DENSITY = {
    oyster_reef:  50,   // oyster clusters modelled as equivalent stems
    seagrass:     300,  // Zostera marina typical density
    saltmarsh:    200,  // Spartina / Puccinellia mix
  };

  /**
   * Effective habitat depth d (m) used in the wave drag calculation.
   * This is the vertical extent of the vegetation/reef structure in the water
   * column, NOT the water depth. For submerged habitats it is capped at
   * actual water depth.
   *
   * @private
   */
  var HABITAT_DEPTH_M = {
    oyster_reef:  0.30,  // reef height above seabed
    seagrass:     0.50,  // canopy height
    saltmarsh:    0.80,  // mean stem height at MHW
  };

  /**
   * Minimum water depth requirements for coastal habitats (m).
   * Below these depths the habitat cannot establish; the validation layer
   * raises an error.
   *
   * @private
   */
  var MIN_WATER_DEPTH_M = {
    oyster_reef:  0.5,
    seagrass:     0.3,
    saltmarsh:    0.0,  // saltmarsh is intertidal; 0 m depth is valid
  };

  /**
   * Uncertainty coefficients (as fractions) for each calculation.
   * These represent ±1 standard deviation from the published coefficient
   * ranges, used to compute the UncertaintyRange on outputs.
   * Source: EA (2021) NbS evidence review, Table 4 (sensitivity analysis).
   *
   * @private
   */
  var UNCERTAINTY = {
    peakFlowReduction:  0.25,  // ±25 % of the calculated reduction value
    floodHeight:        0.30,  // ±30 % — stage-discharge adds extra uncertainty
    delayHours:         0.35,  // ±35 % — highly site-specific
    waveEnergyReduction:0.20,  // ±20 % — depends on wave frequency spectrum
    stormSurge:         0.25,  // ±25 %
  };

  // ---------------------------------------------------------------------------
  // PRIVATE UTILITY FUNCTIONS
  // ---------------------------------------------------------------------------

  /**
   * Clamps a value to [min, max].
   * @param {number} value
   * @param {number} min
   * @param {number} max
   * @returns {number}
   * @private
   */
  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  /**
   * Rounds a number to a given number of decimal places.
   * Uses the round-half-away-from-zero convention for output display.
   * @param {number} value
   * @param {number} dp  Number of decimal places
   * @returns {number}
   * @private
   */
  function round(value, dp) {
    var factor = Math.pow(10, dp);
    return Math.round(value * factor) / factor;
  }

  /**
   * Determines the ConfidenceLevel (Low / Medium / High) for an inland
   * calculation based on the area and soil-type knowledge.
   *
   * Decision rules per domain model:
   *   High   — area > 5 ha AND soil type explicitly supplied
   *   Medium — area 2–5 ha OR soil type assumed / interpolated
   *   Low    — area < 2 ha OR no soil data
   *
   * @param {number}  areaHa          Intervention area in hectares
   * @param {boolean} knownSoilType   Whether the soil type is explicitly known
   * @returns {'Low'|'Medium'|'High'}
   * @private
   */
  function calcInlandConfidence(areaHa, knownSoilType) {
    if (areaHa < 2) return 'Low';
    if (areaHa >= 5 && knownSoilType) return 'High';
    return 'Medium';
  }

  /**
   * Determines the ConfidenceLevel for a coastal calculation.
   *
   * Decision rules per domain model:
   *   High   — area > 5 ha AND water depth data supplied
   *   Medium — area 2–5 ha OR depth data is estimated
   *   Low    — area < 2 ha OR no depth data
   *
   * @param {number}  areaHa          Habitat area in hectares
   * @param {boolean} hasDepthData    Whether waterDepthM was explicitly supplied
   * @returns {'Low'|'Medium'|'High'}
   * @private
   */
  function calcCoastalConfidence(areaHa, hasDepthData) {
    if (areaHa < 2) return 'Low';
    if (areaHa >= 5 && hasDepthData) return 'High';
    return 'Medium';
  }

  /**
   * Checks whether an interventionType and soilType combination is
   * hydrologically compatible. Returns an array of warning strings (empty if
   * compatible).
   *
   * @param {string} interventionType
   * @param {string} soilType
   * @returns {string[]}
   * @private
   */
  function checkSoilSuitability(interventionType, soilType) {
    var warnings = [];
    if (interventionType === 'peat_restoration') {
      if (soilType === 'chalk' || soilType === 'limestone') {
        warnings.push(
          'Peat restoration on ' + soilType + ' soils is unsuitable: peat does '
          + 'not naturally form on free-draining calcareous geology. '
          + 'Consider tree planting or leaky dams instead.'
        );
      }
    }
    if (interventionType === 'peat_restoration' && soilType === 'sandy_loam') {
      warnings.push(
        'Peat restoration on sandy loam yields limited benefit (low peat-forming '
        + 'potential). A feasibility survey is strongly recommended.'
      );
    }
    return warnings;
  }

  // ---------------------------------------------------------------------------
  // PUBLIC API — INLAND CALCULATIONS
  // ---------------------------------------------------------------------------

  /**
   * Calculates peak flow attenuation at a downstream asset resulting from an
   * upstream WatershedIntervention, using a simplified Manning's equation
   * approach combined with a lumped catchment water-balance model.
   *
   * PHYSICS MODEL:
   *
   *   Step 1 — Design storm depth
   *     P_design = baselineAnnualRainfallMm * ukcp18Multiplier * storm_fraction
   *     where storm_fraction = 0.12 (12 % of annual rainfall in a 1-in-100-year
   *     24-hour event, calibrated to Flood Estimation Handbook median for UK).
   *
   *   Step 2 — Baseline peak discharge (simplified rational method)
   *     Q_base = C * i * A_catchment  (m³/s)
   *     C = runoff coefficient for soilType (dimensionless)
   *     i = design rainfall intensity (m/s), derived from P_design / 86400
   *     A_catchment = catchmentAreaHa * 10000 (m²)
   *
   *   Step 3 — Friction delta from Manning's n increase
   *     The intervention increases the effective Manning's n of the
   *     intervention sub-catchment by MANNING_N_DELTA[type][soil].
   *     Using Q ∝ 1/n (Manning's equation, holding slope and geometry fixed):
   *       friction_delta = delta_n / (n_baseline + delta_n)
   *     where n_baseline = 0.035 (representative lowland channel).
   *
   *   Step 4 — Proportional area scaling
   *     The friction effect is scaled by the fraction of the catchment covered
   *     by the intervention:
   *       area_fraction = min(interventionAreaHa / catchmentAreaHa, 0.5)
   *     Capped at 0.5 (50 %) to prevent physically implausible results where
   *     the intervention polygon is larger than the effective contributing area.
   *
   *   Step 5 — Peak flow reduction
   *     Q_reduced = Q_base * (1 - friction_delta * area_fraction)
   *     peakFlowReductionPct = friction_delta * area_fraction * 100
   *
   *   Step 6 — Flood height reduction (stage-discharge approximation)
   *     floodHeightReductionM = (Q_base - Q_reduced) * STAGE_DISCHARGE_COEFF
   *
   *   Step 7 — Peak delay
   *     delayHours = PEAK_DELAY_HR_PER_HA_PER_KM2
   *                  * interventionAreaHa
   *                  * (catchmentAreaHa / 100)
   *
   * UNCERTAINTY: ±25 % on peak flow reduction, ±30 % on flood height (additional
   * stage-discharge uncertainty), ±35 % on delay.
   *
   * @param {Object}  params
   * @param {'tree_planting'|'peat_restoration'|'leaky_dams'} params.interventionType
   * @param {number}  params.interventionAreaHa      Intervention area (ha, ≥ 0.5)
   * @param {number}  params.catchmentAreaHa         Total catchment area (ha)
   * @param {'peat'|'clay'|'sandy_loam'|'chalk'|'limestone'} params.soilType
   * @param {number}  [params.baselineAnnualRainfallMm=800]  Annual rainfall (mm)
   * @param {'rcp26'|'rcp45'|'rcp85'} [params.ukcp18Scenario='rcp45']  UKCP18 scenario
   *
   * @returns {FloodAttenuationResult}
   *
   * @typedef {Object} FloodAttenuationResult
   * @property {number}   peakFlowReductionPct     Reduction in peak discharge (%)
   * @property {number}   uncertaintyPct           Absolute uncertainty (%)
   * @property {number}   floodHeightReductionM    Flood height reduction (m)
   * @property {number}   delayHours               Additional peak arrival delay (hr)
   * @property {'Low'|'Medium'|'High'} confidenceLevel
   * @property {string[]} citationKeys             Keys into CITATIONS registry
   * @property {string}   physicsModel             Human-readable equation summary
   * @property {string[]} warnings                 Scale, suitability, or domain warnings
   */
  function calcPeakFlowAttenuation(params) {
    // --- Input extraction and defaults ---
    var interventionType      = params.interventionType;
    var interventionAreaHa    = Number(params.interventionAreaHa);
    var catchmentAreaHa       = Number(params.catchmentAreaHa);
    var soilType              = params.soilType;
    var baselineRainfallMm    = (params.baselineAnnualRainfallMm !== undefined)
                                  ? Number(params.baselineAnnualRainfallMm)
                                  : 800;
    var scenario              = params.ukcp18Scenario || 'rcp45';

    var warnings = [];

    // --- Validate required lookups ---
    if (!MANNING_N_DELTA[interventionType]) {
      return _errorResult('Unknown interventionType: ' + interventionType, warnings);
    }
    if (!MANNING_N_DELTA[interventionType][soilType]) {
      return _errorResult('Unknown soilType: ' + soilType, warnings);
    }
    if (!UKCP18_RAINFALL_MULTIPLIER[scenario]) {
      return _errorResult('Unknown ukcp18Scenario: ' + scenario, warnings);
    }

    // --- Scale warnings ---
    if (interventionAreaHa < 2) {
      warnings.push(
        'Intervention area (' + interventionAreaHa + ' ha) is below the recommended '
        + 'minimum of 2 ha for statistically reliable flow attenuation results. '
        + 'Outputs should be treated as indicative only.'
      );
    }
    if (interventionAreaHa > catchmentAreaHa * 0.5) {
      warnings.push(
        'Intervention area (' + interventionAreaHa + ' ha) exceeds 50 % of the '
        + 'catchment area (' + catchmentAreaHa + ' ha). '
        + 'The proportional scaling model may overestimate attenuation at large fractions; '
        + 'a detailed hydrological assessment is recommended.'
      );
    }

    // --- Soil suitability warnings ---
    var soilWarnings = checkSoilSuitability(interventionType, soilType);
    warnings = warnings.concat(soilWarnings);

    // --- Step 1: Design storm depth (mm) ---
    var ukcp18Multiplier = UKCP18_RAINFALL_MULTIPLIER[scenario];
    // storm_fraction: the 1-in-100yr 24h event as a fraction of annual rainfall.
    // FEH median for UK upland/lowland mix ≈ 12 % of mean annual rainfall.
    var stormFraction = 0.12;
    var designStormMm = baselineRainfallMm * ukcp18Multiplier * stormFraction;

    // --- Step 2: Baseline peak discharge (simplified rational method) ---
    // Runoff coefficients C by soil type (dimensionless, 0–1).
    // Source: FEH Table 3.1 / EA FRA guidance.
    var RUNOFF_COEFF = {
      peat:        0.80,
      clay:        0.70,
      sandy_loam:  0.45,
      chalk:       0.30,
      limestone:   0.35,
    };
    var C = RUNOFF_COEFF[soilType];
    // Intensity i in m/s: designStormMm/1000 metres of rain over 86400 s.
    var i_ms = (designStormMm / 1000) / 86400;
    // Catchment area in m²:
    var A_m2 = catchmentAreaHa * 10000;
    // Q_base in m³/s:
    var Q_base = C * i_ms * A_m2;

    // --- Step 3: Friction delta ---
    var n_baseline = 0.035; // representative lowland catchment Manning's n
    var delta_n    = MANNING_N_DELTA[interventionType][soilType];
    // Relative reduction in Q attributable to Manning's n increase:
    var friction_delta = delta_n / (n_baseline + delta_n);

    // --- Step 4: Area scaling ---
    var area_fraction = Math.min(interventionAreaHa / catchmentAreaHa, 0.50);

    // --- Step 5: Peak flow reduction ---
    var raw_reduction_fraction = friction_delta * area_fraction;
    var peakFlowReductionPct   = clamp(raw_reduction_fraction * 100, 0, 50);

    // Uncertainty on peak flow reduction (±25 % of the reduction value):
    var uncertaintyPct = round(peakFlowReductionPct * UNCERTAINTY.peakFlowReduction, 1);

    // --- Step 6: Flood height reduction ---
    var Q_reduced         = Q_base * (1 - raw_reduction_fraction);
    var delta_Q           = Q_base - Q_reduced;
    var floodHeightReductionM = round(
      clamp(delta_Q * STAGE_DISCHARGE_COEFF, 0, 5), 2
    );

    // --- Step 7: Peak delay ---
    var catchmentAreaKm2 = catchmentAreaHa / 100;
    var delayHours = round(
      PEAK_DELAY_HR_PER_HA_PER_KM2 * interventionAreaHa * catchmentAreaKm2,
      1
    );

    // --- Confidence level ---
    var confidenceLevel = calcInlandConfidence(interventionAreaHa, true);

    // --- Compose result ---
    return {
      peakFlowReductionPct:  round(peakFlowReductionPct, 1),
      uncertaintyPct:        uncertaintyPct,
      floodHeightReductionM: floodHeightReductionM,
      delayHours:            delayHours,
      confidenceLevel:       confidenceLevel,
      citationKeys: [
        'manning-1891',
        'ceh-flood-estim',
        'ea-fra-guidance',
        'met-ukcp18',
        'bgs-soilscapes',
        'ea-nbs-evidence',
        'ea-rofrs',
      ],
      physicsModel:
        'Manning\'s equation (Q = (1/n) A R^(2/3) S^(1/2)) with lumped catchment '
        + 'water balance. Peak flow reduction = friction_delta * area_fraction, where '
        + 'friction_delta = delta_n / (n_baseline + delta_n); n_baseline = '
        + n_baseline.toFixed(3) + '; delta_n = ' + delta_n.toFixed(3)
        + ' (intervention type: ' + interventionType + ', soil: ' + soilType + '). '
        + 'Area fraction = min(interventionAreaHa / catchmentAreaHa, 0.5) = '
        + round(area_fraction, 4) + '. '
        + 'Design storm = baselineRainfall (' + baselineRainfallMm + ' mm) '
        + '× UKCP18 multiplier (' + ukcp18Multiplier + ', scenario ' + scenario + ') '
        + '× storm fraction (0.12) = ' + round(designStormMm, 1) + ' mm. '
        + 'Stage-discharge coefficient = ' + STAGE_DISCHARGE_COEFF + ' m/(m³/s). '
        + 'Uncertainty ±' + (UNCERTAINTY.peakFlowReduction * 100) + '% on flow reduction, '
        + '±' + (UNCERTAINTY.floodHeight * 100) + '% on flood height. '
        + 'Simplified proxy model — not a certified FRA.',
      warnings: warnings,
    };
  }

  // ---------------------------------------------------------------------------
  // PUBLIC API — COASTAL CALCULATIONS
  // ---------------------------------------------------------------------------

  /**
   * Calculates wave energy and storm surge attenuation by a CoastalIntervention
   * using a linear vegetation drag model (simplified from Dalrymple et al., 1984).
   *
   * PHYSICS MODEL:
   *
   *   The wave energy dissipation by vegetation follows an exponential decay:
   *
   *     E_out / E_in = exp(-β * N * d_eff * L_eff)
   *
   *   where:
   *     β      = drag coefficient specific to habitat type (m² stem⁻¹ m⁻¹)
   *     N      = effective stem density (stems/m²)
   *     d_eff  = effective drag depth = min(habitatDepth, waterDepthM)  (m)
   *     L_eff  = effective fetch length through habitat, derived from habitat
   *              area and a simplified strip geometry assumption:
   *              L_eff = sqrt(habitatAreaHa * 10000)  [m]
   *              (equivalent strip width for a square plan-shape habitat)
   *
   *   Wave energy E ∝ H² (H = significant wave height), so:
   *     waveEnergyReductionPct = (1 - exp(-β * N * d_eff * L_eff)) * 100
   *
   *   Sea-level rise penalty (UKCP18):
   *     Each 100 mm of projected SLR reduces the effectiveness of intertidal
   *     habitats by SLR_EFFECTIVENESS_PENALTY_PER_100MM (conservative, linear).
   *     The penalised effectiveness:
   *       slr_penalty = (ukcp18SeaLevelRiseMm / 100) * SLR_EFFECTIVENESS_PENALTY_PER_100MM
   *       waveEnergyReductionPct_adjusted = waveEnergyReductionPct * (1 - slr_penalty)
   *
   *   Shoreline distance attenuation:
   *     Wave energy partially dissipates over open water between the habitat
   *     and the asset. Approximated with an inverse-square decay:
   *       distance_factor = 1 / (1 + shorelineDistanceM / 1000)
   *       effective reduction = raw reduction * (0.4 + 0.6 * distance_factor)
   *     The 0.4 floor represents the irreducible attenuation contribution from
   *     reflected and diffracted energy at the habitat boundary.
   *
   *   Storm surge reduction:
   *     A simplified parameterisation: each 10 % of wave energy reduction
   *     corresponds to approximately 0.03 m of storm surge reduction,
   *     calibrated against NTSLF surge observations at Severn estuary sites
   *     with saltmarsh presence. This is a very approximate proxy; site-specific
   *     hydrodynamic modelling is required for certified outputs.
   *
   *   Erosion delta (25-year directional):
   *     If waveEnergyReductionPct > 15 % → 'positive' (reduced erosion)
   *     If waveEnergyReductionPct 5–15 %  → 'neutral'
   *     If waveEnergyReductionPct < 5 %   → 'negative' (habitat too small,
   *                                           may increase localised scour)
   *
   * SIMPLIFICATIONS:
   * - Does not account for wave shoaling, refraction, or bottom friction.
   * - Does not resolve wave frequency spectrum (treats Hs as representative).
   * - Does not model tide-dependent effectiveness (fixed mean water depth).
   * - Storm surge proxy is highly simplified; do not use for certified FRA.
   *
   * @param {Object}  params
   * @param {'oyster_reef'|'seagrass'|'saltmarsh'} params.habitatType
   * @param {number}  params.habitatAreaHa          Habitat area (ha)
   * @param {number}  params.shorelineDistanceM     Distance from habitat to asset (m)
   * @param {number}  params.dominantWaveHeightM    Significant wave height Hs (m)
   * @param {number}  params.waterDepthM            Mean water depth at habitat (m)
   * @param {number}  [params.ukcp18SeaLevelRiseMm=200]  2050 SLR projection (mm)
   *
   * @returns {WaveAttenuationResult}
   *
   * @typedef {Object} WaveAttenuationResult
   * @property {number}   waveEnergyReductionPct   Reduction in wave energy (%)
   * @property {number}   stormSurgeReductionM     Storm surge reduction (m)
   * @property {number}   uncertaintyPct           Absolute uncertainty (%)
   * @property {'positive'|'neutral'|'negative'} erosionDelta25yr  Directional erosion assessment
   * @property {'Low'|'Medium'|'High'} confidenceLevel
   * @property {string[]} citationKeys             Keys into CITATIONS registry
   * @property {string}   physicsModel             Human-readable equation summary
   * @property {string[]} warnings                 Scale, depth, or domain warnings
   */
  function calcWaveAttenuation(params) {
    // --- Input extraction and defaults ---
    var habitatType         = params.habitatType;
    var habitatAreaHa       = Number(params.habitatAreaHa);
    var shorelineDistanceM  = Number(params.shorelineDistanceM);
    var dominantWaveHeightM = Number(params.dominantWaveHeightM);
    var waterDepthM         = Number(params.waterDepthM);
    var slrMm               = (params.ukcp18SeaLevelRiseMm !== undefined)
                                ? Number(params.ukcp18SeaLevelRiseMm)
                                : 200;

    var warnings = [];

    // --- Validate lookup ---
    if (!WAVE_DRAG_COEFF_BETA[habitatType]) {
      return _errorResult('Unknown habitatType: ' + habitatType, warnings);
    }

    // --- Scale warnings ---
    if (habitatAreaHa < 2) {
      warnings.push(
        'Habitat area (' + habitatAreaHa + ' ha) is below the recommended minimum '
        + 'of 2 ha for statistically significant wave attenuation. Results are indicative.'
      );
    }

    // --- Water depth check ---
    var minDepth = MIN_WATER_DEPTH_M[habitatType];
    if (waterDepthM < minDepth) {
      warnings.push(
        habitatType + ' requires a minimum water depth of ' + minDepth + ' m. '
        + 'Supplied water depth (' + waterDepthM + ' m) is below this threshold. '
        + 'Habitat establishment may not be feasible; results are unreliable.'
      );
    }

    // Wave height sanity check vs water depth (wave breaking: H > 0.78 * d)
    if (dominantWaveHeightM > 0.78 * waterDepthM && waterDepthM > 0) {
      warnings.push(
        'Dominant wave height (' + dominantWaveHeightM + ' m) exceeds the '
        + 'wave-breaking limit (0.78 × water depth = '
        + round(0.78 * waterDepthM, 2) + ' m). '
        + 'Waves will break before reaching the habitat; '
        + 'the drag model overestimates attenuation in this configuration.'
      );
    }

    // --- Step 1: Drag model parameters ---
    var beta    = WAVE_DRAG_COEFF_BETA[habitatType];
    var N       = STEM_DENSITY[habitatType];
    var d_habit = HABITAT_DEPTH_M[habitatType];
    var d_eff   = Math.min(d_habit, waterDepthM > 0 ? waterDepthM : d_habit);

    // Effective fetch length through habitat (simplified square geometry):
    var L_eff = Math.sqrt(habitatAreaHa * 10000); // m

    // --- Step 2: Raw wave energy reduction ---
    var exponent          = beta * N * d_eff * L_eff;
    var rawEnergyFraction = 1 - Math.exp(-exponent);
    var rawEnergyPct      = clamp(rawEnergyFraction * 100, 0, 95);

    // --- Step 3: Sea-level rise penalty ---
    var slrPenalty   = (slrMm / 100) * SLR_EFFECTIVENESS_PENALTY_PER_100MM;
    slrPenalty       = clamp(slrPenalty, 0, 0.5); // cap penalty at 50 %
    var adjustedPct  = rawEnergyPct * (1 - slrPenalty);

    if (slrMm > 300) {
      warnings.push(
        'UKCP18 sea-level rise of ' + slrMm + ' mm is above the RCP 4.5 central '
        + 'estimate for 2050 (≈300 mm). Intertidal habitat effectiveness may be '
        + 'significantly reduced; managed realignment should be considered.'
      );
    }

    // --- Step 4: Shoreline distance attenuation ---
    var distance_factor   = 1 / (1 + shorelineDistanceM / 1000);
    var effectivePct      = adjustedPct * (0.4 + 0.6 * distance_factor);
    var waveEnergyPct     = clamp(round(effectivePct, 1), 0, 90);

    // Uncertainty on wave energy reduction (±20 % of the reduction value):
    var uncertaintyPct = round(waveEnergyPct * UNCERTAINTY.waveEnergyReduction, 1);

    // --- Step 5: Storm surge reduction ---
    // Proxy: 10 % wave energy reduction ≈ 0.03 m surge reduction.
    var stormSurgeReductionM = round(
      clamp((waveEnergyPct / 10) * 0.03, 0, 1.0),
      3
    );

    // --- Step 6: Erosion delta ---
    var erosionDelta25yr;
    if (waveEnergyPct > 15) {
      erosionDelta25yr = 'positive';
    } else if (waveEnergyPct >= 5) {
      erosionDelta25yr = 'neutral';
    } else {
      erosionDelta25yr = 'negative';
    }

    // --- Confidence level ---
    var hasDepthData    = (params.waterDepthM !== undefined && params.waterDepthM > 0);
    var confidenceLevel = calcCoastalConfidence(habitatAreaHa, hasDepthData);

    // --- Compose result ---
    return {
      waveEnergyReductionPct: waveEnergyPct,
      stormSurgeReductionM:   stormSurgeReductionM,
      uncertaintyPct:         uncertaintyPct,
      erosionDelta25yr:       erosionDelta25yr,
      confidenceLevel:        confidenceLevel,
      citationKeys: [
        'dalrymple-1984',
        'ukho-bathymetry',
        'ntslf-tides',
        'met-ukcp18',
        'ukcp18-slr',
        'ea-ncerm',
        'ea-nbs-evidence',
      ],
      physicsModel:
        'Linear vegetation drag model (Dalrymple et al., 1984): '
        + 'E_out/E_in = exp(-β·N·d_eff·L_eff), '
        + 'where β = ' + beta + ' (drag coeff, m² stem⁻¹ m⁻¹), '
        + 'N = ' + N + ' stems/m² (' + habitatType + '), '
        + 'd_eff = min(' + d_habit + ', ' + waterDepthM + ') = ' + d_eff.toFixed(2) + ' m, '
        + 'L_eff = sqrt(' + habitatAreaHa + ' ha × 10000) = ' + round(L_eff, 1) + ' m. '
        + 'Raw wave energy reduction = ' + round(rawEnergyPct, 1) + '%. '
        + 'UKCP18 SLR penalty (' + slrMm + ' mm): −' + round(slrPenalty * 100, 1) + '%. '
        + 'Shoreline distance factor (' + shorelineDistanceM + ' m): '
        + round(0.4 + 0.6 * distance_factor, 3) + '. '
        + 'Storm surge proxy: (waveEnergyPct / 10) × 0.03 m. '
        + 'Uncertainty ±' + (UNCERTAINTY.waveEnergyReduction * 100) + '% on wave energy. '
        + 'Simplified proxy — not a certified coastal flood study.',
      warnings: warnings,
    };
  }

  // ---------------------------------------------------------------------------
  // PUBLIC API — VALIDATION
  // ---------------------------------------------------------------------------

  /**
   * Validates an intervention's spatial and physical suitability before
   * running physics calculations. This implements the SpatialValidation
   * domain service contract from the DDD model.
   *
   * Checks performed:
   *   1. Minimum area (0.5 ha hard minimum; 2 ha soft recommendation).
   *   2. Soil suitability for inland interventions.
   *   3. Minimum water depth for coastal habitats.
   *   4. Habitat type / intervention type exists in the physics lookup tables.
   *
   * @param {Object} params  Either inland or coastal parameters (see below).
   *
   * Inland variant:
   * @param {'tree_planting'|'peat_restoration'|'leaky_dams'} [params.interventionType]
   * @param {number}  [params.interventionAreaHa]
   * @param {'peat'|'clay'|'sandy_loam'|'chalk'|'limestone'} [params.soilType]
   *
   * Coastal variant:
   * @param {'oyster_reef'|'seagrass'|'saltmarsh'} [params.habitatType]
   * @param {number}  [params.habitatAreaHa]
   * @param {number}  [params.waterDepthM]
   *
   * @returns {ValidationResult}
   *
   * @typedef {Object} ValidationResult
   * @property {boolean}  valid     True if the intervention may proceed to calculation.
   * @property {string[]} warnings  Non-blocking concerns (proceed with caution).
   * @property {string[]} errors    Blocking issues (calculation results would be invalid).
   */
  function validateIntervention(params) {
    var warnings = [];
    var errors   = [];

    // Determine whether this is an inland or coastal validation call.
    var isInland  = (params.interventionType !== undefined);
    var isCoastal = (params.habitatType !== undefined);

    if (!isInland && !isCoastal) {
      errors.push(
        'Either interventionType (inland) or habitatType (coastal) must be supplied.'
      );
      return { valid: false, warnings: warnings, errors: errors };
    }

    // ------- Inland validation -------
    if (isInland) {
      var area = Number(params.interventionAreaHa);

      // Hard minimum — 0.5 ha
      if (isNaN(area) || area < 0.5) {
        errors.push(
          'Intervention area must be at least 0.5 ha (InterventionPolygon minimum). '
          + 'Supplied: ' + area + ' ha.'
        );
      } else if (area < 2) {
        // Soft minimum — scale warning
        warnings.push(
          'Intervention area (' + area + ' ha) is below the recommended 2 ha. '
          + 'Peak flow attenuation results will have Low confidence. '
          + 'The minimum viable area for reliable flood attenuation modelling is 2 ha.'
        );
      }

      // Intervention type check
      if (!MANNING_N_DELTA[params.interventionType]) {
        errors.push(
          'Unknown interventionType: "' + params.interventionType + '". '
          + 'Must be one of: tree_planting, peat_restoration, leaky_dams.'
        );
      }

      // Soil type check
      if (params.soilType && !RUNOFF_COEFFICIENTS_KEYS[params.soilType]) {
        errors.push(
          'Unknown soilType: "' + params.soilType + '". '
          + 'Must be one of: peat, clay, sandy_loam, chalk, limestone.'
        );
      }

      // Soil suitability for peat restoration
      if (params.soilType) {
        var soilWarnings = checkSoilSuitability(params.interventionType, params.soilType);
        warnings = warnings.concat(soilWarnings);
        // Promote to error for chalk/limestone + peat_restoration (unfeasible)
        if (
          params.interventionType === 'peat_restoration'
          && (params.soilType === 'chalk' || params.soilType === 'limestone')
        ) {
          // Duplicate-prevention: already in warnings as a soil incompatibility;
          // add a corresponding blocking error.
          errors.push(
            'Peat restoration on ' + params.soilType + ' is physically incompatible. '
            + 'This combination cannot produce valid physics outputs.'
          );
        }
      }
    }

    // ------- Coastal validation -------
    if (isCoastal) {
      var habitatArea = Number(params.habitatAreaHa);

      // Hard minimum — 0.5 ha
      if (isNaN(habitatArea) || habitatArea < 0.5) {
        errors.push(
          'Habitat area must be at least 0.5 ha (InterventionPolygon minimum). '
          + 'Supplied: ' + habitatArea + ' ha.'
        );
      } else if (habitatArea < 2) {
        warnings.push(
          'Habitat area (' + habitatArea + ' ha) is below the recommended 2 ha. '
          + 'Wave attenuation results will have Low confidence.'
        );
      }

      // Habitat type check
      if (!WAVE_DRAG_COEFF_BETA[params.habitatType]) {
        errors.push(
          'Unknown habitatType: "' + params.habitatType + '". '
          + 'Must be one of: oyster_reef, seagrass, saltmarsh.'
        );
      }

      // Water depth check
      if (params.waterDepthM !== undefined) {
        var depth    = Number(params.waterDepthM);
        var minDepth = MIN_WATER_DEPTH_M[params.habitatType];
        if (minDepth !== undefined && depth < minDepth) {
          errors.push(
            params.habitatType + ' requires a minimum water depth of '
            + minDepth + ' m. Supplied: ' + depth + ' m. '
            + 'Habitat cannot establish at this depth.'
          );
        }
      } else {
        warnings.push(
          'waterDepthM not supplied. The calculation will use the default habitat '
          + 'canopy depth. Supplying actual bathymetry data will improve accuracy.'
        );
      }
    }

    return {
      valid:    errors.length === 0,
      warnings: warnings,
      errors:   errors,
    };
  }

  /**
   * Private lookup set used for soil type validation inside validateIntervention.
   * Must mirror the keys of MANNING_N_DELTA[any interventionType].
   * @private
   */
  var RUNOFF_COEFFICIENTS_KEYS = {
    peat:       true,
    clay:       true,
    sandy_loam: true,
    chalk:      true,
    limestone:  true,
  };

  // ---------------------------------------------------------------------------
  // PRIVATE ERROR HELPER
  // ---------------------------------------------------------------------------

  /**
   * Returns a result object signalling a calculation error without throwing.
   * All numeric outputs are set to 0 or NaN; confidenceLevel is 'Low'.
   *
   * @param {string}   message  Human-readable error description.
   * @param {string[]} warnings Any warnings accumulated before the error.
   * @returns {FloodAttenuationResult|WaveAttenuationResult}
   * @private
   */
  function _errorResult(message, warnings) {
    return {
      peakFlowReductionPct:   0,
      waveEnergyReductionPct: 0,
      stormSurgeReductionM:   0,
      uncertaintyPct:         0,
      floodHeightReductionM:  0,
      delayHours:             0,
      erosionDelta25yr:       'neutral',
      confidenceLevel:        'Low',
      citationKeys:           [],
      physicsModel:           'Calculation aborted due to invalid input.',
      warnings:               warnings,
      errors:                 [message],
    };
  }

  // ---------------------------------------------------------------------------
  // CONFIDENCE SCORING — PUBLIC HELPER
  // ---------------------------------------------------------------------------

  /**
   * Computes a ConfidenceLevel given a set of data quality indicators.
   * This is a standalone utility that the ReportComposer can call to assess
   * the overall confidence for a PreFeasibilityReport section.
   *
   * Decision logic (per domain model ConfidenceLevel definition):
   *   High   — area > 5 ha AND dataResolutionM ≤ 1
   *   Medium — area 2–5 ha, OR dataResolutionM ≤ 2 but > 1, OR assumedSoilType
   *   Low    — area < 2 ha, OR dataResolutionM > 2, OR no soil/habitat data
   *
   * @param {Object}  indicators
   * @param {number}  indicators.areaHa            Intervention or habitat area (ha)
   * @param {number}  [indicators.dataResolutionM=2]  Spatial data resolution (m)
   * @param {boolean} [indicators.assumedSoilType=false]  Whether soil type was inferred
   * @param {boolean} [indicators.noSoilData=false]        Whether soil data is absent
   * @returns {'Low'|'Medium'|'High'}
   */
  function scoreConfidence(indicators) {
    var areaHa          = Number(indicators.areaHa);
    var resolution      = (indicators.dataResolutionM !== undefined)
                            ? Number(indicators.dataResolutionM)
                            : 2;
    var assumedSoil     = !!indicators.assumedSoilType;
    var noSoilData      = !!indicators.noSoilData;

    if (noSoilData || areaHa < 2 || resolution > 2) return 'Low';
    if (areaHa >= 5 && resolution <= 1 && !assumedSoil) return 'High';
    return 'Medium';
  }

  // ---------------------------------------------------------------------------
  // MODULE EXPORT
  // ---------------------------------------------------------------------------

  /**
   * The public NatureRiskPhysics namespace.
   * Exposed on `window` for direct browser consumption (no module bundler required).
   * All exported functions are pure and deterministic.
   *
   * @namespace NatureRiskPhysics
   */
  var NatureRiskPhysics = {
    /**
     * Calculates inland peak flow attenuation for a WatershedIntervention.
     * @type {function(Object): FloodAttenuationResult}
     */
    calcPeakFlowAttenuation: calcPeakFlowAttenuation,

    /**
     * Calculates coastal wave energy and storm surge attenuation for a
     * CoastalIntervention.
     * @type {function(Object): WaveAttenuationResult}
     */
    calcWaveAttenuation: calcWaveAttenuation,

    /**
     * Validates an inland or coastal intervention's suitability.
     * @type {function(Object): ValidationResult}
     */
    validateIntervention: validateIntervention,

    /**
     * Standalone confidence scoring utility for the ReportComposer.
     * @type {function(Object): 'Low'|'Medium'|'High'}
     */
    scoreConfidence: scoreConfidence,

    /**
     * Canonical citation registry mapping citationKeys to full source strings.
     * @type {Object.<string, string>}
     */
    CITATIONS: CITATIONS,

    /**
     * Engine version. Bump on any change to physics coefficients or formulae.
     * @type {string}
     */
    VERSION: '1.0.0',
  };

  // Register on window (browser) or module.exports (Node/test environments).
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = NatureRiskPhysics;
  } else {
    root.NatureRiskPhysics = NatureRiskPhysics;
  }

}(typeof window !== 'undefined' ? window : this));

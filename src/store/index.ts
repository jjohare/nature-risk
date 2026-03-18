// ─── Nature Risk — Main Zustand Store ────────────────────────────────────────
// Domain-sliced store with immer for immutable updates, zundo for undo/redo,
// and event-sourcing middleware for audit trail.
//
// Referenced decisions: ADR-004, ADR-005, PRD §9, PRD §10

import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { temporal } from 'zundo';
import { v4 as uuidv4 } from 'uuid';
import type {
  Viewport,
  AssetPin,
  InterventionPolygon,
  MapLayer,
  AnalysisMode,
  UserIntent,
  AnalysisStep,
  PhysicsResult,
  AdvisoryResult,
  OpportunityZone,
  ActionStreamEntry,
  ChatMessage,
  DomainEvent,
  DomainEventType,
  AdvisorMode,
  Coordinates,
} from '@/types';
import { UK_BOUNDS } from '@/types';
import { emitEvent } from './eventSourcing';

// ─── Store Interface ────────────────────────────────────────────────────────

export interface NatureRiskStore {
  // ── Map slice
  viewport: Viewport;
  assetPin: AssetPin | null;
  interventionPolygon: InterventionPolygon | null;
  activeLayers: Set<MapLayer>;
  setViewport(v: Viewport): void;
  placeAssetPin(pin: AssetPin): void;
  drawInterventionPolygon(polygon: InterventionPolygon): void;
  toggleLayer(layer: MapLayer): void;

  // ── Analysis slice
  mode: AnalysisMode | null;
  userIntent: UserIntent;
  currentStep: AnalysisStep;
  physicsResult: PhysicsResult | null;
  advisoryResult: AdvisoryResult | null;
  opportunityZones: OpportunityZone[];
  actionStream: ActionStreamEntry[];
  setMode(mode: AnalysisMode): void;
  setUserIntent(intent: UserIntent): void;
  runAnalysis(): Promise<void>;
  addActionStep(entry: ActionStreamEntry): void;
  updateActionStep(id: string, update: Partial<ActionStreamEntry>): void;

  // ── CoPilot slice
  messages: ChatMessage[];
  appendMessage(msg: ChatMessage): void;

  // ── Event log (append-only, for audit trail and PDF export)
  eventLog: DomainEvent[];

  // ── Config
  advisorMode: AdvisorMode;
  proxyUrl: string;
  configureAdvisor(apiKey?: string, proxyUrl?: string): void;

  // ── Reset
  resetAnalysis(): void;
}

// ─── Default Viewport ───────────────────────────────────────────────────────

const DEFAULT_VIEWPORT: Viewport = {
  center: {
    lat: (UK_BOUNDS.sw.lat + UK_BOUNDS.ne.lat) / 2,
    lng: (UK_BOUNDS.sw.lng + UK_BOUNDS.ne.lng) / 2,
  },
  zoom: 6,
  bearing: 0,
  pitch: 0,
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function appendEvent(
  draft: { eventLog: DomainEvent[] },
  type: DomainEventType,
  payload: Record<string, unknown>,
  causationId?: string,
): DomainEvent {
  return emitEvent(
    (event) => { draft.eventLog.push(event); },
    type,
    payload,
    causationId,
  );
}

function createActionStep(label: string): ActionStreamEntry {
  return {
    id: uuidv4(),
    label,
    status: 'running',
    startedAt: new Date().toISOString(),
  };
}

function completeActionStep(step: ActionStreamEntry, detail?: string): ActionStreamEntry {
  return {
    ...step,
    status: 'done',
    completedAt: new Date().toISOString(),
    detail,
  };
}

function failActionStep(step: ActionStreamEntry, detail: string): ActionStreamEntry {
  return {
    ...step,
    status: 'error',
    completedAt: new Date().toISOString(),
    detail,
  };
}

// ─── Store Creation ─────────────────────────────────────────────────────────

export const useNatureRiskStore = create<NatureRiskStore>()(
  temporal(
    immer((set, get) => ({
      // ── Map slice defaults
      viewport: DEFAULT_VIEWPORT,
      assetPin: null,
      interventionPolygon: null,
      activeLayers: new Set<MapLayer>(),

      // ── Analysis slice defaults
      mode: null,
      userIntent: 'asset_manager' as UserIntent,
      currentStep: 'idle' as AnalysisStep,
      physicsResult: null,
      advisoryResult: null,
      opportunityZones: [],
      actionStream: [],

      // ── CoPilot slice defaults
      messages: [],

      // ── Event log
      eventLog: [],

      // ── Config defaults — seed from build-time env vars
      advisorMode: (import.meta.env.VITE_PROXY_URL || import.meta.env.VITE_ANTHROPIC_KEY)
        ? ('live' as AdvisorMode)
        : ('demo' as AdvisorMode),
      proxyUrl: import.meta.env.VITE_PROXY_URL ?? '',

      // ── Map actions
      setViewport(v: Viewport) {
        set((state) => {
          state.viewport = v;
        });
      },

      placeAssetPin(pin: AssetPin) {
        set((state) => {
          state.assetPin = pin;
          appendEvent(state, 'AssetPinPlaced', {
            assetId: pin.asset.id,
            assetType: pin.asset.type,
            label: pin.asset.label,
            lat: pin.location.lat,
            lng: pin.location.lng,
          });
        });
      },

      drawInterventionPolygon(polygon: InterventionPolygon) {
        set((state) => {
          state.interventionPolygon = polygon;
          appendEvent(state, 'InterventionPolygonDrawn', {
            polygonId: polygon.id,
            interventionType: polygon.interventionType,
            areaHa: polygon.areaHa,
          });
        });
      },

      toggleLayer(layer: MapLayer) {
        set((state) => {
          if (state.activeLayers.has(layer)) {
            state.activeLayers.delete(layer);
          } else {
            state.activeLayers.add(layer);
          }
        });
      },

      // ── Analysis actions
      setMode(mode: AnalysisMode) {
        set((state) => {
          state.mode = mode;
          appendEvent(state, 'ModeClassified', { mode });
        });
      },

      setUserIntent(intent: UserIntent) {
        set((state) => {
          state.userIntent = intent;
        });
      },

      addActionStep(entry: ActionStreamEntry) {
        set((state) => {
          state.actionStream.push(entry);
        });
      },

      updateActionStep(id: string, update: Partial<ActionStreamEntry>) {
        set((state) => {
          const idx = state.actionStream.findIndex((s) => s.id === id);
          if (idx !== -1) {
            Object.assign(state.actionStream[idx], update);
          }
        });
      },

      async runAnalysis() {
        const state = get();
        const { assetPin, interventionPolygon } = state;

        if (!assetPin) {
          set((s) => {
            s.currentStep = 'error';
            s.actionStream.push({
              id: uuidv4(),
              label: 'Validation failed',
              status: 'error',
              startedAt: new Date().toISOString(),
              completedAt: new Date().toISOString(),
              detail: 'Place an asset pin on the map before running analysis.',
            });
          });
          return;
        }

        const coordinates: Coordinates = assetPin.location;

        // If no polygon drawn, synthesise a default riparian buffer centred on the pin.
        // Dimensions: dLat=0.00225° ≈ 250m, dLng=0.00360° ≈ 250m at 52°N → 500m×500m = 25 ha.
        const effectivePolygon: InterventionPolygon = interventionPolygon ?? (() => {
          const { lat, lng } = assetPin.location;
          const dLat = 0.00225; // ~250 m at UK latitudes
          const dLng = 0.00360; // ~250 m at ~52 °N
          return {
            id: uuidv4(),
            interventionType: 'riparian_buffer' as const,
            areaHa: 25,
            drawnAt: new Date().toISOString(),
            geometry: {
              type: 'Polygon' as const,
              coordinates: [[
                [lng - dLng, lat - dLat],
                [lng + dLng, lat - dLat],
                [lng + dLng, lat + dLat],
                [lng - dLng, lat + dLat],
                [lng - dLng, lat - dLat],
              ]],
            },
          };
        })();

        // ── Step 1: Validate input
        set((s) => {
          s.currentStep = 'validating_input';
          s.actionStream = [];
          s.physicsResult = null;
          s.advisoryResult = null;
          s.opportunityZones = [];
        });

        const validateStep = createActionStep('Validating inputs');
        set((s) => { s.actionStream.push(validateStep); });

        set((s) => {
          const idx = s.actionStream.findIndex((a) => a.id === validateStep.id);
          if (idx !== -1) Object.assign(s.actionStream[idx], completeActionStep(validateStep));
        });

        // ── Step 2: Classify mode
        set((s) => { s.currentStep = 'classifying_mode'; });
        const modeStep = createActionStep('Classifying analysis mode');
        set((s) => { s.actionStream.push(modeStep); });

        try {
          const { classifyMode } = await import('@/services/modeRouter');
          const detectedMode = await classifyMode(coordinates);
          set((s) => {
            s.mode = detectedMode;
            const idx = s.actionStream.findIndex((a) => a.id === modeStep.id);
            if (idx !== -1) Object.assign(s.actionStream[idx], completeActionStep(modeStep, `Mode: ${detectedMode}`));
            appendEvent(s, 'ModeClassified', { mode: detectedMode, lat: coordinates.lat, lng: coordinates.lng });
          });
        } catch (err) {
          set((s) => {
            s.mode = 'inland';
            const idx = s.actionStream.findIndex((a) => a.id === modeStep.id);
            if (idx !== -1) Object.assign(s.actionStream[idx], failActionStep(modeStep, 'Mode classification failed, defaulting to inland'));
          });
        }

        // ── Step 3: Fetch UK data
        set((s) => { s.currentStep = 'fetching_data'; });
        const dataStep = createActionStep('Fetching UK environmental data');
        set((s) => { s.actionStream.push(dataStep); });

        let ukData: Record<string, unknown> = {};
        try {
          const ukDataService = await import('@/services/ukData');
          const [floodZones, catchment, soil, elevation, rainfall, tidal, bathymetry] = await Promise.all([
            ukDataService.fetchFloodZones(coordinates),
            ukDataService.fetchCatchmentData(coordinates),
            ukDataService.fetchSoilData(coordinates),
            ukDataService.fetchElevation(coordinates),
            ukDataService.fetchRainfall(coordinates),
            ukDataService.fetchTidalData(coordinates),
            ukDataService.fetchBathymetry(coordinates),
          ]);
          ukData = { floodZones, catchment, soil, elevation, rainfall, tidal, bathymetry };
          set((s) => {
            const idx = s.actionStream.findIndex((a) => a.id === dataStep.id);
            if (idx !== -1) Object.assign(s.actionStream[idx], completeActionStep(dataStep, 'Data fetched'));
            appendEvent(s, 'DataFetched', {
              sources: ['flood_zones', 'catchment', 'soil', 'elevation', 'rainfall', 'tidal', 'bathymetry'],
              lat: coordinates.lat,
              lng: coordinates.lng,
            });
          });
        } catch (err) {
          set((s) => {
            const idx = s.actionStream.findIndex((a) => a.id === dataStep.id);
            if (idx !== -1) Object.assign(s.actionStream[idx], failActionStep(dataStep, String(err)));
          });
        }

        // ── Step 3b: Validate intervention against classified mode
        {
          const currentMode = get().mode ?? 'inland';
          const physicsLoaderForValidation = await import('@/services/physicsLoader');
          const validation = physicsLoaderForValidation.validateIntervention({
            interventionType: effectivePolygon.interventionType,
            areaHa: effectivePolygon.areaHa,
            mode: currentMode,
          });
          if (!validation.valid) {
            set((s) => {
              s.actionStream.push({
                id: uuidv4(),
                label: 'Intervention validation warning',
                status: 'error',
                startedAt: new Date().toISOString(),
                completedAt: new Date().toISOString(),
                detail: [validation.message, ...validation.suggestions].join(' '),
              });
            });
          } else if (validation.scaleWarnings.length > 0) {
            set((s) => {
              s.actionStream.push({
                id: uuidv4(),
                label: 'Intervention scale warning',
                status: 'done',
                startedAt: new Date().toISOString(),
                completedAt: new Date().toISOString(),
                detail: validation.scaleWarnings.join(' '),
              });
            });
          }
        }

        // ── Step 4: Run physics engine
        set((s) => { s.currentStep = 'running_physics'; });
        const physicsStep = createActionStep('Running physics engine');
        set((s) => { s.actionStream.push(physicsStep); });

        try {
          const currentMode = get().mode ?? 'inland';
          const physicsLoader = await import('@/services/physicsLoader');
          await physicsLoader.initPhysics();

          // Extract live tidal + bathymetry params where available
          const tidalData = ukData.tidal as { data?: { tidalRangeM?: number; meanHighWaterSpringM?: number } } | undefined;
          const liveTidalRangeM = tidalData?.data?.tidalRangeM ?? 4.0;
          const liveMhwsM = tidalData?.data?.meanHighWaterSpringM ?? 3.0;
          const derivedWaveHeightM = Math.max(0.5, Math.min(liveTidalRangeM * 0.25, 3.0));

          const bathyData = ukData.bathymetry as { data?: { depthM?: number; slopeGradient?: number } } | undefined;
          const liveDepthM = bathyData?.data?.depthM ?? Math.max(1.0, liveMhwsM * 0.5);

          // Derive slope gradient from elevation data (rise/run over ~1 km horizontal)
          const elevData = ukData.elevation as { data?: { elevationM?: number } } | undefined;
          const elevM = elevData?.data?.elevationM ?? 50;
          // Simple terrain slope estimate: elevation / 1000m catchment scale, clamped to plausible range
          const derivedSlope = Math.max(0.002, Math.min(elevM / 5000, 0.15));

          let result: PhysicsResult;
          if (currentMode === 'coastal') {
            result = physicsLoader.calculateCoastal({
              habitatType: mapInterventionToHabitat(effectivePolygon.interventionType),
              habitatAreaHa: effectivePolygon.areaHa,
              habitatWidthM: Math.sqrt(effectivePolygon.areaHa * 10000),
              waterDepthM: liveDepthM,
              significantWaveHeightM: derivedWaveHeightM,
              wavePeriodS: 6.0 + liveTidalRangeM * 0.5,
              tidalRangeM: liveTidalRangeM,
              seaLevelRiseM: 0.22,
              distanceToAssetM: 500,
              ukcp18Scenario: 'rcp85',
            });
          } else {
            result = physicsLoader.calculateInland({
              interventionType: effectivePolygon.interventionType,
              interventionAreaHa: effectivePolygon.areaHa,
              catchmentAreaHa: (ukData.catchment as { data?: { areaHa?: number } })?.data?.areaHa ?? 50,
              slopeGradient: derivedSlope,
              soilType: ((ukData.soil as { data?: { soilType?: string } })?.data?.soilType as 'CLAY') ?? 'CLAY',
              rainfallReturnPeriodYears: 100,
              rainfallIntensityMmHr: 30,
              channelWidthM: 8,
              baseManningsN: 0.035,
              ukcp18Scenario: 'rcp85',
            });
          }

          set((s) => {
            s.physicsResult = result;
            const idx = s.actionStream.findIndex((a) => a.id === physicsStep.id);
            if (idx !== -1) Object.assign(s.actionStream[idx], completeActionStep(physicsStep, 'Physics complete'));
            appendEvent(s, 'PhysicsCalculated', {
              mode: currentMode,
              model: result.physicsModel,
              confidence: result.confidence.level,
            });
          });
        } catch (err) {
          set((s) => {
            s.currentStep = 'error';
            const idx = s.actionStream.findIndex((a) => a.id === physicsStep.id);
            if (idx !== -1) Object.assign(s.actionStream[idx], failActionStep(physicsStep, String(err)));
          });
          return;
        }

        // ── Step 5: Synthesise advisory
        set((s) => { s.currentStep = 'synthesising_advisory'; });
        const advisoryStep = createActionStep('Synthesising AI advisory');
        set((s) => { s.actionStream.push(advisoryStep); });

        try {
          const advisor = await import('@/services/advisor');
          const currentState = get();
          const advisoryResult = await advisor.analyse({
            mode: currentState.mode ?? 'inland',
            userIntent: currentState.userIntent,
            interventionType: effectivePolygon.interventionType,
            interventionAreaHa: effectivePolygon.areaHa,
            assetDescription: assetPin.asset.description,
            physicsResult: currentState.physicsResult!,
            coordinates,
          });

          set((s) => {
            s.advisoryResult = advisoryResult;
            s.currentStep = 'complete';
            const idx = s.actionStream.findIndex((a) => a.id === advisoryStep.id);
            if (idx !== -1) Object.assign(s.actionStream[idx], completeActionStep(advisoryStep, 'Advisory complete'));
            appendEvent(s, 'AdvisorySynthesised', {
              mode: s.advisorMode,
              hasNarrative: !!advisoryResult.narrative,
              scaleWarnings: advisoryResult.scaleWarnings.length,
            });

            // Append the advisory as a chat message
            s.messages.push({
              id: uuidv4(),
              role: 'assistant',
              content: advisoryResult.narrative,
              timestamp: new Date().toISOString(),
              physicsResult: s.physicsResult ?? undefined,
              advisoryResult,
            });
          });
        } catch (err) {
          set((s) => {
            s.currentStep = 'error';
            const idx = s.actionStream.findIndex((a) => a.id === advisoryStep.id);
            if (idx !== -1) Object.assign(s.actionStream[idx], failActionStep(advisoryStep, String(err)));
          });
        }
      },

      // ── CoPilot actions
      appendMessage(msg: ChatMessage) {
        set((state) => {
          state.messages.push(msg);
        });
      },

      // ── Config actions
      configureAdvisor(apiKey?: string, proxyUrl?: string) {
        set((state) => {
          if (apiKey || proxyUrl) {
            state.advisorMode = 'live';
          }
          if (proxyUrl !== undefined) {
            state.proxyUrl = proxyUrl;
          }
        });

        // Side-effect: configure the advisor service (outside immer draft)
        import('@/services/advisor').then((advisor) => {
          advisor.configure({
            apiKey,
            proxyUrl: proxyUrl ?? get().proxyUrl,
          });
        });
      },

      // ── Reset
      resetAnalysis() {
        set((state) => {
          state.mode = null;
          state.currentStep = 'idle';
          state.physicsResult = null;
          state.advisoryResult = null;
          state.opportunityZones = [];
          state.actionStream = [];
          appendEvent(state, 'AnalysisReset', {});
        });
      },
    })),
    {
      // zundo temporal config — limit history to 50 states
      limit: 50,
      // Exclude transient state from undo/redo history
      partialize: (state) => {
        const { actionStream, eventLog, messages, currentStep, ...rest } = state;
        return rest as NatureRiskStore;
      },
    },
  ),
);

// ─── Helpers ────────────────────────────────────────────────────────────────

function mapInterventionToHabitat(
  interventionType: string,
): 'oyster_reef' | 'seagrass' | 'saltmarsh' | 'combined' {
  switch (interventionType) {
    case 'oyster_reef':
      return 'oyster_reef';
    case 'seagrass_meadow':
      return 'seagrass';
    case 'saltmarsh':
      return 'saltmarsh';
    case 'combined_reef_saltmarsh':
      return 'combined';
    default:
      return 'saltmarsh';
  }
}

// ─── Selectors ──────────────────────────────────────────────────────────────

export const selectIsAnalysisRunning = (state: NatureRiskStore): boolean =>
  state.currentStep !== 'idle' &&
  state.currentStep !== 'complete' &&
  state.currentStep !== 'error';

export const selectCanRunAnalysis = (state: NatureRiskStore): boolean =>
  state.assetPin !== null &&
  state.interventionPolygon !== null &&
  state.currentStep === 'idle';

export const selectLatestAdvisory = (state: NatureRiskStore): AdvisoryResult | null =>
  state.advisoryResult;

export const selectEventCount = (state: NatureRiskStore): number =>
  state.eventLog.length;

/** Alias for backward compatibility with components importing `useStore`. */
export const useStore = useNatureRiskStore;

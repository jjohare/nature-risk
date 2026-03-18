// ─── UK Data Connectors — Extended (Natural England + EA Water Quality) ───────
// New live data sources added in addition to the core ukData.ts connectors.
//
// Referenced decisions: ADR-003 (Cloudflare Worker proxy), PRD §6 (data sources)

import { get as idbGet, set as idbSet } from 'idb-keyval';
import type { Coordinates } from '@/types';

// ─── Proxy Base URL ─────────────────────────────────────────────────────────

const PROXY = 'https://nature-risk-proxy.solitary-paper-764d.workers.dev';

// ─── Cache TTLs ─────────────────────────────────────────────────────────────

const TTL_SSSI = 24 * 60 * 60 * 1000;       // 24 hours
const TTL_HABITAT = 24 * 60 * 60 * 1000;    // 24 hours
const TTL_WATER = 4 * 60 * 60 * 1000;       // 4 hours

// ─── Minimal IndexedDB cache helpers ────────────────────────────────────────

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

async function cacheGet<T>(key: string): Promise<T | null> {
  try {
    const entry = await idbGet<CacheEntry<T>>(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) return null;
    return entry.data;
  } catch {
    return null;
  }
}

async function cacheSet<T>(key: string, data: T, ttlMs: number): Promise<void> {
  try {
    const entry: CacheEntry<T> = { data, expiresAt: Date.now() + ttlMs };
    await idbSet(key, entry);
  } catch {
    // IndexedDB unavailable — proceed without caching
  }
}

function snap(v: number): number {
  return Math.round(v * 1000) / 1000;
}

function ck(prefix: string, coords: Coordinates): string {
  return `${prefix}:${snap(coords.lat)}:${snap(coords.lng)}`;
}

// ─── SSSI Result type ───────────────────────────────────────────────────────

export interface SSSIResult {
  withinSSSI: boolean;
  siteNames: string[];
  habitatTypes: string[];
  source: 'live' | 'error';
}

/**
 * Query Natural England's SSSI dataset via the worker proxy.
 * Returns whether the point falls within a Site of Special Scientific Interest.
 */
export async function fetchNaturalEnglandSSSI(coordinates: Coordinates): Promise<SSSIResult> {
  const key = ck('sssi', coordinates);
  const cached = await cacheGet<SSSIResult>(key);
  if (cached) return cached;

  try {
    const params = new URLSearchParams({
      geometry: `${coordinates.lng},${coordinates.lat}`,
      geometryType: 'esriGeometryPoint',
      inSR: '4326',
      spatialRel: 'esriSpatialRelIntersects',
      outFields: 'SSSI_NAME,DESIGNATION,STATUS',
      returnGeometry: 'false',
      f: 'json',
    });
    const url = `${PROXY}/api/natural-england/SSSI_England/FeatureServer/0/query?${params.toString()}`;
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      throw new Error(`Natural England SSSI returned HTTP ${response.status}`);
    }

    const json = await response.json();
    const features: unknown[] = Array.isArray(json?.features) ? json.features : [];

    const siteNames = features.map((f: unknown) => {
      const feat = f as { attributes?: { SSSI_NAME?: string } };
      return feat?.attributes?.SSSI_NAME ?? 'Unknown SSSI';
    });
    const habitatTypes = features.map((f: unknown) => {
      const feat = f as { attributes?: { DESIGNATION?: string; STATUS?: string } };
      return feat?.attributes?.DESIGNATION ?? feat?.attributes?.STATUS ?? '';
    }).filter(Boolean);

    const result: SSSIResult = {
      withinSSSI: features.length > 0,
      siteNames,
      habitatTypes,
      source: 'live',
    };
    await cacheSet(key, result, TTL_SSSI);
    return result;
  } catch {
    return { withinSSSI: false, siteNames: [], habitatTypes: [], source: 'error' };
  }
}

// ─── Priority Habitats Result type ──────────────────────────────────────────

export interface PriorityHabitatsResult {
  habitats: Array<{ type: string; area: string }>;
  source: 'live' | 'error';
}

/**
 * Query Natural England's Priority Habitats dataset via the worker proxy.
 */
export async function fetchPriorityHabitats(coordinates: Coordinates): Promise<PriorityHabitatsResult> {
  const key = ck('priority_habitats', coordinates);
  const cached = await cacheGet<PriorityHabitatsResult>(key);
  if (cached) return cached;

  try {
    const params = new URLSearchParams({
      geometry: `${coordinates.lng},${coordinates.lat}`,
      geometryType: 'esriGeometryPoint',
      inSR: '4326',
      spatialRel: 'esriSpatialRelIntersects',
      outFields: 'Main_Habit,Area',
      returnGeometry: 'false',
      f: 'json',
    });
    const url = `${PROXY}/api/natural-england/NHNE_Priority_Habitats/FeatureServer/0/query?${params.toString()}`;
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      throw new Error(`Priority Habitats returned HTTP ${response.status}`);
    }

    const json = await response.json();
    const features: unknown[] = Array.isArray(json?.features) ? json.features : [];

    const habitats = features.map((f: unknown) => {
      const feat = f as { attributes?: { Main_Habit?: string; Area?: string | number } };
      return {
        type: feat?.attributes?.Main_Habit ?? 'Unknown habitat',
        area: String(feat?.attributes?.Area ?? ''),
      };
    });

    const result: PriorityHabitatsResult = { habitats, source: 'live' };
    await cacheSet(key, result, TTL_HABITAT);
    return result;
  } catch {
    return { habitats: [], source: 'error' };
  }
}

// ─── Water Quality Result type ───────────────────────────────────────────────

export interface WaterQualityResult {
  nearestMeasure: string | null;
  qualityClass: string | null;
  ph: number | null;
  source: 'live' | 'error';
}

/**
 * Query EA Water Quality Archive for the nearest sampling point.
 * First finds the nearest sampling point within 2km, then fetches the latest reading.
 */
export async function fetchWaterQuality(coordinates: Coordinates): Promise<WaterQualityResult> {
  const key = ck('water_quality', coordinates);
  const cached = await cacheGet<WaterQualityResult>(key);
  if (cached) return cached;

  try {
    // Step 1: find nearest sampling point
    const spParams = new URLSearchParams({
      lat: String(coordinates.lat),
      long: String(coordinates.lng),
      dist: '2',
      _limit: '1',
    });
    const spUrl = `${PROXY}/api/ea/water-quality/id/sampling-point?${spParams.toString()}`;
    const spResponse = await fetch(spUrl, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });

    if (!spResponse.ok) {
      throw new Error(`EA Water Quality sampling-point returned HTTP ${spResponse.status}`);
    }

    const spJson = await spResponse.json();
    const items: unknown[] = Array.isArray(spJson?.items) ? spJson.items : (Array.isArray(spJson) ? spJson : []);
    if (items.length === 0) {
      return { nearestMeasure: null, qualityClass: null, ph: null, source: 'live' };
    }

    const sp = items[0] as { '@id'?: string; label?: string; notation?: string };
    const spId = sp['@id'] ?? sp.notation ?? null;
    const spLabel = sp.label ?? spId ?? 'Unknown';

    // Step 2: fetch latest readings for this sampling point
    let ph: number | null = null;
    let qualityClass: string | null = null;

    if (spId) {
      const notation = spId.split('/').pop() ?? spId;
      const readParams = new URLSearchParams({
        samplingPoint: notation,
        _limit: '5',
        _sort: '-sample.sampleDateTime',
      });
      const readUrl = `${PROXY}/api/ea/water-quality/data/measurement?${readParams.toString()}`;
      const readResponse = await fetch(readUrl, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(8000),
      });

      if (readResponse.ok) {
        const readJson = await readResponse.json();
        const measurements: unknown[] = Array.isArray(readJson?.items) ? readJson.items : [];
        for (const m of measurements) {
          const meas = m as { determinand?: { definition?: string; label?: string }; result?: number | string };
          const label = (meas?.determinand?.definition ?? meas?.determinand?.label ?? '').toUpperCase();
          if (label.includes('PH') && meas.result !== undefined) {
            ph = Math.round(Number(meas.result) * 10) / 10;
          }
          if (label.includes('CLASS') && meas.result !== undefined) {
            qualityClass = String(meas.result);
          }
        }
      }
    }

    const result: WaterQualityResult = {
      nearestMeasure: spLabel,
      qualityClass,
      ph,
      source: 'live',
    };
    await cacheSet(key, result, TTL_WATER);
    return result;
  } catch {
    return { nearestMeasure: null, qualityClass: null, ph: null, source: 'error' };
  }
}

# Product Requirements Document

**Product Name:** Nature-Based Risk Mitigation Agent (UK Edition)
**Version:** 1.0 — Master PRD
**Document Status:** Draft
**Date:** 2026-03-17

---

## 1. Product Overview

### Vision
An agentic geospatial engine that quantifies how natural capital interventions — inland and coastal — reduce physical climate risks to specific corporate and infrastructure assets across the UK.

### Problem
Corporations want to invest in nature-based solutions (NbS) but lack tools to prove the direct ROI for their own asset protection. Quantifying the downstream benefit (e.g., specific flood risk reduction, wave attenuation) of a proposed wetland or reef currently requires expensive, months-long environmental consulting studies.

### Solution
A dual-mode AI agent that maps upstream/offshore restoration to downstream/onshore protection using UK-specific hydrological and marine data — compressing a 3-month consultancy engagement into a 15-minute interactive session.

### Target Users
Corporate sustainability teams, risk and resilience officers, infrastructure developers, and ESG investors operating in the UK.

---

## 2. User Personas & Primary Flows

| User Persona | Primary Input | Desired Output |
| :--- | :--- | :--- |
| **Asset Manager (Corporate)** | Drops a pin on their factory, port, or infrastructure asset. | A ranked list of "High-Impact" upstream/offshore restoration sites that would measurably protect that specific asset. |
| **Project Developer (Nature)** | Draws a polygon of a proposed wetland, reef, or saltmarsh. | A list of downstream/onshore assets (roads, towns, factories) that benefit, with quantified risk reduction per asset. |

Both flows converge on a shared output: a directional, evidence-cited pre-feasibility report that supports an investment memo.

---

## 3. Core Agentic Capabilities

**Autonomy Level:** Informational and Analytical Autonomy. The agent independently queries data sources and synthesises results but does not execute real-world actions or financial transactions.

### 3.1 Hydrological Intelligence (Inland)

- **Catchment & Flow Tracing:** Trace flow paths from any UK point using 1m-resolution LIDAR. Validate upstream/downstream connection via OS Open Rivers.
- **Intervention Simulation:** Predict how peak flow (the "flood wave") is delayed or reduced by planting trees (friction coefficient), restoring peat (absorption capacity), or installing leaky dams (storage volume).
- **Water Retention Delta:** Calculate soil-specific retention change using BGS Soilscapes and UKCEH Land Cover baselines; apply localised Met Office rainfall to compute peak flow attenuation.
- **Output:** Estimated reduction in peak flood height (metres) and delay in flood peak (hours) at the target asset.

**Key UK Data Sources:**
| Data Type | Source |
| :--- | :--- |
| Topography & Elevation | OS Data Hub (Terrain 50/5), EA LIDAR Composite (1m/2m) |
| Catchments & Flow | EA Catchment Data Explorer, OS Open Rivers, UKCEH FEH Web Service |
| Soil & Land Cover | BGS Soilscapes, UKCEH Land Cover Map, OS MasterMap |
| Baseline Risk & Climate | EA Risk of Flooding from Rivers and Sea (RoFRS) API, Met Office UKCP18 Projections |

### 3.2 Marine Intelligence (Coastal)

- **Wave Attenuation Modelling:** Model how oyster reefs, seagrass meadows, and saltmarshes reduce wave energy before it reaches sea walls or coastal infrastructure. Query UKHO Bathymetry and Met Office Coastal Models to map underwater slope and dominant wave direction.
- **Erosion Prevention Analysis:** Identify areas where natural capital can stabilise sediment to prevent long-term land loss.
- **Output:** Predicted reduction in wave energy (%) and storm surge height (metres) at the onshore asset; erosion risk delta over a 25-year horizon.

**Key UK Data Sources:**
| Data Type | Source |
| :--- | :--- |
| Bathymetry & Seabed | UKHO ADMIRALTY Marine Data Portal |
| Marine Habitats | Cefas/EA Saltmarsh Extents, Ocean Conservation Trust / Project Seagrass Data |
| Tides, Waves & Erosion | National Tide and Sea Level Facility (NTSLF), Met Office Coastal Models, EA NCERM |

### 3.3 Triage & Advisor Logic (The Brain)

- **Spatial Validation:** Corrects unsuitable intervention placements in real time (e.g., *"This soil type is too thin for reforestation; a leaky dam network would be more effective here"*).
- **Scale Warnings:** Alerts users when a proposed project is too small to produce a statistically significant risk reduction, with a suggested minimum viable area.
- **Mode Routing:** Automatically classifies each query as Inland, Coastal, or Mixed based on the input coordinates, and routes to the correct toolchain. Tool Selection Accuracy target: > 99%.

---

## 4. User Experience & Interaction Design

### 4.1 Core Interface Philosophy
A **"Co-Pilot + Map"** split-screen layout:
- **Left Pane:** Conversational AI interface with structured chat and interactive data widgets.
- **Right Pane:** Dynamic GIS visualisation showing the intervention polygon, target asset, flow paths, risk layers, and delta overlays — updating in real time as the agent completes each step.

### 4.2 Interaction Flows

**Inland Happy Path**
1. User draws a polygon (proposed wetland) and drops a pin (target asset).
2. Agent validates upstream/downstream hydrological connection via OS Open Rivers.
3. Agent calculates water retention delta using BGS Soil data and UKCEH land cover.
4. Agent applies localised Met Office rainfall to compute flow attenuation.
5. Agent outputs: estimated reduction in peak flood height at the asset, with a confidence score and source citations.

**Coastal Happy Path**
1. User draws a polygon (proposed reef/saltmarsh) and drops a pin (onshore asset).
2. Agent queries UKHO Bathymetry and Met Office Coastal Models to map underwater slope and dominant wave direction.
3. Agent calculates wave energy drag created by the new habitat structure.
4. Agent outputs: predicted reduction in wave energy and storm surge height, with UKCP18 sea-level rise factored in and confidence score.

### 4.3 UI Components

- **Action Stream:** A live, collapsing checklist in the chat pane showing the agent's tool activity in real time (e.g., *"Pulling baseline EA RoFRS flood risk... [Done]"*). Collapses once all steps are complete.
- **Interactive Data Widgets:** Rendered cards in the chat displaying:
  - Risk Delta dial (before vs. after intervention)
  - Hydrograph (peak flow over time)
  - Confidence Score badge (Low / Medium / High) with a tooltip citing the underlying data resolution
  - Quantified uncertainty range (e.g., *"Peak flow reduction: 12% ± 3%"*)
- **Export:** One-click PDF report generation containing all outputs, source citations, disclaimers, and confidence scores — formatted for inclusion in a Board-level investment memo.

---

## 5. Guardrails, Safety & Constraints

| Constraint | Specification |
| :--- | :--- |
| **"Not an Engineer" Rule** | Every output must carry a mandatory disclaimer that results are proxy models for directional pre-feasibility decisions, not a substitute for a certified Flood Risk Assessment (FRA), structural engineering survey, or regulated environmental impact assessment. |
| **Zero Hallucination on Geospatial Data** | The LLM must never guess or interpolate topographical or bathymetric data if an API call fails. A `DATA_UNAVAILABLE` error must be surfaced to the user with a clear explanation. |
| **Deterministic Physics Engine** | All quantitative calculations (flow attenuation, wave energy, retention delta) must be routed to a deterministic Python/physics engine — not performed by the LLM directly — to eliminate model-layer arithmetic errors. |
| **Financial & Regulatory Compliance** | The agent must not provide regulated financial advice (FCA compliance), guarantee insurance premium reductions, or certify carbon credit yields. |
| **Dynamic Morphology Disclosure** | For coastal interventions, the agent must clearly state that habitats take years to mature and are subject to storm damage, and must incorporate UKCP18 sea-level rise projections rather than static baselines. |
| **Confidence Scoring** | Every output must feature a transparent Confidence Level (Low / Medium / High) based on the resolution and recency of the available data, with direct links to underlying sources (EA, BGS, UKHO, etc.). |
| **Scientific Footnoting** | Every prediction must cite its primary data source inline (e.g., *"Modelled using EA LIDAR 1m Composite, last updated [date]"*). |

---

## 6. Success Metrics & KPIs

| Category | Metric | Target | Description |
| :--- | :--- | :--- | :--- |
| **Business Impact** | Time-to-Case | < 15 minutes | End-to-end time to produce a shareable pre-feasibility business case (baseline: 3 months via consultancy). |
| **Technical** | End-to-End Latency | < 2 minutes | Time from user prompt submission to final rendered map and chat response. |
| **Technical** | API Success Rate | > 98% | Uptime/reliability of calls to all external UK data sources. |
| **Agentic** | Tool Routing Accuracy | > 99% | Rate at which the agent correctly selects Inland vs. Coastal toolchain from the user's input. |
| **Agentic** | Hallucination Rate | 0% | Automated regression tests confirming the agent never fabricates geospatial or quantitative data. |
| **User Engagement** | Scenarios per Session | > 3 | Indicates the tool is useful enough for iterative parameter tweaking within a single session. |
| **Conversion** | Report Export Rate | > 15% | Percentage of sessions resulting in a PDF report export and/or a formal engineering feasibility study request. |

---

## 7. Phased Product Roadmap

### Phase 1 — Inland MVP (v1.0)
**Focus:** Riverine flood risk in one priority UK catchment (e.g., River Severn or River Thames).
**Capability:** Corporate users drop a pin; agent identifies upstream "Opportunity Zones" for tree planting, peat restoration, and leaky dams, ranked by predicted flood risk reduction at the pin.
**Data Integrations:** EA LIDAR, OS MasterMap, EA RoFRS, OS Open Rivers, BGS Soilscapes.

### Phase 2 — Blue Carbon & Coastal (v1.5)
**Focus:** Coastal surge, erosion, and wave attenuation.
**Capability:** Add "Draw a Reef/Saltmarsh" polygon tool. Integrate UKHO Bathymetry and NTSLF tidal data to model wave energy dissipation and sediment stabilisation. Incorporate UKCP18 sea-level rise scenarios.
**New Data Integrations:** UKHO ADMIRALTY Portal, Cefas Saltmarsh Extents, Met Office Coastal Models, EA NCERM.

### Phase 3 — Financial Layer (v2.0)
**Focus:** Economic ROI and investment-grade outputs.
**Capability:** The agent estimates the **£ GBP value of Avoided Loss** for each protected asset, integrating with insurance loss modelling benchmarks and biodiversity net gain (BNG) unit pricing. Output is a structured investment memo section ready for Board review.
**Goal:** Enable users to move directly from the agent's output to a capital allocation decision.

---

## 8. Open Questions & Assumptions

| # | Question | Owner | Assumed Default |
| :--- | :--- | :--- | :--- |
| 1 | Which UK catchment is the Phase 1 pilot geography? | Product / BD | River Severn (highest corporate flood exposure) |
| 2 | What is the minimum polygon size for a valid intervention? | Science | 0.5 ha (to be validated with environmental scientists) |
| 3 | How frequently should risk baseline data be refreshed from EA APIs? | Engineering | Monthly cache with staleness warnings to users |
| 4 | Is the Phase 3 financial model in-house or via a third-party loss model API (e.g., JBA, Fathom)? | Product | TBD — evaluate JBA Flood Maps API for Phase 3 |
| 5 | Will the agent support non-UK geographies in a future version? | Product | Out of scope for v1.0–v2.0; flag for v3.0 planning |

---

*This document should be reviewed alongside the companion System Prompt specification, which defines the agent's internal reasoning logic, tool-calling schema, and error-handling behaviour.*

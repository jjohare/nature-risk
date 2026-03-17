---

# **Product Requirements Document (PRD)**

**Product Name:** Natural Capital Impact Predictor Agent (UK Edition)

**Document Status:** Draft

**Target Audience:** Corporate sustainability teams, risk and resilience officers, infrastructure developers, and ESG investors.

---

## **1\. Product Overview & Objective**

* **Problem Statement:** Corporations and infrastructure owners want to invest in natural capital and nature-based solutions (NbS) to mitigate physical climate risks. However, quantifying the downstream or onshore ROI (e.g., specific flood risk reduction, wave attenuation) is difficult and typically requires expensive, months-long environmental consulting studies.  
* **Value Proposition:** This AI agent dynamically synthesizes UK-specific geospatial data, climate models, and hydrological principles to provide rapid, localized pre-feasibility predictions of how natural capital interventions impact specific corporate assets.  
* **Core Goal:** To accelerate early-stage investment decisions in natural capital by providing an autonomous, dynamic geospatial analyst.

---

## **2\. Core Agentic Capabilities & Integrations**

**Autonomy Level:** Informational & Analytical Autonomy. The agent independently queries data sources and synthesizes results but does not execute real-world actions or financial transactions.

### **2.1. Inland (Hydrological) Data APIs**

* **Topography & Elevation:** Ordnance Survey (OS) Data Hub (Terrain 50/5), Environment Agency (EA) LIDAR Open Data.  
* **Catchments & Flow:** EA Catchment Data Explorer, OS Open Rivers, UKCEH Flood Estimation Handbook (FEH) Web Service.  
* **Soil & Land Cover:** British Geological Survey (BGS) Soilscapes, UKCEH Land Cover Map.  
* **Baseline Risk & Climate:** EA Risk of Flooding from Rivers and Sea (RoFRS) API, Met Office Weather DataHub (UKCP18 Projections).

### **2.2. Coastal (Marine) Data APIs**

* **Bathymetry & Seabed:** UK Hydrographic Office (UKHO) ADMIRALTY Marine Data Portal.  
* **Marine Habitats:** Cefas/EA Saltmarsh Extents, Ocean Conservation Trust / Project Seagrass Data.  
* **Tides, Waves & Erosion:** National Tide and Sea Level Facility (NTSLF), Met Office Coastal Models, EA National Coastal Erosion Risk Mapping (NCERM).

---

## **3\. User Experience & Interaction Flow**

**Core UI Philosophy:** A "Co-Pilot \+ Map" split-screen interface combining conversational AI (left pane) with a dynamic GIS visualization (right pane).

### **3.1. Primary Use Cases (Happy Paths)**

* **Inland Scenario:** 1\. User inputs a proposed wetland intervention (draws a polygon) and target asset (drops a pin).  
  2\. Agent validates upstream/downstream connection via OS Open Rivers.  
  3\. Agent calculates water retention delta based on BGS Soil data and current UKCEH land cover.  
  4\. Agent applies localized Met Office rainfall data to calculate delayed water flow (attenuation).  
  5\. Agent outputs the estimated reduction in peak flood height at the asset.  
* **Coastal Scenario:**  
  1. User inputs a proposed offshore intervention (e.g., native oyster reef/seagrass) and onshore asset (e.g., sea wall or port).  
  2. Agent queries UKHO Bathymetry and Met Office Coastal Models to map underwater slope and dominant wave direction.  
  3. Agent calculates wave attenuation (energy drag) created by the new habitat structure.  
  4. Agent outputs the predicted reduction in wave energy and storm surge height hitting the onshore asset.

### **3.2. Interface Elements**

* **Action Stream:** A live, collapsing checklist in the chat showing the agent's internal tool usage (e.g., *"Pulling baseline EA RoFRS flood risk... \[Done\]"*).  
* **Interactive Data Widgets:** Rendered cards in the chat showing visual dials for Risk Delta, Hydrographs, and calculated confidence scores.

---

## **4\. Guardrails, Safety & Constraints**

* **The "Not an Engineer" Rule:** Every output must include a mandatory disclaimer that these are proxy models for directional decision-making, not a substitute for a certified Flood Risk Assessment (FRA) or structural engineering survey.  
* **Zero-Shot Math & Hallucination Prevention:** The LLM must not guess topographical or bathymetric data if an API fails. It must trigger a Data\_Unavailable error. Furthermore, the LLM must route calculations to a deterministic Python/physics engine rather than performing complex math itself.  
* **Financial Compliance:** The agent will not provide regulated financial advice (FCA compliance), guarantee commercial insurance premium adjustments, or certify carbon credit yields.  
* **Dynamic Morphology & Climate Change:** For coastal projects, the agent must clearly state that habitats take years to mature and are subject to winter storm damage. The agent must also factor in UKCP18 sea-level rise projections rather than assuming static baselines.  
* **Confidence Scoring:** Every output must feature a transparent Confidence Level (Low/Medium/High) based on the resolution of the available data, with cited links to the underlying sources (e.g., BGS, EA).

---

## **5\. Success Metrics & KPIs**

| Metric Category | Specific Metric | Target / Goal | Description |
| :---- | :---- | :---- | :---- |
| **Technical** | End-to-End Latency | \< 2 minutes | Time from user prompt to final rendered map and chat response. |
| **Technical** | API Success Rate | \> 98% | Tracking the failure rate of calls to external UK data sources. |
| **Agentic** | Tool Selection Accuracy | \> 99% | Rate at which the LLM correctly chooses between River vs. Coastal tools based on the prompt. |
| **Agentic** | Hallucination Rate | 0% | Automated testing to ensure the agent never fabricates geospatial data. |
| **Business/UX** | Scenarios per User | \> 3 per session | Indicates the tool is useful enough for iterative parameter tweaking. |
| **Business/UX** | Conversion Rate | \> 15% | Percentage of users who export the report and request a formal engineering feasibility study. |

---


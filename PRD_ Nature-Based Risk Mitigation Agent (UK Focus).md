---

# **PRD: Nature-Based Risk Mitigation Agent (UK Focus)**

## **1\. Product Overview**

* **Vision:** An agentic geospatial engine that quantifies how natural capital interventions (inland and coastal) reduce physical risks to specific corporate and infrastructure assets.  
* **Problem:** Corporations want to invest in nature but lack the tools to prove the direct ROI of "Nature-Based Solutions" (NbS) for their own asset protection.  
* **The Solution:** A dual-input agent that maps upstream/offshore restoration to downstream/onshore protection using UK-specific hydrological and marine data.

---

## **2\. Target Audience & User Flows**

| User Persona | Primary Action (Input) | Desired Outcome (Output) |
| :---- | :---- | :---- |
| **Asset Manager (Corporate)** | Drops a pin on their factory/asset. | A list of "High Impact" restoration sites that would protect that specific pin. |
| **Project Developer (Nature)** | Draws a polygon of a proposed wetland/reef. | A list of downstream assets (roads, towns, factories) that benefit from the intervention. |

---

## **3\. Agent Capabilities**

### **A. The "Hydrological Intelligence" (Inland)**

* **Catchment Analysis:** Trace "Flow Paths" from any point in the UK using 1m-resolution LIDAR data.  
* **Intervention Simulation:** Predict how peak flow (the "flood wave") is delayed or reduced by planting trees (friction) or restoring peat (absorption).

### **B. The "Marine Intelligence" (Coastal)**

* **Wave Attenuation:** Model how oyster reefs, seagrass meadows, or saltmarshes reduce wave energy before it hits sea walls or coastal infrastructure.  
* **Erosion Prevention:** Identify areas where natural capital can stabilize sediment to prevent long-term land loss.

### **C. The "Triage & Advisor" Logic (The Brain)**

* **Spatial Validation:** Corrects users who try to place interventions in unsuitable habitats (e.g., "This soil type is too thin for reforestation; try a leaky dam").  
* **Scale Warnings:** Alerts users if a proposed project is too small to provide a statistically significant reduction in risk.

---

## **4\. Key UK Datasets**

To ensure scientific credibility, the agent queries:

* **Terrain:** EA LIDAR Composite (1m/2m) & OS Terrain 5\.  
* **Water:** EA Risk of Flooding (RoFRS) & National River Flow Archive.  
* **Coastal:** UKHO Bathymetry & National Network of Regional Coastal Monitoring.  
* **Land Use:** OS MasterMap & UKCEH Land Cover Maps.

---

## **5\. Success Metrics & Guardrails**

* **KPI:** **"Time-to-Case":** Reduce the time to build a restoration business case from 3 months (consultancy) to 15 minutes (agent).  
* **Scientific Footnoting:** Every prediction must cite its data source (e.g., *"Modelled using JBA Flood Maps"*).  
* **Uncertainty Disclosure:** The agent must display a confidence interval (e.g., *"This wetland reduces peak flow by 12% ± 3%"*).

---

## **Proposed Product Roadmap**

### **Phase 1: The "Inland MVP" (v1.0)**

* **Focus:** Riverine flood risk in one specific UK catchment (e.g., The Thames or The Severn).  
* **Capability:** Corporate users drop a pin; agent identifies upstream "Opportunity Zones" for tree planting and leaky dams.  
* **Data:** Integration with EA LIDAR and OS MasterMap.

### **Phase 2: The "Blue Carbon & Coastal" Update (v1.5)**

* **Focus:** Coastal surge and erosion.  
* **Capability:** Add "Draw a Reef/Saltmarsh" functionality. Integration with UKHO Bathymetry data to show wave energy dissipation.

### **Phase 3: The "Financial Layer" (v2.0)**

* **Focus:** Economic ROI.  
* **Capability:** The agent estimates the **£ GBP value** of the "Avoided Loss" for the asset, helping the user write the final investment memo for their Board of Directors.

---

**Would you like me to draft a sample "System Prompt" that tells the AI exactly how to act as this Geospatial Agent?** (This would be the actual "code" for the agent's personality and logic.)


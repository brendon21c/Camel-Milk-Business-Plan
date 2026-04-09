# Product Roadmap — Business Viability Intelligence System

**Author:** Brendon McKeever  
**Last updated:** 2026-04-09

---

## Phase Overview

| Phase | Scope | Status |
|---|---|---|
| V1 | Physical import/export — any product, food-biased gov data | In progress (end-to-end test next) |
| V2 | Any physical product, any industry — adaptive research | Planned |
| V3 | General business ventures — SaaS, services, digital, franchise | Future |

The foundation (WAT architecture, agent pipeline, PDF delivery) carries through all phases unchanged. Each phase adds capability on top without rebuilding from scratch.

---

## V1 — Physical Import/Export (Current)

**Scope:** Physical goods moving from an origin country to a target market. First proposition: camel milk powder, Somalia → US.

**What works for any physical product:**
- All 10 research agents (market, competitors, regulatory, production, packaging, distribution, marketing, financials, origin ops, legal)
- Brave Search + Perplexity (general-purpose — industry-agnostic)
- SEC EDGAR, USASpending, Census (industry-agnostic government data)
- Venture intelligence + landscape briefing (makes agents adapt to the venture type)
- PDF report, Supabase Storage, Resend email delivery

**What is food/agriculture biased:**
- `fetch_fda_data.py` — FDA food enforcement + adverse events (food/drug only)
- `fetch_usda_data.py` — USDA FoodData Central + NASS QuickStats (agriculture only)
- Regulatory workflow Step 1b — explicitly calls FDA/USDA

**Current workaround:** The venture intelligence brief tells agents which agencies are relevant. A solar-panel proposition gets DOE/EPA framing from the brief; agents naturally skip FDA/USDA calls. This works but is not structurally enforced.

**Remaining task:** End-to-end test.
```
node run.js --proposition-id 54f51272-d819-4d82-825a-15603ed48654 --force
```

---

## V2 — Any Physical Product, Any Industry

**Goal:** A client with any physical-goods idea (solar panels, apparel, medical devices, electronics, cosmetics, industrial equipment) gets a complete viability analysis with the right data sources for their industry — without any manual workflow changes.

### Key changes required

#### 1. Industry-aware government data routing

Replace the flat `executeTool` switch statement with a routing layer that selects the right gov APIs based on the proposition's industry:

| Industry category | Relevant gov sources |
|---|---|
| Food / beverage | FDA (openFDA), USDA FoodData Central, USDA NASS |
| Agriculture / commodities | USDA NASS, USDA ERS, FDA |
| Energy / clean tech | DOE (NREL, EIA), EPA, ITC |
| Medical devices / health | FDA (device enforcement), CMS, NIH |
| Chemicals / materials | EPA, OSHA, TSCA |
| Electronics / tech hardware | FCC, ITC, BIS (export controls) |
| Apparel / textiles | CBP, FTC (labelling), CPSC |
| Cosmetics / personal care | FDA cosmetics, CPSC |
| General manufacturing | EPA, OSHA, ITC, Census CBP |
| All categories | SEC EDGAR, USASpending, Census (always included) |

Implementation: add an `industry_category` field to propositions. The `executeTool` dispatcher checks this field and routes to the correct Python scripts. Non-applicable tools return a structured "not applicable" response so agents don't waste iterations.

#### 2. New government data tools (build as needed per industry)

| Tool | Source | Priority |
|---|---|---|
| `fetch_doe_data.py` | DOE EIA energy statistics, NREL clean energy data | High (energy/solar) |
| `fetch_epa_data.py` | EPA regulatory database, enforcement actions | High (chemicals, manufacturing) |
| `fetch_fda_device_data.py` | FDA 510(k) clearances, device recalls | High (medical) |
| `fetch_itc_data.py` | ITC trade remedy cases, import injury reports | Medium (any import) |
| `fetch_bls_data.py` | BLS industry employment, wage benchmarks | Medium (labour cost research) |
| `fetch_bis_data.py` | BIS export control classifications (ECCN) | Medium (tech/defence-adjacent) |

#### 3. Proposition intake enrichment

Add `industry_category` to the intake CLI and DB schema:
```
node tools/intake.js --name "..." --email "..." --product "Solar panels" \
  --industry-category "energy" --origin "China" --target "US"
```

New migration: `006_add_industry_category.sql`
```sql
ALTER TABLE propositions ADD COLUMN industry_category TEXT;
```

#### 4. Workflow generalisation

Audit the 10 research workflows and remove food-specific language. The regulatory workflow's Step 1b should reference the `industry_category` to pick the right tool calls, rather than hardcoding FDA/USDA.

Option A (simpler): Keep workflows generic, rely on venture intelligence brief to steer tool selection.  
Option B (more robust): Add an `industry_category` substitution block at the top of each workflow that lists the applicable gov tools for this run.

Recommendation: Start with Option A (already partially working via venture intelligence) and move to Option B if Option A produces poor results for non-food industries.

#### 5. Test propositions to validate V2

| Proposition | Industry category | Key non-food tools needed |
|---|---|---|
| Solar panels, China → US | energy | DOE EIA, EPA, ITC |
| Apparel / activewear, Bangladesh → US | apparel | CBP, FTC, CPSC |
| Medical diagnostic device, Germany → US | medical | FDA device, CMS |
| Consumer electronics, Taiwan → US | electronics | FCC, BIS, ITC |

---

## V3 — General Business Ventures

**Goal:** Any business idea — SaaS, services, digital products, franchises, marketplaces — gets a tailored viability analysis with the right research dimensions for that venture type.

### Why V3 is a separate phase

Physical products share a common research spine: supply chain, regulatory import path, production, distribution, packaging. The 10-agent set maps cleanly onto this.

Non-physical ventures need different dimensions:
- **SaaS:** TAM/SAM/SOM, pricing benchmarks, churn/LTV/CAC, competitive feature matrix, integration ecosystem, developer tools landscape — no supply chain, no import regulatory path
- **Services business:** Labour market, licensing/credentialing, client acquisition, capacity model, geographic territory — no product manufacturing
- **Marketplace / platform:** Network effects, liquidity strategy, take-rate benchmarks, regulatory (payments, data, gig economy) — fundamentally different unit economics
- **Franchise:** Brand strength, territory analysis, FDD review, unit-level P&L benchmarks, support quality — requires franchise-specific data sources

### Key changes required for V3

#### 1. New workflow sets per venture type

Each venture type needs its own set of research workflows. The agent names may change (e.g. `research_acquisition.md` instead of `research_origin_ops.md` for a SaaS).

| Proposition type | Core research dimensions |
|---|---|
| `saas_software` | Market sizing, competitive landscape, pricing, unit economics, technical feasibility, go-to-market, legal (IP/data) |
| `service_business` | Market demand, labour/credentialing, competitive landscape, pricing, client acquisition, financials, legal |
| `digital_product` | Market sizing, competitive landscape, monetisation model, distribution/platform, marketing, financials, legal |
| `franchise` | Brand strength, territory analysis, FDD review, unit economics, support quality, legal |
| `marketplace` | Liquidity strategy, network effects, take-rate, regulatory (payments/gig), competitive, financials |

#### 2. Dynamic agent selection

Not all 10 agents are relevant for every venture type. V3 introduces an agent manifest per proposition type:

```javascript
const AGENT_MANIFEST = {
  physical_import_export: ['market_overview', 'competitors', 'regulatory', 'production',
                           'packaging', 'distribution', 'marketing', 'financials', 'origin_ops', 'legal'],
  saas_software:          ['market_overview', 'competitors', 'regulatory', 'pricing',
                           'unit_economics', 'go_to_market', 'technical', 'financials', 'legal'],
  service_business:       ['market_overview', 'competitors', 'regulatory', 'labour',
                           'pricing', 'acquisition', 'financials', 'legal'],
};
```

`runResearchAgents()` reads the manifest for the proposition type and only runs the relevant agents.

#### 3. New data sources for non-physical ventures

| Source | Venture types | Notes |
|---|---|---|
| Crunchbase (paid) | SaaS, marketplace | Funding data, competitive landscape |
| G2 / Capterra | SaaS | User reviews, competitive positioning |
| SBA loan data | All SMB | Small business benchmarks |
| BLS Occupational Employment | Services | Labour cost benchmarks |
| App store analytics | Digital product | Download/revenue estimates |
| FTC franchise data | Franchise | FDD filings, enforcement history |

#### 4. Proposition intake for V3

The intake form needs to capture the right metadata per venture type. A SaaS proposition needs target customer segment, pricing model, and technical stack — not origin country and product weight.

Likely implementation: `intake.js` branches on `--proposition-type` and prompts for the relevant fields.

---

## Architectural principles that carry through all phases

1. **WAT stays intact.** Workflows → Agents → Tools. Adding a new industry or venture type means adding new workflow markdown files and optionally new tool scripts. The orchestrator (`run.js`) changes minimally.

2. **Venture intelligence scales.** The Perplexity venture intelligence brief already partially bridges the gap between phases. As new proposition types are added, the brief's framing improves the output even before dedicated workflow sets exist.

3. **Model tiers hold.** Haiku for research agents (fast, narrow), Sonnet for assembly (synthesis). Escalation to Sonnet on failure. This holds for all venture types.

4. **Delivery pipeline is unchanged.** PDF → Supabase Storage → Resend email. The report format may grow more sections, but the delivery mechanism stays the same.

5. **New propositions = new DB rows, not new code** (as much as possible). The goal in V2/V3 is that adding a new industry or venture type only requires new workflow markdown files and possibly one new tool script — not a rewrite of the orchestrator.

---

## Decision log

| Decision | Outcome | Rationale |
|---|---|---|
| V2 before V3 | Physical products first | Shared research spine (supply chain, regulatory, manufacturing) makes generalisation lower risk |
| Venture intelligence as bridge | Implement now, rely on it for V2 | Perplexity brief already makes agents adapt to industry — reduces workflow rewrite scope |
| Option A workflow generalisation | Start with brief-driven adaptation | Less work, test it before committing to per-industry workflow blocks |
| Industry category field | Add in migration 006 | Clean DB signal for gov tool routing — better than inferring from product description |

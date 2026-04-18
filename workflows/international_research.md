# Workflow: International & Multilingual Research

**Purpose:** Define how to discover, retrieve, and process business research data from non-English sources when analyzing markets outside English-speaking countries.

**When to use:** Any time the target market or origin country has a primary language other than English, or when English-language sources are likely to be secondhand summaries of local reporting (e.g. Japan, UAE, Germany, Brazil, South Korea).

**Translation approach:** Agents handle translation directly using their own language capabilities. No external translation API is needed. When you encounter a non-English source, translate the relevant passage yourself before incorporating it into your output.

---

## Inputs Required

| Input | Description | Example |
|---|---|---|
| `target_country` | Country being researched | `"UAE"` |
| `target_language` | Primary language of that market | `"Arabic"` |
| `origin_country` | Product origin country (may also be non-English) | `"Somalia"` |
| `origin_language` | Primary language of origin country | `"Somali"` |
| `research_topic` | The research dimension being investigated | `"regulatory"`, `"market_overview"`, `"competitors"` |
| `keywords_en` | English-language search terms for the topic | `["camel milk import", "halal dairy UAE"]` |

---

## Pipeline Steps

### Step 1 — Generate Search Queries in Target Language

Before searching, translate the core research keywords into the target language yourself. Run searches in both English and the target language — local-language queries surface primary-source documents (government portals, local trade publications, regional databases) that never appear in English search results.

**Example:** A search for "camel milk regulations" in Arabic (`لوائح حليب الإبل`) will surface UAE Ministry of Health portals and Arabic trade publications that English queries miss entirely.

**For each research topic, generate:**
- 2–3 English search queries (standard)
- 2–3 queries in the target country's primary language
- Use country TLD operators in Brave to prioritise local sources: `site:.ae`, `site:.de`, `site:.jp`, `site:.br`

**Low-resource languages (e.g. Somali, Tigrinya):** If the origin country's language has limited web presence, prioritise English, French, or Arabic secondary sources for that market instead. Note this limitation in `data_gaps`.

---

### Step 2 — Discover Sources (Targeted by Country + Language)

Run searches using both English and target-language keywords.

**Tools to call:**

| Tool | Call pattern | Notes |
|---|---|---|
| `tools/search_brave.py` | Native language query + `site:.[country_tld]` operator | Primary discovery tool |
| `tools/search_perplexity.py` | "Find primary sources in [language] about [topic] in [country]. Prioritize government portals and local trade associations." | Good for multilingual synthesis and discovery |
| `tools/fetch_gdelt_news.py` | Query by country + keyword | Free global news in 65+ languages, updated every 15 min |

**Note on Perplexity:** Use for discovery and framing ("what are the main regulatory bodies for dairy imports in the UAE?") then use dedicated tools for verification with live data. Perplexity is discovery; APIs are ground truth.

---

### Step 3 — Translate Retrieved Content

When you retrieve a non-English source, translate the relevant passage directly. Do not pass untranslated text to your output.

**What to translate:** Only the portions relevant to the research question — a headline, a key regulatory clause, a price figure with context. You do not need to translate entire documents.

**Tagging requirement:** Each finding that came from a translated source must be tagged in your output notes:
```
[SOURCE: Al Khaleej Times | Language: Arabic | Translated by agent | Date: 2026-04-10]
```

This lets the assembler and consultant brief flag which findings rest on translated evidence.

**When translation is uncertain:** If you are not confident in a translation (e.g. highly technical legal text, specialised industry terminology in a low-resource language), include your best translation and flag it explicitly:
```
[TRANSLATION UNCERTAIN — technical legal text in Somali. Best effort translation below. Recommend native-speaker review before acting on this finding.]
```

---

### Step 4 — Normalize Translated Content

After translating, standardize formats before incorporating into your output:

| Field | Issue | Normalization |
|---|---|---|
| Dates | `DD.MM.YYYY` (EU), Hijri calendar (Gulf) | Convert to `YYYY-MM-DD` ISO format |
| Currency | Local currency amounts (AED, EUR, JPY, etc.) | Retain original + note approximate USD equivalent |
| Numbers | European format: `1.234,56` vs US: `1,234.56` | Normalize to standard numeric format |
| Company names | Local-script names alongside romanized | Keep both; use romanized in main text |

---

### Step 5 — Pass Translated Content to Research Agent

Translated, normalized content is treated identically to English-language source material. Incorporate it into your standard research output as you would any English source.

**Countries with multiple official languages:** Search and translate in all official languages (e.g. Belgium: Dutch + French + German). Tag findings by source language — conflicts between language versions can be significant.

---

### Step 6 — Flag Translation Gaps in Output

At the end of any research run that involved non-English sources, include a translation notes section in `data_gaps`:

```
Translation notes:
- X sources retrieved in [language], translated by agent
- Y sources could not be accessed (paywall / authentication required)
- Z findings flagged as uncertain due to complex technical terminology
- Key findings from translated sources only: [brief bullet list]
```

---

## Source Discovery Tools

| Tool | Free | Notes |
|---|---|---|
| `tools/search_brave.py` | Yes (key required) | Supports any language query; use country TLD operators |
| `tools/search_perplexity.py` | No (key required) | Strong multilingual synthesis; use for discovery |
| `tools/fetch_gdelt_news.py` | Yes (no key) | Global news, 65+ languages, 170 countries |
| `tools/fetch_world_bank.py` | Yes (no key) | Economic indicators, all countries |
| `tools/fetch_imf_data.py` | Yes (no key) | Macroeconomic indicators, all countries |
| `tools/fetch_fao_data.py` | Yes (no key) | Food/agriculture data, global |
| `tools/fetch_wto_data.py` | Yes (no key) | Tariff and trade data, all WTO members |

---

## Edge Cases

| Situation | How to handle |
|---|---|
| Low-resource language with poor web presence | Prioritise English and French secondary sources; note limitation in `data_gaps` |
| Source requires local account authentication | Note the URL, log in `data_gaps`, flag for manual follow-up if authoritative |
| Translation confidence is low (technical/legal text) | Include best-effort translation, tag `[TRANSLATION UNCERTAIN]`, recommend native review |
| Country uses multiple official languages | Search and translate in all; tag findings by source language |
| All local-language queries return no results | Continue with English queries only; note "local-language sources unavailable" in `data_gaps` |

---

## Output

Each research agent that runs with this workflow produces:
- Standard research output (same format as English-language runs)
- Source tags on any translated findings (`[SOURCE | Language | Translated by agent | Date]`)
- Translation gap flags in `data_gaps` for uncertain or inaccessible sources

The assembler treats translated sources identically to English sources in the main report. Translation notes surface in the consultant brief's "Where the data was thin" section.

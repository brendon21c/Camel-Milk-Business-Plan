# Workflow: International & Multilingual Research

**Purpose:** Define how to discover, retrieve, translate, and normalize business research data from non-English sources when analyzing markets outside English-speaking countries.

**When to use:** Any time the target market or origin country has a primary language other than English, or when English-language sources are likely to be secondhand summaries of local reporting (e.g. Japan, UAE, Germany, Brazil, South Korea).

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

### Step 1 — Translate Keywords Into Target Language

Before searching, translate the core research keywords into the target language. This ensures you're finding primary-source documents, not just English-language coverage of the market.

**Tool:** `tools/translate_text.py`  
**Input:** `keywords_en`, `target_language`  
**Output:** `keywords_translated` — the same keywords in the target language  

**Why this matters:** A search for "camel milk regulations" in Arabic (`لوائح حليب الإبل`) will surface UAE government portals and Arabic trade publications that never appear in English search results.

---

### Step 2 — Discover Sources (Targeted by Country + Language)

Run searches using both English and translated keywords. Use country-specific operators to prioritize local sources.

**Tools to call (in parallel):**

| Tool | Call pattern | Notes |
|---|---|---|
| `tools/search_brave.py` | `site:.ae` / `site:.de` / `site:.jp` operator + translated keyword | Country TLD targeting |
| `tools/search_perplexity.py` | Prompt: "Find primary sources in [language] about [topic] in [country]. Prioritize government portals, local trade associations, and local news." | Perplexity handles multilingual synthesis well |
| GDELT API (future: `tools/fetch_gdelt_news.py`) | Query by country + keyword, return news events in local language | Free global news firehose |
| OpenCorporates API (future: `tools/fetch_opencorporates.py`) | Company lookup by jurisdiction | Returns local-language records for 140+ countries |

**Note on Perplexity's role here:** Use Perplexity for discovery and framing — "what are the main regulatory bodies for dairy imports in the UAE?" — then use dedicated tools for verification with live data. Perplexity is discovery; APIs are ground truth.

---

### Step 3 — Detect Language of Retrieved Content

Before processing scraped or returned text, detect its language. Do not assume all content from a given country is in one language — the UAE has Arabic, English, and Urdu content; Switzerland has German, French, and Italian.

**Tool:** Python library — `lingua-py` (offline, no API cost)  
**Input:** raw text block  
**Output:** `detected_language` (ISO 639-1 code, e.g. `"ar"`, `"de"`, `"ja"`)  

**Decision logic:**
- If `detected_language == "en"` → skip translation, pass directly to extraction
- If `detected_language != "en"` → route to Step 4
- If detection confidence < 0.75 → flag as uncertain, include in outputs but mark for review

---

### Step 4 — Translate Retrieved Content to English

Translate non-English source material to English before passing it to any analysis agent.

**Routing logic — pick translation service based on language:**

| Language group | Recommended service | Reason |
|---|---|---|
| European (DE, FR, ES, IT, PT, NL, PL, RU) | DeepL API | Best quality for European business/legal text |
| Arabic, Hebrew, Turkish, Persian | Google Cloud Translation | Broader coverage, stronger on RTL languages |
| Chinese (Simplified/Traditional), Japanese, Korean | Google Cloud Translation | Stronger CJK support |
| Other / low-resource languages | Google Cloud Translation | Broader language coverage |
| Short passages needing cultural nuance | Claude directly | Slower/pricier but handles idiom and context |

**Tool:** `tools/translate_text.py` (handles routing logic above based on `source_language`)  
**Input:** raw text + `source_language` (from Step 3)  
**Output:** translated English text + metadata (`source_language`, `translation_service_used`, `char_count`)

**Confidence note:** Store `source_language` and `translation_service_used` in source metadata. If a finding is later questioned, you need to know it came from a machine-translated Arabic government document vs. an original English report.

---

### Step 5 — Normalize Translated Content

After translation, standardize data formats that vary by country before passing to extraction.

**Normalizations to apply:**

| Field | Issue | Normalization |
|---|---|---|
| Dates | `DD.MM.YYYY` (EU), `YYYY年MM月DD日` (JP), Hijri calendar (Gulf) | Convert all to `YYYY-MM-DD` ISO format |
| Currency | Local currency amounts (AED, EUR, JPY, etc.) | Retain original + append USD equivalent at time of research. Note the conversion date. |
| Numbers | European format: `1.234,56` vs US: `1,234.56` | Normalize to standard numeric format |
| Units | Metric vs. imperial, local weight units | Convert to metric and note original |
| Company names | Local-script names alongside romanized | Keep both; use romanized in main text |

**Tool:** `tools/normalize_international_data.py` (future — build when non-English pipeline is first used)

---

### Step 6 — Pass Normalized English Content to Research Agent

The translated, normalized content is now treated identically to English-language source material. Pass it to the relevant research workflow (market_overview, regulatory, competitors, etc.) as part of the standard context.

**Tagging requirement:** Each translated source must carry metadata in the context passed to the agent:
```
[SOURCE: Al Khaleej Times | Language: Arabic | Translated: DeepL | Date: 2026-04-10 | Confidence: High]
```

This lets the agent reason about source provenance and flag uncertainty when translated sources conflict with English ones.

---

### Step 7 — Flag Translation Gaps in Output

At the end of any research run that involved translation, the agent must include a "Translation & Source Notes" block in its output:

```
Translation notes:
- X sources retrieved in [language], translated via [service]
- Y sources could not be retrieved (paywall / authentication required)
- Z sources flagged as uncertain due to low detection confidence
- Key findings from translated sources: [bullet list of translated-only findings]
```

This surfaces to the assembler agent and eventually the consultant brief — so you know which parts of the analysis rest on translated evidence.

---

## APIs & Services — Costs and Setup

### Translation

| Service | Free Tier | Paid Rate | Best For | Sign Up |
|---|---|---|---|---|
| **DeepL API** | 500,000 chars/month | $25 per 1M chars (Pro) | European languages, formal/legal text | deepl.com/pro-api |
| **Google Cloud Translation** | 500,000 chars/month | $20 per 1M chars | Arabic, CJK, broad coverage | console.cloud.google.com |
| **MyMemory API** | 5,000 chars/day (no key) / 10,000 with free key | Contact for paid | Low-volume fallback, 70+ languages | mymemory.translated.net |
| **LibreTranslate** | Self-hosted: free | Hosted API: ~$0.01/1k chars | Open-source fallback, no data privacy concerns | libretranslate.com |

**Recommendation:** Start with DeepL free tier + Google Cloud free tier. Combined that's 1M chars/month before any cost. A typical research run translating 10 sources at ~2,000 chars each = 20,000 chars. You'd need 50 international runs/month to hit the free cap.

### Language Detection (No API needed)

| Library | Cost | Language Support | Install |
|---|---|---|---|
| **lingua-py** | Free, offline | 75 languages, high accuracy on short text | `pip install lingua-language-detector` |
| **langdetect** | Free, offline | 55 languages, fast | `pip install langdetect` |
| **fastText LID model** | Free, offline | 176 languages (Meta's model) | Download `lid.176.bin` from fastText site |

**Recommendation:** `lingua-py` for production use — better accuracy on short excerpts (headers, captions, partial page scrapes) than `langdetect`.

### International News & Source Discovery

| Service | Free Tier | Paid | Notes |
|---|---|---|---|
| **GDELT Project** | Fully free | N/A | Global news events, 170 countries, 65 languages. Structured event data updated every 15 min. No API key needed. |
| **MediaStack** | 500 requests/month | From $9.99/month | 7,500+ news sources, 50+ countries, multilingual |
| **NewsAPI** | 100 req/day (dev) | From $449/month | ~80,000 sources, international. Dev plan sufficient for testing. |
| **Event Registry** | 50 req/day free | From $99/month | Multilingual news, good for market research |

**Recommendation:** Start with GDELT (fully free, no key) for international news discovery. Add MediaStack paid tier only if GDELT event data proves insufficient for a specific market.

### International Business & Trade Data

| Service | Free Tier | Notes |
|---|---|---|
| **OpenCorporates API** | Free (rate limited) | 160M+ company records, 140+ jurisdictions, local-language records |
| **UN Comtrade** | Free with registration | International trade flow data, all countries |
| **World Bank Open Data API** | Fully free | Economic indicators, all countries, multiple languages |
| **IMF Data API** | Fully free | Macroeconomic/financial indicators |
| **OECD API** | Fully free | OECD member country stats, often available in French/German |
| **Eurostat API** | Fully free | EU statistical office, data in all EU languages |
| **FAO STAT API** | Fully free | Food and agriculture data, global |

All of the above are free and require only registration (no payment). UN Comtrade is particularly useful for import/export propositions — it tracks bilateral trade flows at the product level (HS code) between any two countries.

---

## Error Handling & Failure Retries

The goal when something fails is to **preserve what already worked, skip what can't be recovered cheaply, and never restart a run from scratch**. Every failure should be scoped as tightly as possible before deciding what to do next.

---

### General Principles

**1. Fail at the source level, not the run level.**
If one source can't be translated, skip that source and continue. If one API is down, fall back to the next option. A failure at Step 4 for a single document should never abort a run that has already completed Steps 1–3 for 10 other sources.

**2. Never retry a paid API call without diagnosing first.**
Translation API calls cost money. Before retrying any failed translation call, read the error. A 429 (rate limit) calls for a wait-and-retry. A 400 (bad request) means the input is malformed — retrying immediately burns quota without fixing anything.

**3. Cache what you've already translated.**
Any text that has been successfully translated should be written to `.tmp/` immediately — before the agent processes it. If the agent fails later, the translated content is already on disk and doesn't need to be re-translated on the next run. Translation cost should be paid once per source per run.

**4. Degrade gracefully, report honestly.**
A run with partial translated coverage is better than a failed run. If 3 of 10 targeted local-language sources couldn't be processed, deliver the analysis based on the 7 that worked and flag the gaps clearly. Don't abort a $10 run because one Arabic PDF was unreadable.

---

### Failure Handling by Step

**Step 1 — Keyword translation fails**

| Error type | Action |
|---|---|
| API timeout | Wait 5 seconds, retry once. If it fails again, proceed with English keywords only and note "local-language keyword translation unavailable" in Step 7 output. |
| Rate limit (429) | Log remaining quota. If quota is exhausted for the month, fall back to MyMemory API (free, lower quality). Log the fallback. |
| Language not supported | Use English keywords only. Note the limitation. Do not abort. |

English-only keywords still work — they just produce less local coverage. The run continues.

---

**Step 2 — Source discovery fails**

| Error type | Action |
|---|---|
| Brave Search API down | Fall back to Perplexity for source discovery. Log that Brave was unavailable. |
| Perplexity API down | Use Brave only. If both are down, note "discovery limited to cached/prior sources" and continue with whatever was already retrieved. |
| GDELT API timeout | Skip GDELT for this run. It's a supplemental source — its absence doesn't block the run. |
| OpenCorporates rate limit | Cache the response you have. Do not retry until the rate limit window resets (1 hour). Log the gap. |

Never spin up extra Brave or Perplexity calls to compensate for one tool's failure. One tool down = note the gap and move on.

---

**Step 3 — Language detection returns low confidence**

- If confidence < 0.75 → do not abort. Proceed with translation anyway, but tag the source `[LANGUAGE UNCERTAIN]` in metadata.
- If detection fails entirely (exception) → default to translating with Google Cloud Translation (handles unknown input more gracefully than DeepL). Tag as `[LANGUAGE DETECTION FAILED — TRANSLATED WITH GOOGLE]`.
- Never skip a source entirely just because language detection was uncertain. A poorly detected language that gets translated is still useful. A skipped source is a silent gap.

---

**Step 4 — Translation fails**

This is the highest-risk step for wasted cost. Follow this decision tree strictly:

```
Translation call fails
│
├── 400 Bad Request
│     → Input problem (text too short, encoding issue, unsupported chars)
│     → Fix the input. Strip non-printable characters. Re-chunk if text > API limit.
│     → Retry ONCE with cleaned input.
│     → If still fails: skip this source, log it, continue.
│
├── 429 Rate Limit
│     → Check remaining monthly quota before retrying anything.
│     → If quota remains: wait 60 seconds, retry once.
│     → If monthly quota exhausted on primary service:
│           - DeepL exhausted → switch to Google Cloud Translation
│           - Google exhausted → switch to MyMemory (free, lower quality)
│           - All exhausted → skip translation, use English-only sources, flag clearly
│     → Do NOT retry repeatedly — each retry burns quota.
│
├── 5xx Server Error (service down)
│     → Do not retry the same service.
│     → Immediately fall back to the alternate service (DeepL → Google or vice versa).
│     → Log which service was down and when.
│     → If both primaries are down: use MyMemory for short texts (<500 chars) or skip
│       long documents and note as a gap.
│
└── Timeout (no response)
      → Wait 10 seconds, retry once.
      → If still no response: fall back to alternate service.
      → If alternate also times out: skip the source, continue.
```

**Cost protection rule:** No single source should ever trigger more than **2 translation API calls** across all services combined. If two attempts fail, log the source as untranslated and move on.

---

**Step 5 — Normalization fails**

Normalization is deterministic Python with no external API calls. Failures here are code bugs, not service outages.

- If a date can't be parsed → retain the raw string, tag `[DATE FORMAT UNKNOWN]`, do not abort.
- If a currency conversion fails (e.g. exchange rate API down) → retain the local currency amount, note "USD equivalent unavailable — converted rate API was down at time of research."
- Log all normalization failures to `.tmp/normalization_errors.log` for debugging.

Normalization failures should never abort a run. Worst case: some fields are in non-standard format. That's a data quality note, not a blocker.

---

**Step 6 — Agent handoff fails**

If the research agent receives translated content but returns an error or empty output:

- Do not re-translate. The translated content is already in `.tmp/`. 
- Retry the agent call once with the same input (agent failures are often transient LLM timeouts).
- If the second attempt also fails: log the failure, write `"agent_output": null` for this step, and let the assembler handle the gap (it's designed to work with incomplete agent outputs).
- Never re-run the full pipeline from Step 1 to recover a single agent failure.

---

### Retry Budget

To prevent runaway cost from cascading retries, enforce a hard retry budget per run:

| Resource | Max retries per run |
|---|---|
| Translation API calls (total) | 2 per source document |
| Research agent calls (total) | 1 retry per agent |
| Source discovery tools | 1 retry per tool if timeout; 0 retries if rate-limited |
| Normalization passes | No retries — fail fast, log, continue |

If the retry budget is exhausted for a resource, **stop retrying and proceed with what you have.** Log what was skipped and why. The run should still complete and deliver a report — just with noted gaps.

---

### What Never Triggers a Full Re-run

A full re-run (from Step 1, discarding all prior work) is justified only when:
- The proposition inputs changed (different country, product, or language)
- A critical system error corrupted the `.tmp/` cache
- The user explicitly requests a fresh run

It is **never** justified because:
- One API was temporarily down
- A single source couldn't be translated
- Language detection was uncertain on one document
- An agent returned a low-confidence output

Partial runs with documented gaps produce more value than aborted runs, and cost far less to recover from.

---

### Logging Requirements

Every failure in this pipeline must be written to `.tmp/international_research_errors.log` with:
- Timestamp
- Step number and description
- Error type and message
- Action taken (fallback used, source skipped, etc.)
- Whether the run continued or was aborted

This log feeds the consultant brief's "Where the data was thin" section and serves as the post-run diagnostic for improving the pipeline over time.

---

## Edge Cases

**What to do when translation quality is clearly poor:**
- Flag the source in the agent output as `[TRANSLATION UNCERTAIN]`
- Note what language it was and what service was used
- If the finding is material, note it as a research gap and recommend a human native-language review

**What to do when a source requires local account authentication:**
- Note the source URL and why it couldn't be accessed
- Log in the "data gaps" section of the agent output
- Flag for manual follow-up if the source appears to be authoritative (e.g. a government registry)

**What to do when a country uses multiple official languages:**
- Translate and search in all official languages (e.g. Belgium: Dutch + French + German)
- Tag findings by language of source — conflicts between language versions can be significant

**What to do for low-resource languages (e.g. Somali, Tigrinya):**
- Machine translation quality drops significantly
- Flag any low-resource language translations prominently
- Prioritize English and French secondary sources for these markets
- Note the limitation in the research gaps section

---

## Output

Each research agent that runs with this workflow produces:
- Standard research output (same format as English-language runs)
- Translation metadata block (sources translated, services used, char count)
- Translation gap flags for any uncertain or inaccessible sources

The assembler workflow treats translated sources identically to English sources in the main report. Translation notes surface in the consultant brief's "Where the data was thin" section.

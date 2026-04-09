"""
tools/compute_data_confidence.py

Computes a Data Confidence Score (0–100) for a completed report run.
Aggregates the confidence signals embedded in each research agent's output
into a single score that appears alongside the viability score in the report.

Why this matters:
  A viability score without confidence context is misleading. If 80% of the
  underlying data is low-confidence (inferred, outdated, or poorly sourced),
  a "Strong 4.2" verdict may not be trustworthy. This score makes that visible.

Confidence signal sources:
  1. Per-field confidence ratings (high/medium/low) in each agent output
  2. Agent completion rate (failed agents penalise the score)
  3. Source count per agent (more cited sources = higher confidence)
  4. Data gaps count (each flagged gap reduces the score)

Score interpretation:
  85–100  → High Confidence    — data is well-sourced and current
  65–84   → Moderate Confidence — some gaps or medium-confidence fields
  40–64   → Low Confidence     — significant gaps, reliance on inferred data
  0–39    → Very Low Confidence — major data problems; treat viability score cautiously

CLI usage:
  python tools/compute_data_confidence.py --report-id <uuid>

Can also be called as a module:
  from tools.compute_data_confidence import compute_confidence
  score = compute_confidence(agent_outputs)

Returns JSON to stdout.
"""

import argparse
import json
import os
import sys
from datetime import datetime, timezone

from dotenv import load_dotenv
from supabase import create_client

# ── Config ────────────────────────────────────────────────────────────────────

load_dotenv()

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_KEY")

# Confidence level → numeric score mapping
CONFIDENCE_SCORES = {
    "high":   1.0,
    "medium": 0.6,
    "low":    0.2,
    "unknown": 0.0,
}

# Minimum expected sources per agent (used to normalise source count contribution)
MIN_EXPECTED_SOURCES = 3
TARGET_SOURCES       = 10  # A well-sourced agent has ~10 sources

# Weight of each signal in the final score
SIGNAL_WEIGHTS = {
    "field_confidence":  0.45,  # Per-field confidence ratings are the primary signal
    "agent_completion":  0.25,  # Whether all expected agents completed successfully
    "source_coverage":   0.20,  # How well-cited each agent's output is
    "data_gaps":         0.10,  # Flagged data gaps penalise the score
}

# Critical agents — failure of any of these penalises the score more heavily
CRITICAL_AGENTS = {
    "research_market_overview",
    "research_regulatory",
    "research_financials",
    "research_origin_ops",
}

# All expected agents for a complete run
ALL_AGENTS = {
    "research_market_overview",
    "research_competitors",
    "research_regulatory",
    "research_production",
    "research_packaging",
    "research_distribution",
    "research_marketing",
    "research_financials",
    "research_origin_ops",
    "research_legal",
}


# ── Confidence field extractor ─────────────────────────────────────────────────

def extract_confidence_fields(output: dict, path: str = "") -> list[tuple[str, str]]:
    """
    Recursively walk the agent output JSON and collect all fields named
    'confidence' with their values. Returns a list of (path, value) pairs.

    This handles nested confidence ratings in any agent output format,
    since different agents embed confidence at different depths.
    """
    findings = []

    if isinstance(output, dict):
        for key, value in output.items():
            current_path = f"{path}.{key}" if path else key

            if key == "confidence" and isinstance(value, str):
                # Found a confidence rating — record it
                findings.append((current_path, value.lower()))
            else:
                # Recurse into nested dicts/lists
                findings.extend(extract_confidence_fields(value, current_path))

    elif isinstance(output, list):
        for i, item in enumerate(output):
            findings.extend(extract_confidence_fields(item, f"{path}[{i}]"))

    return findings


def count_data_gaps(output: dict) -> int:
    """
    Count the number of flagged data gaps in an agent's output.
    Gaps are stored as a list under the 'data_gaps' key.
    """
    gaps = output.get("data_gaps", [])
    if isinstance(gaps, list):
        return len(gaps)
    if isinstance(gaps, str) and gaps:
        return 1
    return 0


def count_sources(output: dict) -> int:
    """
    Count the number of sources cited in an agent's output.
    Sources may be under 'sources' (list) or counted from URLs found.
    """
    sources = output.get("sources", [])
    if isinstance(sources, list):
        return len(sources)
    return 0


# ── Signal calculators ────────────────────────────────────────────────────────

def compute_field_confidence_score(agent_outputs: list[dict]) -> tuple[float, dict]:
    """
    Aggregate per-field confidence ratings across all agent outputs.
    Returns a 0–1 score and a breakdown by agent.

    Each 'confidence' field is extracted and averaged. The mean is then
    weighted: high=1.0, medium=0.6, low=0.2, unknown=0.0.
    """
    all_ratings   = []
    agent_details = {}

    for agent_data in agent_outputs:
        agent_name = agent_data.get("agent_name", "unknown")
        output     = agent_data.get("output", {})

        if not isinstance(output, dict):
            continue

        # Extract all confidence fields from this agent's output
        ratings = extract_confidence_fields(output)

        if not ratings:
            agent_details[agent_name] = {"fields": 0, "avg_score": None}
            continue

        # Convert text ratings to numeric scores
        scores = [CONFIDENCE_SCORES.get(val, 0.0) for _, val in ratings]
        avg    = sum(scores) / len(scores) if scores else 0.0

        agent_details[agent_name] = {
            "fields":    len(ratings),
            "avg_score": round(avg, 3),
            "ratings":   {path: val for path, val in ratings},
        }
        all_ratings.extend(scores)

    overall = sum(all_ratings) / len(all_ratings) if all_ratings else 0.0

    return overall, agent_details


def compute_agent_completion_score(agent_outputs: list[dict]) -> tuple[float, dict]:
    """
    Score based on what fraction of expected agents completed successfully.
    Critical agent failures are penalised twice as heavily as non-critical ones.
    """
    completed = {
        d.get("agent_name")
        for d in agent_outputs
        if d.get("status") == "complete"
    }
    failed    = ALL_AGENTS - completed

    # Base score: fraction of agents that completed
    base_score = len(completed) / len(ALL_AGENTS)

    # Extra penalty for critical agent failures
    # Each critical failure reduces the score by an additional 5%
    critical_failures = failed & CRITICAL_AGENTS
    critical_penalty  = len(critical_failures) * 0.05

    final_score = max(0.0, base_score - critical_penalty)

    return final_score, {
        "completed":          sorted(completed),
        "failed":             sorted(failed),
        "critical_failures":  sorted(critical_failures),
        "base_score":         round(base_score, 3),
        "critical_penalty":   round(critical_penalty, 3),
    }


def compute_source_coverage_score(agent_outputs: list[dict]) -> tuple[float, dict]:
    """
    Score based on how many sources each agent cited.
    Uses a soft cap — agents with >= TARGET_SOURCES score 1.0, fewer score proportionally.
    """
    agent_source_counts = {}
    all_scores          = []

    for agent_data in agent_outputs:
        if agent_data.get("status") != "complete":
            continue

        agent_name = agent_data.get("agent_name", "unknown")
        output     = agent_data.get("output", {})
        count      = count_sources(output)

        # Normalise: 0 sources = 0.0, TARGET_SOURCES+ = 1.0
        score = min(count / TARGET_SOURCES, 1.0)

        agent_source_counts[agent_name] = {"sources": count, "score": round(score, 3)}
        all_scores.append(score)

    overall = sum(all_scores) / len(all_scores) if all_scores else 0.0

    return overall, agent_source_counts


def compute_data_gaps_score(agent_outputs: list[dict]) -> tuple[float, dict]:
    """
    Score based on the number of data gaps flagged across all agents.
    More gaps = lower score. 0 gaps = 1.0, 20+ gaps = 0.0 (linear).

    MAX_GAPS is the threshold at which the score hits 0.
    """
    MAX_GAPS = 20

    agent_gap_counts = {}
    total_gaps       = 0

    for agent_data in agent_outputs:
        if agent_data.get("status") != "complete":
            continue

        agent_name = agent_data.get("agent_name", "unknown")
        output     = agent_data.get("output", {})
        count      = count_data_gaps(output)

        agent_gap_counts[agent_name] = count
        total_gaps += count

    # Linear decay: 0 gaps → 1.0, MAX_GAPS+ → 0.0
    score = max(0.0, 1.0 - (total_gaps / MAX_GAPS))

    return score, {"total_gaps": total_gaps, "by_agent": agent_gap_counts}


# ── Main confidence computation ───────────────────────────────────────────────

def compute_confidence(agent_outputs: list[dict]) -> dict:
    """
    Main entry point. Given a list of agent output records, computes and returns
    a full Data Confidence Score report.

    agent_outputs — list of dicts, each with:
      { "agent_name": str, "status": str, "output": dict }

    Returns a dict with the final score (0–100), interpretation, and breakdown.
    """
    # Compute each signal
    field_score,      field_detail      = compute_field_confidence_score(agent_outputs)
    completion_score, completion_detail = compute_agent_completion_score(agent_outputs)
    source_score,     source_detail     = compute_source_coverage_score(agent_outputs)
    gaps_score,       gaps_detail       = compute_data_gaps_score(agent_outputs)

    # Weighted aggregate (0–1)
    w = SIGNAL_WEIGHTS
    raw_score = (
        field_score      * w["field_confidence"]  +
        completion_score * w["agent_completion"]  +
        source_score     * w["source_coverage"]   +
        gaps_score       * w["data_gaps"]
    )

    # Convert to 0–100
    final_score = round(raw_score * 100, 1)

    # Interpretation label
    if final_score >= 85:
        interpretation = "High"
        description    = "Data is well-sourced and current. Viability score is reliable."
    elif final_score >= 65:
        interpretation = "Moderate"
        description    = "Some gaps or medium-confidence fields. Viability score is broadly reliable but verify key assumptions."
    elif final_score >= 40:
        interpretation = "Low"
        description    = "Significant gaps or reliance on inferred data. Treat viability score with caution."
    else:
        interpretation = "Very Low"
        description    = "Major data problems. Viability score may not be reliable — consider re-running with better sources."

    return {
        "data_confidence_score": final_score,
        "interpretation":        interpretation,
        "description":           description,
        "computed_at":           datetime.now(timezone.utc).isoformat(),
        "signal_breakdown": {
            "field_confidence": {
                "score":       round(field_score * 100, 1),
                "weight":      f"{int(w['field_confidence'] * 100)}%",
                "details":     field_detail,
            },
            "agent_completion": {
                "score":       round(completion_score * 100, 1),
                "weight":      f"{int(w['agent_completion'] * 100)}%",
                "details":     completion_detail,
            },
            "source_coverage": {
                "score":       round(source_score * 100, 1),
                "weight":      f"{int(w['source_coverage'] * 100)}%",
                "details":     source_detail,
            },
            "data_gaps": {
                "score":       round(gaps_score * 100, 1),
                "weight":      f"{int(w['data_gaps'] * 100)}%",
                "details":     gaps_detail,
            },
        },
    }


# ── Supabase fetch helper ─────────────────────────────────────────────────────

def fetch_agent_outputs(report_id: str) -> list[dict]:
    """
    Fetch all agent outputs for a given report_id from the Supabase agent_outputs table.
    Mirrors the fetch logic in the assembler workflow.
    """
    if not SUPABASE_URL or not SUPABASE_KEY:
        raise EnvironmentError("SUPABASE_URL or SUPABASE_SERVICE_KEY not set in .env")

    supabase = create_client(SUPABASE_URL, SUPABASE_KEY)

    resp = (
        supabase.table("agent_outputs")
        .select("agent_name, status, output")
        .eq("report_id", report_id)
        .execute()
    )

    return resp.data or []


# ── CLI entrypoint ────────────────────────────────────────────────────────────

if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Compute data confidence score for a completed report run"
    )
    parser.add_argument("--report-id", required=True, help="Report UUID to score")
    args = parser.parse_args()

    outputs = fetch_agent_outputs(args.report_id)

    if not outputs:
        print(
            json.dumps({"error": f"No agent outputs found for report_id: {args.report_id}"}),
            file=sys.stderr,
        )
        sys.exit(1)

    result = compute_confidence(outputs)
    print(json.dumps(result, indent=2))

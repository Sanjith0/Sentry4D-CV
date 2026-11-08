import json

import pytest

from blacksite_agent import schemas
from blacksite_agent.fixtures import FixtureDataSource
from blacksite_agent.tools import ToolContext, build_registry

NAME = "draft_response_plan"
ALLOWED = (NAME,)
IMM = "immediate_isolation"
STG = "staged_failover_then_isolation"


def _outcome(strategy, assets):
    return schemas.SimulatedOutcome(
        strategy=strategy, service_disruption="medium", assets_affected=assets,
        recovery_complexity="low", response_time_minutes=5, assumptions=["illustrative"],
    )


def _ctx(strategies=(IMM, STG), evidence=True):
    ctx = ToolContext(data=FixtureDataSource("test"))
    if evidence:
        ev = ctx.data.evidence
        ctx.seen_evidence[ev.evidence_id] = ev
    assets = {IMM: ["router-1", "laptop-b", "laptop-b"], STG: ["nas-1"]}
    for s in strategies:
        ctx.simulated_outcomes[s] = _outcome(s, assets[s])
    return ctx


def _run(ctx, **over):
    args = {"incident_id": "incident-001", "proposed_response": IMM, "rationale": "Because."}
    args.update(over)
    return build_registry().execute(NAME, json.dumps(args), ALLOWED, ctx)


def test_success():
    ctx = _ctx()
    out = _run(ctx)
    assert out.ok
    body = json.loads(out.content)
    d = body["draft"]
    assert body["notice"] == "DRAFT for human review. Simulated only. No action was taken."
    assert d["incidentId"] == "incident-001"
    assert d["evidenceIds"] == ["evidence-test"]
    assert d["affectedAssets"] == ["laptop-b", "router-1"]
    assert d["proposedResponse"] == IMM
    assert d["rationale"] == "Because."
    assert [o["strategy"] for o in d["strategyComparison"]["outcomes"]] == [IMM, STG]
    assert d["strategyComparison"]["preferredStrategy"] == IMM


def test_flags_always_true_and_comparison_validates():
    d = json.loads(_run(_ctx(), proposed_response=STG).content)["draft"]
    assert d["humanApprovalRequired"] is True
    assert d["isSimulated"] is True
    assert d["affectedAssets"] == ["nas-1"]
    sc = d["strategyComparison"]
    assert sc["isSimulated"] is True
    sc.setdefault("tradeoffs", "n/a")  # not supplied by this tool; model adds it in the final plan
    schemas.StrategyComparison.model_validate(sc)


@pytest.mark.parametrize("have", [(IMM,), (STG,), ()])
def test_missing_simulation_refused(have):
    out = _run(_ctx(strategies=have))
    assert not out.ok
    err = json.loads(out.content)["error"]
    assert "simulate_response" in err
    for s in (IMM, STG):
        if s not in have:
            assert s in err


def test_no_evidence_refused():
    out = _run(_ctx(evidence=False))
    assert not out.ok
    assert "evidence" in json.loads(out.content)["error"].lower()


def test_unknown_incident_refused():
    out = _run(_ctx(), incident_id="nope-999")
    assert not out.ok
    assert "nope-999" in json.loads(out.content)["error"]


def test_invalid_strategy_rejected():
    out = _run(_ctx(), proposed_response="nuke_it")
    assert not out.ok
    assert json.loads(out.content)["details"][0]["field"] == "proposed_response"


def test_overlong_or_empty_rationale_rejected():
    for bad in ("x" * 2001, ""):
        out = _run(_ctx(), rationale=bad)
        assert not out.ok
        assert json.loads(out.content)["details"][0]["field"] == "rationale"


def test_bad_incident_id_pattern_rejected():
    assert not _run(_ctx(), incident_id="../etc").ok

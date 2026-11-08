"""Offline checks that agents cannot answer beyond what the tools returned."""

import pytest

from blacksite_agent.agent import check_grounding
from blacksite_agent.fixtures import FixtureDataSource
from blacksite_agent.schemas import ImpactAssessment, ResponsePlan, SimulatedOutcome, StrategyComparison
from blacksite_agent.tools import ToolContext

IMMEDIATE = "immediate_isolation"
STAGED = "staged_failover_then_isolation"


def outcome(strategy, minutes):
    return SimulatedOutcome(
        strategy=strategy, service_disruption="medium", assets_affected=["laptop-b"],
        recovery_complexity="low", response_time_minutes=minutes, assumptions=["illustrative"],
    )


@pytest.fixture
def context():
    data = FixtureDataSource("t")
    ctx = ToolContext(data=data)
    ctx.seen_evidence[data.evidence.evidence_id] = data.evidence
    ctx.simulated_outcomes = {IMMEDIATE: outcome(IMMEDIATE, 7), STAGED: outcome(STAGED, 30)}
    return ctx


def comparison(minutes=7, preferred=STAGED):
    return StrategyComparison(
        incident_id="incident-001",
        outcomes=[outcome(IMMEDIATE, minutes), outcome(STAGED, 30)],
        preferred_strategy=preferred, tradeoffs="Speed versus disruption.",
    )


def plan(context, proposed=STAGED, evidence=None, comp=None):
    return ResponsePlan(
        incident_id="incident-001", incident_summary="s", confirmed_observations=["o"],
        uncertainties=["u"], affected_assets=["laptop-b"],
        evidence_ids=evidence or list(context.seen_evidence),
        strategy_comparison=comp or comparison(), proposed_response=proposed, rationale="r",
    )


def impact(context, confirmed):
    return ImpactAssessment(
        incident_id="incident-001", potentially_affected_assets=["nas-1"],
        confirmed_data_exposure=confirmed, suspected_data_exposure=[], uncertainties=["u"],
        evidence_ids=list(context.seen_evidence),
    )


def test_accurate_comparison_passes(context):
    check_grounding(comparison(), context)


def test_invented_simulation_numbers_are_rejected(context):
    with pytest.raises(ValueError, match="must match"):
        check_grounding(comparison(minutes=1), context)


def test_unsimulated_strategy_is_rejected(context):
    del context.simulated_outcomes[STAGED]
    with pytest.raises(ValueError, match="never simulated"):
        check_grounding(comparison(), context)


def test_comparison_must_cover_both_strategies(context):
    partial = comparison().model_copy(update={"outcomes": [outcome(IMMEDIATE, 7)]})
    with pytest.raises(ValueError, match="missing"):
        check_grounding(partial, context)


def test_valid_plan_passes(context):
    check_grounding(plan(context), context)


def test_plan_with_invented_evidence_is_rejected(context):
    with pytest.raises(ValueError, match="not returned"):
        check_grounding(plan(context, evidence=["evidence-fake"]), context)


def test_plan_must_propose_the_preferred_strategy(context):
    with pytest.raises(ValueError, match="preferredStrategy"):
        check_grounding(plan(context, proposed=IMMEDIATE), context)


def test_test_event_cannot_confirm_data_exposure(context):
    with pytest.raises(ValueError, match="cannot confirm"):
        check_grounding(impact(context, ["project documents"]), context)


def test_suspected_only_impact_passes(context):
    check_grounding(impact(context, []), context)


def test_assembled_plan_takes_verified_values_from_the_draft(context):
    from blacksite_agent.orchestrator import assemble_plan
    from blacksite_agent.schemas import CommanderBrief
    from blacksite_agent.tools import build_registry

    args = f'{{"incident_id": "incident-001", "proposed_response": "{STAGED}", "rationale": "r"}}'
    assert build_registry().execute("draft_response_plan", args, ("draft_response_plan",), context).ok
    brief = CommanderBrief(incident_summary="s", confirmed_observations=["o"], uncertainties=["u"])
    result = assemble_plan(brief, comparison(), context)
    assert result.evidence_ids == list(context.seen_evidence)
    assert result.proposed_response == STAGED and result.human_approval_required
    assert {o.response_time_minutes for o in result.strategy_comparison.outcomes} == {7, 30}

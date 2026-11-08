"""Offline tests of the training engine. The scripted model exists only here."""

import json
import re
from types import SimpleNamespace as NS

import pytest
from pydantic import ValidationError

from blacksite_agent.agent import AgentError
from blacksite_agent.fixtures import FIXTURE_ALERT
from blacksite_agent.orchestrator import claim_problem, check_pre_choice, missing_tools
from blacksite_agent.schemas import (
    GuideBriefing,
    OptionDraft,
    Selection,
    SimulatedOutcome,
    StepJudgement,
)
from blacksite_agent.session import InvalidChoice, SessionEngine
from blacksite_agent.tools import ToolContext, build_registry

ARGS = {
    "get_security_events": {"alert_id": "alert-001"},
    "get_incident_context": {"incident_id": "incident-001"},
    "get_related_assets": {"asset_id": "laptop-b"},
    "simulate_response": {"strategy": "monitor_only", "target_asset_id": "laptop-b"},
    "get_data_scope": {"asset_id": "laptop-b"},
}
ACTIONS = ["immediate_isolation", "block_traffic", "preserve_evidence", "monitor_only"]


def verdicts(correct):
    return [
        {"optionId": o, "correct": o == correct, "reasoning": f"reason-{o}"} for o in "ABCD"
    ]


class TrainingLLM:
    """Calls whichever tool is forced, then gives a canned answer for the role."""

    def __init__(self, correct="B"):
        self.correct = correct
        self.calls = []
        self.overrides = {}

    def complete(self, messages, tools, trace, role, tool_choice="auto"):
        self.calls.append((role, json.dumps(messages)))
        names = [t["function"]["name"] for t in tools]
        if tool_choice == "required" and len(names) == 1:
            call = NS(id="c", function=NS(name=names[0], arguments=json.dumps(ARGS[names[0]])))
            return NS(content=None, tool_calls=[call])
        if self.overrides.get(role):
            return NS(content=self.overrides[role].pop(0), tool_calls=None)
        return NS(content=json.dumps(self._answer(role, messages)), tool_calls=None)

    def _answer(self, role, messages):
        if role == "Scenario Guide":
            evidence = re.search(r"evidence-[a-f0-9]+-\d+", json.dumps(messages)).group(0)
            return {"narrative": "n", "leadingQuestion": "q", "evidenceIds": [evidence]}
        if role == "Option Designer":
            return {"options": [{"label": f"do {a}", "action": a} for a in ACTIONS]}
        if role == "Judge":
            return {"verdicts": verdicts(self.correct)}
        if role == "Consequence Explainer":
            return {"narrative": "what happened", "hint": "think about spread"}
        return {"summary": "s", "strengths": ["a"], "improvements": ["b"]}

    def count(self, role):
        return sum(1 for r, _ in self.calls if r == role)


@pytest.fixture
def llm():
    return TrainingLLM()


@pytest.fixture
def engine(llm):
    return SessionEngine(llm, build_registry())


@pytest.fixture
def session_id(engine):
    return engine.start_session(FIXTURE_ALERT).session_id


def choose(engine, session_id, step_id, attempt, option):
    return engine.submit_choice(
        session_id, Selection(step_id=step_id, attempt=attempt, option_id=option)
    )


def present_and_choose(engine, session_id, attempt, option):
    step = engine.present_step(session_id)
    return choose(engine, session_id, step.step_id, attempt, option)


@pytest.mark.parametrize(
    "wrong_first,points", [([], 100), (["A"], 50), (["A", "C"], 25)]
)
def test_points_table(engine, session_id, wrong_first, points):
    for attempt, option in enumerate(wrong_first, 1):
        assert present_and_choose(engine, session_id, attempt, option).points == 0
    result = present_and_choose(engine, session_id, len(wrong_first) + 1, "B")
    assert result.correct and result.points == points and result.step_resolved


def test_three_misses_score_zero_and_reveal_the_answer(engine, session_id):
    assert present_and_choose(engine, session_id, 1, "A").correct_option_id is None
    assert present_and_choose(engine, session_id, 2, "C").correct_option_id is None
    last = present_and_choose(engine, session_id, 3, "D")
    assert last.points == 0 and last.step_resolved and last.correct_option_id == "B"
    assert engine.get_score(session_id) == 0


def test_wrong_answer_gets_consequence_and_hint(engine, session_id):
    result = present_and_choose(engine, session_id, 1, "A")
    assert not result.correct and not result.step_resolved
    assert result.consequence.is_simulated and result.hint == "think about spread"


def test_full_session_max_score_and_debrief(engine, session_id):
    for _ in range(3):
        result = present_and_choose(engine, session_id, 1, "B")
    assert result.session_complete and result.total_score == 300
    assert engine.get_debrief(session_id).summary == "s"


def test_judge_runs_once_and_ruling_is_stable_across_retries(engine, session_id, llm):
    present_and_choose(engine, session_id, 1, "A")
    judged = llm.count("Judge")
    llm.correct = "A"  # A changed mind must have no effect now.
    assert present_and_choose(engine, session_id, 2, "B").correct
    assert llm.count("Judge") == judged


def test_judge_is_blind_to_the_selection(engine, session_id, llm):
    present_and_choose(engine, session_id, 1, "C")
    judge_text = " ".join(text for role, text in llm.calls if role == "Judge")
    assert "chose" not in judge_text.lower() and "selected" not in judge_text.lower()


def test_explainer_never_receives_a_ruling_or_other_options(engine, session_id, llm):
    step = engine.present_step(session_id)
    choose(engine, session_id, step.step_id, 1, "A")
    chosen = step.options[0].label
    others = [o.label for o in step.options[1:]]
    text = " ".join(t for role, t in llm.calls if role == "Consequence Explainer")
    assert chosen in text and not any(label in text for label in others)
    assert "reason-B" not in text


def test_pre_choice_agents_run_before_any_ruling_exists(engine, session_id):
    step = engine.present_step(session_id)
    assert engine.store.get(session_id).step_records[0].judgement is None
    assert not hasattr(step, "judgement")


def test_double_submit_scores_once(engine, session_id):
    first = present_and_choose(engine, session_id, 1, "B")
    replay = choose(engine, session_id, "triage", 1, "B")
    assert replay == first and engine.get_score(session_id) == 100


def test_resubmitting_an_attempt_with_another_option_is_refused(engine, session_id):
    present_and_choose(engine, session_id, 1, "A")
    with pytest.raises(InvalidChoice):
        choose(engine, session_id, "triage", 1, "C")


def test_same_wrong_option_cannot_be_retried(engine, session_id):
    present_and_choose(engine, session_id, 1, "A")
    with pytest.raises(InvalidChoice):
        choose(engine, session_id, "triage", 2, "A")


def test_attempts_cannot_be_skipped(engine, session_id):
    engine.present_step(session_id)
    with pytest.raises(InvalidChoice):
        choose(engine, session_id, "triage", 2, "A")


def test_future_step_is_refused(engine, session_id):
    engine.present_step(session_id)
    with pytest.raises(InvalidChoice):
        choose(engine, session_id, "contain", 1, "A")


def test_choice_before_presentation_is_refused(engine, session_id):
    with pytest.raises(InvalidChoice):
        choose(engine, session_id, "triage", 1, "A")


def test_unknown_session_is_refused(engine):
    with pytest.raises(InvalidChoice):
        engine.present_step("session-nope")


@pytest.mark.parametrize("option", ["E", "a", "", "DROP TABLE"])
def test_invalid_option_ids_are_rejected(option):
    with pytest.raises(ValidationError):
        Selection(step_id="triage", attempt=1, option_id=option)


def test_debrief_requires_a_finished_session(engine, session_id):
    with pytest.raises(InvalidChoice):
        engine.get_debrief(session_id)


def test_judge_failure_does_not_use_up_the_attempt(engine, session_id, llm):
    engine.present_step(session_id)
    llm.overrides["Judge"] = ["not json", "not json", "not json"]
    with pytest.raises(AgentError):
        choose(engine, session_id, "triage", 1, "B")
    llm.overrides.clear()
    assert choose(engine, session_id, "triage", 1, "B").points == 100


def test_later_steps_reveal_more_evidence_only_when_reached(engine, session_id):
    session = engine.store.get(session_id)
    context = engine._context(session)
    first, _ = context.data.get_security_events("alert-001", 50)
    assert len(first) == 2
    for _ in range(1):
        present_and_choose(engine, session_id, 1, "B")
    second, _ = engine._context(engine.store.get(session_id)).data.get_security_events(
        "alert-001", 50
    )
    assert len(second) == 4


def test_duplicate_and_agent_alerts_start_no_session(engine, session_id):
    assert engine.start_session(FIXTURE_ALERT) is None
    agent_alert = FIXTURE_ALERT.model_copy(update={"alert_id": "alert-9", "origin": "agent"})
    assert engine.start_session(agent_alert) is None


def test_all_roles_have_their_tools():
    assert missing_tools(build_registry()) == {}


@pytest.mark.parametrize(
    "bad",
    [
        [{"optionId": o, "correct": False, "reasoning": "r"} for o in "ABCD"],
        [{"optionId": o, "correct": True, "reasoning": "r"} for o in "ABCD"],
        [{"optionId": o, "correct": o == "A", "reasoning": "r"} for o in "AABC"],
    ],
)
def test_judgement_needs_exactly_one_correct_option_for_each_id(bad):
    with pytest.raises(ValidationError):
        StepJudgement(verdicts=bad)


def test_options_must_use_distinct_actions():
    with pytest.raises(ValidationError):
        OptionDraft(options=[{"label": "x", "action": "monitor_only"}] * 4)


@pytest.mark.parametrize(
    "narrative",
    ["The best move is obvious.", "This is the correct path.", "You should pick the first."],
)
def test_leak_filter_rejects_steering_language(narrative):
    context = ToolContext(data=None)
    output = GuideBriefing.model_construct(
        narrative=narrative, leading_question="q", evidence_ids=[]
    )
    with pytest.raises(ValueError):
        check_pre_choice(output, context)


def outcome(disruption="high", assets=("laptop-b", "nas-1"), minutes=7):
    return SimulatedOutcome(
        strategy="immediate_isolation", service_disruption=disruption, assets_affected=list(assets),
        recovery_complexity="low", response_time_minutes=minutes, assumptions=["illustrative"],
    )


@pytest.mark.parametrize(
    "text",
    [
        "It works while minimizing disruption to the team.",
        "This causes low service disruption.",
        "It has no disruption at all.",
        "Only the compromised asset is affected.",
        "It affects only the laptop.",
        "This takes 99 minutes.",
    ],
)
def test_claims_contradicting_the_simulation_are_caught(text):
    assert claim_problem(text, outcome(), {7, 30})


@pytest.mark.parametrize(
    "text",
    [
        "Isolation stops the spread but causes high disruption.",
        "It takes 7 minutes and also touches the NAS.",
        "A different action would take 30 minutes.",
    ],
)
def test_accurate_claims_pass(text):
    assert claim_problem(text, outcome(), {7, 30}) is None


def test_low_disruption_claim_is_allowed_when_true():
    assert claim_problem("This has low disruption.", outcome("low", ("laptop-b",)), {7}) is None


def test_judge_receives_simulated_results_for_every_option(engine, session_id, llm):
    step = engine.present_step(session_id)
    choose(engine, session_id, step.step_id, 1, "B")
    text = next(t for role, t in llm.calls if role == "Judge")
    assert text.count("simulatedResult") == 4 and "responseTimeMinutes" in text


def test_judge_contradicting_the_simulation_must_correct_itself(engine, session_id, llm):
    step = engine.present_step(session_id)
    isolate = next(o.option_id for o in step.options if o.action == "immediate_isolation")
    wrong = verdicts("B")
    next(v for v in wrong if v["optionId"] == isolate)["reasoning"] = (
        "Only the compromised asset is affected."
    )
    llm.overrides["Judge"] = [json.dumps({"verdicts": wrong})]
    choose(engine, session_id, step.step_id, 1, "B")
    trace = engine.trace_for(session_id)
    assert trace.count("repair") == 1
    stored = engine.store.get(session_id).step_records[0].judgement
    assert "Only the compromised" not in stored.verdict_for(isolate).reasoning


def test_consequence_shown_is_the_simulated_result_for_the_chosen_action(engine, session_id):
    step = engine.present_step(session_id)
    option = step.options[0]
    result = choose(engine, session_id, step.step_id, 1, "A")
    assert result.consequence.strategy == option.action


def test_session_model_calls_stay_within_budget(engine, session_id, llm):
    # Worst case: two wrong answers on every step, so two explanations per step.
    for _ in range(3):
        step = engine.present_step(session_id)
        choose(engine, session_id, step.step_id, 1, "A")
        choose(engine, session_id, step.step_id, 2, "C")
        choose(engine, session_id, step.step_id, 3, "B")
    engine.get_debrief(session_id)
    assert llm.count("Scenario Guide") == 6  # One tool request and one answer per step.
    assert llm.count("Option Designer") == 3
    assert llm.count("Judge") == 3
    assert llm.count("Consequence Explainer") == 6
    assert llm.count("Instructor") == 1
    assert len(llm.calls) == 19


def test_scenario_guide_still_requests_evidence_itself(engine, session_id):
    engine.present_step(session_id)
    called = [
        s for s in engine.trace_for(session_id).steps
        if s.kind == "tool_call" and s.tool_name == "get_security_events"
    ]
    assert called and called[0].role == "Scenario Guide"


def test_prefetched_data_reaches_the_agents_and_is_traced(engine, session_id, llm):
    step = engine.present_step(session_id)
    choose(engine, session_id, step.step_id, 1, "A")
    judge_text = next(t for role, t in llm.calls if role == "Judge")
    assert "Data scope" in judge_text and "dataClasses" in judge_text
    designer_text = next(t for role, t in llm.calls if role == "Option Designer")
    assert "relatedAssets" in designer_text
    fetched = {
        s.tool_name for s in engine.trace_for(session_id).steps
        if s.tool_call_id == "engine-prefetch"
    }
    assert {"get_incident_context", "get_related_assets", "get_data_scope"} <= fetched


def test_client_retries_rate_limits():
    from blacksite_agent.config import Settings
    from blacksite_agent.llm import NemotronClient

    client = NemotronClient(Settings(api_key="k", base_url="https://example.test/v1", model="m"))
    assert client._client.max_retries == 5


def _principle(engine, session_id, index=0):
    return engine.store.get(session_id).scenario.steps[index].judging_principle


def test_judge_receives_the_step_principle(engine, session_id, llm):
    step = engine.present_step(session_id)
    choose(engine, session_id, step.step_id, 1, "B")
    judge_text = next(t for role, t in llm.calls if role == "Judge")
    assert _principle(engine, session_id) in judge_text


def test_principle_never_reaches_other_agents_or_the_learner(engine, session_id, llm):
    step = engine.present_step(session_id)
    result = choose(engine, session_id, step.step_id, 1, "A")
    principle = _principle(engine, session_id)
    other_roles = [t for role, t in llm.calls if role != "Judge"]
    assert other_roles and not any(principle in t for t in other_roles)
    assert principle not in step.model_dump_json() and principle not in result.model_dump_json()


def test_every_step_has_its_own_principle(engine, session_id):
    steps = engine.store.get(session_id).scenario.steps
    assert len({s.judging_principle for s in steps}) == 3

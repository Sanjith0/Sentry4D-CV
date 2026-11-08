"""Offline unit tests. The scripted client exists only here; these do not prove the live API."""

import json
from dataclasses import replace
from types import SimpleNamespace as NS

import pytest
from pydantic import ValidationError

from blacksite_agent.agent import AgentError, AgentRole, run_agent
from blacksite_agent.fixtures import FixtureDataSource
from blacksite_agent.schemas import Finding
from blacksite_agent.tools import ToolContext, build_registry
from blacksite_agent.trace import Trace, sanitize

ROLE = AgentRole(
    name="Investigator",
    instructions="Investigate.",
    tool_names=("get_security_events",),
    output_model=Finding,
    required_tools=("get_security_events",),
)
EVIDENCE = "evidence-test"


class ScriptedLLM:
    def __init__(self, replies):
        self.replies = list(replies)
        self.tool_choices = []
        self.offered = []

    def complete(self, messages, tools, trace, role, tool_choice="auto"):
        self.tool_choices.append(tool_choice)
        self.offered.append([t["function"]["name"] for t in tools])
        return self.replies.pop(0)


def call(name="get_security_events", args='{"alert_id": "alert-001"}'):
    return NS(
        content=None,
        tool_calls=[NS(id="call-1", function=NS(name=name, arguments=args))],
    )


def answer(**overrides):
    body = {
        "incidentId": "incident-001",
        "summary": "A monitored test file changed.",
        "evidenceIds": [EVIDENCE],
        "confidence": "high",
        "classification": "suspicious",
        "recommendedAction": "Review simulated isolation",
    } | overrides
    return NS(content=json.dumps(body), tool_calls=None)


def run(replies):
    trace = Trace()
    context = ToolContext(data=FixtureDataSource("test"))
    llm = ScriptedLLM(replies)
    return run_agent(llm, ROLE, build_registry(), context, "go", trace), trace


def test_valid_round_trip_serializes_camel_case():
    finding, trace = run([call(), answer()])
    assert trace.count("tool_call") == 1
    assert finding.model_dump(by_alias=True)["evidenceIds"] == [EVIDENCE]


def test_answer_without_a_tool_call_is_repaired():
    _, trace = run([answer(), call(), answer()])
    assert trace.count("repair") == 1


def test_rejected_tool_call_forces_a_retry():
    bad = call(args='{"alert_id": "alert-001", "limit": 100}')
    llm = ScriptedLLM([bad, call(), answer()])
    trace = Trace()
    context = ToolContext(data=FixtureDataSource("test"))
    run_agent(llm, ROLE, build_registry(), context, "go", trace)
    assert llm.tool_choices == ["required", "required", "auto"]
    assert trace.count("tool_rejected") == 1 and trace.count("tool_call") == 1


def test_required_tool_is_forced_by_offering_only_that_tool():
    role = replace(ROLE, tool_names=("get_security_events", "get_related_assets"))
    llm = ScriptedLLM([call(), answer()])
    context = ToolContext(data=FixtureDataSource("test"))
    run_agent(llm, role, build_registry(), context, "go", Trace())
    assert llm.offered == [["get_security_events"], ["get_security_events", "get_related_assets"]]


def test_answer_format_is_withheld_until_required_tools_have_run():
    seen = []

    class Recorder(ScriptedLLM):
        def complete(self, messages, tools, trace, role, tool_choice="auto"):
            seen.append(json.dumps(messages))
            return super().complete(messages, tools, trace, role, tool_choice)

    context = ToolContext(data=FixtureDataSource("test"))
    run_agent(Recorder([call(), answer()]), ROLE, build_registry(), context, "go", Trace())
    assert "matching this schema" not in seen[0] and "matching this schema" in seen[1]


def test_premature_answer_is_not_echoed_back():
    seen = []

    class Recorder(ScriptedLLM):
        def complete(self, messages, tools, trace, role, tool_choice="auto"):
            seen.append(list(messages))
            return super().complete(messages, tools, trace, role, tool_choice)

    context = ToolContext(data=FixtureDataSource("test"))
    run_agent(Recorder([answer(), call(), answer()]), ROLE, build_registry(), context, "go", Trace())
    assert all(m["role"] != "assistant" for m in seen[1])


def test_invented_evidence_is_rejected():
    _, trace = run([call(), answer(evidenceIds=["evidence-made-up"]), answer()])
    assert trace.count("repair") == 1


def test_repairs_are_bounded():
    with pytest.raises(AgentError):
        run([call(), answer(evidenceIds=["x"]), answer(evidenceIds=["x"]), answer(evidenceIds=["x"])])


@pytest.mark.parametrize(
    "name,args",
    [
        ("run_shell", '{"cmd": "rm -rf /"}'),
        ("get_security_events", '{"alert_id": "a; rm -rf /"}'),
        ("get_security_events", '{"alert_id": "alert-001", "limit": 9999}'),
        ("get_security_events", '{"alert_id": "alert-001", "extra": 1}'),
        ("get_security_events", "not json"),
    ],
)
def test_bad_tool_calls_are_rejected_without_executing(name, args):
    context = ToolContext(data=FixtureDataSource("test"))
    outcome = build_registry().execute(name, args, ROLE.tool_names, context)
    assert not outcome.ok and not context.seen_evidence


def test_tool_output_keeps_test_label_but_hides_harness_label():
    context = ToolContext(data=FixtureDataSource("test"))
    outcome = build_registry().execute(
        "get_security_events", '{"alert_id": "alert-001"}', ROLE.tool_names, context
    )
    event = json.loads(outcome.content)["events"][0]
    assert event["isTestEvent"] is True and "isFixture" not in event


def test_secrets_are_redacted():
    text = sanitize("nvapi-abc123 Bearer xyz.789 custom-secret", ("custom-secret",))
    for leaked in ("abc123", "xyz.789", "custom-secret"):
        assert leaked not in text


def test_trace_redacts_tool_fields():
    trace = Trace(secrets=("s3cret",))
    trace.add("r", "tool_call", tool_result="value s3cret")
    assert "s3cret" not in trace.render()


def test_finding_requires_evidence():
    with pytest.raises(ValidationError):
        Finding(
            incident_id="i", summary="s", evidence_ids=[], confidence="low",
            classification="suspicious", recommended_action="a",
        )

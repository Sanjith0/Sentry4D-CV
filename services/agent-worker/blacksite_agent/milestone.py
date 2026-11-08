"""First milestone: prove a real Nemotron tool-calling round trip.

Run from services/agent-worker:  .venv/bin/python -m blacksite_agent.milestone

There is no offline mode. Without working credentials this exits with an error.
Incident data is fixture data; the model call and tool execution are real.
"""

import secrets
import sys

from .agent import AgentError, AgentRole, run_agent
from .config import ConfigError, load_settings
from .fixtures import FIXTURE_ALERT, FixtureDataSource
from .llm import LLMError, NemotronClient
from .schemas import Finding
from .tools import ToolContext, build_registry
from .trace import Trace


def _fail(message: str) -> int:
    print(f"MILESTONE FAILED: {message}", file=sys.stderr)
    return 1


def main() -> int:
    try:
        settings = load_settings()
    except ConfigError as exc:
        return _fail(str(exc))

    run_token = secrets.token_hex(4)
    data = FixtureDataSource(run_token)
    context = ToolContext(data=data)
    trace = Trace(secrets=(settings.api_key.get_secret_value(),))
    llm = NemotronClient(settings)
    role = AgentRole(
        name="Investigator",
        instructions=(
            "You are a security investigator. Retrieve the events for the alert and cite "
            "specific evidence. Separate confirmed facts from hypotheses."
        ),
        tool_names=("get_security_events",),
        output_model=Finding,
        required_tools=("get_security_events",),
    )
    briefing = (
        "A new alert needs investigation.\n"
        f"Alert: {FIXTURE_ALERT.model_dump_json(by_alias=True)}"
    )

    print(f"Endpoint : {settings.base_url}")
    print(f"Model    : {settings.model}")
    print("Incident : FIXTURE data (model call and tool execution are real)")
    print(f"Run token: {run_token} (evidence IDs exist only in the tool result)\n")

    try:
        if not llm.is_model_listed():
            return _fail(f"{settings.model} is not in this endpoint's model list.")
        finding = run_agent(llm, role, build_registry(), context, briefing, trace)
    except (LLMError, AgentError) as exc:
        print(trace.render())
        return _fail(trace.clean(str(exc)))

    print("=== TRACE ===")
    print(trace.render())
    print("\n=== VALIDATED FINDING ===")
    print(trace.clean(finding.model_dump_json(by_alias=True, indent=2)))

    response_ids = [s.response_id for s in trace.steps if s.kind == "model_response"]
    checks = {
        "Real API responses received": bool(response_ids),
        "Tool executed at the model's request": trace.count("tool_call") >= 1,
        "Structured result passed validation": trace.count("final_output") == 1,
        "Cited evidence came from the tool result": data.evidence.evidence_id
        in finding.evidence_ids,
    }
    print("\n=== MILESTONE CHECKS ===")
    for label, passed in checks.items():
        print(f"[{'PASS' if passed else 'FAIL'}] {label}")
    print(f"Response IDs: {', '.join(str(r) for r in response_ids)}")
    return 0 if all(checks.values()) else 1


if __name__ == "__main__":
    sys.exit(main())

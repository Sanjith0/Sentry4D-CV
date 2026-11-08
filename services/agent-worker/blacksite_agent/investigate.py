"""Run the full four-agent investigation against the live NVIDIA API.

Run from services/agent-worker:  .venv/bin/python -m blacksite_agent.investigate

There is no offline mode. Incident data is fixture data until SpacetimeDB is
connected; every model call, tool execution, and simulation is real.
"""

import secrets
import sys

from .agent import AgentError
from .config import ConfigError, load_settings
from .fixtures import FIXTURE_ALERT, FixtureDataSource
from .llm import LLMError, NemotronClient
from .orchestrator import ROLES, Orchestrator
from .tools import ToolContext, build_registry
from .trace import Trace


def _fail(message: str) -> int:
    print(f"INVESTIGATION FAILED: {message}", file=sys.stderr)
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
    orchestrator = Orchestrator(NemotronClient(settings), build_registry(), context)

    print(f"Model    : {settings.model}")
    print("Incident : FIXTURE data (model calls, tools, and simulations are real)")
    print(f"Run token: {run_token}\n")

    try:
        result = orchestrator.investigate(FIXTURE_ALERT, trace)
    except (LLMError, AgentError) as exc:
        print(trace.render())
        return _fail(trace.clean(str(exc)))

    print("=== TRACE ===")
    print(trace.render())
    print("\n=== INVESTIGATOR FINDING ===")
    print(trace.clean(result.finding.model_dump_json(by_alias=True, indent=2)))
    print("\n=== SIMULATED RESPONSE PLAN (requires human approval) ===")
    print(trace.clean(result.plan.model_dump_json(by_alias=True, indent=2)))

    executed = [s.tool_name for s in trace.steps if s.kind == "tool_call"]
    checks = {
        "All four agents produced validated output": trace.count("final_output") == len(ROLES),
        "At least three real tool calls": len(executed) >= 3,
        "Both strategies simulated": len(context.simulated_outcomes) == 2,
        "Draft plan tool executed": "draft_response_plan" in executed,
        "Incident context retrieved": "get_incident_context" in executed,
        "Plan cites evidence from the tool result": data.evidence.evidence_id
        in result.plan.evidence_ids,
        "Finding is not confirmed compromise": result.finding.classification
        != "confirmed_compromise",
        "Human approval required": result.plan.human_approval_required,
        "Duplicate alert is skipped": orchestrator.investigate(FIXTURE_ALERT, trace) is None,
    }
    print("\n=== CHECKS ===")
    for label, passed in checks.items():
        print(f"[{'PASS' if passed else 'FAIL'}] {label}")
    print(f"Tools executed ({len(executed)}): {', '.join(executed)}")
    return 0 if all(checks.values()) else 1


if __name__ == "__main__":
    sys.exit(main())

"""Four-role investigation orchestrator (skeleton).

Roles are fully declared. `investigate` refuses to run until every tool a role
needs is registered, rather than running with fabricated results.
"""

from dataclasses import dataclass, field

from .agent import AgentRole, run_agent
from .llm import NemotronClient
from .schemas import Alert, Finding, ImpactAssessment, ResponsePlan, StrategyComparison
from .tools import ToolContext, ToolRegistry
from .trace import Trace

INVESTIGATOR = AgentRole(
    name="Investigator",
    instructions=(
        "You are the Investigator on a security incident team. Retrieve the events "
        "for the alert, establish a timeline, identify the devices involved, and cite "
        "specific evidence. Separate confirmed facts from hypotheses. Do not classify "
        "an asset as compromised unless the evidence supports it. Classify by observed "
        "behaviour, not by test or fixture labels: a monitored file changed by an unknown "
        "or unverified process is suspicious. Record any test label as a confirmed fact, "
        "and never treat a test event as confirmed compromise."
    ),
    tool_names=(
        "get_security_events",
        "get_incident_context",
        "get_related_assets",
        "get_cv_observations",
    ),
    output_model=Finding,
)

IMPACT_ANALYST = AgentRole(
    name="Impact Analyst",
    instructions=(
        "You are the Impact Analyst. Examine asset relationships and data scope to "
        "identify potentially affected systems. Keep suspected and confirmed data "
        "exposure separate, explain uncertainty, and never claim compromise from a "
        "harmless test event."
    ),
    tool_names=("get_related_assets", "get_data_scope", "get_incident_context"),
    output_model=ImpactAssessment,
)

STRATEGIST = AgentRole(
    name="Strategist",
    instructions=(
        "You are the Strategist. Use the deterministic simulation to compare immediate "
        "simulated isolation with staged simulated failover followed by isolation. "
        "Compare service disruption, assets affected, recovery complexity, and response "
        "time. These are illustrative scenario assumptions, not predictions."
    ),
    tool_names=("simulate_response", "get_related_assets"),
    output_model=StrategyComparison,
)

INCIDENT_COMMANDER = AgentRole(
    name="Incident Commander",
    instructions=(
        "You are the Incident Commander. Combine the team's findings into an "
        "evidence-backed recommendation for a simulated response. A human must approve "
        "it; you never execute containment."
    ),
    tool_names=("draft_response_plan", "get_incident_context"),
    output_model=ResponsePlan,
)

ROLES = (INVESTIGATOR, IMPACT_ANALYST, STRATEGIST, INCIDENT_COMMANDER)


def missing_tools(registry: ToolRegistry) -> dict[str, list[str]]:
    gaps = {
        role.name: sorted(set(role.tool_names) - registry.names()) for role in ROLES
    }
    return {name: tools for name, tools in gaps.items() if tools}


@dataclass
class Orchestrator:
    llm: NemotronClient
    registry: ToolRegistry
    context: ToolContext
    processed_alert_ids: set[str] = field(default_factory=set)

    def should_process(self, alert: Alert) -> bool:
        return alert.origin == "telemetry" and alert.alert_id not in self.processed_alert_ids

    def investigate(self, alert: Alert, trace: Trace) -> ResponsePlan | None:
        if not self.should_process(alert):
            return None
        gaps = missing_tools(self.registry)
        if gaps:
            raise NotImplementedError(f"Tools not implemented yet: {gaps}")
        self.processed_alert_ids.add(alert.alert_id)

        briefing = f"Alert: {alert.model_dump_json(by_alias=True)}"
        result = None
        for role in ROLES:
            result = run_agent(self.llm, role, self.registry, self.context, briefing, trace)
            briefing += f"\n{role.name} result: {result.model_dump_json(by_alias=True)}"
        return result

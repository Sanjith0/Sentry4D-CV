"""Four-role investigation orchestrator.

Roles run in order and share one ToolContext, so later agents can only build on
what earlier tools really returned. `investigate` refuses to run if any tool a
role needs is missing, rather than running with fabricated results.
"""

from dataclasses import dataclass, field

from .agent import AgentRole, check_grounding, run_agent
from .llm import NemotronClient
from .schemas import (
    Alert,
    CommanderBrief,
    Finding,
    ImpactAssessment,
    ResponsePlan,
    StrategyComparison,
)
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
    required_tools=("get_security_events", "get_incident_context"),
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
    required_tools=("get_related_assets", "get_data_scope"),
)

STRATEGIST = AgentRole(
    name="Strategist",
    instructions=(
        "You are the Strategist. Use the deterministic simulation to compare immediate "
        "simulated isolation with staged simulated failover followed by isolation. "
        "Compare service disruption, assets affected, recovery complexity, and response "
        "time. These are illustrative scenario assumptions, not predictions. Call "
        "simulate_response once per strategy on the alert's asset, and copy each result "
        "into your answer without changing its values."
    ),
    tool_names=("simulate_response", "get_related_assets"),
    output_model=StrategyComparison,
    required_tools=("simulate_response",),
)

INCIDENT_COMMANDER = AgentRole(
    name="Incident Commander",
    instructions=(
        "You are the Incident Commander. Combine the team's findings into an "
        "evidence-backed recommendation for a simulated response. A human must approve "
        "it; you never execute containment. Call draft_response_plan with the strategy "
        "you recommend and your rationale. Then write only the incident summary, the "
        "confirmed observations, and the uncertainties. The system merges them with the "
        "verified draft."
    ),
    tool_names=("draft_response_plan", "get_incident_context"),
    output_model=CommanderBrief,
    required_tools=("draft_response_plan",),
)

ROLES = (INVESTIGATOR, IMPACT_ANALYST, STRATEGIST, INCIDENT_COMMANDER)


def missing_tools(registry: ToolRegistry) -> dict[str, list[str]]:
    gaps = {
        role.name: sorted(set(role.tool_names) - registry.names()) for role in ROLES
    }
    return {name: tools for name, tools in gaps.items() if tools}


def assemble_plan(
    brief: CommanderBrief, comparison: StrategyComparison, context: ToolContext
) -> ResponsePlan:
    """Merge the Commander's writing with the draft, so evidence and simulated values
    come from tool results and are never retyped by the model."""
    draft = context.plan_draft
    plan = ResponsePlan.model_validate(
        {
            **draft,
            "strategyComparison": {**draft["strategyComparison"], "tradeoffs": comparison.tradeoffs},
            **brief.model_dump(by_alias=True),
        }
    )
    check_grounding(plan, context)
    return plan


@dataclass(frozen=True)
class InvestigationResult:
    finding: Finding
    impact: ImpactAssessment
    comparison: StrategyComparison
    plan: ResponsePlan


@dataclass
class Orchestrator:
    llm: NemotronClient
    registry: ToolRegistry
    context: ToolContext
    processed_alert_ids: set[str] = field(default_factory=set)

    def should_process(self, alert: Alert) -> bool:
        return alert.origin == "telemetry" and alert.alert_id not in self.processed_alert_ids

    def investigate(self, alert: Alert, trace: Trace) -> InvestigationResult | None:
        if not self.should_process(alert):
            return None
        gaps = missing_tools(self.registry)
        if gaps:
            raise NotImplementedError(f"Tools not implemented yet: {gaps}")
        # Marked before running, so a failed investigation is never retried automatically.
        self.processed_alert_ids.add(alert.alert_id)

        briefing = f"Alert: {alert.model_dump_json(by_alias=True)}"
        results = []
        for role in ROLES:
            result = run_agent(self.llm, role, self.registry, self.context, briefing, trace)
            results.append(result)
            briefing += f"\n{role.name} result: {result.model_dump_json(by_alias=True)}"
        finding, impact, comparison, brief = results
        plan = assemble_plan(brief, comparison, self.context)
        return InvestigationResult(finding, impact, comparison, plan)

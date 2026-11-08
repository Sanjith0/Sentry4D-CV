"""Plan tool: assembles a DRAFT from data already gathered. Executes nothing, writes nothing."""

from typing import get_args

from pydantic import Field

from .schemas import StrategyId
from .tool_base import ToolArgs, ToolContext, ToolDefinition, ToolRefused, for_model

NOTICE = "DRAFT for human review. Simulated only. No action was taken."
_REQUIRED_STRATEGIES = tuple(get_args(StrategyId))


class DraftResponsePlanArgs(ToolArgs):
    incident_id: str = Field(
        pattern=r"^[A-Za-z0-9_\-]{1,64}$", description="ID of the incident the draft is for."
    )
    proposed_response: StrategyId = Field(description="The strategy you recommend.")
    rationale: str = Field(
        min_length=1, max_length=2000, description="Why this strategy is recommended."
    )


def draft_response_plan(args: DraftResponsePlanArgs, context: ToolContext) -> dict:
    if context.data.get_incident_context(args.incident_id) is None:
        raise ToolRefused(f"Unknown incident '{args.incident_id}'.")
    missing = [s for s in _REQUIRED_STRATEGIES if s not in context.simulated_outcomes]
    if missing:
        raise ToolRefused(
            f"Missing simulated outcomes for: {', '.join(missing)}. "
            "Run simulate_response for each strategy first."
        )
    if not context.seen_evidence:
        raise ToolRefused("No evidence has been gathered yet. Retrieve evidence first.")

    outcomes = [for_model(context.simulated_outcomes[s]) for s in sorted(context.simulated_outcomes)]
    proposed = context.simulated_outcomes[args.proposed_response]
    context.plan_draft = {
        "incidentId": args.incident_id,
        "evidenceIds": sorted(context.seen_evidence),
        "affectedAssets": sorted(set(proposed.assets_affected)),
        "strategyComparison": {
            "incidentId": args.incident_id,
            "outcomes": outcomes,
            "preferredStrategy": args.proposed_response,
            "isSimulated": True,
        },
        "proposedResponse": args.proposed_response,
        "rationale": args.rationale,  # untrusted model text, echoed as data only
        "humanApprovalRequired": True,
        "isSimulated": True,
    }
    return {"draft": context.plan_draft, "notice": NOTICE}


TOOLS: list[ToolDefinition] = [
    ToolDefinition(
        name="draft_response_plan",
        description=(
            "Assemble a DRAFT response plan for human review from the evidence and simulated "
            "outcomes already gathered. Executes nothing and changes nothing; requires "
            "simulate_response to have run for both strategies."
        ),
        args_model=DraftResponsePlanArgs,
        handler=draft_response_plan,
    )
]

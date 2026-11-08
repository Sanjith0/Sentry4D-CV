"""Strategy tools: run the deterministic sandbox. Simulation only, never a real action."""

from blacksite_sim.sandbox import Neighbour, simulate

from pydantic import Field

from .schemas import SimulatedOutcome, StrategyId
from .tool_base import ToolArgs, ToolContext, ToolDefinition, ToolRefused, for_model

NOTICE = (
    "SIMULATED: illustrative scenario assumptions, not real-world predictions. "
    "No action was taken."
)


class SimulateResponseArgs(ToolArgs):
    strategy: StrategyId = Field(description="Response strategy to simulate.")
    target_asset_id: str = Field(
        pattern=r"^[A-Za-z0-9_\-]{1,64}$", description="ID of the asset to respond on."
    )


def _target_criticality(target_asset_id: str, related, context: ToolContext) -> str | None:
    """The data interface has no get-asset call, so read the target's own record from a
    neighbour's related assets. Returns None if it cannot be found."""
    for rel in related:
        for back in context.data.get_related_assets(rel.asset.asset_id):
            if back.asset.asset_id == target_asset_id:
                return back.asset.criticality
    return None


def simulate_response(args: SimulateResponseArgs, context: ToolContext) -> dict:
    related = context.data.get_related_assets(args.target_asset_id)
    if not related:
        raise ToolRefused(f"Unknown asset '{args.target_asset_id}': no related assets found.")

    criticality = _target_criticality(args.target_asset_id, related, context)
    neighbours = [
        Neighbour(r.asset.asset_id, r.asset.criticality, r.relation, r.hops) for r in related
    ]
    result = simulate(args.strategy, args.target_asset_id, criticality or "medium", neighbours)
    assumptions = list(result.assumptions)
    if criticality is None:
        assumptions.append(
            f"Criticality of {args.target_asset_id} could not be looked up; assumed medium."
        )
    outcome = SimulatedOutcome(
        strategy=result.strategy,
        service_disruption=result.service_disruption,
        assets_affected=result.assets_affected,
        recovery_complexity=result.recovery_complexity,
        response_time_minutes=result.response_time_minutes,
        assumptions=assumptions,
    )
    context.simulated_outcomes[args.strategy] = outcome
    return {"simulation": for_model(outcome), "notice": NOTICE}


TOOLS: list[ToolDefinition] = [
    ToolDefinition(
        name="simulate_response",
        description=(
            "Run a simulation only of a response strategy on an asset and return the "
            "illustrative outcome (disruption, affected assets, recovery, time). It takes "
            "no real action and changes nothing."
        ),
        args_model=SimulateResponseArgs,
        handler=simulate_response,
    )
]

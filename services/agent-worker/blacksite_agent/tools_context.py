"""Context tools: incident record and neighbouring assets (see tool_base.py)."""

from pydantic import Field

from .tool_base import ToolArgs, ToolContext, ToolDefinition, ToolRefused, for_model

_ID_PATTERN = r"^[A-Za-z0-9_\-]{1,64}$"


class GetIncidentContextArgs(ToolArgs):
    incident_id: str = Field(pattern=_ID_PATTERN, description="ID of the incident to look up.")


class GetRelatedAssetsArgs(ToolArgs):
    asset_id: str = Field(
        pattern=_ID_PATTERN, description="ID of the asset whose neighbours to list."
    )


def get_incident_context(args: GetIncidentContextArgs, context: ToolContext) -> dict:
    record = context.data.get_incident_context(args.incident_id)
    if record is None:
        raise ToolRefused(f"Unknown incident ID '{args.incident_id}'.")
    return {"incident": for_model(record)}


def get_related_assets(args: GetRelatedAssetsArgs, context: ToolContext) -> dict:
    results = context.data.get_related_assets(args.asset_id)
    return {"assetId": args.asset_id, "relatedAssets": [for_model(r) for r in results]}


TOOLS: list[ToolDefinition] = [
    ToolDefinition(
        name="get_incident_context",
        description="Use this to get the incident record (status, severity, primary asset, alerts) for an incident ID.",
        args_model=GetIncidentContextArgs,
        handler=get_incident_context,
    ),
    ToolDefinition(
        name="get_related_assets",
        description="Use this to list assets connected to a given asset, to judge how far an incident could spread.",
        args_model=GetRelatedAssetsArgs,
        handler=get_related_assets,
    ),
]

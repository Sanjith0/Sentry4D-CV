"""Evidence tools: computer-vision observations and data scope for an asset."""

from pydantic import Field

from .tool_base import ToolArgs, ToolContext, ToolDefinition, ToolRefused, for_model

_ID_PATTERN = r"^[A-Za-z0-9_\-]{1,64}$"


class GetCvObservationsArgs(ToolArgs):
    asset_id: str = Field(pattern=_ID_PATTERN, description="ID of the asset to look up.")


def get_cv_observations(args: GetCvObservationsArgs, context: ToolContext) -> dict:
    results = context.data.get_cv_observations(args.asset_id)
    return {"assetId": args.asset_id, "observations": [for_model(o) for o in results]}


class GetDataScopeArgs(ToolArgs):
    asset_id: str = Field(pattern=_ID_PATTERN, description="ID of the asset to look up.")


def get_data_scope(args: GetDataScopeArgs, context: ToolContext) -> dict:
    record = context.data.get_data_scope(args.asset_id)
    if record is None:
        raise ToolRefused(f"Unknown asset '{args.asset_id}'.")
    return {"dataScope": for_model(record)}


TOOLS: list[ToolDefinition] = [
    ToolDefinition(
        name="get_cv_observations",
        description=(
            "Retrieve computer-vision observations (for example QR scans or object "
            "detections) recorded for an asset. Use it to find physical-world evidence "
            "tied to that asset; an empty list means nothing was observed."
        ),
        args_model=GetCvObservationsArgs,
        handler=get_cv_observations,
    ),
    ToolDefinition(
        name="get_data_scope",
        description=(
            "Retrieve what kinds of data an asset holds and how sensitive they are. "
            "This describes what the asset contains and is NOT evidence that any data "
            "was accessed or exposed."
        ),
        args_model=GetDataScopeArgs,
        handler=get_data_scope,
    ),
]

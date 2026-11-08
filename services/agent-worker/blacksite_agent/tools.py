"""Typed tool registry. Agents can reach only the functions registered here.

Arguments are validated before execution, and a role can call only the tools it
is allowed. Nothing here runs shell commands or touches an endpoint.
"""

import json
from pydantic import Field, ValidationError

from .tool_base import (  # noqa: F401  (re-exported for callers)
    ToolArgs,
    ToolContext,
    ToolDefinition,
    ToolOutcome,
    ToolRefused,
    for_model,
)

MAX_EVENTS = 50


class ToolRegistry:
    def __init__(self, tools: list[ToolDefinition]) -> None:
        self._tools = {tool.name: tool for tool in tools}

    def names(self) -> set[str]:
        return set(self._tools)

    def openai_schemas(self, allowed: tuple[str, ...]) -> list[dict]:
        return [
            {
                "type": "function",
                "function": {
                    "name": name,
                    "description": self._tools[name].description,
                    "parameters": self._tools[name].args_model.model_json_schema(),
                },
            }
            for name in allowed
        ]

    def execute(
        self, name: str, raw_arguments: str, allowed: tuple[str, ...], context: ToolContext
    ) -> ToolOutcome:
        if name not in allowed or name not in self._tools:
            return _rejected(f"Tool '{name}' is not available to this agent.")
        tool = self._tools[name]
        try:
            args = tool.args_model.model_validate_json(raw_arguments or "{}")
        except ValidationError as exc:
            details = [
                {"field": ".".join(map(str, e["loc"])), "problem": e["msg"]}
                for e in exc.errors()
            ]
            return _rejected("Invalid arguments.", details)
        try:
            result = tool.handler(args, context)
        except ToolRefused as exc:
            return _rejected(str(exc))
        except Exception as exc:  # A tool failure is reported to the model, not raised.
            return _rejected(f"Tool failed: {type(exc).__name__}.")
        return ToolOutcome(ok=True, content=json.dumps(result))


def _rejected(message: str, details: list | None = None) -> ToolOutcome:
    payload: dict = {"error": message}
    if details:
        payload["details"] = details
    return ToolOutcome(ok=False, content=json.dumps(payload))


class GetSecurityEventsArgs(ToolArgs):
    alert_id: str = Field(
        pattern=r"^[A-Za-z0-9_\-]{1,64}$", description="ID of the alert to investigate."
    )


def get_security_events(args: GetSecurityEventsArgs, context: ToolContext) -> dict:
    events, evidence = context.data.get_security_events(args.alert_id, MAX_EVENTS)
    context.seen_evidence.update({item.evidence_id: item for item in evidence})
    context.seen_events.update({item.event_id: item for item in events})
    return {"events": [for_model(e) for e in events], "evidence": [for_model(e) for e in evidence]}


def build_registry() -> ToolRegistry:
    # Each module owns its tools and exposes them as a TOOLS list.
    from . import tools_context, tools_evidence, tools_plan, tools_strategy

    own = ToolDefinition(
        name="get_security_events",
        description="Retrieve the security events and evidence records linked to an alert.",
        args_model=GetSecurityEventsArgs,
        handler=get_security_events,
    )
    return ToolRegistry(
        [own, *tools_context.TOOLS, *tools_evidence.TOOLS, *tools_strategy.TOOLS, *tools_plan.TOOLS]
    )

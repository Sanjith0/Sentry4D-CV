"""Investigation trace, with secrets redacted from everything it holds or prints."""

import re

from .schemas import AgentStep

_SECRET_PATTERNS = [
    re.compile(r"nvapi-[A-Za-z0-9_\-]+"),
    re.compile(r"(?i)bearer\s+[A-Za-z0-9._\-]+"),
]
_MAX_FIELD_CHARS = 1200


def sanitize(text: str, secrets: tuple[str, ...] = ()) -> str:
    for secret in secrets:
        if secret:
            text = text.replace(secret, "[REDACTED]")
    for pattern in _SECRET_PATTERNS:
        text = pattern.sub("[REDACTED]", text)
    return text


class Trace:
    def __init__(self, secrets: tuple[str, ...] = ()) -> None:
        self._secrets = secrets
        self.steps: list[AgentStep] = []

    def clean(self, text: str) -> str:
        return sanitize(text, self._secrets)

    def add(self, role: str, kind: str, **fields) -> AgentStep:
        cleaned = {
            key: self.clean(value) if isinstance(value, str) else value
            for key, value in fields.items()
        }
        step = AgentStep(step=len(self.steps) + 1, role=role, kind=kind, **cleaned)
        self.steps.append(step)
        return step

    def count(self, kind: str) -> int:
        return sum(1 for step in self.steps if step.kind == kind)

    def render(self) -> str:
        return "\n".join(_render_step(step) for step in self.steps)


def _clip(text: str | None) -> str:
    text = text or ""
    if len(text) <= _MAX_FIELD_CHARS:
        return text
    return f"{text[:_MAX_FIELD_CHARS]}... [{len(text) - _MAX_FIELD_CHARS} chars clipped]"


def _render_step(step: AgentStep) -> str:
    head = f"[{step.step:02d}] {step.role} / {step.kind}"
    if step.kind == "model_response":
        return "\n".join(
            [
                head,
                f"     response id : {step.response_id}",
                f"     served model: {step.served_model}",
                f"     finish      : {step.finish_reason}",
                f"     tokens      : {step.prompt_tokens} in / {step.completion_tokens} out",
                f"     latency     : {step.latency_ms} ms",
                f"     detail      : {_clip(step.detail)}",
            ]
        )
    if step.kind in ("tool_call", "tool_rejected"):
        return "\n".join(
            [
                head,
                f"     call id  : {step.tool_call_id}",
                f"     tool     : {step.tool_name}",
                f"     arguments: {_clip(step.tool_arguments)}",
                f"     result   : {_clip(step.tool_result)}",
            ]
        )
    return f"{head}\n     {_clip(step.detail)}"

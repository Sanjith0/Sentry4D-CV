"""Client for NVIDIA's OpenAI-compatible hosted API."""

import time

from openai import APIStatusError, OpenAI, OpenAIError

from .config import Settings
from .trace import Trace


class LLMError(RuntimeError):
    """A model call failed; the message is safe to log."""


class NemotronClient:
    def __init__(self, settings: Settings) -> None:
        self.model = settings.model
        self._client = OpenAI(
            api_key=settings.api_key.get_secret_value(),
            base_url=settings.base_url,
            timeout=90.0,
            max_retries=2,
        )

    def is_model_listed(self) -> bool:
        try:
            return any(item.id == self.model for item in self._client.models.list().data)
        except OpenAIError as exc:
            raise _safe_error(exc) from None

    def complete(
        self,
        messages: list[dict],
        tools: list[dict],
        trace: Trace,
        role: str,
        tool_choice: str | dict = "auto",
    ):
        started = time.monotonic()
        try:
            response = self._client.chat.completions.create(
                model=self.model,
                messages=messages,
                tools=tools,
                tool_choice=tool_choice,
                temperature=0.6,
                top_p=0.95,
                max_tokens=4096,
            )
        except OpenAIError as exc:
            raise _safe_error(exc) from None
        if not response.choices:
            raise LLMError("The API returned no choices.")
        choice = response.choices[0]
        calls = choice.message.tool_calls or []
        trace.add(
            role,
            "model_response",
            latency_ms=int((time.monotonic() - started) * 1000),
            response_id=response.id,
            served_model=response.model,
            finish_reason=choice.finish_reason,
            prompt_tokens=response.usage.prompt_tokens if response.usage else None,
            completion_tokens=response.usage.completion_tokens if response.usage else None,
            detail=(
                "requested tools: " + ", ".join(c.function.name for c in calls)
                if calls
                else f"text answer: {(choice.message.content or '')[:400]}"
            ),
        )
        return choice.message


def _safe_error(exc: OpenAIError) -> LLMError:
    # Exception bodies can echo request details, so only the status is surfaced.
    if isinstance(exc, APIStatusError):
        hint = {401: " Check NVIDIA_API_KEY.", 403: " Check NVIDIA_API_KEY.",
                404: " Check NVIDIA_MODEL and NVIDIA_BASE_URL.",
                429: " Rate limited."}.get(exc.status_code, "")
        return LLMError(f"NVIDIA API returned HTTP {exc.status_code}.{hint}")
    return LLMError(f"Could not complete the NVIDIA API call ({type(exc).__name__}).")

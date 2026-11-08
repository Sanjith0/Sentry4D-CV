"""Live check of NVIDIA authentication, inference, and tool calling.

Run from services/agent-worker:  .venv/bin/python -m blacksite_agent.connection_test
"""

import json
import secrets
import sys

from openai import APIStatusError, OpenAI, OpenAIError

from .config import ConfigError, load_settings
from .trace import sanitize

LOOKUP_TOOL = {
    "type": "function",
    "function": {
        "name": "lookup_verification_code",
        "description": "Return the verification code for a named system.",
        "parameters": {
            "type": "object",
            "properties": {"system": {"type": "string", "description": "System name."}},
            "required": ["system"],
            "additionalProperties": False,
        },
    },
}


def _describe(exc: OpenAIError) -> str:
    # Exception bodies can echo request details, so only the status is reported.
    if isinstance(exc, APIStatusError):
        return f"HTTP {exc.status_code}"
    return type(exc).__name__


def main() -> int:
    try:
        settings = load_settings()
    except ConfigError as exc:
        print(f"FAIL configuration: {exc}", file=sys.stderr)
        return 1

    key = settings.api_key.get_secret_value()
    client = OpenAI(api_key=key, base_url=settings.base_url, timeout=90.0, max_retries=1)
    common = {"model": settings.model, "temperature": 0.6, "top_p": 0.95, "max_tokens": 2048}
    show = lambda text: sanitize(str(text), (key,))

    print(f"Endpoint: {settings.base_url}")
    print(f"Model   : {settings.model}\n")

    # 1 and 2. A chat completion requires a valid key, so it proves both.
    try:
        reply = client.chat.completions.create(
            messages=[{"role": "user", "content": "In one sentence, what is an endpoint alert?"}],
            **common,
        )
    except OpenAIError as exc:
        print(f"FAIL authentication/inference: {_describe(exc)}", file=sys.stderr)
        return 1
    print("PASS authentication")
    print(f"PASS inference (response id {show(reply.id)}, served by {show(reply.model)})")
    print(f"     Reply: {show(reply.choices[0].message.content)}\n")

    # 3. The code exists only in the tool result, so the model cannot guess it.
    code = secrets.token_hex(4)
    messages = [
        {
            "role": "user",
            "content": "Use the tool to get the verification code for system 'laptop-b', "
            "then state the code exactly.",
        }
    ]
    try:
        first = client.chat.completions.create(
            messages=messages, tools=[LOOKUP_TOOL], tool_choice="auto", **common
        )
        message = first.choices[0].message
        if not message.tool_calls:
            print("FAIL tool calling: the model answered without calling the tool.", file=sys.stderr)
            print(f"     Reply: {show(message.content)}", file=sys.stderr)
            return 1

        call = message.tool_calls[0]
        arguments = json.loads(call.function.arguments)
        print(f"PASS tool request (response id {show(first.id)})")
        print(f"     Called: {show(call.function.name)}({show(json.dumps(arguments))})")

        messages.append(
            {
                "role": "assistant",
                "content": message.content or "",
                "tool_calls": [
                    {
                        "id": call.id,
                        "type": "function",
                        "function": {
                            "name": call.function.name,
                            "arguments": call.function.arguments,
                        },
                    }
                ],
            }
        )
        messages.append(
            {"role": "tool", "tool_call_id": call.id, "content": json.dumps({"code": code})}
        )
        second = client.chat.completions.create(messages=messages, tools=[LOOKUP_TOOL], **common)
    except OpenAIError as exc:
        print(f"FAIL tool calling: {_describe(exc)}", file=sys.stderr)
        return 1
    except json.JSONDecodeError:
        print("FAIL tool calling: the tool arguments were not valid JSON.", file=sys.stderr)
        return 1

    answer = second.choices[0].message.content or ""
    print(f"     Reply: {show(answer)}")
    if code not in answer:
        print("FAIL tool result: the reply did not contain the tool's code.", file=sys.stderr)
        return 1
    print(f"PASS tool result (response id {show(second.id)}, code {code} returned by the model)")
    print("\nAll checks passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

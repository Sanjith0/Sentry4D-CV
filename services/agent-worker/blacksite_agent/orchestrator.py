"""Training agent roles and the rules their output must satisfy.

Roles that run before the learner chooses never receive a ruling, because none
exists yet. Each role uses the same Nemotron model with separate instructions.
"""

import re

from pydantic import BaseModel

from .agent import AgentRole, check_grounding
from .schemas import (
    ConsequenceFeedback,
    Debrief,
    GuideBriefing,
    OptionDraft,
    SimulatedOutcome,
    StepJudgement,
    TrainingOption,
)
from .tools import ToolContext, ToolRegistry

_TRAINING = (
    "This is a cybersecurity training exercise. The attack is scripted and fictional, "
    "and nothing is real or executed. "
)

SCENARIO_GUIDE = AgentRole(
    name="Scenario Guide",
    instructions=(
        f"{_TRAINING}You are the Scenario Guide. Retrieve this step's events and describe "
        "what is happening in two or three plain sentences, citing the evidence. End with "
        "one leading question that helps the learner reason about the objective. Never say "
        "what the learner should do, and never rank possible actions."
    ),
    tool_names=(
        "get_security_events",
        "get_incident_context",
        "get_related_assets",
        "get_cv_observations",
    ),
    output_model=GuideBriefing,
    required_tools=("get_security_events",),
)

OPTION_DESIGNER = AgentRole(
    name="Option Designer",
    instructions=(
        f"{_TRAINING}You are the Option Designer. The related assets are in the briefing. Write four "
        "short, plausible response options for this step, each using a different action. "
        "Make them similar in length and tone. Never indicate that any option is better "
        "than another."
    ),
    tool_names=("get_related_assets", "simulate_response"),
    output_model=OptionDraft,
    data_provided=True,
)

JUDGE = AgentRole(
    name="Judge",
    instructions=(
        f"{_TRAINING}You are the Judge. Decide which single option best meets the step's "
        "objective given the evidence. The asset's data scope is in the briefing. Mark exactly one "
        "option correct and give brief reasoning for every option. Each option's simulated "
        "result is in the briefing: use only those facts when describing its consequences. "
        "Apply the judging principle first. Simulated cost only separates options that "
        "satisfy it; a cheap or fast option does not win for that reason. Do not quote the "
        "principle."
    ),
    tool_names=("get_data_scope", "get_related_assets"),
    output_model=StepJudgement,
    data_provided=True,
)

CONSEQUENCE_EXPLAINER = AgentRole(
    name="Consequence Explainer",
    instructions=(
        f"{_TRAINING}You are the Consequence Explainer. The learner's choice did not best "
        "meet the objective. The related assets are in the briefing. Explain in two sentences what "
        "the simulated result of their choice means. Add one hint about what to think about "
        "next. Do not name a specific action to take instead."
    ),
    tool_names=("get_related_assets",),
    output_model=ConsequenceFeedback,
    data_provided=True,
)

INSTRUCTOR = AgentRole(
    name="Instructor",
    instructions=(
        f"{_TRAINING}You are the Instructor. Review the learner's decisions across the "
        "session and give an encouraging, specific debrief: what they did well and what to "
        "improve. Refer to their actual choices. Do not state a score."
    ),
    tool_names=("get_incident_context",),
    output_model=Debrief,
    data_provided=True,
)

ROLES = (SCENARIO_GUIDE, OPTION_DESIGNER, JUDGE, CONSEQUENCE_EXPLAINER, INSTRUCTOR)

_LEAK_WORDS = re.compile(
    r"\b(correct|incorrect|best|optimal|recommend(?:ed|s)?|right answer|"
    r"should (?:choose|select|pick))\b",
    re.IGNORECASE,
)


def _strings(value) -> list[str]:
    if isinstance(value, str):
        return [value]
    if isinstance(value, dict):
        return [s for v in value.values() for s in _strings(v)]
    if isinstance(value, list):
        return [s for v in value for s in _strings(v)]
    return []


def check_pre_choice(output: BaseModel, context: ToolContext) -> None:
    """Grounding plus a filter for language that steers the learner before they choose."""
    check_grounding(output, context)
    for text in _strings(output.model_dump()):
        match = _LEAK_WORDS.search(text)
        if match:
            raise ValueError(
                f"Remove the word '{match.group(0)}'. Do not judge or rank anything; the "
                "learner decides."
            )


_SOFT_DISRUPTION = re.compile(
    r"\b(minimi[sz]\w*|limit\w*|reduc\w*|low|little|minimal)\b(?:\W+\w+){0,2}?\W+disruption",
    re.IGNORECASE,
)
_NO_DISRUPTION = re.compile(r"\b(no|without|zero)\b(?:\W+\w+){0,2}?\W+disruption", re.IGNORECASE)
_ONLY_AFFECTED = re.compile(r"\bonly\b[^.]{0,50}\baffected\b|\baffect\w*\s+only\b", re.IGNORECASE)
_MINUTES = re.compile(r"\b(\d+)[\s-]*min", re.IGNORECASE)


def claim_problem(text: str, outcome: SimulatedOutcome, known_minutes: set[int]) -> str | None:
    """Explains how `text` contradicts the simulated outcome, or returns None if it does not."""
    facts = (
        f"the simulation says disruption is {outcome.service_disruption}, it takes "
        f"{outcome.response_time_minutes} minutes, and it affects "
        f"{', '.join(outcome.assets_affected)}"
    )
    if outcome.service_disruption == "high" and _SOFT_DISRUPTION.search(text):
        return f"understates the disruption: {facts}."
    if outcome.service_disruption != "low" and _NO_DISRUPTION.search(text):
        return f"claims there is no disruption: {facts}."
    if len(outcome.assets_affected) > 1 and _ONLY_AFFECTED.search(text):
        return f"understates which assets are affected: {facts}."
    if any(int(m) not in known_minutes for m in _MINUTES.findall(text)):
        return f"states a time that was not simulated: {facts}."
    return None


def check_judgement_facts(
    output: StepJudgement, options: list[TrainingOption], context: ToolContext
) -> None:
    outcomes = {o.option_id: context.simulated_outcomes[o.action] for o in options}
    known = {o.response_time_minutes for o in outcomes.values()}
    for verdict in output.verdicts:
        problem = claim_problem(verdict.reasoning, outcomes[verdict.option_id], known)
        if problem:
            raise ValueError(f"The reasoning for option {verdict.option_id} {problem}")


def missing_tools(registry: ToolRegistry) -> dict[str, list[str]]:
    gaps = {role.name: sorted(set(role.tool_names) - registry.names()) for role in ROLES}
    return {name: tools for name, tools in gaps.items() if tools}

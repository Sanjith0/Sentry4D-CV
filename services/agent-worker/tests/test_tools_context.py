import json

import pytest

from blacksite_agent.fixtures import FixtureDataSource
from blacksite_agent.tool_base import ToolContext
from blacksite_agent.tools import build_registry

ALLOWED = ("get_incident_context", "get_related_assets")


def run(name, args):
    ctx = ToolContext(data=FixtureDataSource("test"))
    outcome = build_registry().execute(name, json.dumps(args), ALLOWED, ctx)
    return outcome.ok, json.loads(outcome.content)


def test_incident_context_success():
    ok, body = run("get_incident_context", {"incident_id": "incident-001"})
    assert ok
    assert body["incident"]["incidentId"] == "incident-001"
    assert "isFixture" not in json.dumps(body)


def test_incident_context_unknown_id():
    ok, body = run("get_incident_context", {"incident_id": "nope-9"})
    assert not ok
    assert "nope-9" in body["error"]


@pytest.mark.parametrize("bad", ["", "a b", "../etc", "x" * 65, "id;rm"])
def test_incident_context_malformed_id(bad):
    ok, body = run("get_incident_context", {"incident_id": bad})
    assert not ok
    assert body["details"][0]["field"] == "incident_id"


def test_incident_context_extra_argument_rejected():
    ok, body = run("get_incident_context", {"incident_id": "incident-001", "limit": 5})
    assert not ok
    assert body["details"][0]["field"] == "limit"


def test_related_assets_success_and_no_fixture_flag():
    ok, body = run("get_related_assets", {"asset_id": "laptop-b"})
    assert ok
    assert body["assetId"] == "laptop-b"
    ids = {r["asset"]["assetId"] for r in body["relatedAssets"]}
    assert {"router-1", "nas-1"} <= ids
    assert "isFixture" not in json.dumps(body)


def test_related_assets_unknown_asset_is_empty_not_refused():
    ok, body = run("get_related_assets", {"asset_id": "ghost-1"})
    assert ok
    assert body == {"assetId": "ghost-1", "relatedAssets": []}


@pytest.mark.parametrize("bad", ["", "a/b", "y" * 65])
def test_related_assets_malformed_id(bad):
    ok, body = run("get_related_assets", {"asset_id": bad})
    assert not ok
    assert body["details"][0]["field"] == "asset_id"


def test_related_assets_extra_argument_rejected():
    ok, body = run("get_related_assets", {"asset_id": "laptop-b", "limit": 3})
    assert not ok
    assert body["details"][0]["field"] == "limit"

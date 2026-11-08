import json

import pytest

from blacksite_agent.fixtures import FixtureDataSource
from blacksite_agent.tools import ToolContext, build_registry

ALLOWED = ("get_cv_observations", "get_data_scope")


def run(name, args):
    ctx = ToolContext(data=FixtureDataSource("test"))
    outcome = build_registry().execute(name, json.dumps(args), ALLOWED, ctx)
    return outcome.ok, json.loads(outcome.content)


def test_cv_observations_success_hides_fixture_flag():
    ok, body = run("get_cv_observations", {"asset_id": "laptop-b"})
    assert ok
    assert body["assetId"] == "laptop-b"
    assert len(body["observations"]) >= 1
    assert all(o["assetId"] == "laptop-b" for o in body["observations"])
    assert "isFixture" not in json.dumps(body)


def test_cv_observations_empty_is_valid():
    ok, body = run("get_cv_observations", {"asset_id": "router-1"})
    assert ok
    assert body == {"assetId": "router-1", "observations": []}


def test_cv_observations_unknown_asset_is_empty():
    ok, body = run("get_cv_observations", {"asset_id": "nope-9"})
    assert ok
    assert body["observations"] == []


def test_data_scope_success_hides_fixture_flag():
    ok, body = run("get_data_scope", {"asset_id": "nas-1"})
    assert ok
    assert body["dataScope"]["assetId"] == "nas-1"
    assert "isFixture" not in json.dumps(body)


def test_data_scope_unknown_asset_refused():
    ok, body = run("get_data_scope", {"asset_id": "ghost-1"})
    assert not ok
    assert "ghost-1" in body["error"]


@pytest.mark.parametrize("name", ALLOWED)
@pytest.mark.parametrize("bad", ["../etc/passwd", "a b", "", "x" * 65, "id;rm"])
def test_malformed_id_rejected(name, bad):
    ok, body = run(name, {"asset_id": bad})
    assert not ok
    assert body["error"] == "Invalid arguments."
    assert body["details"][0]["field"] == "asset_id"


@pytest.mark.parametrize("name", ALLOWED)
def test_extra_argument_rejected(name):
    ok, body = run(name, {"asset_id": "router-1", "limit": 5})
    assert not ok
    assert body["error"] == "Invalid arguments."
    assert body["details"][0]["field"] == "limit"


@pytest.mark.parametrize("name", ALLOWED)
def test_missing_argument_rejected(name):
    ok, _ = run(name, {})
    assert not ok


def test_data_scope_description_disclaims_exposure():
    schemas = build_registry().openai_schemas(("get_data_scope",))
    desc = schemas[0]["function"]["description"]
    assert "NOT evidence" in desc

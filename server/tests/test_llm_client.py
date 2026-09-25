"""LLM client options: api.anthropic.com by default, or an Anthropic-compatible gateway."""

import pytest

from cxd_server.app import _anthropic_client_kwargs


def test_default_is_the_key_alone():
    assert _anthropic_client_kwargs("k") == {"api_key": "k"}


def test_gateway_base_url_and_key_header():
    assert _anthropic_client_kwargs("k", "https://gw.example.test/anthropic", "api-key") == {
        "api_key": "k", "base_url": "https://gw.example.test/anthropic",
        "default_headers": {"api-key": "k"}}


def test_the_sdk_accepts_them():
    anthropic = pytest.importorskip("anthropic")
    client = anthropic.Anthropic(
        **_anthropic_client_kwargs("k", "https://gw.example.test/anthropic", "api-key"))
    assert str(client.base_url).rstrip("/") == "https://gw.example.test/anthropic"
    headers = client.default_headers
    assert headers["api-key"] == "k" and headers["X-Api-Key"] == "k"

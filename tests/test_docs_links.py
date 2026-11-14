"""Docs links in the app point at unversioned geometrikks.dev/docs pages."""
import re

import pytest

from geometrikks.domain.system.proxy_detection import PROXY_SETUP_DOCS_URL
from geometrikks.services.logparser.formats import NPM_DOCS_URL
from geometrikks.services.logsources.loki import LOKI_DOCS_URL

DOCS_URL = re.compile(
    r"^https://geometrikks\.dev/docs/(?!next/)(?!\d+\.\d+\.\d+/)[a-z0-9-]+(/[a-z0-9-]+)*/$"
)


@pytest.mark.parametrize("url", [PROXY_SETUP_DOCS_URL, LOKI_DOCS_URL, NPM_DOCS_URL])
def test_app_docs_urls_are_unversioned_site_urls(url: str) -> None:
    assert DOCS_URL.match(url), url

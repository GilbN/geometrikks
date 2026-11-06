"""Seed traffic into a development database: ``uv run python -m tests.seed --help``.

The seeder resolves visitor IPs through the GeoLite2 databases, so locations,
ASNs and the IP-to-place mapping match what live ingestion would write.
"""

from tests.seed.config import SeedConfig
from tests.seed.seeder import SeedStats, run_seed

__all__ = ["SeedConfig", "SeedStats", "run_seed"]

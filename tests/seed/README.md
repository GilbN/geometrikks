# Data Seeding Module

High-performance test data generation for GeoMetrikks using [Polyfactory](https://github.com/litestar-org/polyfactory).

## Quick Start

```bash
# Activate virtual environment
source .venv/bin/activate

# Preview what will be created (no database writes)
python -m tests.seed --dry-run --rows 100000

# Seed 100k rows (default)
python -m tests.seed

# Seed 1 million rows
python -m tests.seed --rows 1000000
```

## CLI Options

```
python -m tests.seed [OPTIONS]

Options:
  --rows, -r          Number of access logs to generate (default: 100000)
  --num-locations, -l Number of unique locations (default: 5000)
  --seed, -s          Random seed for reproducibility (default: 42)
  --batch-size, -b    Batch size for bulk inserts (default: 10000)
  --days, -d          Days of historical data (default: 30)
  --database-url      Override database URL
  --locations-only    Only seed locations table
  --skip-aggregates   Skip refreshing TimescaleDB continuous aggregates
  --quiet, -q         Suppress progress output
  --dry-run           Show config without seeding
```

## Examples

```bash
# Reproducible dataset with specific seed
python -m tests.seed --rows 500000 --seed 12345

# Faster inserts with larger batches (uses more memory)
python -m tests.seed --rows 1000000 --batch-size 50000

# 90 days of historical data
python -m tests.seed --rows 1000000 --days 90

# More geographic diversity
python -m tests.seed --rows 1000000 --num-locations 20000

# Custom database
python -m tests.seed --database-url "postgresql+asyncpg://user:pass@host/db"
```

## Programmatic Usage

### Bulk Seeding

```python
import asyncio
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from tests.seed import DataSeeder, SeedConfig

async def seed_database():
    engine = create_async_engine(
        "postgresql+asyncpg://geouser:geopass@localhost/geometrikks"
    )
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    config = SeedConfig(
        seed=42,
        num_locations=10_000,
        num_access_logs=1_000_000,
        num_geo_events=1_000_000,
        batch_size=50_000,
    )

    async with DataSeeder(session_factory, config) as seeder:
        stats = await seeder.seed_all()
        print(f"Created {stats['access_logs']:,} access logs")
        print(f"Rate: {stats['rows_per_second']:,.0f} rows/sec")

    await engine.dispose()

asyncio.run(seed_database())
```

### Using Factories in Tests

```python
import pytest
from tests.seed import (
    GeoLocationFactory,
    GeoEventFactory,
    AccessLogFactory,
    AccessLogDebugFactory,
    seed_factories,
)

# Seed for reproducibility
@pytest.fixture(autouse=True)
def reproducible_factories():
    seed_factories(42)


def test_location_has_valid_geohash():
    """Factory generates valid geohash."""
    location = GeoLocationFactory.build()

    assert location.geohash is not None
    assert len(location.geohash) == 8
    assert len(location.country_code) == 2


def test_access_log_realistic_distribution():
    """Status codes follow realistic distribution."""
    logs = [AccessLogFactory.build_dict() for _ in range(1000)]

    status_200 = sum(1 for l in logs if l["status_code"] == 200)
    status_4xx = sum(1 for l in logs if 400 <= l["status_code"] < 500)

    # ~75% should be 200, ~10% should be 4xx
    assert 700 < status_200 < 800
    assert 50 < status_4xx < 150


def test_geo_event_links_to_location():
    """GeoEvent correctly references location."""
    event = GeoEventFactory.build_dict(location_id=42)

    assert event["location_id"] == 42
    assert event["ip_address"] is not None
    assert event["hostname"] == "geometrikks.local"


def test_malformed_debug_log():
    """Debug factory generates malformed entries."""
    debug = AccessLogDebugFactory.build_dict(is_malformed=True)

    assert debug["is_malformed"] is True
    assert debug["parse_error"] == "Malformed request line"
```

### Factory Methods

Each factory provides:

| Method | Returns | Use Case |
|--------|---------|----------|
| `.build()` | Model instance | Unit tests, single records |
| `.build_dict()` | Dictionary | Bulk inserts, performance |
| `.batch(n)` | List of instances | Multiple test records |
| `.batch_dicts(n)` | List of dicts | Bulk seeding (GeoLocationFactory only) |

## Data Distributions

The generators create realistic data distributions:

| Data | Distribution | Notes |
|------|--------------|-------|
| IP addresses | Zipf (α=1.5) | Few IPs generate most traffic |
| Locations | Zipf (α=1.2) | Geographic clustering |
| Status codes | Weighted | 75% 200, 5% 304, 10% 4xx, etc. |
| Request time | Log-normal | Most fast, long tail of slow |
| Bytes sent | Log-normal | ~3KB median, varies by status |
| HTTP methods | Weighted | 85% GET, 8% POST, etc. |

## Configuration

```python
from datetime import datetime, timedelta, timezone
from tests.seed import SeedConfig

config = SeedConfig(
    # Reproducibility
    seed=42,

    # Volume
    num_locations=5_000,
    num_access_logs=100_000,
    num_geo_events=100_000,

    # Performance
    batch_size=10_000,

    # Time range
    start_date=datetime.now(timezone.utc) - timedelta(days=30),
    end_date=datetime.now(timezone.utc),

    # Data characteristics
    malformed_ratio=0.02,  # 2% malformed requests
    ip_zipf_exponent=1.5,  # IP concentration
    location_zipf_exponent=1.2,  # Geographic clustering

    # Output
    verbose=True,
)
```

## Performance Tips

1. **Increase batch size** for faster inserts (uses more memory):
   ```bash
   python -m tests.seed --rows 1000000 --batch-size 50000
   ```

2. **Skip aggregate refresh** if you'll do it manually later:
   ```bash
   python -m tests.seed --rows 1000000 --skip-aggregates
   ```

3. **Disable indexes** before bulk load, recreate after (manual SQL).

4. **Expected throughput**: ~10,000-50,000 rows/sec depending on hardware and batch size.

## Module Structure

```
tests/seed/
├── __init__.py      # Public exports
├── __main__.py      # CLI entry point
├── config.py        # SeedConfig dataclass
├── factories.py     # Polyfactory model factories
├── generators.py    # DataSeeder and distribution helpers
└── README.md        # This file
```

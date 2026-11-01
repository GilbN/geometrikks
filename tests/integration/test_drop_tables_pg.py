"""DROP list tables: created by the migrations, GiST-indexed, queryable by containment."""
import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

pytestmark = pytest.mark.anyio


@pytest.fixture()
async def clean_drop_tables(pg_engine):
    async with pg_engine.begin() as connection:
        await connection.execute(text("DELETE FROM drop_networks"))
        await connection.execute(text("DELETE FROM drop_asns"))
        await connection.execute(text("DELETE FROM drop_list_state"))
    yield


async def test_tables_and_gist_index_exist(pg_engine):
    async with pg_engine.connect() as connection:
        table_names = (
            await connection.execute(
                text(
                    "SELECT table_name FROM information_schema.tables "
                    "WHERE table_name IN ('drop_networks', 'drop_asns', 'drop_list_state')"
                )
            )
        ).scalars().all()
        index_definition = (
            await connection.execute(
                text("SELECT indexdef FROM pg_indexes WHERE indexname = 'ix_drop_networks_cidr_gist'")
            )
        ).scalar_one()
    assert set(table_names) == {"drop_networks", "drop_asns", "drop_list_state"}
    assert "USING gist" in index_definition
    assert "inet_ops" in index_definition


async def test_containment_matches_an_address_inside_a_listed_network(pg_engine, clean_drop_tables):
    async with pg_engine.begin() as connection:
        await connection.execute(
            text("INSERT INTO drop_networks (cidr, sbl_id, rir) VALUES ('45.148.10.0/24', 'SBL678435', 'ripencc')")
        )
        listed_sbl_id = (
            await connection.execute(
                text("SELECT sbl_id FROM drop_networks WHERE CAST(:ip AS inet) <<= cidr"),
                {"ip": "45.148.10.183"},
            )
        ).scalar_one()
        unlisted_count = (
            await connection.execute(
                text("SELECT count(*) FROM drop_networks WHERE CAST(:ip AS inet) <<= cidr"),
                {"ip": "45.148.11.1"},
            )
        ).scalar_one()
    assert listed_sbl_id == "SBL678435"
    assert unlisted_count == 0


async def test_list_state_rejects_an_unknown_feed(pg_engine, clean_drop_tables):
    with pytest.raises(IntegrityError):
        async with pg_engine.begin() as connection:
            await connection.execute(text("INSERT INTO drop_list_state (feed) VALUES ('v5')"))


async def test_asn_and_list_state_round_trip(pg_engine, clean_drop_tables):
    async with pg_engine.begin() as connection:
        await connection.execute(
            text(
                "INSERT INTO drop_asns (asn, name, country_code, rir, domain) "
                "VALUES (9009, 'M247', 'RO', 'ripencc', 'm247.com')"
            )
        )
        await connection.execute(
            text("INSERT INTO drop_list_state (feed, record_count, checked_at) VALUES ('asn', 1, now())")
        )
        asn_name = (await connection.execute(text("SELECT name FROM drop_asns WHERE asn = 9009"))).scalar_one()
        record_count = (
            await connection.execute(text("SELECT record_count FROM drop_list_state WHERE feed = 'asn'"))
        ).scalar_one()
    assert asn_name == "M247"
    assert record_count == 1

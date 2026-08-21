# Vendored ASN classification data

## hosting_asns.csv

A vendored copy of the community-maintained
[bad-asn-list](https://github.com/brianhama/bad-asn-list), a catalogue of
autonomous systems belonging to hosting, datacenter, and VPN operators.
Networks on this list get the Hosting badge in the analytics views; every
other network shows as Other, which means unclassified, not residential.

- Source: <https://raw.githubusercontent.com/brianhama/bad-asn-list/master/bad-asn-list.csv>
- Upstream filename: `bad-asn-list.csv` (renamed on vendoring)
- Retrieved: 2026-08-18
- License: MIT, Copyright (c) 2025 Brian Hamachek (see `hosting_asns.LICENSE`)

The file has a `ASN,Entity` header. Some ASNs appear more than once under
different entity spellings; the loader in `../asn_classification.py`
deduplicates on ASN, first row wins. Classification happens at read time,
so refreshing this file applies retroactively to all existing data with no
backfill or aggregate rebuild.

Upstream's stated purpose is "ASNs you may want to block" (abuse-oriented),
so a few entries are not hosting providers in the literal sense
(universities, a bank). This is why the UI labels the category Hosting
rather than claiming Datacenter outright.

To refresh:

```bash
curl -fsSL https://raw.githubusercontent.com/brianhama/bad-asn-list/master/bad-asn-list.csv \
  -o geometrikks/domain/analytics/data/hosting_asns.csv
```

Then update the retrieval date above and check the license upstream has not
changed.

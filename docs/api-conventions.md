# API conventions

The wire-format policy for the GeoMetrikks HTTP API, decided for 0.7.0.
`tests/test_error_contract.py` and the generated OpenAPI document
(`resources/generated/openapi.json`) pin these rules; change them only with a
coordinated client regeneration and a changelog migration note.

## Versioning

Every REST endpoint lives under `/api/v1`, mounted as a single Litestar
`Router` in `geometrikks/server/routes.py`, which stays the one explicit
registration point. Controllers live in their vertical domain packages
(`geometrikks/domain/<domain>/controllers*`) and own only their domain
segment (`/analytics`, `/crowdsec`, ...); the router supplies the version
prefix. Everything under `/api/v1` requires the session cookie except
`/api/v1/auth/login` (with `APP_AUTH_DISABLED=true` the auth endpoints are
not registered at all). Outside the router:

- `/health` and `/health/ready`: unauthenticated probe endpoints.
- `/ws/live`, `/ws/logs`, `/ws/crowdsec`: WebSocket feeds
  (`geometrikks/domain/realtime/`), session-authenticated during the
  handshake.
- `/schema` (deliberately unauthenticated), `/sw.js`, and the SPA shell.

## Field casing: camelCase

All request and response JSON fields are camelCase on the wire; Python
attributes stay snake_case.

- SQLAlchemy-model responses use Advanced Alchemy DTOs with
  `rename_strategy="camel"`.
- Bespoke request and response models are msgspec Structs declared with
  `rename="camel"` (see `geometrikks/domain/geo/schemas.py` for the idiom);
  they live in each domain package's `schemas.py`/`dtos.py` or next to their
  controller. Digit-adjacent names pin their wire form explicitly with
  `msgspec.field(name=...)`: `status2xx`, `requestCount24h`.
- Query parameters carry explicit camelCase `name=` declarations
  (`fromTimestamp`, `startDate`, `ipAddressNotIn`, ...); shared aliases live
  in `geometrikks/lib/parameters.py`.
- Path parameters are URL segments, not fields, and stay snake_case
  (`{location_id}`, `{job_id}`).
- WebSocket frame payloads are a separate contract and are not covered by
  this policy (revisited with the realtime refactor).
- Data values are exempt: `SettingFieldView.key` deliberately carries Python
  settings field names like `home_latitude`.

## Error envelope: Litestar native

Errors use Litestar's native HTTP-exception envelope, unchanged:

```json
{"status_code": 404, "detail": "Not Found"}
```

- `extra` appears additionally on request-validation errors with the
  per-field breakdown.
- The envelope keys are the framework's and stay snake_case; the camelCase
  policy applies to success payloads only.
- Domain exceptions (`DomainValidationError`, CrowdSec errors) are translated
  centrally in `geometrikks/server/exceptions.py` into the same envelope.
- API-path 404s render this envelope too; non-API 404s (static-asset misses)
  keep litestar-vite's empty-body behavior.

## Operation IDs

OpenAPI operation IDs use Litestar's default path-derived naming
(`ApiV1AnalyticsSummaryGetSummary`). Generated TypeScript client method names
hang off them, so route moves must keep full paths stable or accept a
client-wide rename.

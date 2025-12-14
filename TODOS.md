# TODOS

## API

- [] make the fucking api...
- [] Validate log line endpoint ?
- [] Manual IP lookup (Use geoip reader)

## Parser

- [x] Create a LogIngestionService that orchestrates LogParser + repositories

## Frontend

- [] Decide frontend framework..

## Backend

- [x] Get backend up and running
- [x] Add logs repositories
- [x] Add logs controllers

## Database

- [] Retention..

### Models

- Normalization
  - tables could be massive, look into normalization for access logs etc.
  - user_agents, urls, host, method ?

## MaxMind

- [] Decide on shipping with GeoLite database.

## ASGI

- [] uvicorn or granian?

## GeoAlchemy2

- Look into geoalchemy2 https://github.com/cemrehancavdar/litestar-geoalchemy

https://geoalchemy-2.readthedocs.io/en/latest/index.html

- [x] Look into geoalchemy2
- [x] Add `geom` column to `GeoLocation` with GiST index
- [] Add `/api/events/geojson` endpoint for mapping clients
- [] Evaluate Leaflet vs Mapbox etc for frontend visualization
- [] Add spatial query endpoints (radius search, bounding box)

### Vector Raster maps

https://github.com/maptiler/tileserver-gl?tab=readme-ov-file
https://github.com/maplibre/martin
https://python-visualization.github.io/folium/latest/index.html

## Caching

### Redis Cache
- [] Look at implementing Redis caching for LogParser
- [] Must? be optional.
- [] Same with the litestar app, need to make the Redis cache optional

## Background tasks

- [] APCSCheduler, celery, litestar?
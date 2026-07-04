# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Standardized on bun as the JS package manager; removed npm lockfile.
- Pinned all frontend dependencies (previously `"latest"`).
- Removed duplicate alembic scaffold; `migrations/` is canonical.
- Removed bundled MaxMind GeoLite2 databases from the repository and its
  history (GeoLite2 EULA); tests use the redistributable MaxMind test database.

### Fixed

- Vite `@` alias resolved to the filesystem root instead of `resources/`.

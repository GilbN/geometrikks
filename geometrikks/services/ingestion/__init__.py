"""Log ingestion service - handles persistence via repositories."""
from .service import LogIngestionService, LogInput, UnavailableSource

__all__ = ["LogIngestionService", "LogInput", "UnavailableSource"]

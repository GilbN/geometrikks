from __future__ import annotations

from geometrikks.config.settings import get_settings
from geometrikks.server.core import create_app
from dotenv import load_dotenv

load_dotenv()

if __name__ == "__main__":
    import uvicorn
    
    settings = get_settings()
    uvicorn.run(
        "geometrikks.server.core:create_app",
        host=settings.api.host,
        port=settings.api.port,
        reload=settings.api.reload,
        workers=settings.api.workers,
        log_level=settings.api.log_level,
    )
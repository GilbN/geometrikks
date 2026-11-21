from advanced_alchemy.repository import SQLAlchemyAsyncRepository

from geometrikks.domain.muted_ips.models import MutedIp


class MutedIpRepository(SQLAlchemyAsyncRepository[MutedIp]):
    model_type = MutedIp

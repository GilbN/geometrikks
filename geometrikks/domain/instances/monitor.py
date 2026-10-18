"""Log agent state changes seen by the head's scheduled check."""
from geometrikks.domain.instances.evaluation import HeadIdentity, InstanceEvaluation
from geometrikks.server.logging import get_logger

logger = get_logger(__name__)

NOT_CHECKING_IN = "instance-not-checking-in"

_PROBLEM_EVENTS: dict[str, tuple[str, str]] = {
    NOT_CHECKING_IN: ("agent_down", "warning"),
    "instance-schema-behind": ("agent_schema_mismatch", "warning"),
    "instance-schema-ahead": ("agent_schema_mismatch", "warning"),
    "instance-version-mismatch": ("agent_version_mismatch", "info"),
    "instance-name-conflict": ("agent_name_conflict", "info"),
    "instance-restart-loop": ("agent_restart_loop", "info"),
}


class InstanceMonitor:
    """Remembers each agent's problem ids between checks and logs what changed.

    The first observation only records state, so a head restart does not
    replay every standing problem as news.
    """

    def __init__(self) -> None:
        self._problem_ids_by_name: dict[str, frozenset[str]] | None = None

    def observe(self, evaluations: list[InstanceEvaluation], head: HeadIdentity) -> None:
        current = {
            evaluation.row.instance_name: frozenset(problem.id for problem in evaluation.problems)
            for evaluation in evaluations
            if not evaluation.is_self
        }
        previous = self._problem_ids_by_name
        self._problem_ids_by_name = current
        if previous is None:
            return

        for evaluation in evaluations:
            if evaluation.is_self:
                continue
            name = evaluation.row.instance_name
            context = {
                "instance_name": name,
                "mode": evaluation.row.mode,
                "app_version": evaluation.row.app_version,
                "schema_revision": evaluation.row.schema_revision,
                "head_app_version": head.app_version,
                "head_schema_revision": head.schema_revision,
            }
            if name not in previous:
                logger.info("agent_seen", **context)
            before = previous.get(name, frozenset())
            after = current[name]
            if NOT_CHECKING_IN in before and NOT_CHECKING_IN not in after:
                logger.info("agent_recovered", **context)
            new_events = {
                _PROBLEM_EVENTS[problem_id] for problem_id in after - before if problem_id in _PROBLEM_EVENTS
            }
            for event, level in sorted(new_events):
                getattr(logger, level)(event, **context)

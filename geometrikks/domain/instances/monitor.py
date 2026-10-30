"""Log agent state changes seen by the head's scheduled check."""
from geometrikks.domain.instances.evaluation import WRITES_FAILING_ID, HeadIdentity, InstanceEvaluation
from geometrikks.lib.advisories import INGESTION_WRITE_FAILURES_ID
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
        self._writes_severity_by_name: dict[str, str] = {}

    def observe(self, evaluations: list[InstanceEvaluation], head: HeadIdentity) -> None:
        current = {
            evaluation.row.instance_name: frozenset(problem.id for problem in evaluation.problems)
            for evaluation in evaluations
            if not evaluation.is_self
        }
        previous = self._problem_ids_by_name
        self._problem_ids_by_name = current
        previous_writes_severity = self._writes_severity_by_name
        self._writes_severity_by_name = {}
        for evaluation in evaluations:
            if evaluation.is_self:
                continue
            name = evaluation.row.instance_name
            severity = _writes_failing_severity(evaluation, previous_writes_severity.get(name))
            if severity is not None:
                self._writes_severity_by_name[name] = severity
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
            _log_writes_change(
                evaluation,
                previous_writes_severity.get(name),
                self._writes_severity_by_name.get(name),
                context,
            )


def _writes_failing_severity(evaluation: InstanceEvaluation, previous_severity: str | None) -> str | None:
    """How badly writes are failing now, for logging; None when they are not.

    The agent's own critical write-failure advisory counts too: it is the only
    sign while the 5-minute counts are unknown, in an agent's first minutes
    and after its ingestion service is rebuilt. Unknown counts never mean
    recovery, so the previous state carries over until they are known again.
    """
    for problem in evaluation.problems:
        if problem.id == WRITES_FAILING_ID:
            return problem.severity
    for problem in evaluation.problems:
        if problem.id == INGESTION_WRITE_FAILURES_ID and problem.severity == "critical":
            return "critical"
    payload = evaluation.payload
    if evaluation.checking_in and (payload is None or payload.failed_5m is None):
        return previous_severity
    return None


def _log_writes_change(
    evaluation: InstanceEvaluation,
    previous_severity: str | None,
    severity: str | None,
    context: dict[str, str],
) -> None:
    """Log failing writes when they start or turn critical, and when they stop.

    An agent that stops checking in loses the problem too, but agent_down
    already says so.
    """
    payload = evaluation.payload
    counts = {
        "failed_5m": payload.failed_5m if payload is not None else None,
        "written_5m": payload.written_5m if payload is not None else None,
    }
    escalated = previous_severity == "warning" and severity == "critical"
    if severity is not None and (previous_severity is None or escalated):
        logger.warning("agent_writes_failing", severity=severity, **counts, **context)
    elif severity is None and previous_severity is not None and evaluation.checking_in:
        logger.info("agent_writes_recovered", severity=previous_severity, **counts, **context)

import { SEVERITY_LABEL, STATUS_LABEL } from '../format';
import type { Severity, Status } from '../../../shared/types';

export function SeverityBadge({ severity }: { severity: Severity }) {
  return <span className={`badge sev sev-${severity}`}>{SEVERITY_LABEL[severity]}</span>;
}

export function StatusBadge({ status }: { status: Status }) {
  return <span className={`badge status status-${status}`}>{STATUS_LABEL[status]}</span>;
}

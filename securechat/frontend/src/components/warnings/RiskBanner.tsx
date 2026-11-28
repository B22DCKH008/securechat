import type { StoredRisk } from '../../storage';
import { notesForStored } from './riskText';

export function RiskBanner({ risk }: { risk?: StoredRisk }) {
  const notes = notesForStored(risk);
  if (notes.length === 0) return null;
  return (
    <ul className="risk-notes" aria-label="Cảnh báo an toàn">
      {notes.map((n) => (
        <li key={n.text} className={`risk risk-${n.kind}`}>
          {n.kind === 'danger' ? '⚠ ' : n.kind === 'warning' ? '! ' : 'ⓘ '}
          {n.text}
        </li>
      ))}
    </ul>
  );
}

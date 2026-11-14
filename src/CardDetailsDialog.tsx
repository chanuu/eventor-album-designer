import { CheckIcon, XIcon } from 'lucide-react';
import { useState } from 'react';
import type { CardDetails } from './api';
import CardDetailsForm from './CardDetailsForm';

/** Changes the couple's details. Saving rewrites the words made from them on every card. */
export default function CardDetailsDialog({
  value, onSave, onClose,
}: {
  value: CardDetails;
  onSave: (next: CardDetails) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(value);
  return (
    <div className="modal-back" role="dialog" aria-modal="true" aria-label="Card details">
      <div className="modal modal-details">
        <h2>Card details</h2>
        <p className="muted">These fill in the names, date and studio line on every card. Words you have typed over by hand are left alone.</p>
        <CardDetailsForm value={draft} onChange={setDraft} />
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}><XIcon aria-hidden="true" />Cancel</button>
          <button type="button" className="btn-primary" onClick={() => onSave(draft)}><CheckIcon aria-hidden="true" />Save details</button>
        </div>
      </div>
    </div>
  );
}

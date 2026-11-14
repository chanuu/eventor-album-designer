import type { CardDetails } from './api';

/** The couple's details, which fill in the words on every card. */
export default function CardDetailsForm({
  value, onChange,
}: {
  value: CardDetails;
  onChange: (next: CardDetails) => void;
}) {
  const field = (key: keyof CardDetails, label: string, placeholder: string, type = 'text') => (
    <label className="field">
      {label}
      <input
        className="input"
        type={type}
        name={key}
        placeholder={placeholder}
        maxLength={120}
        value={value[key]}
        onChange={(e) => onChange({ ...value, [key]: e.target.value })}
      />
    </label>
  );

  return (
    <div className="card-details">
      {field('first_name', 'First name', 'Nimal')}
      {field('second_name', 'Second name', 'Sachini')}
      {field('date', 'Date', '', 'date')}
      {field('venue', 'Venue', 'Galle Face Hotel')}
      {field('mua', 'Make-up artist (MUA)', 'Salon name and number')}
      {field('studio', 'Your studio line', 'Studio name | phone number')}
    </div>
  );
}

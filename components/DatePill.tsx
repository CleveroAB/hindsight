'use client';

// A period date shown as "Jan 1, 2016" in a pill. Clicking opens the native
// date picker via an invisible <input type="date"> overlaid on the pill, so
// the visual stays exactly on-design in both themes.

import { useRef } from 'react';
import { formatDatePill } from '@/lib/format';

export interface DatePillProps {
  iso: string;
  onChange: (iso: string) => void;
  disabled?: boolean;
  ariaLabel?: string;
}

export default function DatePill({ iso, onChange, disabled = false, ariaLabel }: DatePillProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <span style={{ position: 'relative', display: 'inline-flex', opacity: disabled ? 0.55 : 1 }}>
      <span
        className="num"
        style={{
          border: '1px solid var(--border-input)',
          background: 'var(--surface)',
          borderRadius: 'var(--r-pill)',
          padding: '8px 14px',
          fontSize: 14,
          color: 'var(--text)',
          whiteSpace: 'nowrap',
        }}
      >
        {formatDatePill(iso)}
      </span>
      <input
        ref={inputRef}
        type="date"
        value={iso}
        disabled={disabled}
        aria-label={ariaLabel ?? 'Change date'}
        onClick={() => {
          try {
            inputRef.current?.showPicker();
          } catch {
            // Some browsers require a direct user gesture on the field itself;
            // the field is under the cursor, so the click still focuses it.
          }
        }}
        onChange={(e) => {
          if (e.target.value) onChange(e.target.value);
        }}
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          opacity: 0,
          border: 'none',
          padding: 0,
          margin: 0,
          cursor: disabled ? 'default' : 'pointer',
        }}
      />
    </span>
  );
}

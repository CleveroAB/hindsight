'use client';

export interface CopyToastProps {
  message: string;
  tone?: 'success' | 'error';
}

/** Shared confirmation toast for copy actions across the strategy view. */
export default function CopyToast({ message, tone = 'success' }: CopyToastProps) {
  const success = tone === 'success';

  return (
    <div
      role="status"
      aria-live="polite"
      className="hs-fade-in"
      style={{
        position: 'fixed',
        left: '50%',
        bottom: 28,
        transform: 'translateX(-50%)',
        display: 'flex',
        alignItems: 'center',
        gap: 9,
        padding: '10px 14px',
        borderRadius: 'var(--r-round)',
        background: 'var(--surface)',
        border: '1px solid var(--border-chrome)',
        boxShadow: '0 14px 40px rgba(0,0,0,0.22)',
        color: 'var(--text)',
        fontSize: 13,
        fontWeight: 600,
        whiteSpace: 'nowrap',
        zIndex: 100,
        pointerEvents: 'none',
      }}
    >
      <span
        style={{
          width: 20,
          height: 20,
          borderRadius: '50%',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: success ? 'rgba(31,190,110,0.14)' : 'rgba(217,73,79,0.14)',
          color: success ? 'var(--green-text)' : 'var(--red)',
        }}
      >
        {success ? '✓' : '!'}
      </span>
      {message}
    </div>
  );
}

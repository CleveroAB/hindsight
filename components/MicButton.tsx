'use client';

// Microphone button for dictating a strategy instead of typing it. Purely
// presentational — the composer owns the dictation state via useDictation and
// this just toggles it. While listening the icon turns red and pulses so it's
// unmistakable that the mic is hot. Render only when dictation is supported.

export interface MicButtonProps {
  listening: boolean;
  onToggle: () => void;
  disabled?: boolean;
  /** Button edge length; icon scales with it. */
  size?: number;
}

export default function MicButton({
  listening,
  onToggle,
  disabled = false,
  size = 26,
}: MicButtonProps) {
  const icon = Math.round(size * 0.58);

  return (
    <>
      <style>{`@keyframes hs-mic-pulse{0%,100%{opacity:1}50%{opacity:.35}}`}</style>
      <button
        type="button"
        onClick={onToggle}
        disabled={disabled}
        aria-label={listening ? 'Stop dictation' : 'Dictate'}
        aria-pressed={listening}
        title={listening ? 'Stop dictation' : 'Dictate a strategy'}
        style={{
          width: size,
          height: size,
          borderRadius: 7,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flex: 'none',
          opacity: disabled ? 0.45 : 1,
          cursor: disabled ? 'default' : 'pointer',
        }}
      >
        {/* Microphone, drawn to match the paperclip / ⓘ icon weight. */}
        <svg
          width={icon}
          height={icon}
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden="true"
          style={listening ? { animation: 'hs-mic-pulse 1.2s ease-in-out infinite' } : undefined}
        >
          <rect
            x="6"
            y="1.5"
            width="4"
            height="7.5"
            rx="2"
            stroke={listening ? 'var(--red)' : 'var(--icon)'}
            strokeWidth="1.3"
          />
          <path
            d="M3.5 7.5a4.5 4.5 0 0 0 9 0M8 12v2.5"
            stroke={listening ? 'var(--red)' : 'var(--icon)'}
            strokeWidth="1.3"
            strokeLinecap="round"
          />
        </svg>
      </button>
    </>
  );
}

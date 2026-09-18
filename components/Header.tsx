// 64px app header: wordmark left (plus a "← Strategies" back affordance where
// there's something to go back to), settings + theme controls right. Bottom
// hairline only in 'withBack'.
//
// The back affordance is a Link to "/" by default, but the home page's composer
// isn't a route — it's a mode of "/" — so an `onBack` callback renders the same
// thing as a button. Same pixels either way; only the mechanism differs.

'use client';

import Link from 'next/link';
import SettingsControl from './SettingsControl';
import ThemeToggle from './ThemeToggle';
import SignOutControl from './SignOutControl';

export interface HeaderProps {
  /**
   * 'withBack' adds the bottom hairline and (absent `onBack`) a link home.
   * 'signedOut' is the sign-in page: wordmark and theme control only, since
   * settings and sign-out need a session the visitor doesn't have yet.
   */
  variant: 'plain' | 'withBack' | 'signedOut';
  /** Renders the back affordance as a button running this instead of navigating. */
  onBack?: () => void;
}

const backStyle = { fontSize: 13, color: 'var(--muted)' } as const;

export default function Header({ variant, onBack }: HeaderProps) {
  return (
    <header
      className="hs-app-header"
      style={{
        height: 64,
        flex: 'none',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '0 28px',
        borderBottom: variant === 'withBack' ? '1px solid var(--hairline)' : 'none',
      }}
    >
      <div className="hs-header-left" style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
        <Link
          href="/"
          style={{
            fontWeight: 700,
            fontSize: 16,
            letterSpacing: '-0.02em',
            color: 'var(--text)',
          }}
        >
          Hindsight
        </Link>
        {onBack ? (
          <button type="button" onClick={onBack} style={backStyle}>
            ← Strategies
          </button>
        ) : variant === 'withBack' ? (
          <Link href="/" style={backStyle}>
            ← Strategies
          </Link>
        ) : null}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        {variant !== 'signedOut' && (
          <>
            <SignOutControl />
            <SettingsControl />
          </>
        )}
        <ThemeToggle />
      </div>
    </header>
  );
}

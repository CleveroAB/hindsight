'use client';

// Sign-in. Two steps in one box: email in, then the 8-digit code. Laid out
// exactly like the home composer so the door looks like the house.

import { useEffect, useRef, useState, type FormEvent } from 'react';
import Header from '@/components/Header';
import styles from './login.module.css';

export default function LoginForm() {
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const fieldRef = useRef<HTMLInputElement>(null);

  // Refocus the (new) field whenever the step changes.
  useEffect(() => {
    fieldRef.current?.focus();
  }, [sent]);

  async function sendCode() {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const response = await fetch('/api/auth/request-code', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'The code could not be sent.');
      setSent(true);
      setCode('');
      setNotice(body.message);
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Please try again.');
    } finally { setBusy(false); }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!sent) return sendCode();
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/auth/verify-code', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'The code could not be verified.');
      const next = new URLSearchParams(window.location.search).get('next');
      // Never redirect to a caller-selected external site after authentication.
      const destination = next ? new URL(next, window.location.origin) : new URL('/', window.location.origin);
      window.location.assign(destination.origin === window.location.origin && !destination.pathname.startsWith('/login')
        ? destination.pathname + destination.search : '/');
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Please try again.');
      setBusy(false);
    }
  }

  const canSubmit = !busy && (sent ? code.length === 8 : email.trim().length > 0);
  const hint = busy
    ? (sent ? 'Signing in…' : 'Sending…')
    : (sent ? 'The code expires in 10 minutes' : 'Enter to continue');

  return (
    <div className={styles.page}>
      <Header variant="signedOut" />
      <main className={`${styles.main} hs-fade-in`}>
        <h1 className={styles.title}>{sent ? 'Check your email' : 'Sign in'}</h1>

        <form className={styles.box} onSubmit={submit}>
          {!sent ? (
            <input
              ref={fieldRef}
              className={styles.field}
              type="email"
              name="email"
              aria-label="Email address"
              placeholder="Email address"
              autoComplete="email"
              required
              maxLength={254}
              value={email}
              disabled={busy}
              onChange={(event) => setEmail(event.target.value)}
            />
          ) : (
            <input
              ref={fieldRef}
              className={`${styles.field} ${styles.code}`}
              type="text"
              name="code"
              aria-label="Sign-in code"
              placeholder="8-digit code"
              inputMode="numeric"
              autoComplete="one-time-code"
              required
              pattern="[0-9]{8}"
              maxLength={8}
              value={code}
              disabled={busy}
              onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 8))}
            />
          )}
          <div className={styles.row}>
            {error ? (
              <div className={styles.error} role="alert">{error}</div>
            ) : (
              <div className={styles.hint}>{hint}</div>
            )}
            <button
              className={styles.send}
              type="submit"
              aria-label={sent ? 'Sign in' : 'Send sign-in code'}
              disabled={!canSubmit}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path
                  d="M12 19V6M6 12l6-6 6 6"
                  stroke="var(--primary-text)"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          </div>
        </form>

        {sent ? (
          <>
            <div className={styles.caption} role="status">
              {notice || `A sign-in code was sent to ${email}.`}
            </div>
            <div className={styles.links}>
              <button className={styles.link} type="button" onClick={sendCode} disabled={busy}>
                Send a new code
              </button>
              <button
                className={styles.link}
                type="button"
                disabled={busy}
                onClick={() => { setSent(false); setCode(''); setError(''); setNotice(''); }}
              >
                Change email
              </button>
            </div>
          </>
        ) : (
          <div className={styles.caption}>
            A one-time code is emailed to you. Private workspace, no registration.
          </div>
        )}
      </main>
    </div>
  );
}

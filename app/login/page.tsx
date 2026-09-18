import type { Metadata } from 'next';
import LoginForm from './LoginForm';

export const metadata: Metadata = { title: 'Sign in · Hindsight', robots: { index: false, follow: false } };
export default function LoginPage() {
  return <LoginForm />;
}

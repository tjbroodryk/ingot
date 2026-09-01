'use client';

import { useCallback, useEffect, useState } from 'react';
import type { Credentials } from './ingot-api';

/**
 * The session, which is a key and the account it belongs to.
 *
 * There is nothing else to it. Ingot authenticates a bearer key on every
 * request and holds no session of its own, so "signed in" here means "we are
 * holding a key that worked a moment ago" — and the only honest way to
 * establish that is to have made a call with it, which `SignIn` does.
 *
 * `sessionStorage`, not `localStorage`, and that is the whole reason this file
 * exists rather than a `useState` in the page:
 *
 * - It survives a reload and a navigation between the docs and the dashboard,
 *   which is what makes this feel like being signed in at all.
 * - It dies with the tab. A key that outlives the tab on a shared machine is a
 *   key somebody else can open the dashboard and use, and this one is not
 *   scoped, not short-lived, and cannot be revoked from here.
 *
 * Both accessors are wrapped, because a browser set to block site data throws
 * on the accessor itself rather than returning null — and a dashboard that
 * cannot remember a key should still let you type one in.
 */

const STORAGE_KEY = 'ingot.session';

export type Session = Credentials | null;

export interface SessionHandle {
  readonly session: Session;
  /** Whether storage has been read yet. Render nothing until it has. */
  readonly ready: boolean;
  readonly signIn: (credentials: Credentials) => void;
  readonly signOut: () => void;
}

export function useSession(): SessionHandle {
  const [session, setSession] = useState<Session>(null);
  const [ready, setReady] = useState(false);

  // Read in an effect rather than in the initialiser: this component is
  // prerendered to static HTML at build time, where `sessionStorage` does not
  // exist, and reading it during render is a hydration mismatch even when it
  // does. `ready` is what stops the sign-in form flashing for someone who is
  // already holding a key.
  useEffect(() => {
    setSession(read());
    setReady(true);
  }, []);

  const signIn = useCallback((credentials: Credentials) => {
    write(credentials);
    setSession(credentials);
  }, []);

  const signOut = useCallback(() => {
    write(null);
    setSession(null);
  }, []);

  return { session, ready, signIn, signOut };
}

function read(): Session {
  try {
    const stored = window.sessionStorage.getItem(STORAGE_KEY);
    if (!stored) return null;

    const parsed: unknown = JSON.parse(stored);
    return isCredentials(parsed) ? parsed : null;
  } catch {
    // Blocked storage, or something else wrote nonsense under our key.
    return null;
  }
}

function write(credentials: Credentials | null): void {
  try {
    if (credentials) window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(credentials));
    else window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to do about it, and nothing worth interrupting a sign-in for:
    // the session lives in React state either way, it just will not survive a
    // reload.
  }
}

/** Parsed at the edge — what came out of storage is a string, not a `Credentials`. */
function isCredentials(value: unknown): value is Credentials {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;

  return (
    typeof candidate.account === 'string' &&
    candidate.account.length > 0 &&
    typeof candidate.key === 'string' &&
    candidate.key.length > 0
  );
}

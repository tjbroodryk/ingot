'use client';

import { useCallback, useEffect, useState } from 'react';
import type { Credentials } from './ingot-api';

/**
 * The session: a key and the account it belongs to, held in `sessionStorage`
 * so it survives a reload but dies with the tab. Accessors are wrapped, since
 * blocked site data throws on access rather than returning null.
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

  // Read in an effect, not the initialiser: `sessionStorage` is absent during
  // static prerender and reading it in render is a hydration mismatch.
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
    // Session lives in React state either way; it just will not survive a reload.
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

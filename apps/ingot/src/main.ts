import 'reflect-metadata';
import { loadEnv } from './config/env.js';
import { serve } from './serve.js';

async function bootstrap(): Promise<void> {
  /**
   * The whole environment, parsed before anything is built.
   *
   * First because the auth mode is a fact the module graph is assembled
   * *from* — `imports` are evaluated before the container exists, so nothing
   * inside it can be asked. It also means any bad value, anywhere, throws with
   * nothing listening, rather than leaving a service that accepts connections
   * and refuses every one of them. Bun loads `.env` before this file runs, and
   * a deployment sets real environment variables.
   */
  const env = loadEnv();

  await serve(env, 'Ingot');
}

void bootstrap();

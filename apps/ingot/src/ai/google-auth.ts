import { GoogleAuth } from 'google-auth-library';
import { DependencyUnavailable } from '../shared/domain/index.js';
import { upstream } from '../observability/index.js';

/** Vertex takes the broad platform scope; there is no narrower one for it. */
export const SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

/** Advice for a missing or unprivileged Vertex credential. Shared so the two paths cannot drift. */
export const VERTEX_CREDENTIAL_ADVICE =
  'This service authenticates with Application Default Credentials — under Kubernetes that ' +
  "is the workload identity bound to the pod's service account, otherwise " +
  'GOOGLE_APPLICATION_CREDENTIALS pointing at a key file. The service account needs ' +
  'roles/aiplatform.user on the project in INGOT_GCP_PROJECT.';

/**
 * Bearer tokens for Vertex AI from Application Default Credentials; no key to
 * configure. Not cached here — the library holds one until shortly before it expires.
 */
export class GoogleCredentials {
  private readonly auth: GoogleAuth;

  constructor(auth?: GoogleAuth) {
    this.auth = auth ?? new GoogleAuth({ scopes: [SCOPE] });
  }

  async token(): Promise<string> {
    const token = await upstream('vertex', 'access_token', () => this.auth.getAccessToken()).catch(
      (error: unknown) => {
        throw new DependencyUnavailable(
          'vertex ai',
          'Could not get an access token for Vertex AI. This service authenticates with ' +
            'Application Default Credentials — under Kubernetes that is the workload identity ' +
            "bound to the pod's service account, otherwise GOOGLE_APPLICATION_CREDENTIALS " +
            `pointing at a key file. (${firstLine(error)})`,
          { cause: error },
        );
      },
    );

    if (!token) {
      throw new DependencyUnavailable(
        'vertex ai',
        'Application Default Credentials returned no access token for Vertex AI. The ' +
          'credential was found but has no permission to mint one — the service account ' +
          'needs roles/aiplatform.user on ' +
          'the project in INGOT_GCP_PROJECT.',
      );
    }
    return token;
  }
}

export const GOOGLE_CREDENTIALS = Symbol('GoogleCredentials');

/** Vertex's regional endpoint. Overridden only for a local stand-in. */
export function vertexUrl(input: {
  endpoint?: string;
  location: string;
  project: string;
  model: string;
  method: string;
}): string {
  const root = input.endpoint ?? `https://${input.location}-aiplatform.googleapis.com`;
  return (
    `${root}/v1/projects/${input.project}/locations/${input.location}` +
    `/publishers/google/models/${input.model}:${input.method}`
  );
}

function firstLine(error: unknown): string {
  return String(error instanceof Error ? error.message : error).split('\n')[0] ?? '';
}

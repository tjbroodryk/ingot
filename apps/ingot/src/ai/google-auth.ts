import { GoogleAuth } from 'google-auth-library';
import { DependencyUnavailable } from '../shared/domain/index.js';
import { upstream } from '../observability/index.js';

/** Vertex takes the broad platform scope; there is no narrower one for it. */
export const SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

/**
 * What to do about a Vertex credential that is missing or unprivileged.
 *
 * Exported because the summariser lets the AI SDK mint its own token and so
 * never sees the errors below — it meets the same two failures as a 401 or a
 * 403 instead, and this is the half of those messages that is advice rather
 * than narration. One string, so the two paths cannot drift into telling an
 * operator two different things about one credential.
 */
export const VERTEX_CREDENTIAL_ADVICE =
  'This service authenticates with Application Default Credentials — under Kubernetes that ' +
  "is the workload identity bound to the pod's service account, otherwise " +
  'GOOGLE_APPLICATION_CREDENTIALS pointing at a key file. The service account needs ' +
  'roles/aiplatform.user on the project in INGOT_GCP_PROJECT.';

/**
 * Bearer tokens for Vertex AI, from whatever credential this process has.
 *
 * The same argument the GCS adapter makes, so the same shape: there is no key
 * to configure because the credential is not ours to hold. Application Default
 * Credentials find it — the metadata server under a GKE workload identity,
 * `GOOGLE_APPLICATION_CREDENTIALS` pointing at a mounted key file, or a
 * developer's `gcloud auth application-default login`. `INGOT_GCP_PROJECT` is
 * the only variable, and only because a token does not say which project's
 * quota to spend.
 *
 * Not cached here. The library already holds a token until shortly before it
 * expires, and a second cache in front of that would only ever be the one
 * holding a token that has died — which fails as a 401 on a model call,
 * minutes after the thing that caused it.
 *
 * Shared by both Vertex adapters rather than duplicated, because the failure
 * this reports well is the one an operator actually hits: a Kubernetes service
 * account with no binding to a Google one, so the metadata server is there and
 * answers that it has nothing.
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

import type { ReactNode } from 'react';
import { CodeBlock } from './code-block';
import { Prose } from './prose';
import { Auth, type Endpoint, HttpMethod, SampleTone } from './reference';

/**
 * One route: what it is on the left, what it looks like on the right.
 *
 * The two columns collapse before the sidebar does, because the sample is the
 * wider of the two and runs out of room first.
 */
export function EndpointRow({ endpoint }: { endpoint: Endpoint }): ReactNode {
  return (
    <section className="ep" id={endpoint.id}>
      <div>
        <div className="ep-head">
          <span className={`method ${METHOD_CLASS[endpoint.method]}`}>{endpoint.method}</span>
          <code className={pathClass(endpoint.path)}>{endpoint.path}</code>
          <span className={endpoint.auth === Auth.Key ? 'authtag authtag-key' : 'authtag'}>
            {endpoint.auth}
          </span>
        </div>

        <p className="prose">
          <Prose text={endpoint.summary} />
        </p>

        {endpoint.note ? (
          <p className="prose">
            <Prose text={endpoint.note} />
          </p>
        ) : null}

        {endpoint.chips ? <Chips labels={endpoint.chips} /> : null}

        {endpoint.fields ? (
          <table className="table">
            <tbody>
              {endpoint.fields.map((field) => (
                <tr key={field.name}>
                  <td className="field">{field.name}</td>
                  <td>
                    <Prose text={field.doc} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </div>

      {endpoint.sample ? (
        <CodeBlock code={endpoint.sample} tone={endpoint.sampleTone ?? SampleTone.Paper} />
      ) : null}

      {endpoint.asideChips ? <Chips labels={endpoint.asideChips} /> : null}
    </section>
  );
}

function Chips({ labels }: { labels: readonly string[] }): ReactNode {
  return (
    <div className="chips">
      {labels.map((label) => (
        <span className="chip" key={label}>
          {label}
        </span>
      ))}
    </div>
  );
}

const METHOD_CLASS: Record<HttpMethod, string> = {
  [HttpMethod.Get]: 'method-get',
  [HttpMethod.Post]: 'method-post',
  [HttpMethod.Delete]: 'method-delete',
  [HttpMethod.All]: 'method-all',
};

/**
 * A long path shrinks rather than wrapping mid-segment.
 *
 * `/api/v1/:account/:ingot/config/:table` broken across two lines reads as two
 * paths, and the reader's eye has to put it back together. Three steps is
 * enough for every path this service serves.
 */
function pathClass(path: string): string {
  if (path.length > 32) return 'path path-longer';
  if (path.length > 26) return 'path path-long';
  return 'path';
}

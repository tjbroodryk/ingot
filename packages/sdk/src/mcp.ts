import { IngotError, McpToolError } from './errors.js';
import type { Transport } from './transport.js';
import { SDK_VERSION } from './version.js';

/** The protocol revision this client speaks; the server may answer with an older one. */
const PROTOCOL_VERSION = '2025-06-18';

/** One of Ingot's MCP tools, ready to hand to an agent framework. */
export interface IngotMcpTool {
  readonly name: string;
  readonly title?: string;
  readonly description: string;
  /** JSON Schema for the arguments, exactly as the server declared it. */
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly annotations?: Readonly<Record<string, unknown>>;
  /** Whether the tool changes nothing. From the server's `readOnlyHint`. */
  readonly readOnly: boolean;
  /**
   * Runs the tool. Resolves with its structured result — Ingot's tools answer
   * with JSON — and rejects with `McpToolError` when the tool reports failure,
   * whose message is written for a model to act on.
   */
  execute(args: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<unknown>;
}

export interface McpOptions {
  /** Only these tools, by name. */
  readonly only?: readonly string[];
  /** Only tools that change nothing. */
  readonly readOnly?: boolean;
  readonly signal?: AbortSignal;
}

interface JsonRpcResponse {
  readonly jsonrpc: '2.0';
  readonly id?: number | string | null;
  readonly result?: Record<string, unknown>;
  readonly error?: { readonly code: number; readonly message: string };
}

interface ToolListing {
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly inputSchema?: Record<string, unknown>;
  readonly annotations?: Record<string, unknown>;
}

interface CallResult {
  readonly content?: readonly { readonly type: string; readonly text?: string }[];
  readonly structuredContent?: unknown;
  readonly isError?: boolean;
}

/**
 * Just enough of MCP's Streamable HTTP transport to list and call tools.
 *
 * Written here rather than depending on `@modelcontextprotocol/sdk` so the SDK
 * stays free of runtime dependencies. Ingot serves MCP statelessly, but a
 * session id is still carried if a server issues one.
 */
export class McpConnection {
  private nextId = 1;
  private sessionId: string | null = null;
  private protocolVersion = PROTOCOL_VERSION;

  constructor(
    private readonly transport: Transport,
    private readonly path: string,
  ) {}

  async tools(options: McpOptions = {}): Promise<IngotMcpTool[]> {
    await this.initialize(options.signal);

    const listed: ToolListing[] = [];
    let cursor: string | undefined;
    do {
      const result = await this.request(
        'tools/list',
        cursor === undefined ? {} : { cursor },
        true,
        options.signal,
      );
      listed.push(...((result.tools as ToolListing[] | undefined) ?? []));
      cursor = typeof result.nextCursor === 'string' ? result.nextCursor : undefined;
    } while (cursor !== undefined);

    const only = options.only ? new Set(options.only) : null;
    return listed
      .map((tool) => this.toolFor(tool))
      .filter((tool) => (only ? only.has(tool.name) : true))
      .filter((tool) => (options.readOnly ? tool.readOnly : true));
  }

  private toolFor(listing: ToolListing): IngotMcpTool {
    const readOnly = listing.annotations?.readOnlyHint === true;
    return {
      name: listing.name,
      ...(listing.title === undefined ? {} : { title: listing.title }),
      description: listing.description ?? '',
      inputSchema: listing.inputSchema ?? { type: 'object', properties: {} },
      ...(listing.annotations === undefined ? {} : { annotations: listing.annotations }),
      readOnly,
      execute: async (args, options = {}) => {
        const result = (await this.request(
          'tools/call',
          { name: listing.name, arguments: args },
          readOnly,
          options.signal,
        )) as CallResult;
        const text = (result.content ?? [])
          .filter((part) => part.type === 'text' && typeof part.text === 'string')
          .map((part) => part.text)
          .join('\n');

        if (result.isError) throw new McpToolError(listing.name, text || 'The tool failed');
        if (result.structuredContent !== undefined) return result.structuredContent;
        try {
          return JSON.parse(text);
        } catch {
          return text;
        }
      },
    };
  }

  private async initialize(signal: AbortSignal | undefined): Promise<void> {
    const result = await this.request(
      'initialize',
      {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: '@ingot/sdk', version: SDK_VERSION },
      },
      true,
      signal,
    );
    if (typeof result.protocolVersion === 'string') this.protocolVersion = result.protocolVersion;
    await this.notify('notifications/initialized', signal);
  }

  private async notify(method: string, signal: AbortSignal | undefined): Promise<void> {
    const response = await this.transport.response({
      method: 'POST',
      path: this.path,
      json: { jsonrpc: '2.0', method },
      safe: true,
      signal,
      headers: this.headers(),
    });
    await response.body?.cancel();
  }

  private async request(
    method: string,
    params: Record<string, unknown>,
    safe: boolean,
    signal: AbortSignal | undefined,
  ): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    const response = await this.transport.response({
      method: 'POST',
      path: this.path,
      json: { jsonrpc: '2.0', id, method, params },
      safe,
      signal,
      headers: this.headers(),
    });

    const session = response.headers.get('mcp-session-id');
    if (session) this.sessionId = session;

    const messages = await messagesOf(response);
    const reply = messages.find((message) => message.id === id);
    if (!reply) throw new IngotError(`MCP ${method} got no reply`, { code: 'mcp_no_reply' });
    if (reply.error) {
      throw new IngotError(`MCP ${method} failed: ${reply.error.message}`, {
        code: `mcp_${reply.error.code}`,
      });
    }
    return reply.result ?? {};
  }

  private headers(): Record<string, string> {
    return {
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': this.protocolVersion,
      ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}),
    };
  }
}

/** A JSON reply, or every `data:` payload of an event stream. */
async function messagesOf(response: Response): Promise<JsonRpcResponse[]> {
  const text = await response.text();
  if (text.trim().length === 0) return [];

  if (!(response.headers.get('content-type') ?? '').includes('text/event-stream')) {
    const parsed = JSON.parse(text) as JsonRpcResponse | JsonRpcResponse[];
    return Array.isArray(parsed) ? parsed : [parsed];
  }

  const messages: JsonRpcResponse[] = [];
  for (const event of text.split(/\r?\n\r?\n/)) {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
      .join('\n');
    if (data.length > 0) messages.push(JSON.parse(data) as JsonRpcResponse);
  }
  return messages;
}

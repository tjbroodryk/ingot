import { All, Controller, Param, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { Account } from '../contexts/accounts/domain/index.js';
import { Account as AccountScope } from '../contexts/accounts/interface/account.decorator.js';
import { CurrentAccount } from '../contexts/accounts/interface/current-account.decorator.js';
import { Wire } from '@ingot/versioning/nest';
import { IngotMcpServer, type ServerLike, schemaSummary } from './ingot-server.js';

/** What one connection needs, decided before the server is constructed. */
interface Session {
  /** Handed to the client at initialize, before any tool has been called. */
  readonly instructions: string;
  readonly register: (server: ServerLike) => void;
}

/**
 * MCP over streamable HTTP, on the same process and the same key.
 *
 * Stateless: a fresh server and transport per request, no session id. That is
 * the right mode for a service meant to run behind a load balancer — a session
 * pinned to one replica breaks on a deploy, and nothing here needs continuity
 * between calls that the ingot itself does not already hold.
 *
 * Authentication is the ordinary `Authorization: Bearer ing_sk_…`, checked by
 * the same two guards every other route goes through, because `@AccountScope()`
 * below is the same decorator. There is no MCP-specific auth path — which is
 * the point, since a second one is a second thing to get wrong.
 */
@Controller({ path: ':account', version: '1' })
export class McpController {
  constructor(private readonly servers: IngotMcpServer) {}

  /** Scoped to one memory: the tools take no ids and cannot reach another. */
  @All(':ingot/mcp')
  @AccountScope()
  // JSON-RPC, not this API's wire contract. MCP negotiates its own protocol
  // version at initialize, and its tool schemas are self-describing.
  @Wire.Empty()
  async ingot(
    @CurrentAccount() account: Account,
    @Param('ingot') ingotId: string,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    // The schema is read once per connection and handed over as the server's
    // instructions. This is the difference between a model that writes working
    // SQL and one that invents column names — and it costs no tool call.
    const info = await this.servers.describeIngot(ingotId, account);

    await this.serve(request, response, {
      instructions: schemaSummary(info),
      register: (server) => {
        this.servers.register(server, { account, ingotId });
        this.servers.registerInfoResource(server, ingotId, account);
      },
    });
  }

  /** Account-wide, for a client that has not been handed a memory yet. */
  @All('mcp')
  @AccountScope()
  @Wire.Empty()
  async account(
    @CurrentAccount() account: Account,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    await this.serve(request, response, {
      instructions:
        'Create a memory with create_memory, then reconnect to ' +
        `/api/v1/${account.slug.value}/{ingot}/mcp to store and query things in it.`,
      register: (server) => this.servers.register(server, { account }),
    });
  }

  /**
   * The SDK is ESM-only and this service is CommonJS, so it is imported
   * dynamically rather than at the top of the file.
   *
   * Confined to this one method deliberately: a `require` of an ESM package
   * fails at runtime rather than at build time, so keeping the boundary in one
   * place means there is one thing to change if the app is ever moved to ESM.
   */
  private async serve(request: Request, response: Response, session: Session): Promise<void> {
    const [{ McpServer }, { StreamableHTTPServerTransport }] = await Promise.all([
      import('@modelcontextprotocol/sdk/server/mcp.js'),
      import('@modelcontextprotocol/sdk/server/streamableHttp.js'),
    ]);

    const server = new McpServer(
      { name: 'ingot', version: '1' },
      { instructions: session.instructions },
    );
    session.register(server as unknown as ServerLike);

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless; see the note on the class
      enableJsonResponse: true,
    });

    response.on('close', () => {
      void transport.close();
      void server.close();
    });

    await server.connect(transport);
    // Nest's body parser has already read the request, so the parsed body is
    // handed over explicitly — the transport would otherwise wait on a stream
    // that has already ended.
    await transport.handleRequest(request, response, request.body);
  }
}

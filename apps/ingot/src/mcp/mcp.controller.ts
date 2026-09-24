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
 * MCP over streamable HTTP, stateless: a fresh server and transport per request.
 *
 * Authenticated by the same guards as every other route via `@AccountScope()`;
 * there is no MCP-specific auth path.
 */
@Controller({ path: ':account', version: '1' })
export class McpController {
  constructor(private readonly servers: IngotMcpServer) {}

  /** Scoped to one memory: the tools take no ids and cannot reach another. */
  @All(':ingot/mcp')
  @AccountScope()
  // JSON-RPC, not this API's wire contract.
  @Wire.Empty()
  async ingot(
    @CurrentAccount() account: Account,
    @Param('ingot') ingotId: string,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    // Read once per connection and handed over as the server's instructions.
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

  /** Imports the ESM-only SDK dynamically; the boundary is confined to this method. */
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
    // Nest already parsed the body, so hand it over explicitly; the stream has ended.
    await transport.handleRequest(request, response, request.body);
  }
}

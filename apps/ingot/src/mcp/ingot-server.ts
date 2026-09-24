import { Injectable } from '@nestjs/common';
import type { AddBody, ConfigureTableBody, IngotInfo } from '@ingot/shared/ingot-v1';
import { Dispatcher } from '../shared/application/index.js';
import type { Account } from '../contexts/accounts/domain/index.js';
import { ConfigureIngot } from '../contexts/ingots/application/commands/configure-ingot.command.js';
import { ConfigureTable } from '../contexts/ingots/application/commands/configure-table.command.js';
import { CreateIngot } from '../contexts/ingots/application/commands/create-ingot.command.js';
import { DeleteIngot } from '../contexts/ingots/application/commands/delete-ingot.command.js';
import { DropTable } from '../contexts/ingots/application/commands/drop-table.command.js';
import { GetIngotInfo } from '../contexts/ingots/application/queries/get-ingot-info.query.js';
import { ListIngots } from '../contexts/ingots/application/queries/list-ingots.query.js';
import { AddRecords } from '../contexts/records/application/commands/add-records.command.js';
import { DeleteRecords } from '../contexts/records/application/commands/delete-records.command.js';
import { QueryIngot } from '../contexts/query/application/queries/query-ingot.query.js';
import { McpScope, McpTool, type ToolDefinition, toolsFor } from './tool-catalogue.js';

/**
 * The slice of the SDK's `McpServer` this file uses. Structural because the SDK
 * is ESM-only; `mcp.controller.ts` imports it dynamically.
 */
export interface ServerLike {
  registerTool(name: string, config: Record<string, unknown>, handler: ToolHandler): unknown;
  registerResource(
    name: string,
    uri: string,
    config: Record<string, unknown>,
    read: (uri: URL) => Promise<{ contents: { uri: string; mimeType: string; text: string }[] }>,
  ): unknown;
}

type ToolHandler = (args: Record<string, unknown>) => Promise<ToolReply>;
interface ToolReply {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

/**
 * Builds the MCP surface over the same `Dispatcher` the controllers use.
 *
 * Another interface, not a second implementation: each handler builds the same
 * command an HTTP route would. Scoping to one ingot means the tools take no ids.
 */
@Injectable()
export class IngotMcpServer {
  constructor(private readonly dispatcher: Dispatcher) {}

  /** Reads the manifest so the `query` tool's description can carry the live schema. */
  async describeIngot(ingotId: string, account: Account): Promise<IngotInfo> {
    return this.dispatcher.ask(new GetIngotInfo(ingotId, account.id.value, account.slug.value));
  }

  register(server: ServerLike, context: { account: Account; ingotId?: string }): void {
    const scope = context.ingotId ? McpScope.Ingot : McpScope.Account;
    for (const tool of toolsFor(scope)) {
      server.registerTool(
        tool.name,
        {
          title: tool.title,
          description: tool.description,
          inputSchema: tool.inputSchema,
          annotations: { readOnlyHint: tool.readOnly, destructiveHint: !tool.readOnly },
        },
        this.handlerFor(tool, context),
      );
    }
  }

  /** The schema, also as a resource, so reading it costs no tool call. */
  registerInfoResource(server: ServerLike, ingotId: string, account: Account): void {
    server.registerResource(
      'schema',
      `ingot://${ingotId}/info`,
      {
        title: 'This memory’s schema',
        description: 'Tables, columns and types. Read this before writing SQL.',
        mimeType: 'application/json',
      },
      async (uri: URL) => ({
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(await this.describeIngot(ingotId, account), null, 2),
          },
        ],
      }),
    );
  }

  private handlerFor(
    tool: ToolDefinition,
    context: { account: Account; ingotId?: string },
  ): ToolHandler {
    const accountId = context.account.id.value;
    const ingotId = context.ingotId ?? '';

    return async (args) => {
      try {
        return reply(await this.dispatch(tool.name, args, accountId, ingotId, context.account));
      } catch (error) {
        // Tool errors are reported to the model, not thrown at the transport,
        // so it can fix the call.
        return {
          content: [{ type: 'text', text: message(error) }],
          isError: true,
        };
      }
    };
  }

  private dispatch(
    tool: McpTool,
    args: Record<string, unknown>,
    accountId: string,
    ingotId: string,
    account: Account,
  ): Promise<unknown> {
    switch (tool) {
      case McpTool.Describe:
        return this.dispatcher.ask(new GetIngotInfo(ingotId, accountId, account.slug.value));

      case McpTool.Remember:
        return this.dispatcher.send(
          new AddRecords(ingotId, accountId, {
            table: String(args.table),
            rows: args.rows === undefined ? undefined : String(args.rows),
            columns: (args.columns ?? {}) as never,
            key: Array.isArray(args.key) ? args.key.map(String) : undefined,
            raw: Boolean(args.raw),
            // Left as it arrived; `ReceiptBuilder.kindOf` parses it.
            receipt: args.receipt as AddBody['receipt'],
            // Same: bounded by the command, not a pipe.
            externalId: args.externalId as AddBody['externalId'],
            result: args.result,
          }),
        );

      case McpTool.Query:
        return this.dispatcher.ask(
          new QueryIngot(ingotId, accountId, {
            sql: String(args.sql),
            text: args.text === undefined ? undefined : String(args.text),
            limit: args.limit === undefined ? undefined : Number(args.limit),
          }),
        );

      case McpTool.Recall:
        return this.dispatcher.ask(
          new QueryIngot(ingotId, accountId, {
            text: String(args.text),
            table: args.table === undefined ? undefined : String(args.table),
            column: args.column === undefined ? undefined : String(args.column),
            limit: args.limit === undefined ? undefined : Number(args.limit),
          }),
        );

      case McpTool.Forget:
        return this.dispatcher.send(
          new DeleteRecords(ingotId, accountId, {
            table: String(args.table),
            where: String(args.where),
          }),
        );

      case McpTool.ConfigureTable:
        return this.dispatcher.send(
          new ConfigureTable(
            ingotId,
            accountId,
            String(args.table),
            // Left as it arrived; `FtsSettings` parses the enums.
            (args.fts === undefined ? {} : { fts: args.fts }) as ConfigureTableBody,
          ),
        );

      case McpTool.ConfigureDelivery:
        return this.dispatcher.send(
          // Left as it arrived; `Delivery` parses the strategy.
          new ConfigureIngot(ingotId, accountId, { delivery: args.delivery }),
        );

      case McpTool.DropTable:
        return this.dispatcher
          .send(new DropTable(ingotId, accountId, String(args.table)))
          .then(() => ({ dropped: String(args.table) }));

      case McpTool.CreateMemory:
        return this.dispatcher.send(
          new CreateIngot(
            accountId,
            String(args.name),
            args.retainFor === undefined ? undefined : String(args.retainFor),
          ),
        );

      case McpTool.ListMemories:
        return this.dispatcher.ask(new ListIngots(accountId));

      case McpTool.DeleteMemory:
        return this.dispatcher
          .send(new DeleteIngot(String(args.ingot), accountId))
          .then(() => ({ deleted: String(args.ingot) }));
    }
  }
}

function reply(result: unknown): ToolReply {
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The schema, rendered for a tool description; names and types only. */
export function schemaSummary(info: IngotInfo): string {
  if (info.tables.length === 0) {
    return 'This memory is empty. Use remember to store something first.';
  }
  const tables = info.tables
    .map((table) => {
      const columns = table.columns
        .map((column) => `${column.name} ${column.type}${column.embedded ? ' (embedded)' : ''}`)
        .join(', ');
      // Noted only when enabled.
      const searchable = table.config.fts.enabled ? ', keyword-searchable' : '';
      return `  ${table.name} (${table.rows} rows${searchable}): ${columns}`;
    })
    .join('\n');
  return `Tables in this memory:\n${tables}`;
}

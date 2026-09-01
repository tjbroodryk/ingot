import { Module } from '@nestjs/common';
import { IngotsModule } from '../contexts/ingots/ingots.module.js';
import { McpController } from './mcp.controller.js';
import { IngotMcpServer } from './ingot-server.js';

/**
 * A delivery mechanism, not a context.
 *
 * It owns no domain and no tables: every tool it exposes resolves to a command
 * or query that already exists for the HTTP surface. That is the whole design
 * — the same rule webhooks get in `CLAUDE.md`, applied to the other direction.
 */
@Module({
  imports: [IngotsModule],
  controllers: [McpController],
  providers: [IngotMcpServer],
})
export class McpModule {}

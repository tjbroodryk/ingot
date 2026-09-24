import { Module } from '@nestjs/common';
import { IngotsModule } from '../contexts/ingots/ingots.module.js';
import { McpController } from './mcp.controller.js';
import { IngotMcpServer } from './ingot-server.js';

/** A delivery mechanism, not a context: it owns no domain and no tables. */
@Module({
  imports: [IngotsModule],
  controllers: [McpController],
  providers: [IngotMcpServer],
})
export class McpModule {}

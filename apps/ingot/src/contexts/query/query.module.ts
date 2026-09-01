import { Module } from '@nestjs/common';
import { IngotsModule } from '../ingots/ingots.module.js';
import { QueryIngotHandler } from './application/queries/query-ingot.query.js';
import { QueryController } from './interface/query.controller.js';

@Module({
  imports: [IngotsModule],
  controllers: [QueryController],
  providers: [QueryIngotHandler],
})
export class QueryModule {}

import { Query as CqrsQuery } from '@nestjs/cqrs';
import type { QueryResult } from '@nestjs/cqrs';

/**
 * A request for data that changes nothing, answered from read models rather
 * than aggregates. "Read-only" is about effect, not HTTP verb.
 */
export abstract class Query<TResult> extends CqrsQuery<TResult> {
  readonly queryName: string;

  constructor() {
    super();
    this.queryName = new.target.name;
  }
}

export interface IQueryHandler<TQuery extends Query<unknown>> {
  execute(query: TQuery): Promise<QueryResult<TQuery>>;
}

export type { QueryResult };

import { Query as CqrsQuery } from '@nestjs/cqrs';
import type { QueryResult } from '@nestjs/cqrs';

/**
 * A request for data that changes nothing.
 *
 * Queries deliberately bypass aggregates: they are answered from read models
 * shaped for the caller, not by rehydrating a write-side object and mapping it.
 * A query handler must never load a repository and never record an event.
 *
 * Note that "read-only" is about effect, not HTTP verb — a request that needs a
 * body (conflict checking across a list of pull requests) is still a query even
 * though it arrives as a POST.
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

import type * as amqp from 'amqplib';

/**
 * Opens a connection to the broker, the one thing this service does not own.
 * `recovery: true` is passed by the caller, so the options stay visible at the
 * call site.
 */
export type AmqpConnect = (
  url: string,
  options: { recovery: true },
) => Promise<amqp.RecoveringChannelModel>;

export const AMQP_CONNECT = Symbol('AmqpConnect');

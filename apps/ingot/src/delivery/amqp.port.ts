import type * as amqp from 'amqplib';

/**
 * Opening a connection to the broker, as the one thing this service does not
 * own.
 *
 * A port for a single function, and it exists so `RmqTransport` can be tested
 * without one. What is worth asserting about that class is not AMQP — amqplib
 * has its own suite — but the bookkeeping around it: that a queue is declared
 * once per connection rather than once per message, that the cache of what has
 * been declared is dropped when the connection is, and that a burst of
 * deliveries opens one connection rather than one each. All of that is
 * observable through a stand-in channel that counts calls, and none of it is
 * observable at all while `amqp.connect` is reached through a module import.
 *
 * `recovery: true` is passed by the caller rather than baked in here, so the
 * options a real connection is opened with stay visible at the call site.
 */
export type AmqpConnect = (
  url: string,
  options: { recovery: true },
) => Promise<amqp.RecoveringChannelModel>;

export const AMQP_CONNECT = Symbol('AmqpConnect');

import { Guard, InvariantViolation, ValueObject } from '../../../shared/domain/index.js';

/** The units a retention may be expressed in, as a closed set. */
export enum RetentionUnit {
  Minutes = 'm',
  Hours = 'h',
  Days = 'd',
  Weeks = 'w',
}

const MILLISECONDS: Record<RetentionUnit, number> = {
  [RetentionUnit.Minutes]: 60_000,
  [RetentionUnit.Hours]: 3_600_000,
  [RetentionUnit.Days]: 86_400_000,
  [RetentionUnit.Weeks]: 604_800_000,
};

/** Nothing may be kept for less than this, or longer than this. */
const SHORTEST = MILLISECONDS[RetentionUnit.Minutes];
const LONGEST = 520 * MILLISECONDS[RetentionUnit.Weeks]; // ten years

/**
 * How long a memory is kept — `30m`, `12h`, `14d`, `4w`.
 *
 * A duration rather than a timestamp because the question a caller is asking is
 * "how long", and making them do date arithmetic to express it is a way to get
 * a memory that expires in 1970. A short grammar rather than a count of seconds
 * because `14d` cannot be misread by three orders of magnitude and `1209600`
 * can — and the thing on the other end of this mistake is an irreversible
 * delete.
 *
 * Bounded at both ends for the same reason. `0d` would mean "delete this the
 * moment I create it", which nobody means, and a retention past the heat death
 * of the sun is a typo rather than a plan.
 */
export class Retention extends ValueObject {
  readonly value: string;
  readonly milliseconds: number;

  private constructor(value: string, milliseconds: number) {
    super();
    this.value = value;
    this.milliseconds = milliseconds;
    this.seal();
  }

  static of(raw: string): Retention {
    const value = Guard.notBlank(raw, 'retainFor').toLowerCase();
    const match = /^(\d+)(m|h|d|w)$/.exec(value);

    if (!match?.[1] || !match[2]) {
      throw new InvariantViolation(
        `"${raw}" is not a retention. Use a whole number and a unit: ` + '30m, 12h, 14d, 4w.',
      );
    }

    const unit = Guard.oneOf(match[2], Object.values(RetentionUnit), 'retainFor.unit');
    const milliseconds = Number(match[1]) * MILLISECONDS[unit];

    if (milliseconds < SHORTEST) {
      throw new InvariantViolation(
        `"${raw}" is shorter than a minute. A memory deleted before anything can ` +
          'be written to it is not one worth creating.',
      );
    }
    if (milliseconds > LONGEST) {
      throw new InvariantViolation(
        `"${raw}" is longer than ten years. Omit retainFor to keep a memory indefinitely.`,
      );
    }

    return new Retention(value, milliseconds);
  }

  /** When a memory created at `from` under this retention falls due. */
  from(start: Date): Date {
    return new Date(start.getTime() + this.milliseconds);
  }

  toString(): string {
    return this.value;
  }
}

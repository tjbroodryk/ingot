import { Injectable } from '@nestjs/common';
import type { Clock } from '../domain/index.js';

@Injectable()
export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

import { Controller, Get, VERSION_NEUTRAL } from '@nestjs/common';
import { Wire } from '@ingot/versioning/nest';
import { Account } from '../contexts/accounts/interface/account.decorator.js';

/**
 * Version-neutral, because a load balancer's health check should not have to
 * be updated when the API surface is versioned.
 */
@Controller({ path: 'health', version: VERSION_NEUTRAL })
export class HealthController {
  @Get()
  @Account.Open()
  @Wire.Empty() // version-neutral: a load balancer negotiates nothing
  check(): { status: string; service: string } {
    return { status: 'ok', service: 'ingot' };
  }
}

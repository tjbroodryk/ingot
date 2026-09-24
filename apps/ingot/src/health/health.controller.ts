import { Controller, Get, VERSION_NEUTRAL } from '@nestjs/common';
import { Wire } from '@ingot/versioning/nest';
import { Account } from '../contexts/accounts/interface/account.decorator.js';

/** Version-neutral: the health check is not part of the versioned API surface. */
@Controller({ path: 'health', version: VERSION_NEUTRAL })
export class HealthController {
  @Get()
  @Account.Open()
  @Wire.Empty() // version-neutral: nothing to negotiate
  check(): { status: string; service: string } {
    return { status: 'ok', service: 'ingot' };
  }
}

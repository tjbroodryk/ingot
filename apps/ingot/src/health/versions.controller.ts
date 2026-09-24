import { Controller, Get, VERSION_NEUTRAL } from '@nestjs/common';
import { Wire } from '@ingot/versioning/nest';
import { Account } from '../contexts/accounts/interface/account.decorator.js';
import { INGOT_VERSIONS, VERSION_HEADER } from '../versioning/changeset.js';

/** What versions of the contract exist, and what each release changed. Public and version-neutral. */
@Controller({ path: 'versions', version: VERSION_NEUTRAL })
export class VersionsController {
  @Get()
  @Account.Open()
  @Wire.Empty() // the changelog is not part of the contract it describes
  list(): {
    header: string;
    latest: string;
    versions: readonly string[];
    changelog: readonly { version: string; summary: string; changes: readonly string[] }[];
  } {
    return {
      header: VERSION_HEADER,
      latest: INGOT_VERSIONS.latest,
      versions: INGOT_VERSIONS.versions,
      changelog: INGOT_VERSIONS.changelog(),
    };
  }
}

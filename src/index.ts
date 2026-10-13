import { PlatformConfig, PlatformMatterbridge } from 'matterbridge';
import { AnsiLogger } from 'matterbridge/logger';

import { FrigatePlatform } from './platform.js';

export default function initializePlugin(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: PlatformConfig): FrigatePlatform {
  return new FrigatePlatform(matterbridge, log, config);
}

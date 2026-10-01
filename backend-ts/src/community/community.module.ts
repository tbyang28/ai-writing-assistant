import { Module } from "@nestjs/common";

import { OptionalJwtGuard } from "./optional-jwt.guard";
import { PublishingController } from "./publishing.controller";
import { CommunityService } from "./community.service";
import { DiscoveryController } from "./discovery.controller";
import { SocialController } from "./social.controller";

@Module({
  controllers: [DiscoveryController, SocialController, PublishingController],
  providers: [CommunityService, OptionalJwtGuard],
  exports: [CommunityService],
})
export class CommunityModule {}

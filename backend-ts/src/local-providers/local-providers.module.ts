import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DrizzleModule } from '../db/drizzle.module';
import { LocalProvidersController, LocalRuntimeController } from './local-providers.controller';
import { LocalProvidersService } from './local-providers.service';
import { LocalJobBroker } from './local-job-broker';

@Module({ imports: [AuthModule, DrizzleModule], controllers: [LocalProvidersController, LocalRuntimeController],
  providers: [LocalProvidersService, LocalJobBroker], exports: [LocalProvidersService, LocalJobBroker] })
export class LocalProvidersModule {}

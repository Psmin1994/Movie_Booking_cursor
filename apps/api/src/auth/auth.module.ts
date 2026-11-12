import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtModule } from "@nestjs/jwt";
import { DatabaseModule } from "../database/database.module.js";
import { AuthController } from "./controller/auth.controller.js";
import { AuthService } from "./use-case/auth.service.js";
import { JwtAuthGuard } from "./guard/jwt-auth.guard.js";
import { UsersService } from "./use-case/users.service.js";

@Module({
  imports: [
    DatabaseModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const jwtExpiresDays = configService.getOrThrow<number>(
          "auth.jwtExpiresDays",
        );

        return {
          secret: configService.getOrThrow<string>("auth.jwtSecret"),
          signOptions: {
            expiresIn: `${jwtExpiresDays}d`,
          },
        };
      },
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, UsersService, JwtAuthGuard],
  exports: [JwtAuthGuard, JwtModule],
})
export class AuthModule {}

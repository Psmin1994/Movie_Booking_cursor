import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { ScheduleModule } from "@nestjs/schedule";
import { AuthModule } from "./auth/auth.module.js";
import { AppController } from "./app.controller.js";
import { AppService } from "./app.service.js";
import { BookingModule } from "./booking/booking.module.js";
import configuration from "./config/configuration.js";
import { envValidationSchema } from "./config/env.validation.js";
import { DatabaseModule } from "./database/database.module.js";
import { MovieModule } from "./movie/movie.module.js";
import { PaymentModule } from "./payment/payment.module.js";
import { RefundModule } from "./refund/refund.module.js";
import { ScreeningModule } from "./screening/screening.module.js";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      validationSchema: envValidationSchema,
    }),
    ScheduleModule.forRoot(),
    DatabaseModule,
    AuthModule,
    BookingModule,
    MovieModule,
    PaymentModule,
    RefundModule,
    ScreeningModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}

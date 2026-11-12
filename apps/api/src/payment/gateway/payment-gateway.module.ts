import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PaymentGateway } from "./payment-gateway.js";
import { TossPaymentGateway } from "./toss-payment-gateway.js";

@Module({
  providers: [
    {
      provide: PaymentGateway,
      inject: [ConfigService],
      useFactory: (configService: ConfigService) =>
        new TossPaymentGateway(configService.getOrThrow<string>("payments.tossSecretKey")),
    },
  ],
  exports: [PaymentGateway],
})
export class PaymentGatewayModule {}

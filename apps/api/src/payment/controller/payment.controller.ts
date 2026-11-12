import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBody,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiExtraModels,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
  getSchemaPath,
} from "@nestjs/swagger";
import { CurrentUser } from "../../auth/decorators/current-user.decorator.js";
import type { AuthenticatedUser } from "../../auth/decorators/current-user.decorator.js";
import { JwtAuthGuard } from "../../auth/guard/jwt-auth.guard.js";
import { CreatePaymentService } from "../use-case/create-payment.service.js";
import { ReconciliationRequiredPaymentResponseDto } from "../dto/reconciliation-required-payment-response.dto.js";
import { CreatePaymentDto } from "../dto/create-payment.dto.js";
import { CreatePaymentResponseDto } from "../dto/create-payment-response.dto.js";
import { FailedPaymentResponseDto } from "../dto/failed-payment-response.dto.js";
import { PayPaymentDto } from "../dto/pay-payment.dto.js";
import { PaymentResponseDto } from "../dto/payment-response.dto.js";
import { PaymentService } from "../use-case/payment.service.js";

@ApiTags("payments")
@ApiExtraModels(PaymentResponseDto, FailedPaymentResponseDto, ReconciliationRequiredPaymentResponseDto)
@Controller("payments")
export class PaymentController {
  constructor(
    private readonly createPaymentService: CreatePaymentService,
    private readonly paymentService: PaymentService,
  ) {}

  @Post()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: "결제 생성" })
  @ApiBody({ type: CreatePaymentDto })
  @ApiCreatedResponse({ type: CreatePaymentResponseDto })
  @ApiUnauthorizedResponse({ description: "인증 필요" })
  @ApiNotFoundResponse({ description: "예매를 찾을 수 없습니다." })
  @ApiConflictResponse({
    description: "이미 결제가 생성된 예매입니다. 또는 결제할 수 없는 예매입니다.",
  })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreatePaymentDto,
  ): Promise<CreatePaymentResponseDto> {
    return this.createPaymentService.execute(user, dto);
  }

  @Post(":paymentId")
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "결제 승인",
    description:
      "승인은 PAID, FAILED, RECONCILIATION_REQUIRED 중 하나의 최종 상태로 응답한다. PAID는 paidAt을, FAILED는 failedAt을 포함한다. RECONCILIATION_REQUIRED는 기한까지 승인 결과를 확정하지 못한 상태이다.",
  })
  @ApiOkResponse({
    schema: {
      oneOf: [
        { $ref: getSchemaPath(PaymentResponseDto) },
        { $ref: getSchemaPath(FailedPaymentResponseDto) },
        { $ref: getSchemaPath(ReconciliationRequiredPaymentResponseDto) },
      ],
    },
  })
  @ApiUnauthorizedResponse({ description: "인증 필요" })
  @ApiNotFoundResponse({ description: "결제를 찾을 수 없습니다." })
  @ApiConflictResponse({
    description:
      "결제할 수 없는 상태입니다. 또는 결제 가능 시간이 만료되었습니다. 응답 본문에는 최종 Payment 상태가 포함되지 않습니다.",
  })
  pay(
    @CurrentUser() user: AuthenticatedUser,
    @Param("paymentId") paymentId: string,
    @Body() body: PayPaymentDto,
  ): Promise<PaymentResponseDto | FailedPaymentResponseDto | ReconciliationRequiredPaymentResponseDto> {
    return this.paymentService.pay(user, paymentId, body.paymentKey);
  }
}

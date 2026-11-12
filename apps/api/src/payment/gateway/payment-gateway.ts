export type PaymentGatewayConfirmInput = {
  paymentKey: string;
  orderId: string;
  amount: number;
};

export type PaymentGatewayRetrieveInput = {
  paymentKey: string;
};

export type PaymentGatewayCancelInput = {
  paymentKey: string;
  cancelReason: string;
  cancelAmount: number;
  idempotencyKey: string;
};

export type PaymentGatewayCancelResult =
  | {
      status: "SUCCESS";
      paymentKey: string;
      cancelAmount: number;
      transactionKey: string;
    }
  | {
      status: "FAILED";
    }
  | {
      status: "UNKNOWN";
    };

export type PaymentGatewayRetrieveCancelOutcomeInput = {
  paymentKey: string;
  transactionKey: string;
  cancelAmount: number;
};

export type PaymentGatewayRetrieveCancelOutcomeResult =
  | {
      status: "CANCELED";
      paymentKey: string;
      transactionKey: string;
      cancelAmount: number;
    }
  | {
      status: "NOT_CANCELED";
    }
  | {
      status: "UNKNOWN";
    };

export type PaymentGatewayConfirmResult =
  | {
      status: "SUCCESS";
      paymentKey: string;
      orderId: string;
      amount: number;
      approvedAt: Date;
    }
  | {
      status: "FAILED";
    }
  | {
      status: "UNKNOWN";
    };

export type PaymentGatewayRetrieveResult =
  | {
      status: "PAID";
      paymentKey: string;
      orderId: string;
      amount: number;
      approvedAt: Date;
    }
  | {
      status: "NOT_PAID";
    }
  | {
      status: "UNKNOWN";
    };

export abstract class PaymentGateway {
  abstract confirm(input: PaymentGatewayConfirmInput): Promise<PaymentGatewayConfirmResult>;

  abstract retrieve(input: PaymentGatewayRetrieveInput): Promise<PaymentGatewayRetrieveResult>;

  abstract cancel(input: PaymentGatewayCancelInput): Promise<PaymentGatewayCancelResult>;

  abstract retrieveCancelOutcome(
    input: PaymentGatewayRetrieveCancelOutcomeInput,
  ): Promise<PaymentGatewayRetrieveCancelOutcomeResult>;
}

export class UnconfiguredPaymentGateway extends PaymentGateway {
  confirm(_input: PaymentGatewayConfirmInput): Promise<PaymentGatewayConfirmResult> {
    return Promise.resolve({
      status: "UNKNOWN",
    });
  }

  retrieve(_input: PaymentGatewayRetrieveInput): Promise<PaymentGatewayRetrieveResult> {
    return Promise.resolve({
      status: "UNKNOWN",
    });
  }

  cancel(_input: PaymentGatewayCancelInput): Promise<PaymentGatewayCancelResult> {
    return Promise.resolve({
      status: "UNKNOWN",
    });
  }

  retrieveCancelOutcome(
    _input: PaymentGatewayRetrieveCancelOutcomeInput,
  ): Promise<PaymentGatewayRetrieveCancelOutcomeResult> {
    return Promise.resolve({
      status: "UNKNOWN",
    });
  }
}

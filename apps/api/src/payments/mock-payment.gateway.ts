import type {
  PaymentGateway,
  CreatePaymentRequest,
  CreatePaymentResult,
  VerifyPaymentResult,
} from "./payment-gateway.interface";

export class MockPaymentGateway implements PaymentGateway {
  async createPaymentUrl(
    request: CreatePaymentRequest,
  ): Promise<CreatePaymentResult> {
    if (process.env.NODE_ENV === "production") {
      throw new Error("Mock gateway is disabled in production");
    }

    if (!Number.isSafeInteger(request.amountVnd) || request.amountVnd <= 0) {
      throw new Error("Invalid payment amount");
    }

    if (!request.transactionRef.trim()) {
      throw new Error("Transaction reference is required");
    }

    // URL giả chỉ dùng để kiểm tra logic.
    // Không dẫn đến trang thanh toán thật.
    const paymentUrl = `mock://payment/${encodeURIComponent(request.transactionRef)}`;

    return {
      transactionRef: request.transactionRef,
      paymentUrl,
    };
  }

  verifyCallback(params: Record<string, string>): VerifyPaymentResult {
    void params;

    // Không tin tưởng callback giả từ bên ngoài.
    return {
      verified: false,
      success: false,
      transactionRef: null,
    };
  }
}

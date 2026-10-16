import { createHmac, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

import { env } from "../config/env.config";

import type {
  PaymentGateway,
  CreatePaymentRequest,
  CreatePaymentResult,
  VerifyPaymentResult,
} from "./payment-gateway.interface";

const VNPAY_VERSION = "2.1.0";
const PAYMENT_EXPIRE_MINUTES = 15;

// VNPay sử dụng múi giờ GMT+7.
function formatVnpayDate(date: Date): string {
  const vietnamTime = new Date(date.getTime() + 7 * 60 * 60 * 1000);

  return vietnamTime.toISOString().slice(0, 19).replace(/\D/g, "");
}

// Sắp xếp tham số và mã hóa thống nhất khi ký/xác minh.
function buildSignData(params: Record<string, string>): string {
  const query = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (
      key.startsWith("vnp_") &&
      key !== "vnp_SecureHash" &&
      key !== "vnp_SecureHashType"
    ) {
      query.append(key, value);
    }
  }

  query.sort();
  return query.toString();
}

function signData(data: string, secret: string): string {
  return createHmac("sha512", secret).update(data, "utf8").digest("hex");
}

function hasValidConfig(): boolean {
  return (
    env.VNPAY_TMN_CODE.trim().length > 0 &&
    env.VNPAY_HASH_SECRET.trim().length > 0 &&
    env.VNPAY_TMN_CODE !== "TEST_TMN_CODE" &&
    env.VNPAY_HASH_SECRET !== "TEST_HASH_SECRET"
  );
}

export class VnpayGateway implements PaymentGateway {
  async createPaymentUrl(
    request: CreatePaymentRequest,
  ): Promise<CreatePaymentResult> {
    if (!hasValidConfig()) {
      throw new Error("VNPay Sandbox credentials not configured");
    }

    if (
      !Number.isSafeInteger(request.amountVnd) ||
      request.amountVnd <= 0 ||
      !Number.isSafeInteger(request.amountVnd * 100) ||
      request.amountVnd * 100 >= 1_000_000_000_000
    ) {
      throw new Error("Invalid payment amount");
    }

    if (!/^[A-Za-z0-9]{1,100}$/.test(request.transactionRef)) {
      throw new Error("Invalid transaction reference");
    }

    const orderInfo = request.orderInfo.trim();

    if (
      orderInfo.length === 0 ||
      orderInfo.length > 255 ||
      !/^[\x20-\x7E]+$/.test(orderInfo)
    ) {
      throw new Error(
        "Order info must be printable ASCII, maximum 255 characters",
      );
    }

    // Không cho phép client tự chọn URL chuyển hướng.
    if (request.returnUrl !== env.VNPAY_RETURN_URL) {
      throw new Error("Untrusted VNPay return URL");
    }

    if (isIP(request.ipAddress) === 0) {
      throw new Error("Invalid client IP address");
    }

    const now = new Date();
    const expireAt = new Date(
      now.getTime() + PAYMENT_EXPIRE_MINUTES * 60 * 1000,
    );

    const params: Record<string, string> = {
      vnp_Version: VNPAY_VERSION,
      vnp_Command: "pay",
      vnp_TmnCode: env.VNPAY_TMN_CODE,
      vnp_Amount: String(request.amountVnd * 100),
      vnp_CurrCode: "VND",
      vnp_TxnRef: request.transactionRef,
      vnp_OrderInfo: orderInfo,
      vnp_OrderType: "other",
      vnp_Locale: "vn",
      vnp_ReturnUrl: env.VNPAY_RETURN_URL,
      vnp_IpAddr: request.ipAddress,
      vnp_CreateDate: formatVnpayDate(now),
      vnp_ExpireDate: formatVnpayDate(expireAt),
    };

    const signContent = buildSignData(params);
    const secureHash = signData(signContent, env.VNPAY_HASH_SECRET);

    const url = new URL(env.VNPAY_URL);
    url.search = `${signContent}&vnp_SecureHash=${secureHash}`;

    return {
      transactionRef: request.transactionRef,
      paymentUrl: url.toString(),
    };
  }

  verifyCallback(params: Record<string, string>): VerifyPaymentResult {
    const invalid: VerifyPaymentResult = {
      verified: false,
      success: false,
      transactionRef: null,
    };

    if (!hasValidConfig()) {
      return invalid;
    }

    const receivedHash = params.vnp_SecureHash;

    if (!receivedHash || !/^[0-9a-fA-F]{128}$/.test(receivedHash)) {
      return invalid;
    }

    const expectedHash = signData(buildSignData(params), env.VNPAY_HASH_SECRET);

    const received = Buffer.from(receivedHash, "hex");
    const expected = Buffer.from(expectedHash, "hex");

    if (
      received.length !== expected.length ||
      !timingSafeEqual(received, expected)
    ) {
      return invalid;
    }

    const transactionRef = params.vnp_TxnRef;

    if (
      params.vnp_TmnCode !== env.VNPAY_TMN_CODE ||
      !transactionRef ||
      !/^[A-Za-z0-9]{1,100}$/.test(transactionRef) ||
      !/^[1-9]\d*$/.test(params.vnp_Amount ?? "") ||
      !params.vnp_ResponseCode ||
      !params.vnp_TransactionStatus
    ) {
      return invalid;
    }

    return {
      verified: true,
      success:
        params.vnp_ResponseCode === "00" &&
        params.vnp_TransactionStatus === "00",
      transactionRef,
      ...(params.vnp_TransactionNo
        ? { providerTransactionId: params.vnp_TransactionNo }
        : {}),
    };
  }
}

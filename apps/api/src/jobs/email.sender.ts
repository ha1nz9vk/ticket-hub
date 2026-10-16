import { Resend } from "resend";
import { env } from "../config/env.config";
import type { UserRegisteredPayload } from "./email.types";

export async function sendRegistrationEmail(
  outboxId: string,
  payload: UserRegisteredPayload,
): Promise<string> {
  // env import ensures local .env has been loaded.
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;

  if (!apiKey || !from) {
    throw new Error(
      "Email is not configured: RESEND_API_KEY or EMAIL_FROM is missing",
    );
  }

  if (env.NODE_ENV === "production" && from.includes("resend.dev")) {
    const sender = from.trim().toLowerCase();

    const validTestSender =
      sender === "onboarding@resend.dev" ||
      sender === "tickethub <onboarding@resend.dev>";

    const allowTestEmail =
      process.env.EMAIL_WORKER_MODE === "live-test" &&
      process.env.ALLOW_RESEND_TEST_SENDER === "true" &&
      validTestSender &&
      !!process.env.TEST_EMAIL_TO &&
      payload.email.trim().toLowerCase() ===
        process.env.TEST_EMAIL_TO.trim().toLowerCase();

    if (!allowTestEmail) {
      throw new Error("Configure a verified sender domain for production");
    }
  }

  const resend = new Resend(apiKey);

  const { data, error } = await resend.emails.send(
    {
      from,
      to: payload.email,
      subject: "Xác thực tài khoản TicketHub",
      text: [
        `Xin chào ${payload.fullName},`,
        "",
        "Cảm ơn bạn đã đăng ký TicketHub.",
        "Mã xác thực tài khoản của bạn:",
        payload.verificationToken,
        "",
        "Vui lòng sử dụng mã xác thực theo hướng dẫn của TicketHub.",
        "Nếu bạn không đăng ký, hãy bỏ qua email này.",
      ].join("\n"),
    },
    {
      idempotencyKey: `registration/${outboxId}`,
    },
  );

  if (error) {
    throw new Error(`Resend failed: ${error.message}`);
  }

  if (!data?.id) {
    throw new Error("Resend did not return an email ID");
  }

  return data.id;
}

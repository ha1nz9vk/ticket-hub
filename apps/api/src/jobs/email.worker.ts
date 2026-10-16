import { Worker } from "bullmq";
import IORedis from "ioredis";
import { and, eq } from "drizzle-orm";
import { OutboxStatus } from "@tickethub/shared";

import { env } from "../config/env.config";
import { db, sqlClient } from "../database/db";
import { outbox } from "../database/schema";
import { sendRegistrationEmail } from "./email.sender";

import {
  EMAIL_QUEUE_NAME,
  UserRegisteredPayloadSchema,
  type EmailJobData,
} from "./email.types";

const connection = new IORedis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
});

const worker = new Worker<EmailJobData>(
  EMAIL_QUEUE_NAME,
  async (job) => {
    if (
      job.name !== "user-registered" ||
      job.data.eventType !== "USER_REGISTERED"
    ) {
      throw new Error(`Unsupported job: ${job.name}`);
    }

    const payload = UserRegisteredPayloadSchema.parse(job.data.payload);

    const mode = process.env.EMAIL_WORKER_MODE ?? "mock";

    console.log(`[Email Worker] Processing: ${job.id}`);

    // Chế độ giả lập: không gửi email và
    // không đánh dấu Outbox đã hoàn thành.
    if (mode === "mock") {
      console.log("[Email Worker] Mock completed");
      return { simulated: true };
    }

    if (mode === "live-test") {
      // Chỉ gửi đến email kiểm thử.
      const testEmail = process.env.TEST_EMAIL_TO?.trim().toLowerCase();

      if (!testEmail || payload.email.toLowerCase() !== testEmail) {
        throw new Error("Recipient is not TEST_EMAIL_TO");
      }
    } else if (mode === "live") {
      // Chỉ cho phép gửi email thật khi bật rõ ràng.
      if (process.env.ENABLE_REAL_EMAIL !== "true") {
        throw new Error("Real email sending is disabled");
      }
    } else {
      throw new Error(`Unsupported mode: ${mode}`);
    }

    // Tìm bản ghi Outbox tương ứng.
    const [event] = await db
      .select({
        id: outbox.id,
        eventType: outbox.eventType,
        payload: outbox.payload,
        status: outbox.status,
      })
      .from(outbox)
      .where(eq(outbox.id, job.data.outboxId))
      .limit(1);

    if (!event || event.eventType !== "USER_REGISTERED") {
      throw new Error("Matching Outbox event not found");
    }

    const storedPayload = UserRegisteredPayloadSchema.parse(event.payload);

    // Chống sử dụng job có dữ liệu không khớp Outbox.

    if (
      storedPayload.userId !== payload.userId ||
      storedPayload.email !== payload.email ||
      storedPayload.fullName !== payload.fullName ||
      storedPayload.verificationToken !== payload.verificationToken
    ) {
      throw new Error("Job payload does not match Outbox");
    }

    // Nếu đã hoàn thành, không gửi email lần nữa.
    if (event.status === OutboxStatus.COMPLETED) {
      console.log("[Email Worker] Already completed");
      return { alreadyCompleted: true };
    }

    if (event.status !== OutboxStatus.PROCESSING) {
      throw new Error(`Unexpected Outbox status: ${event.status}`);
    }

    // Gửi email qua Resend.
    const emailId = await sendRegistrationEmail(event.id, storedPayload);

    // Chỉ cập nhật sau khi Resend chấp nhận yêu cầu.
    const [updated] = await db
      .update(outbox)
      .set({
        status: OutboxStatus.COMPLETED,
        errorMessage: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(outbox.id, event.id),
          eq(outbox.status, OutboxStatus.PROCESSING),
        ),
      )
      .returning({ id: outbox.id });

    if (!updated) {
      throw new Error("Email accepted but Outbox completion failed");
    }

    console.log(`[Email Worker] Outbox COMPLETED: ${updated.id}`);

    return {
      simulated: false,
      provider: "resend",
      emailId,
    };
  },
  {
    connection,
    concurrency: 1,
  },
);

worker.on("ready", () => {
  console.log("[Email Worker] Ready");
});

worker.on("completed", (job) => {
  console.log(`[Email Worker] Job ${job.id} completed`);
});

worker.on("failed", (job, error) => {
  console.error(`[Email Worker] Job ${job?.id} failed: ${error.message}`);
});

worker.on("error", (error) => {
  console.error("[Email Worker] Error:", error.message);
});

async function shutdown() {
  await worker.close();
  await connection.quit();
  await sqlClient.end();
}

process.once("SIGINT", () => {
  void shutdown();
});

process.once("SIGTERM", () => {
  void shutdown();
});

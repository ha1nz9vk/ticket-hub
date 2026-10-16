import { and, asc, eq, lte, sql } from "drizzle-orm";
import { OutboxStatus } from "@tickethub/shared";

import { db, sqlClient } from "../database/db";
import { outbox } from "../database/schema";

import { emailQueue, enqueueRegistrationEmail } from "./email.queue";

import { UserRegisteredPayloadSchema } from "./email.types";

// Chỉ cho phép gửi job với dữ liệu giả khi kiểm thử.
const enqueueTest = process.argv.includes("--enqueue-test");
const enqueueLive = process.argv.includes("--enqueue");
const enqueueEmailTest = process.argv.includes("--enqueue-email-test");

if ([enqueueTest, enqueueLive, enqueueEmailTest].filter(Boolean).length > 1) {
  throw new Error("Only one enqueue mode is allowed.");
}

async function main() {
  const testEmail = process.env.TEST_EMAIL_TO?.trim().toLowerCase();

  if (enqueueEmailTest) {
    if (process.env.ENABLE_TEST_EMAIL_DISPATCH !== "true") {
      throw new Error("Test email dispatch is disabled.");
    }

    if (!testEmail) {
      throw new Error("TEST_EMAIL_TO is required.");
    }

    if (process.env.EMAIL_WORKER_MODE !== "live-test") {
      throw new Error("Worker must use live-test mode.");
    }

    const redisUrl = process.env.REDIS_URL;

    if (!redisUrl || new URL(redisUrl).hostname !== "email-test-redis") {
      throw new Error("Test dispatch must use isolated Redis.");
    }
  }

  if (enqueueLive && process.env.ENABLE_REAL_EMAIL_DISPATCH !== "true") {
    throw new Error(
      "Real email dispatch is disabled. " +
        "ENABLE_REAL_EMAIL_DISPATCH must be true.",
    );
  }

  const mode = enqueueEmailTest
    ? "EMAIL LIVE TEST"
    : enqueueTest
      ? "TEST ENQUEUE"
      : enqueueLive
        ? "LIVE ENQUEUE"
        : "DRY RUN";

  console.log("[Dispatcher] Starting...");
  console.log(`[Dispatcher] Mode: ${mode}`);

  const events = await db
    .select({
      id: outbox.id,
      eventType: outbox.eventType,
      payload: outbox.payload,
      retryCount: outbox.retryCount,
    })
    .from(outbox)
    .where(
      and(
        eq(outbox.status, OutboxStatus.PENDING),
        eq(outbox.eventType, "USER_REGISTERED"),
        lte(outbox.nextRetryAt, new Date()),
        enqueueEmailTest
          ? sql`lower(${outbox.payload} ->> 'email') = ${testEmail}`
          : undefined,
      ),
    )
    .orderBy(asc(outbox.createdAt))
    .limit(10);

  console.log(`[Dispatcher] Found ${events.length} events`);

  let failed = 0;

  for (const event of events) {
    try {
      const payload = UserRegisteredPayloadSchema.parse(event.payload);

      if (!enqueueTest && !enqueueLive && !enqueueEmailTest) {
        console.log(`[Dispatcher] Valid event: ${event.id}`);
        continue;
      }

      if (
        enqueueEmailTest &&
        payload.email.trim().toLowerCase() !== testEmail
      ) {
        console.log(`[Dispatcher] Skipped other email: ${event.id}`);
        continue;
      }

      // Không xử lý email đăng ký thật trong giai đoạn mock.
      if (
        enqueueTest &&
        (payload.email !== "outbox-smoke@example.invalid" ||
          payload.verificationToken !== "fake-test-token")
      ) {
        console.log(`[Dispatcher] Skipped non-test event: ${event.id}`);
        continue;
      }

      // Phát hiện job còn lưu từ bài kiểm thử trước.
      const existingJob = await emailQueue.getJob(`outbox_${event.id}`);

      if (existingJob) {
        const jobState = await existingJob.getState();

        console.warn(
          `[Dispatcher] Existing BullMQ job detected: ` +
            `outboxId=${event.id}, ` +
            `jobId=${existingJob.id}, ` +
            `state=${jobState}`,
        );

        // Không tự động enqueue lại khi chưa đối soát
        // trạng thái Redis với PostgreSQL.
        console.warn(
          `[Dispatcher] Skipped to prevent duplicate enqueue. ` +
            `Manual reconciliation may be required.`,
        );

        continue;
      }

      // Atomic Claim: chỉ 1 Dispatcher nhận được sự kiện.
      const [claimed] = await db
        .update(outbox)
        .set({
          status: OutboxStatus.PROCESSING,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(outbox.id, event.id),
            eq(outbox.status, OutboxStatus.PENDING),
            lte(outbox.nextRetryAt, new Date()),
          ),
        )
        .returning({
          id: outbox.id,
        });

      if (!claimed) {
        console.log(`[Dispatcher] Already claimed: ${event.id}`);
        continue;
      }

      try {
        const job = await enqueueRegistrationEmail(event.id, payload);

        console.log(`[Dispatcher] Enqueued: ${job.id}`);
      } catch (error) {
        // Chỉ hoàn lại claim nếu Redis enqueue thất bại.
        const message =
          error instanceof Error ? error.message : "Unknown error";

        await db
          .update(outbox)
          .set({
            status: OutboxStatus.PENDING,
            retryCount: event.retryCount + 1,
            nextRetryAt: new Date(Date.now() + 30_000),
            errorMessage: message,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(outbox.id, event.id),
              eq(outbox.status, OutboxStatus.PROCESSING),
            ),
          );

        throw error;
      }
    } catch (error) {
      failed++;

      console.error(
        `[Dispatcher] Failed event ${event.id}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  console.log("[Dispatcher] Finished");

  if (failed > 0) {
    process.exitCode = 1;
  }
}

main()
  .catch((error: unknown) => {
    console.error("[Dispatcher] Fatal error:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await emailQueue.close();
    await sqlClient.end();
  });

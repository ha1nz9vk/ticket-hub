import { and, asc, eq, lte } from "drizzle-orm";
import { OutboxStatus } from "@tickethub/shared";
import { decideRecovery } from "./recovery-decision";
import { db, sqlClient } from "../database/db";
import { outbox } from "../database/schema";
import { emailQueue } from "./email.queue";

const STALE_AFTER_MS = 5 * 60 * 1000;
const markFailed = process.argv.includes("--mark-failed");

async function main() {
  if (markFailed && process.env.ENABLE_OUTBOX_RECOVERY_WRITE !== "true") {
    throw new Error(
      "Recovery write is disabled. " +
        "ENABLE_OUTBOX_RECOVERY_WRITE must be true.",
    );
  }

  console.log("[Recovery] Checking stuck Outbox events...");
  console.log(`[Recovery] Mode: ${markFailed ? "MARK FAILED" : "READ ONLY"}`);

  const cutoff = new Date(Date.now() - STALE_AFTER_MS);

  const events = await db
    .select({
      id: outbox.id,
      eventType: outbox.eventType,
      status: outbox.status,
      retryCount: outbox.retryCount,
      updatedAt: outbox.updatedAt,
    })
    .from(outbox)
    .where(
      and(
        eq(outbox.status, OutboxStatus.PROCESSING),
        eq(outbox.eventType, "USER_REGISTERED"),
        lte(outbox.updatedAt, cutoff),
      ),
    )
    .orderBy(asc(outbox.updatedAt))
    .limit(20);

  console.log(`[Recovery] Found ${events.length} stale events`);

  let markedFailed = 0;
  let requiresReview = 0;

  for (const event of events) {
    const jobId = `outbox_${event.id}`;

    try {
      const job = await emailQueue.getJob(jobId);

      const jobState = job ? await job.getState() : "missing";

      const attemptsMade = job?.attemptsMade ?? 0;
      const maxAttempts = Math.max(1, job?.opts.attempts ?? 1);
      const decision = decideRecovery(jobState, attemptsMade, maxAttempts);

      console.log(`[Recovery] Decision: ${decision}`);
      console.log({
        outboxId: event.id,
        outboxStatus: event.status,
        retryCount: event.retryCount,
        jobState,
        attemptsMade,
        maxAttempts,
        updatedAt: event.updatedAt,
      });

      // Job vẫn nằm trong hàng đợi hoặc đang retry.
      if (decision === "WAIT") {
        console.log(`[Recovery] Job ${jobId} is still managed by BullMQ`);
        continue;
      }

      const exhausted = decision === "MARK_FAILED";

      if (exhausted) {
        if (!markFailed) {
          console.warn(
            `[Recovery] ${jobId} exhausted retries. ` +
              "Use approved recovery procedure.",
          );
          requiresReview++;
          continue;
        }

        const [updated] = await db
          .update(outbox)
          .set({
            status: OutboxStatus.FAILED,
            errorMessage:
              `BullMQ job exhausted ${attemptsMade} attempts. ` +
              "Manual reconciliation required.",
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(outbox.id, event.id),
              eq(outbox.status, OutboxStatus.PROCESSING),
              lte(outbox.updatedAt, cutoff),
            ),
          )
          .returning({
            id: outbox.id,
          });

        if (updated) {
          markedFailed++;
          console.log(`[Recovery] Outbox marked FAILED: ${updated.id}`);
        } else {
          console.warn(`[Recovery] Outbox changed concurrently: ${event.id}`);
          requiresReview++;
        }

        continue;
      }

      // Không biết chắc email đã gửi hay chưa:
      // Không tự động đưa Outbox về PENDING.
      console.warn(
        `[Recovery] Manual review required: ${jobId}, ` +
          `jobState=${jobState}`,
      );

      requiresReview++;
    } catch (error) {
      requiresReview++;

      console.error(
        `[Recovery] Error inspecting ${event.id}:`,
        error instanceof Error ? error.message : "Unknown error",
      );
    }
  }

  console.log("[Recovery] Finished", {
    inspected: events.length,
    markedFailed,
    requiresReview,
  });

  if (requiresReview > 0) {
    console.warn("[Recovery] Some events require manual reconciliation.");
  }
}

main()
  .catch((error: unknown) => {
    console.error("[Recovery] Fatal error:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await emailQueue.close();
    await sqlClient.end();
  });

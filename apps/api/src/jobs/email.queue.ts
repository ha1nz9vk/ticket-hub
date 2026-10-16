import { Queue } from "bullmq";
import { env } from "../config/env.config";
import {
  EMAIL_QUEUE_NAME,
  EmailJobData,
  UserRegisteredPayload,
  UserRegisteredPayloadSchema,
} from "./email.types";

const redisUrl = new URL(env.REDIS_URL);

const connection = {
  host: redisUrl.hostname,
  port: Number(redisUrl.port || 6379),
  username: redisUrl.username
    ? decodeURIComponent(redisUrl.username)
    : undefined,
  password: redisUrl.password
    ? decodeURIComponent(redisUrl.password)
    : undefined,
  ...(redisUrl.protocol === "rediss:" ? { tls: {} } : {}),
};

export const emailQueue = new Queue<EmailJobData>(EMAIL_QUEUE_NAME, {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: "exponential",
      delay: 2000,
    },
    removeOnComplete: {
      age: 86400,
    },
    removeOnFail: {
      age: 604800,
    },
  },
});

export async function enqueueRegistrationEmail(
  outboxId: string,
  payload: UserRegisteredPayload,
) {
  const validPayload = UserRegisteredPayloadSchema.parse(payload);

  return emailQueue.add(
    "user-registered",
    {
      outboxId,
      eventType: "USER_REGISTERED",
      payload: validPayload,
    },
    {
      jobId: `outbox_${outboxId}`,
    },
  );
}

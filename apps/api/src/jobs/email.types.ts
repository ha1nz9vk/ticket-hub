import { z } from "zod";

export const EMAIL_QUEUE_NAME = "tickethub-email";

export const UserRegisteredPayloadSchema = z.object({
  userId: z.string().uuid(),
  email: z.string().email(),
  fullName: z.string(),
  verificationToken: z.string().min(1),
});

export type UserRegisteredPayload = z.infer<typeof UserRegisteredPayloadSchema>;

export interface EmailJobData {
  outboxId: string;
  eventType: "USER_REGISTERED";
  payload: UserRegisteredPayload;
}

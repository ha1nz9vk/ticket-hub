export type RecoveryDecision = "WAIT" | "MARK_FAILED" | "MANUAL_REVIEW";

const activeStates = new Set([
  "waiting",
  "active",
  "delayed",
  "prioritized",
  "waiting-children",
]);

export function decideRecovery(
  jobState: string,
  attemptsMade: number,
  maxAttempts: number,
): RecoveryDecision {
  // Job vẫn đang được BullMQ quản lý.
  if (activeStates.has(jobState)) {
    return "WAIT";
  }

  // Job đã thất bại và không còn lượt thử.
  if (jobState === "failed" && maxAttempts > 0 && attemptsMade >= maxAttempts) {
    return "MARK_FAILED";
  }

  // Không xác định chắc chắn tình trạng email.
  // Tuyệt đối không tự động gửi lại.
  return "MANUAL_REVIEW";
}

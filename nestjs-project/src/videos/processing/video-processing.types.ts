/**
 * The job payload carries the identifier and nothing else: BullMQ delivers
 * at-least-once, so the handler re-reads the row instead of trusting a
 * snapshot taken at enqueue time. That also makes the commit-then-enqueue
 * ordering safe — Redis is not part of the database transaction.
 */
export interface VideoProcessingJobData {
  videoId: string;
}

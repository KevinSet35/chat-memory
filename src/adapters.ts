import type { MemorySummaryRecord, UpsertSummaryData } from './types.js';

/**
 * Storage adapter for persisting and retrieving memory summaries.
 * Consuming apps implement this interface with their own database.
 */
export interface MemoryStorageAdapter {
    getSummary(
        entityType: string,
        entityId: string,
        modelKey: string | null,
    ): Promise<MemorySummaryRecord | null>;

    upsertSummary(data: UpsertSummaryData): Promise<void>;

    deleteSummariesByEntity(entityType: string, entityId: string): Promise<void>;
}

/**
 * Summarizer adapter for generating conversation summaries.
 * Consuming apps implement this interface with their own LLM provider.
 */
export interface SummarizerAdapter {
    /**
     * Generate or update a conversation summary.
     * Returns null on failure — summarization is always best-effort.
     *
     * @param messagesText - Pre-formatted messages to summarize
     * @param existingSummary - Existing summary to update incrementally (null for initial)
     * @param context - Optional opaque context passed through from BuildHistoryInput.summarizationContext
     */
    summarize(
        messagesText: string,
        existingSummary: string | null,
        context?: unknown,
    ): Promise<string | null>;
}

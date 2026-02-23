import type { MemoryStorageAdapter, SummarizerAdapter } from './adapters.js';
import { MemorySplitUtil } from './memory-split.js';
import type {
    Message,
    BuildHistoryInput,
    MemoryContext,
    ThreeTierMemoryManagerConfig,
    ThreeTierConfig,
    ThreeTierSplitResult,
    TokenBudgetConfig,
    MemoryLogger,
} from './types.js';

/** Default max tokens reserved for the summary slot. */
const DEFAULT_MAX_SUMMARY_BUDGET_TOKENS = 500;

/**
 * Framework-agnostic 3-tier memory orchestration.
 *
 * Handles the full workflow: split -> check summary -> summarize -> persist -> assemble.
 * Consumers provide storage and summarizer adapters; if either is missing,
 * summarization is skipped gracefully.
 */
export class ThreeTierMemoryManager {
    private readonly storage?: MemoryStorageAdapter;
    private readonly summarizer?: SummarizerAdapter;
    private readonly summarizationEnabled: boolean;
    private readonly maxSummaryBudgetTokens: number;
    private readonly charsPerToken?: number;
    private readonly logger?: MemoryLogger;

    constructor(options?: {
        storage?: MemoryStorageAdapter;
        summarizer?: SummarizerAdapter;
        config?: ThreeTierMemoryManagerConfig;
    }) {
        this.storage = options?.storage;
        this.summarizer = options?.summarizer;
        this.summarizationEnabled = options?.config?.summarizationEnabled ?? true;
        this.maxSummaryBudgetTokens = options?.config?.defaultMaxSummaryBudgetTokens ?? DEFAULT_MAX_SUMMARY_BUDGET_TOKENS;
        this.charsPerToken = options?.config?.defaultCharsPerToken;
        this.logger = options?.config?.logger;
    }

    /**
     * Build message history using 3-tier memory:
     * 1. First pair (always kept verbatim)
     * 2. Summary of dropped messages (generated via LLM, best-effort)
     * 3. Recent messages (kept verbatim)
     *
     * Falls back to simple sliding-window truncation if 3-tier split is not applicable.
     * Appends the new user message to the end of the assembled history.
     */
    async buildHistory(input: BuildHistoryInput, context?: MemoryContext): Promise<Message[]> {
        const { allHistory, contextWindow, maxOutputTokens, systemMessage, newUserMessage } = input;

        const splitResult = this.splitMessages(
            allHistory, contextWindow, maxOutputTokens, systemMessage, newUserMessage,
        );

        // No truncation needed — all messages fit
        if (!splitResult.wasTruncated) {
            const messages = [...allHistory];
            if (newUserMessage) {
                messages.push({ role: 'user', content: newUserMessage });
            }
            return messages;
        }

        // 3-tier split not applicable (budget exhausted or first pair too large) — fall back
        if (splitResult.firstPair.length === 0) {
            const truncated = this.truncateMessages(
                allHistory, contextWindow, maxOutputTokens, systemMessage, newUserMessage,
            );
            const messages = [...truncated];
            if (newUserMessage) {
                messages.push({ role: 'user', content: newUserMessage });
            }
            return messages;
        }

        // Build summary of dropped messages (best-effort).
        // Skip DB + LLM calls entirely when summarization is disabled or no context provided.
        const summaryMessage = context
            ? await this.buildSummaryMessage(splitResult.droppedMessages, context, input.summarizationContext)
            : null;

        // Assemble: firstPair + summary? + recentMessages + newUserMessage
        const assembled: Message[] = [
            ...splitResult.firstPair,
            ...(summaryMessage ? [summaryMessage] : []),
            ...splitResult.recentMessages,
        ];
        if (newUserMessage) {
            assembled.push({ role: 'user', content: newUserMessage });
        }

        return assembled;
    }

    /**
     * Delete all summaries for a given entity (fire-and-forget cleanup).
     */
    async deleteSummaries(entityType: string, entityId: string): Promise<void> {
        if (!this.storage) return;
        await this.storage.deleteSummariesByEntity(entityType, entityId);
    }

    // ============================================================
    // Private helpers
    // ============================================================

    /**
     * Split messages into three tiers based on token budget.
     * Returns a no-truncation result when all messages fit.
     */
    private splitMessages(
        messages: Message[],
        contextWindow: number,
        maxOutputTokens: number,
        systemMessage?: string,
        newUserMessage?: string,
    ): ThreeTierSplitResult {
        const noTruncation: ThreeTierSplitResult = {
            firstPair: [],
            droppedMessages: [],
            recentMessages: messages,
            processedThroughIndex: Math.max(messages.length - 1, 0),
            wasTruncated: false,
        };

        if (messages.length < MemorySplitUtil.MIN_MESSAGES_FOR_FIRST_PAIR) {
            return noTruncation;
        }

        const threeTierConfig: ThreeTierConfig = {
            contextWindow,
            maxOutputTokens,
            maxSummaryBudgetTokens: this.maxSummaryBudgetTokens,
            charsPerToken: this.charsPerToken,
            systemMessage,
            newUserMessage,
        };

        const result = MemorySplitUtil.splitForThreeTierMemory(messages, threeTierConfig);

        if (result.wasTruncated) {
            this.logger?.debug(
                `3-tier split: ${messages.length} messages -> firstPair: ${result.firstPair.length}, dropped: ${result.droppedMessages.length}, recent: ${result.recentMessages.length}`,
            );
        }

        return result;
    }

    /**
     * Sliding-window truncation fallback when 3-tier split is not applicable.
     */
    private truncateMessages(
        messages: Message[],
        contextWindow: number,
        maxOutputTokens: number,
        systemMessage?: string,
        newUserMessage?: string,
    ): Message[] {
        if (messages.length === 0) return messages;

        const config: TokenBudgetConfig = {
            contextWindow,
            maxOutputTokens,
            charsPerToken: this.charsPerToken,
            systemMessage,
            newUserMessage,
        };

        const truncated = MemorySplitUtil.truncateToTokenBudget(messages, config);

        if (truncated.length < messages.length) {
            this.logger?.debug(
                `Truncated history from ${messages.length} to ${truncated.length} messages (contextWindow: ${contextWindow})`,
            );
        }

        return truncated;
    }

    /**
     * Build a summary message from dropped messages, using existing summaries
     * and incremental summarization when available.
     */
    private async buildSummaryMessage(
        droppedMessages: Message[],
        context: MemoryContext,
        summarizationContext?: unknown,
    ): Promise<Message | null> {
        if (droppedMessages.length === 0 || !this.summarizationEnabled) {
            return null;
        }

        // No adapters = no summarization
        if (!this.storage || !this.summarizer) {
            return null;
        }

        try {
            const existingSummary = await this.storage.getSummary(
                context.entityType, context.entityId, context.modelKey,
            );

            // Determine which dropped messages are newly dropped (not yet summarized).
            // summarizedThroughIndex stores droppedMessages.length + 1 as a marker;
            // subtract 1 to get the count of already-summarized dropped messages.
            // This assumes messages are append-only (no mid-conversation deletions).
            let newlyDroppedMessages = droppedMessages;
            if (existingSummary && existingSummary.summarizedThroughIndex > 1) {
                const alreadySummarizedInDropped = existingSummary.summarizedThroughIndex - 1;
                if (alreadySummarizedInDropped < droppedMessages.length) {
                    newlyDroppedMessages = droppedMessages.slice(alreadySummarizedInDropped);
                } else {
                    newlyDroppedMessages = [];
                }
            }

            // Short-circuit: no new messages to summarize but we have an existing summary
            if (newlyDroppedMessages.length === 0 && existingSummary) {
                return {
                    role: 'user',
                    content: `[Conversation Summary]\n${existingSummary.summary}`,
                };
            }

            if (newlyDroppedMessages.length > 0) {
                // Generate or update summary
                const messagesText = newlyDroppedMessages
                    .map(m => `${m.role}: ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`)
                    .join('\n\n');

                const summaryText = await this.summarizer.summarize(
                    messagesText,
                    existingSummary?.summary ?? null,
                    summarizationContext,
                );

                if (summaryText) {
                    // Persist summary (fire-and-forget, safe for concurrent requests)
                    const newSummarizedThroughIndex = droppedMessages.length + 1;
                    void this.storage.upsertSummary({
                        entityType: context.entityType,
                        entityId: context.entityId,
                        modelKey: context.modelKey,
                        summary: summaryText,
                        summarizedThroughIndex: newSummarizedThroughIndex,
                    }).catch(err => this.logger?.warn(
                        `Failed to persist summary for ${context.entityType}/${context.entityId}`, err,
                    ));

                    return {
                        role: 'user',
                        content: `[Conversation Summary]\n${summaryText}`,
                    };
                }

                // Summarization failed but we have a previous summary — use it
                if (existingSummary) {
                    return {
                        role: 'user',
                        content: `[Conversation Summary]\n${existingSummary.summary}`,
                    };
                }
            }
        } catch (error) {
            this.logger?.warn(
                `Failed to build summary for ${context.entityType}/${context.entityId}, proceeding without`, error,
            );
        }

        return null;
    }
}

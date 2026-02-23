import { TokenEstimationUtil } from './token-estimation.js';
import type { Message, TokenBudgetConfig, ThreeTierConfig, ThreeTierSplitResult } from './types.js';

/**
 * Utility for splitting and truncating message history for the 3-tier memory system.
 * Handles token-budget-aware splitting of conversation history into first pair,
 * dropped (summarizable) messages, and recent window.
 */
export class MemorySplitUtil {
    /** Minimum messages required for a first-pair (user + assistant) exchange */
    static readonly MIN_MESSAGES_FOR_FIRST_PAIR = 2;

    /** Default token buffer for message framing and formatting overhead */
    private static readonly DEFAULT_SAFETY_MARGIN = 200;

    /**
     * Trim conversation history to fit within a model's context window token budget.
     *
     * Walks messages from newest to oldest, keeping as many recent messages as
     * the budget allows. The system message, new user message, max output tokens,
     * and a safety margin are all deducted from the context window first.
     *
     * @param messages - Existing conversation history in chronological order
     * @param config - Token budget configuration
     * @returns Messages that fit within the budget, in chronological order (oldest first)
     */
    static truncateToTokenBudget(messages: Message[], config: TokenBudgetConfig): Message[] {
        if (messages.length === 0) return [];

        const budget = MemorySplitUtil.calculateHistoryBudget(config);
        if (budget <= 0) return [];

        const { charsPerToken } = config;

        // Walk from newest to oldest, accumulating tokens
        const kept: Message[] = [];
        let usedTokens = 0;

        for (let i = messages.length - 1; i >= 0; i--) {
            const msgTokens = TokenEstimationUtil.estimateContentTokens(
                messages[i].content,
                charsPerToken,
            );

            // Break (not continue) to preserve contiguous conversation context.
            // A single oversized message stops inclusion of all older messages.
            if (usedTokens + msgTokens > budget) break;

            usedTokens += msgTokens;
            kept.push(messages[i]);
        }

        // Return in chronological order (oldest first)
        return kept.reverse();
    }

    /**
     * Split conversation history into three tiers for the 3-tier memory system:
     * 1. First pair — first user + assistant exchange (anchors the conversation)
     * 2. Dropped messages — middle messages that need summarization
     * 3. Recent window — recent messages kept verbatim
     *
     * Returns `wasTruncated: false` only when all messages fit within the budget.
     * When the 3-tier split is not applicable (too few messages, budget exhausted,
     * or first pair exceeds budget), the caller should fall back to
     * `truncateToTokenBudget()` for basic sliding-window truncation.
     *
     * @param messages - Existing conversation history in chronological order
     * @param config - Token budget configuration including summary budget
     * @returns ThreeTierSplitResult with the split
     */
    static splitForThreeTierMemory(messages: Message[], config: ThreeTierConfig): ThreeTierSplitResult {
        const noTruncation: ThreeTierSplitResult = {
            firstPair: [],
            droppedMessages: [],
            recentMessages: messages,
            processedThroughIndex: Math.max(messages.length - 1, 0),
            wasTruncated: false,
        };

        // Need at least 2 messages for a first pair
        if (messages.length < MemorySplitUtil.MIN_MESSAGES_FOR_FIRST_PAIR) return noTruncation;

        const { charsPerToken, maxSummaryBudgetTokens } = config;
        const totalBudget = MemorySplitUtil.calculateHistoryBudget(config);

        // Budget exhausted — nothing fits, caller should handle via truncateToTokenBudget
        if (totalBudget <= 0) {
            return { firstPair: [], droppedMessages: messages, recentMessages: [], processedThroughIndex: messages.length - 1, wasTruncated: true };
        }

        // Calculate first pair tokens
        const firstPairTokens = TokenEstimationUtil.estimateContentTokens(messages[0].content, charsPerToken)
            + TokenEstimationUtil.estimateContentTokens(messages[1].content, charsPerToken);

        // First pair alone exceeds budget — 3-tier split not applicable, caller should fall back
        if (firstPairTokens >= totalBudget) {
            return { firstPair: [], droppedMessages: messages, recentMessages: [], processedThroughIndex: messages.length - 1, wasTruncated: true };
        }

        // Check if all messages fit without truncation
        let allMessagesTokens = 0;
        for (const msg of messages) {
            allMessagesTokens += TokenEstimationUtil.estimateContentTokens(msg.content, charsPerToken);
        }

        if (allMessagesTokens <= totalBudget) return noTruncation;

        // Truncation is needed — perform the 3-tier split
        const firstPair = messages.slice(0, MemorySplitUtil.MIN_MESSAGES_FOR_FIRST_PAIR);

        // Budget remaining after first pair and summary reservation
        const recentBudget = totalBudget - firstPairTokens - maxSummaryBudgetTokens;

        // Fill recent window from the end (backward walk, same as truncateToTokenBudget)
        const recentMessages: Message[] = [];
        let recentTokens = 0;

        if (recentBudget > 0) {
            for (let i = messages.length - 1; i >= MemorySplitUtil.MIN_MESSAGES_FOR_FIRST_PAIR; i--) {
                const msgTokens = TokenEstimationUtil.estimateContentTokens(messages[i].content, charsPerToken);
                if (recentTokens + msgTokens > recentBudget) break;
                recentTokens += msgTokens;
                recentMessages.push(messages[i]);
            }
            recentMessages.reverse();
        }

        // Everything between first pair and recent window = dropped messages
        const recentStartIndex = messages.length - recentMessages.length;
        const droppedMessages = messages.slice(MemorySplitUtil.MIN_MESSAGES_FOR_FIRST_PAIR, recentStartIndex);

        return {
            firstPair,
            droppedMessages,
            recentMessages,
            processedThroughIndex: messages.length - 1,
            wasTruncated: true,
        };
    }

    /**
    * Calculate the token budget available for message history.
    * Shared by truncateToTokenBudget and splitForThreeTierMemory.
    */
    private static calculateHistoryBudget(config: TokenBudgetConfig): number {
        const safetyMargin = config.safetyMargin ?? MemorySplitUtil.DEFAULT_SAFETY_MARGIN;
        let budget = config.contextWindow - config.maxOutputTokens - safetyMargin;

        if (config.systemMessage) {
            budget -= TokenEstimationUtil.estimateStringTokens(config.systemMessage, config.charsPerToken);
        }
        if (config.newUserMessage) {
            budget -= TokenEstimationUtil.estimateStringTokens(config.newUserMessage, config.charsPerToken);
        }

        return budget;
    }
}

import { describe, it, expect } from 'vitest';
import { MemorySplitUtil } from '../src/index.js';
import type { Message, TokenBudgetConfig, ThreeTierConfig } from '../src/index.js';

/** Helper: create a message with content of a given character length. */
function msg(role: 'user' | 'assistant', charLength: number): Message {
    return { role, content: 'x'.repeat(charLength) };
}

describe('MemorySplitUtil', () => {
    describe('truncateToTokenBudget', () => {
        const baseConfig: TokenBudgetConfig = {
            contextWindow: 1000,
            maxOutputTokens: 200,
            // budget = 1000 - 200 - 200 (safety) = 600 tokens = 2400 chars at 4 chars/token
        };

        it('should return empty array for empty messages', () => {
            expect(MemorySplitUtil.truncateToTokenBudget([], baseConfig)).toEqual([]);
        });

        it('should return all messages when they fit', () => {
            const messages = [msg('user', 100), msg('assistant', 100)];
            const result = MemorySplitUtil.truncateToTokenBudget(messages, baseConfig);
            expect(result).toHaveLength(2);
        });

        it('should keep recent messages when history exceeds budget', () => {
            // Each message = 1000 chars = 250 tokens. Budget = 600 tokens.
            // Can fit 2 messages (500 tokens). 3rd won't fit.
            const messages = [msg('user', 1000), msg('assistant', 1000), msg('user', 1000)];
            const result = MemorySplitUtil.truncateToTokenBudget(messages, baseConfig);
            expect(result).toHaveLength(2);
            // Should keep the 2 most recent
            expect(result[0]).toBe(messages[1]);
            expect(result[1]).toBe(messages[2]);
        });

        it('should return empty when budget is non-positive', () => {
            const config: TokenBudgetConfig = {
                contextWindow: 100,
                maxOutputTokens: 200,
            };
            const messages = [msg('user', 10)];
            expect(MemorySplitUtil.truncateToTokenBudget(messages, config)).toEqual([]);
        });

        it('should deduct system message from budget', () => {
            // budget = 1000 - 200 - 200 - systemMessage tokens
            // systemMessage = 400 chars = 100 tokens
            // remaining = 500 tokens = 2000 chars
            const config: TokenBudgetConfig = { ...baseConfig, systemMessage: 'x'.repeat(400) };
            // Each message = 1000 chars = 250 tokens. Can fit 2 (500 tokens).
            const messages = [msg('user', 1000), msg('assistant', 1000), msg('user', 1000)];
            const result = MemorySplitUtil.truncateToTokenBudget(messages, config);
            expect(result).toHaveLength(2);
        });

        it('should deduct new user message from budget', () => {
            const config: TokenBudgetConfig = { ...baseConfig, newUserMessage: 'x'.repeat(400) };
            const messages = [msg('user', 1000), msg('assistant', 1000), msg('user', 1000)];
            const result = MemorySplitUtil.truncateToTokenBudget(messages, config);
            expect(result).toHaveLength(2);
        });

        it('should preserve chronological order', () => {
            const messages = [
                { role: 'user' as const, content: 'first' },
                { role: 'assistant' as const, content: 'second' },
                { role: 'user' as const, content: 'third' },
            ];
            const result = MemorySplitUtil.truncateToTokenBudget(messages, baseConfig);
            expect(result.map(m => m.content)).toEqual(['first', 'second', 'third']);
        });
    });

    describe('splitForThreeTierMemory', () => {
        const baseConfig: ThreeTierConfig = {
            contextWindow: 1000,
            maxOutputTokens: 200,
            maxSummaryBudgetTokens: 100,
            // budget = 1000 - 200 - 200 (safety) = 600 tokens
            // recentBudget = 600 - firstPairTokens - 100 (summary)
        };

        it('should return no-truncation when all messages fit', () => {
            const messages = [msg('user', 40), msg('assistant', 40)];
            const result = MemorySplitUtil.splitForThreeTierMemory(messages, baseConfig);
            expect(result.wasTruncated).toBe(false);
            expect(result.recentMessages).toBe(messages);
            expect(result.firstPair).toEqual([]);
            expect(result.droppedMessages).toEqual([]);
        });

        it('should return no-truncation for less than MIN_MESSAGES_FOR_FIRST_PAIR', () => {
            const messages = [msg('user', 40)];
            const result = MemorySplitUtil.splitForThreeTierMemory(messages, baseConfig);
            expect(result.wasTruncated).toBe(false);
        });

        it('should split into 3 tiers when truncation is needed', () => {
            // Create messages that exceed budget
            // First pair: 2 * 200 chars = 100 tokens
            // recentBudget = 600 - 100 - 100 = 400 tokens = 1600 chars
            // Total: 10 messages * 200 chars = 500 tokens > 600
            const messages: Message[] = [];
            for (let i = 0; i < 10; i++) {
                messages.push(msg(i % 2 === 0 ? 'user' : 'assistant', 200));
            }
            // total = 10 * 50 = 500 tokens > 600? No, 500 < 600. Let's make them bigger.
            // Each message = 400 chars = 100 tokens. Total = 1000 tokens > 600.
            const bigMessages: Message[] = [];
            for (let i = 0; i < 10; i++) {
                bigMessages.push(msg(i % 2 === 0 ? 'user' : 'assistant', 400));
            }
            // firstPair = 200 tokens. recentBudget = 600 - 200 - 100 = 300 tokens = 3 messages
            const result = MemorySplitUtil.splitForThreeTierMemory(bigMessages, baseConfig);

            expect(result.wasTruncated).toBe(true);
            expect(result.firstPair).toHaveLength(2);
            expect(result.firstPair[0]).toBe(bigMessages[0]);
            expect(result.firstPair[1]).toBe(bigMessages[1]);
            expect(result.recentMessages.length).toBeGreaterThan(0);
            expect(result.droppedMessages.length).toBeGreaterThan(0);
            // firstPair + dropped + recent should cover all messages
            expect(
                result.firstPair.length + result.droppedMessages.length + result.recentMessages.length,
            ).toBe(bigMessages.length);
        });

        it('should return empty firstPair when budget is exhausted', () => {
            const config: ThreeTierConfig = {
                contextWindow: 100,
                maxOutputTokens: 200,
                maxSummaryBudgetTokens: 50,
            };
            const messages = [msg('user', 40), msg('assistant', 40)];
            const result = MemorySplitUtil.splitForThreeTierMemory(messages, config);
            expect(result.wasTruncated).toBe(true);
            expect(result.firstPair).toEqual([]);
        });

        it('should return empty firstPair when first pair exceeds budget', () => {
            // budget = 1000 - 200 - 200 = 600 tokens
            // first pair = 2 * 2400 chars = 1200 tokens > 600
            const messages = [msg('user', 2400), msg('assistant', 2400), msg('user', 40)];
            const result = MemorySplitUtil.splitForThreeTierMemory(messages, baseConfig);
            expect(result.wasTruncated).toBe(true);
            expect(result.firstPair).toEqual([]);
        });

        it('should set processedThroughIndex correctly', () => {
            const messages: Message[] = [];
            for (let i = 0; i < 10; i++) {
                messages.push(msg(i % 2 === 0 ? 'user' : 'assistant', 400));
            }
            const result = MemorySplitUtil.splitForThreeTierMemory(messages, baseConfig);
            expect(result.processedThroughIndex).toBe(messages.length - 1);
        });
    });

    describe('MIN_MESSAGES_FOR_FIRST_PAIR', () => {
        it('should be 2', () => {
            expect(MemorySplitUtil.MIN_MESSAGES_FOR_FIRST_PAIR).toBe(2);
        });
    });
});

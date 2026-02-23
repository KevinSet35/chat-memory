import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ThreeTierMemoryManager } from '../src/index.js';
import type {
    MemoryStorageAdapter,
    SummarizerAdapter,
    Message,
    BuildHistoryInput,
    MemoryContext,
    MemorySummaryRecord,
} from '../src/index.js';

/** Helper: create a message with content of a given character length. */
function msg(role: 'user' | 'assistant', content: string): Message {
    return { role, content };
}

/** Helper: create a short message. */
function shortMsg(role: 'user' | 'assistant', idx: number): Message {
    return { role, content: `msg-${idx}` };
}

/** Helper: create a long message (400 chars = 100 tokens at default 4 chars/token). */
function longMsg(role: 'user' | 'assistant', idx: number): Message {
    return { role, content: `[${idx}]` + 'x'.repeat(400 - `[${idx}]`.length) };
}

function createMockStorage(): MemoryStorageAdapter {
    return {
        getSummary: vi.fn().mockResolvedValue(null),
        upsertSummary: vi.fn().mockResolvedValue(undefined),
        deleteSummariesByEntity: vi.fn().mockResolvedValue(undefined),
    };
}

function createMockSummarizer(): SummarizerAdapter {
    return {
        summarize: vi.fn().mockResolvedValue('Generated summary'),
    };
}

const defaultContext: MemoryContext = {
    entityType: 'conversation',
    entityId: 'conv-123',
    modelKey: null,
};

describe('ThreeTierMemoryManager', () => {
    let storage: MemoryStorageAdapter;
    let summarizer: SummarizerAdapter;
    let manager: ThreeTierMemoryManager;

    beforeEach(() => {
        storage = createMockStorage();
        summarizer = createMockSummarizer();
        manager = new ThreeTierMemoryManager({
            storage,
            summarizer,
            config: { summarizationEnabled: true },
        });
    });

    describe('buildHistory - no truncation needed', () => {
        it('should return all messages when they fit within budget', async () => {
            const input: BuildHistoryInput = {
                allHistory: [shortMsg('user', 1), shortMsg('assistant', 2)],
                contextWindow: 10000,
                maxOutputTokens: 1000,
            };

            const result = await manager.buildHistory(input, defaultContext);
            expect(result).toEqual(input.allHistory);
            expect(storage.getSummary).not.toHaveBeenCalled();
        });

        it('should append newUserMessage when provided', async () => {
            const input: BuildHistoryInput = {
                allHistory: [shortMsg('user', 1), shortMsg('assistant', 2)],
                contextWindow: 10000,
                maxOutputTokens: 1000,
                newUserMessage: 'new question',
            };

            const result = await manager.buildHistory(input, defaultContext);
            expect(result).toHaveLength(3);
            expect(result[2]).toEqual({ role: 'user', content: 'new question' });
        });
    });

    describe('buildHistory - 3-tier split with summary generation', () => {
        it('should generate summary for dropped messages', async () => {
            // Create enough messages to trigger truncation
            // contextWindow: 1000, maxOutputTokens: 200
            // budget = 1000 - 200 - 200 (safety) = 600 tokens
            const messages: Message[] = [];
            for (let i = 0; i < 10; i++) {
                messages.push(longMsg(i % 2 === 0 ? 'user' : 'assistant', i));
            }

            const input: BuildHistoryInput = {
                allHistory: messages,
                contextWindow: 1000,
                maxOutputTokens: 200,
            };

            const result = await manager.buildHistory(input, defaultContext);

            // Should have called summarizer
            expect(summarizer.summarize).toHaveBeenCalled();
            // Should have called storage to persist
            expect(storage.upsertSummary).toHaveBeenCalled();

            // Result should contain summary message
            const summaryMsg = result.find(m =>
                typeof m.content === 'string' && m.content.includes('[Conversation Summary]'),
            );
            expect(summaryMsg).toBeDefined();
            expect(summaryMsg?.content).toContain('Generated summary');
        });
    });

    describe('buildHistory - incremental summarization', () => {
        it('should use existing summary and only summarize new messages', async () => {
            const existingSummary: MemorySummaryRecord = {
                id: 'sum-1',
                entityType: 'conversation',
                entityId: 'conv-123',
                modelKey: null,
                summary: 'Previous summary',
                summarizedThroughIndex: 4, // 3 messages already summarized
                createdAt: '2024-01-01',
                updatedAt: '2024-01-01',
            };
            vi.mocked(storage.getSummary).mockResolvedValue(existingSummary);

            const messages: Message[] = [];
            for (let i = 0; i < 10; i++) {
                messages.push(longMsg(i % 2 === 0 ? 'user' : 'assistant', i));
            }

            const input: BuildHistoryInput = {
                allHistory: messages,
                contextWindow: 1000,
                maxOutputTokens: 200,
            };

            await manager.buildHistory(input, defaultContext);

            // Summarizer should be called with existing summary
            expect(summarizer.summarize).toHaveBeenCalledWith(
                expect.any(String),
                'Previous summary',
                undefined,
            );
        });

        it('should short-circuit when no new messages to summarize', async () => {
            const existingSummary: MemorySummaryRecord = {
                id: 'sum-1',
                entityType: 'conversation',
                entityId: 'conv-123',
                modelKey: null,
                summary: 'Full summary',
                summarizedThroughIndex: 100, // More than all dropped messages
                createdAt: '2024-01-01',
                updatedAt: '2024-01-01',
            };
            vi.mocked(storage.getSummary).mockResolvedValue(existingSummary);

            const messages: Message[] = [];
            for (let i = 0; i < 10; i++) {
                messages.push(longMsg(i % 2 === 0 ? 'user' : 'assistant', i));
            }

            const input: BuildHistoryInput = {
                allHistory: messages,
                contextWindow: 1000,
                maxOutputTokens: 200,
            };

            const result = await manager.buildHistory(input, defaultContext);

            // Should NOT call summarizer since all are already summarized
            expect(summarizer.summarize).not.toHaveBeenCalled();
            // Should still include summary message
            const summaryMsg = result.find(m =>
                typeof m.content === 'string' && m.content.includes('[Conversation Summary]'),
            );
            expect(summaryMsg).toBeDefined();
            expect(summaryMsg?.content).toContain('Full summary');
        });
    });

    describe('buildHistory - summarization failure fallback', () => {
        it('should fall back to existing summary when summarizer returns null', async () => {
            const existingSummary: MemorySummaryRecord = {
                id: 'sum-1',
                entityType: 'conversation',
                entityId: 'conv-123',
                modelKey: null,
                summary: 'Old summary',
                summarizedThroughIndex: 2,
                createdAt: '2024-01-01',
                updatedAt: '2024-01-01',
            };
            vi.mocked(storage.getSummary).mockResolvedValue(existingSummary);
            vi.mocked(summarizer.summarize).mockResolvedValue(null);

            const messages: Message[] = [];
            for (let i = 0; i < 10; i++) {
                messages.push(longMsg(i % 2 === 0 ? 'user' : 'assistant', i));
            }

            const input: BuildHistoryInput = {
                allHistory: messages,
                contextWindow: 1000,
                maxOutputTokens: 200,
            };

            const result = await manager.buildHistory(input, defaultContext);

            const summaryMsg = result.find(m =>
                typeof m.content === 'string' && m.content.includes('[Conversation Summary]'),
            );
            expect(summaryMsg).toBeDefined();
            expect(summaryMsg?.content).toContain('Old summary');
        });

        it('should return no summary when summarizer fails and no existing summary', async () => {
            vi.mocked(summarizer.summarize).mockResolvedValue(null);

            const messages: Message[] = [];
            for (let i = 0; i < 10; i++) {
                messages.push(longMsg(i % 2 === 0 ? 'user' : 'assistant', i));
            }

            const input: BuildHistoryInput = {
                allHistory: messages,
                contextWindow: 1000,
                maxOutputTokens: 200,
            };

            const result = await manager.buildHistory(input, defaultContext);

            const summaryMsg = result.find(m =>
                typeof m.content === 'string' && m.content.includes('[Conversation Summary]'),
            );
            expect(summaryMsg).toBeUndefined();
        });
    });

    describe('buildHistory - no context = no summarization', () => {
        it('should skip summarization when no context is provided', async () => {
            const messages: Message[] = [];
            for (let i = 0; i < 10; i++) {
                messages.push(longMsg(i % 2 === 0 ? 'user' : 'assistant', i));
            }

            const input: BuildHistoryInput = {
                allHistory: messages,
                contextWindow: 1000,
                maxOutputTokens: 200,
            };

            // No context provided
            const result = await manager.buildHistory(input);

            expect(storage.getSummary).not.toHaveBeenCalled();
            expect(summarizer.summarize).not.toHaveBeenCalled();
            // Should still have firstPair + recent, just no summary
            const summaryMsg = result.find(m =>
                typeof m.content === 'string' && m.content.includes('[Conversation Summary]'),
            );
            expect(summaryMsg).toBeUndefined();
        });
    });

    describe('buildHistory - no adapters = no summarization', () => {
        it('should skip summarization when no storage adapter is provided', async () => {
            const managerNoStorage = new ThreeTierMemoryManager({
                summarizer,
                config: { summarizationEnabled: true },
            });

            const messages: Message[] = [];
            for (let i = 0; i < 10; i++) {
                messages.push(longMsg(i % 2 === 0 ? 'user' : 'assistant', i));
            }

            const input: BuildHistoryInput = {
                allHistory: messages,
                contextWindow: 1000,
                maxOutputTokens: 200,
            };

            const result = await managerNoStorage.buildHistory(input, defaultContext);

            expect(summarizer.summarize).not.toHaveBeenCalled();
            const summaryMsg = result.find(m =>
                typeof m.content === 'string' && m.content.includes('[Conversation Summary]'),
            );
            expect(summaryMsg).toBeUndefined();
        });

        it('should skip summarization when no summarizer adapter is provided', async () => {
            const managerNoSummarizer = new ThreeTierMemoryManager({
                storage,
                config: { summarizationEnabled: true },
            });

            const messages: Message[] = [];
            for (let i = 0; i < 10; i++) {
                messages.push(longMsg(i % 2 === 0 ? 'user' : 'assistant', i));
            }

            const input: BuildHistoryInput = {
                allHistory: messages,
                contextWindow: 1000,
                maxOutputTokens: 200,
            };

            const result = await managerNoSummarizer.buildHistory(input, defaultContext);

            expect(storage.getSummary).not.toHaveBeenCalled();
            const summaryMsg = result.find(m =>
                typeof m.content === 'string' && m.content.includes('[Conversation Summary]'),
            );
            expect(summaryMsg).toBeUndefined();
        });
    });

    describe('buildHistory - sliding-window fallback', () => {
        it('should fall back to truncation when first pair exceeds budget', async () => {
            // Make first pair very large so 3-tier split fails
            const messages: Message[] = [
                { role: 'user', content: 'x'.repeat(4000) },       // 1000 tokens
                { role: 'assistant', content: 'x'.repeat(4000) },   // 1000 tokens
                shortMsg('user', 3),
                shortMsg('assistant', 4),
            ];

            const input: BuildHistoryInput = {
                allHistory: messages,
                contextWindow: 1000,
                maxOutputTokens: 200,
                // budget = 1000 - 200 - 200 = 600 tokens. First pair = 2000 tokens > 600.
            };

            const result = await manager.buildHistory(input, defaultContext);

            // Should not have tried summarization
            expect(storage.getSummary).not.toHaveBeenCalled();
            // Should return truncated recent messages
            expect(result.length).toBeLessThan(messages.length);
        });
    });

    describe('buildHistory - summarizationContext passthrough', () => {
        it('should pass summarizationContext to the summarizer adapter', async () => {
            const messages: Message[] = [];
            for (let i = 0; i < 10; i++) {
                messages.push(longMsg(i % 2 === 0 ? 'user' : 'assistant', i));
            }

            const customContext = { userId: 'user-abc', apiKey: 'key-123' };
            const input: BuildHistoryInput = {
                allHistory: messages,
                contextWindow: 1000,
                maxOutputTokens: 200,
                summarizationContext: customContext,
            };

            await manager.buildHistory(input, defaultContext);

            expect(summarizer.summarize).toHaveBeenCalledWith(
                expect.any(String),
                null,
                customContext,
            );
        });
    });

    describe('deleteSummaries', () => {
        it('should delegate to storage adapter', async () => {
            await manager.deleteSummaries('conversation', 'conv-123');
            expect(storage.deleteSummariesByEntity).toHaveBeenCalledWith('conversation', 'conv-123');
        });

        it('should not throw when no storage adapter', async () => {
            const managerNoStorage = new ThreeTierMemoryManager();
            await expect(managerNoStorage.deleteSummaries('conversation', 'conv-123')).resolves.toBeUndefined();
        });
    });

    describe('constructor defaults', () => {
        it('should work with no options', () => {
            const m = new ThreeTierMemoryManager();
            expect(m).toBeInstanceOf(ThreeTierMemoryManager);
        });

        it('should work with empty options', () => {
            const m = new ThreeTierMemoryManager({});
            expect(m).toBeInstanceOf(ThreeTierMemoryManager);
        });
    });
});

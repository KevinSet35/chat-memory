// ============================================================
// Message types
// ============================================================

/** Message role as a string union for maximum compatibility. */
export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

/** A single part of a multimodal message. */
export interface ContentPart {
    type: 'text' | 'image_url';
    text?: string;
    image_url?: { url: string };
}

/** A tool call made by the assistant. */
export interface ToolCall {
    id: string;
    /** Name of the tool being called */
    name: string;
    /** Arguments passed to the tool (parsed JSON) */
    arguments: string;
}

/** A chat message. */
export interface Message {
    /** The role of the message sender */
    role: MessageRole;
    /** The content of the message (string or multimodal parts) */
    content: string | ContentPart[];
    /** Optional name for the message (used with tool messages) */
    name?: string;
    /** Tool call ID (for tool response messages) */
    toolCallId?: string;
    /** Tool calls made by the assistant */
    toolCalls?: ToolCall[];
}

// ============================================================
// Token budget & split types
// ============================================================

/** Configuration for token budget calculation used by the sliding window. */
export interface TokenBudgetConfig {
    /** Model's max context window in tokens */
    contextWindow: number;
    /** Tokens reserved for the model's response */
    maxOutputTokens: number;
    /** System message text (deducted from budget) */
    systemMessage?: string;
    /** New user message about to be appended (deducted from budget) */
    newUserMessage?: string;
    /** Characters per token ratio override (default: 4) */
    charsPerToken?: number;
    /** Buffer for formatting/framing overhead in tokens (default: 200) */
    safetyMargin?: number;
}

/** Configuration for the 3-tier memory split. */
export interface ThreeTierConfig extends TokenBudgetConfig {
    /** Max tokens reserved for the summary slot between first pair and recent window */
    maxSummaryBudgetTokens: number;
}

/** Result of the 3-tier memory split. */
export interface ThreeTierSplitResult {
    /** First user + assistant message pair (always kept verbatim) */
    firstPair: Message[];
    /** Messages that fell out of the window and need to be summarized */
    droppedMessages: Message[];
    /** Recent messages kept verbatim */
    recentMessages: Message[];
    /** Index of the last message in the original array that was processed */
    processedThroughIndex: number;
    /** Whether truncation was needed at all */
    wasTruncated: boolean;
}

// ============================================================
// Storage types
// ============================================================

/** A persisted memory summary record. */
export interface MemorySummaryRecord {
    id: string;
    entityType: string;
    entityId: string;
    modelKey: string | null;
    summary: string;
    /** Marker value: droppedMessages.length + 1. Subtract 1 to get the count of already-summarized messages. */
    summarizedThroughIndex: number;
    createdAt: string;
    updatedAt: string;
}

/** Data for upserting a summary. */
export interface UpsertSummaryData {
    entityType: string;
    entityId: string;
    modelKey: string | null;
    summary: string;
    /** Marker value: droppedMessages.length + 1. Subtract 1 to get the count of already-summarized messages. */
    summarizedThroughIndex: number;
}

// ============================================================
// Manager input/context types
// ============================================================

/** Input for ThreeTierMemoryManager.buildHistory(). */
export interface BuildHistoryInput {
    /** Full conversation history in chronological order */
    allHistory: Message[];
    /** Model's context window size in tokens */
    contextWindow: number;
    /** Tokens reserved for the model's response */
    maxOutputTokens: number;
    /** System message text (deducted from budget) */
    systemMessage?: string;
    /** New user message about to be appended */
    newUserMessage?: string;
    /** Opaque context passed through to the SummarizerAdapter */
    summarizationContext?: unknown;
}

/** Context identifying the entity whose summary to load/save. */
export interface MemoryContext {
    entityType: string;
    entityId: string;
    modelKey: string | null;
}

// ============================================================
// Configuration types
// ============================================================

/** Optional logger interface for the memory manager. */
export interface MemoryLogger {
    debug(message: string, ...args: unknown[]): void;
    warn(message: string, ...args: unknown[]): void;
}

/** Constructor configuration for ThreeTierMemoryManager. */
export interface ThreeTierMemoryManagerConfig {
    /** Whether summarization is enabled (default: true) */
    summarizationEnabled?: boolean;
    /** Max tokens reserved for the summary slot (default: 500) */
    defaultMaxSummaryBudgetTokens?: number;
    /** Characters per token estimate (default: 4) */
    defaultCharsPerToken?: number;
    /** Optional logger */
    logger?: MemoryLogger;
}

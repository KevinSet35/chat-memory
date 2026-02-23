import type { ContentPart, Message } from './types.js';

/**
 * Approximate characters per token for estimation purposes.
 * Used as the default for pre-flight budget checks, not billing.
 */
export const DEFAULT_CHARS_PER_TOKEN_ESTIMATE = 4;

/**
 * Single source of truth for token estimation using a chars-per-token heuristic.
 * Used for context window budget calculations.
 */
export class TokenEstimationUtil {
    /**
     * Estimate token count for a plain string.
     *
     * @param text - The text to estimate tokens for
     * @param charsPerToken - Characters per token ratio (default: 4)
     * @returns Estimated token count
     */
    static estimateStringTokens(
        text: string,
        charsPerToken: number = DEFAULT_CHARS_PER_TOKEN_ESTIMATE,
    ): number {
        if (!text || charsPerToken <= 0) return 0;
        return Math.ceil(text.length / charsPerToken);
    }

    /**
     * Estimate token count for message content (string or ContentPart[]).
     * For ContentPart[], only text parts are counted — image parts have
     * separate token costs handled by providers and are NOT included in
     * this estimate.
     *
     * @param content - Message content (string or multimodal parts)
     * @param charsPerToken - Characters per token ratio (default: 4)
     * @returns Estimated token count
     */
    static estimateContentTokens(
        content: string | ContentPart[],
        charsPerToken: number = DEFAULT_CHARS_PER_TOKEN_ESTIMATE,
    ): number {
        if (typeof content === 'string') {
            return TokenEstimationUtil.estimateStringTokens(content, charsPerToken);
        }

        if (charsPerToken <= 0) return 0;

        let totalChars = 0;
        for (const part of content) {
            if (part.type === 'text' && part.text) {
                totalChars += part.text.length;
            }
        }
        return Math.ceil(totalChars / charsPerToken);
    }

    /**
     * Estimate total token count across input text, message history, and system message.
     *
     * @param input - The input/prompt text
     * @param messages - Conversation message history
     * @param systemMessage - System message text
     * @param charsPerToken - Characters per token ratio (default: 4)
     * @returns Estimated total token count
     */
    static estimateTotalTokens(
        input: string,
        messages?: Message[],
        systemMessage?: string,
        charsPerToken: number = DEFAULT_CHARS_PER_TOKEN_ESTIMATE,
    ): number {
        let tokens = TokenEstimationUtil.estimateStringTokens(input, charsPerToken);

        if (messages) {
            for (const msg of messages) {
                tokens += TokenEstimationUtil.estimateContentTokens(msg.content, charsPerToken);
            }
        }

        if (systemMessage) {
            tokens += TokenEstimationUtil.estimateStringTokens(systemMessage, charsPerToken);
        }

        return tokens;
    }
}

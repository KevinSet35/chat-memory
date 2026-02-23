import { describe, it, expect } from 'vitest';
import { TokenEstimationUtil, DEFAULT_CHARS_PER_TOKEN_ESTIMATE } from '../src/index.js';
import type { ContentPart, Message } from '../src/index.js';

describe('TokenEstimationUtil', () => {
    describe('estimateStringTokens', () => {
        it('should estimate tokens using default chars per token', () => {
            // 20 chars / 4 chars per token = 5
            expect(TokenEstimationUtil.estimateStringTokens('12345678901234567890')).toBe(5);
        });

        it('should ceil the result', () => {
            // 5 chars / 4 = 1.25 -> ceil = 2
            expect(TokenEstimationUtil.estimateStringTokens('hello')).toBe(2);
        });

        it('should use custom chars per token', () => {
            // 10 chars / 2 = 5
            expect(TokenEstimationUtil.estimateStringTokens('1234567890', 2)).toBe(5);
        });

        it('should return 0 for empty string', () => {
            expect(TokenEstimationUtil.estimateStringTokens('')).toBe(0);
        });

        it('should return 0 for charsPerToken <= 0', () => {
            expect(TokenEstimationUtil.estimateStringTokens('hello', 0)).toBe(0);
            expect(TokenEstimationUtil.estimateStringTokens('hello', -1)).toBe(0);
        });
    });

    describe('estimateContentTokens', () => {
        it('should estimate string content', () => {
            expect(TokenEstimationUtil.estimateContentTokens('12345678')).toBe(2);
        });

        it('should estimate ContentPart[] with text parts only', () => {
            const parts: ContentPart[] = [
                { type: 'text', text: '12345678' },  // 8 chars
                { type: 'image_url', image_url: { url: 'https://example.com/img.png' } },
                { type: 'text', text: '1234' },       // 4 chars
            ];
            // 12 chars / 4 = 3
            expect(TokenEstimationUtil.estimateContentTokens(parts)).toBe(3);
        });

        it('should ignore image parts', () => {
            const parts: ContentPart[] = [
                { type: 'image_url', image_url: { url: 'https://example.com/img.png' } },
            ];
            expect(TokenEstimationUtil.estimateContentTokens(parts)).toBe(0);
        });

        it('should return 0 for empty parts array', () => {
            expect(TokenEstimationUtil.estimateContentTokens([])).toBe(0);
        });

        it('should return 0 for charsPerToken <= 0 with parts', () => {
            const parts: ContentPart[] = [{ type: 'text', text: 'hello' }];
            expect(TokenEstimationUtil.estimateContentTokens(parts, 0)).toBe(0);
        });

        it('should handle text parts with undefined text', () => {
            const parts: ContentPart[] = [{ type: 'text' }];
            expect(TokenEstimationUtil.estimateContentTokens(parts)).toBe(0);
        });
    });

    describe('estimateTotalTokens', () => {
        it('should estimate tokens for input only', () => {
            expect(TokenEstimationUtil.estimateTotalTokens('12345678')).toBe(2);
        });

        it('should include messages', () => {
            const messages: Message[] = [
                { role: 'user', content: '12345678' },     // 2 tokens
                { role: 'assistant', content: '1234' },     // 1 token
            ];
            // input: 2 + messages: 2 + 1 = 5
            expect(TokenEstimationUtil.estimateTotalTokens('12345678', messages)).toBe(5);
        });

        it('should include system message', () => {
            // input: 2 + system: 2 = 4
            expect(TokenEstimationUtil.estimateTotalTokens('12345678', undefined, '12345678')).toBe(4);
        });

        it('should combine all sources', () => {
            const messages: Message[] = [{ role: 'user', content: '1234' }]; // 1 token
            // input: 2 + messages: 1 + system: 2 = 5
            expect(TokenEstimationUtil.estimateTotalTokens('12345678', messages, '12345678')).toBe(5);
        });
    });

    describe('DEFAULT_CHARS_PER_TOKEN_ESTIMATE', () => {
        it('should be 4', () => {
            expect(DEFAULT_CHARS_PER_TOKEN_ESTIMATE).toBe(4);
        });
    });
});

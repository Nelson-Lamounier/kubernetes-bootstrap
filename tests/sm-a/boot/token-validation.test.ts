import { describe, expect, it } from 'vitest';

import { validateKubeadmToken } from '../../../sm-a/boot/steps/common.js';

const VALID_TOKEN     = 'ku8rm0.abc1234567890123';
const VALID_TOKEN_ALT = 'abcdef.0123456789abcdef';

describe('validateKubeadmToken', () => {
    describe('valid tokens', () => {
        it('passes clean token through unchanged', () => {
            expect(validateKubeadmToken(VALID_TOKEN, 'test')).toBe(VALID_TOKEN);
        });

        it('passes alternate valid pattern', () => {
            expect(validateKubeadmToken(VALID_TOKEN_ALT, 'test')).toBe(VALID_TOKEN_ALT);
        });
    });

    describe('leading backslash sanitisation', () => {
        it('strips single leading backslash (SSM SecureString artefact)', () => {
            expect(validateKubeadmToken(`\\${VALID_TOKEN}`, 'SSM')).toBe(VALID_TOKEN);
        });

        it('strips multiple leading backslashes', () => {
            expect(validateKubeadmToken(`\\\\\\${VALID_TOKEN}`, 'SSM')).toBe(VALID_TOKEN);
        });
    });

    describe('whitespace sanitisation', () => {
        it('strips trailing newline', () => {
            expect(validateKubeadmToken(`${VALID_TOKEN}\n`, 'test')).toBe(VALID_TOKEN);
        });

        it('strips leading and trailing whitespace', () => {
            expect(validateKubeadmToken(`  ${VALID_TOKEN}  `, 'test')).toBe(VALID_TOKEN);
        });

        it('handles combined backslash and whitespace', () => {
            expect(validateKubeadmToken(`  \\${VALID_TOKEN}\n`, 'test')).toBe(VALID_TOKEN);
        });
    });

    describe('invalid tokens — should throw', () => {
        it('throws on empty string', () => {
            expect(() => validateKubeadmToken('', 'test')).toThrow('Empty kubeadm join token');
        });

        it('throws on whitespace-only input', () => {
            expect(() => validateKubeadmToken('   \n\t  ', 'test')).toThrow();
        });

        it('throws on token with too-short suffix', () => {
            expect(() => validateKubeadmToken('ab1234.short', 'test')).toThrow('Invalid kubeadm');
        });

        it('throws when dot separator is missing', () => {
            expect(() => validateKubeadmToken('abcdef0123456789012345', 'test')).toThrow('Invalid kubeadm');
        });

        it('throws on uppercase characters', () => {
            expect(() => validateKubeadmToken('ABCDEF.0123456789abcdef', 'test')).toThrow('Invalid kubeadm');
        });

        it('throws on special characters', () => {
            expect(() => validateKubeadmToken('abc!ef.0123456789abcdef', 'test')).toThrow('Invalid kubeadm');
        });

        it('throws on backslash in middle of token', () => {
            expect(() => validateKubeadmToken('abc\\ef.0123456789abcdef', 'test')).toThrow('Invalid kubeadm');
        });

        it('includes source label in error message', () => {
            expect(() => validateKubeadmToken('bad-token', 'SSM Parameter Store'))
                .toThrow('SSM Parameter Store');
        });
    });
});

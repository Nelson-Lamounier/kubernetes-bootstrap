// @format
import tsPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';

export default [
    {
        ignores: ['dist/**', 'cdk.out/**', 'node_modules/**'],
    },
    {
        files: ['bin/**/*.ts', 'lib/**/*.ts'],
        languageOptions: {
            parser: tsParser,
            parserOptions: {
                project: './tsconfig.json',
                tsconfigRootDir: import.meta.dirname,
            },
        },
        plugins: {
            '@typescript-eslint': tsPlugin,
        },
        rules: {
            ...tsPlugin.configs['recommended'].rules,
            // CDK constructs routinely use `any` for CloudFormation token types
            '@typescript-eslint/no-explicit-any': 'warn',
            // Step Functions state JSON uses `object` type legitimately
            '@typescript-eslint/ban-types': 'off',
            // Allow _-prefixed vars for intentional unused destructuring slots
            '@typescript-eslint/no-unused-vars': ['error', { varsIgnorePattern: '^_', argsIgnorePattern: '^_' }],
        },
    },
];

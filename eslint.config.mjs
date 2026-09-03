import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // The Expo Go target is a separate React Native project with its own dependency
    // and bundle CI. Keep the root web/TypeScript lint pass scoped to the web app;
    // Expo syntax/module compatibility is validated by .github/workflows/expo-unified.yml.
    ignores: ['dist/**', 'node_modules/**', 'models/**', 'expo-recorder/**'],
  },
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
);

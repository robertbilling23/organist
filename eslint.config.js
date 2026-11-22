import js from '@eslint/js';
import firebaseRulesPlugin from '@firebase/eslint-plugin-security-rules';

export default [
  {
    ignores: ['dist/**/*', 'node_modules/**/*', 'audio/**/*', '*.json', '**/*.ts']
  },
  {
    files: ['**/*.js'],
    ...js.configs.recommended,
    languageOptions: {
      globals: {
        window: 'readonly',
        document: 'readonly',
        navigator: 'readonly',
        localStorage: 'readonly',
        caches: 'readonly',
        fetch: 'readonly',
        console: 'readonly',
        URL: 'readonly',
        Request: 'readonly',
        Response: 'readonly',
        self: 'readonly',
        process: 'readonly',
        Buffer: 'readonly'
      }
    }
  },
  firebaseRulesPlugin.configs['flat/recommended']
];

/**
 * What the linter is for here, and what it is not.
 *
 * It is for the class of mistake that reads fine and fails at runtime: a
 * variable that no longer exists, a promise nobody awaited, a `case` that
 * falls into the next one, a condition that is always true. This project is
 * plain JavaScript with no type checker, so those reach production unless
 * something looks for them — and several of them have, at least once each.
 *
 * It is deliberately not a formatter. The code has a voice: long explanatory
 * comments, sentences in the prose style of the file they're in, deliberate
 * spacing around the parts that took thought. A style rule set would rewrite
 * that into something uniform and mean, and the diff would bury every real
 * change for a month. Formatting stays a human decision.
 */
import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: ['node_modules/**', 'dist/**', 'runtime/**', 'data/**', '.claude/**', 'shots/**'],
  },

  js.configs.recommended,

  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: globals.node,
    },
    rules: {
      // Bugs, not preferences.
      'no-await-in-loop': 'off', // sequential on purpose in several places
      'no-constant-binary-expression': 'error',
      'no-promise-executor-return': 'error',
      'no-self-compare': 'error',
      'no-template-curly-in-string': 'error',
      'no-unmodified-loop-condition': 'error',
      'no-unreachable-loop': 'error',
      'no-async-promise-executor': 'error',

      // Off, and worth saying why rather than leaving it looking arbitrary.
      // It flagged three places here. Two are its documented false-positive
      // shape — a plain write to a parameter's property after an await, with
      // no read-modify-write and no second writer. The third was real: two
      // transcription paths could pick up the same utterance, send it twice
      // and disagree about the result. That one is fixed (see the in-flight
      // map in agent/stt.js), which is the outcome this rule is for, and the
      // reason it is worth turning back on the day the false positives stop
      // outnumbering the findings.
      'require-atomic-updates': 'off',

      // Off because it is all noise in this codebase: the MCP `tool()`
      // contract takes an async callback whether or not the body awaits
      // anything, and thirty-odd tool definitions each trip it. A rule nobody
      // can act on teaches people to skim past the ones they can.
      'require-await': 'off',

      // `catch {}` is used on purpose where the fallback is the point, so the
      // rule allows it and asks only that the empty block be a `catch`.
      'no-empty': ['error', { allowEmptyCatch: true }],

      // Unused arguments are often documentation of a callback's shape, so
      // only leading ones are flagged; `_` prefixes opt out entirely.
      'no-unused-vars': [
        'error',
        { args: 'after-used', argsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
    },
  },

  {
    files: ['test/**/*.js'],
    rules: {
      // The one `require-await` would have been worth keeping for, made
      // precise. An `assert.rejects` nobody awaits passes whatever happens —
      // it does not even wait to find out — which silently turned the most
      // important test in the suite into one that could never fail.
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "ExpressionStatement > CallExpression[callee.property.name=/^(rejects|doesNotReject)$/]",
          message:
            'await this — an unawaited assert.rejects passes no matter what happens.',
        },
      ],
    },
  },

  {
    // Browser code: no Node globals.
    files: ['src/web/public/**/*.js'],
    // ES modules served as they are; the panel has no build step.
    languageOptions: {
      sourceType: 'module',
      globals: globals.browser,
    },
  },
];

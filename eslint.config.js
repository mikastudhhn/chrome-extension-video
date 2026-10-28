export default [
  { ignores: ['node_modules/**', 'dist/**', 'test-results/**'] },
  {
    files: [
      'extension/**/*.js',
      'server/**/*.js',
      'admin/**/*.js',
      'scripts/**/*.js',
      'tests/**/*.js',
      'demo/**/*.js',
      '*.config.js'
    ],
    rules: {
      'constructor-super': 'error',
      'for-direction': 'error',
      'getter-return': 'error',
      'no-async-promise-executor': 'error',
      'no-compare-neg-zero': 'error',
      'no-cond-assign': ['error', 'always'],
      'no-const-assign': 'error',
      'no-dupe-args': 'error',
      'no-dupe-class-members': 'error',
      'no-dupe-else-if': 'error',
      'no-dupe-keys': 'error',
      'no-duplicate-case': 'error',
      'no-import-assign': 'error',
      'no-self-assign': 'error',
      'no-setter-return': 'error',
      'no-unexpected-multiline': 'error',
      'no-unreachable': 'error',
      'no-unsafe-finally': 'error',
      'no-unsafe-optional-chaining': 'error',
      'use-isnan': 'error',
      'valid-typeof': 'error'
    }
  }
];

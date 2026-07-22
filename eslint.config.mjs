// Flat ESLint config (eslint 9 + eslint-config-next 16). `next lint` was
// removed in Next 16; `bun run lint` now runs the eslint CLI directly.

import coreWebVitals from 'eslint-config-next/core-web-vitals';
import typescript from 'eslint-config-next/typescript';

const config = [
  ...coreWebVitals,
  ...typescript,
  {
    ignores: ['node_modules/**', '.next/**', 'data/**', 'unzipped_ui/**'],
  },
  {
    rules: {
      // New react-hooks v6 strictness (React-compiler era). The codebase
      // predates them and the flagged patterns (reset-state-on-prop-change
      // effects, measuring refs during render) are deliberate; surface as
      // warnings until they're refactored case by case.
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/refs': 'warn',
    },
  },
];

export default config;

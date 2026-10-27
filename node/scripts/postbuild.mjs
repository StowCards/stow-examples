// Copyright 2026 Stow Cards
// SPDX-License-Identifier: Apache-2.0

// Mark the CommonJS build as CommonJS: the package root is "type": "module",
// so without this marker Node and TypeScript would read dist/cjs as ESM.
import { writeFileSync } from 'node:fs';

writeFileSync(
  new URL('../dist/cjs/package.json', import.meta.url),
  `${JSON.stringify({ type: 'commonjs' }, null, 2)}\n`,
);

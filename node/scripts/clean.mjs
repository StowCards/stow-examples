// Copyright 2026 Stow Cards
// SPDX-License-Identifier: Apache-2.0

// Remove build output so stale files never reach a published package.
import { rmSync } from 'node:fs';

rmSync(new URL('../dist', import.meta.url), { recursive: true, force: true });

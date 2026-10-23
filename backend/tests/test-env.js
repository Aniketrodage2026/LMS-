'use strict';

// Tests must never use a developer's real R2 bucket by default. R2-focused
// tests explicitly opt in with their own isolated configuration.
process.env.R2_ENABLED = 'false';

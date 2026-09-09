import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/real-engines.e2e.spec.ts'],
    testTimeout: 60_000,
  },
})

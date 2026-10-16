module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  testMatch: ['**/*.test.ts'],
  // test/integration needs DynamoDB Local: `npm run test:int`.
  testPathIgnorePatterns: ['/node_modules/', '<rootDir>/test/integration/'],
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }] },
  testTimeout: 60000,
};

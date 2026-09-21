process.env.NODE_ENV = "test";
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
process.env.JWT_SECRET ??= "test-secret-value-for-unit-tests-0000000000";
process.env.ENCRYPTION_KEY ??= "test-encryption-key-for-unit-tests-00000000000";

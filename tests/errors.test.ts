import { describe, expect, it } from "vitest";
import {
  AppError,
  ValidationError,
  AuthenticationError,
  AuthorizationError,
  NotFoundError,
  RateLimitError,
} from "@/core/errors";
import { registerSchema } from "@/modules/auth/schemas";

describe("error hierarchy", () => {
  it("maps error classes to status codes", () => {
    expect(new ValidationError().statusCode).toBe(422);
    expect(new AuthenticationError().statusCode).toBe(401);
    expect(new AuthorizationError().statusCode).toBe(403);
    expect(new NotFoundError("Order").statusCode).toBe(404);
    expect(new RateLimitError().statusCode).toBe(429);
  });

  it("errors are operational instances of AppError", () => {
    const err = new ValidationError("bad", [{ field: "email" }]);
    expect(err).toBeInstanceOf(AppError);
    expect(err.isOperational).toBe(true);
    expect(err.details).toEqual([{ field: "email" }]);
  });
});

describe("auth schemas", () => {
  it("normalizes email to lowercase and trims", () => {
    const parsed = registerSchema.parse({
      name: "  Ahmad ",
      email: "  Ahmad@Example.COM ",
      password: "password123",
      workspaceName: "My Store",
    });
    expect(parsed.email).toBe("ahmad@example.com");
    expect(parsed.name).toBe("Ahmad");
  });

  it("rejects short passwords and invalid emails", () => {
    expect(() =>
      registerSchema.parse({ name: "A", email: "a@b.co", password: "short", workspaceName: "W" })
    ).toThrow();
    expect(() =>
      registerSchema.parse({ name: "Ahmad", email: "not-an-email", password: "password123", workspaceName: "W" })
    ).toThrow();
  });
});

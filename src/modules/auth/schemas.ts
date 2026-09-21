import { z } from "zod";

export const registerSchema = z.object({
  name: z.string().trim().min(2).max(100),
  email: z.string().trim().toLowerCase().email().max(255),
  password: z.string().min(8).max(128),
  workspaceName: z.string().trim().min(2).max(100),
});

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1).max(128),
});

export const createWorkspaceSchema = z.object({
  name: z.string().trim().min(2).max(100),
});

export const switchWorkspaceSchema = z.object({
  workspaceId: z.string().cuid(),
});

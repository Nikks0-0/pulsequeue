import { Request, Response, NextFunction } from "express";
import { ZodSchema } from "zod";

// Wrap any zod schema into an Express middleware. Keeps route handlers
// free of manual `if (!req.body.x)` checks and gives consistent 400 responses.
export function validateBody(schema: ZodSchema) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({
        error: "validation_error",
        details: result.error.flatten().fieldErrors,
      });
    }
    req.body = result.data;
    next();
  };
}

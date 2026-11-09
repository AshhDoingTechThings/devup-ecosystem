import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../../middleware/auth";
import { validate } from "../../middleware/validate";
import { messageLimiter } from "../../middleware/rateLimit";
import { MAX_MESSAGE_LENGTH } from "./messages.service";
import * as controller from "./messages.controller";

const router = Router();

const contact = z.object({ contactId: z.string().uuid("Unknown contact") });

router.use(requireAuth);

router.get("/:contactId", validate(z.object({ params: contact })), controller.getMessages);
router.post(
  "/:contactId",
  // Reading is polled by the chat window; only sending is limited.
  messageLimiter,
  validate(
    z.object({
      params: contact,
      body: z.object({
        content: z
          .string({ error: "Write a message first" })
          .trim()
          .min(1, "Write a message first")
          .max(MAX_MESSAGE_LENGTH, `Keep messages under ${MAX_MESSAGE_LENGTH} characters`),
      }),
    })
  ),
  controller.sendMessage
);

export default router;

import { Router } from "express";
import { AuthController } from "./auth.controller";
import { validate } from "../../middleware/validate";
import {
  registerSchema,
  loginSchema,
  refreshSchema,
  verifyEmailSchema,
  resendVerificationSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
} from "./auth.schema";
import { requireAuth } from "../../middleware/auth";

const router = Router();
const controller = new AuthController();

router.post("/register", validate(registerSchema), controller.register);
router.post("/login", validate(loginSchema), controller.login);
router.post("/refresh", validate(refreshSchema), controller.refresh);
router.post("/verify-email", validate(verifyEmailSchema), controller.verifyEmail);
router.post("/resend-verification", validate(resendVerificationSchema), controller.resendVerification);
router.post("/forgot-password", validate(forgotPasswordSchema), controller.forgotPassword);
router.post("/reset-password", validate(resetPasswordSchema), controller.resetPassword);
router.post("/logout", requireAuth, controller.logout);
router.get("/me", requireAuth, controller.getMe);
router.post("/google/sync", controller.syncGoogle);

export default router;

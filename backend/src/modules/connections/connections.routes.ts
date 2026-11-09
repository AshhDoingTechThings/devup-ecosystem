import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { sendConnectionRequest, respondToConnection, getConnections } from './connections.service';

const router = Router();

const requestBody = z.object({
  body: z.object({
    toUserId: z.string().uuid("Choose who to connect with"),
    message: z.string().trim().max(500, "Keep the note under 500 characters").optional().default(""),
  }),
});

const respondBody = z.object({
  body: z.object({ status: z.enum(['ACCEPTED', 'REJECTED']) }),
});

router.post('/request', requireAuth, validate(requestBody), async (req, res, next) => {
  try {
    const request = await sendConnectionRequest({
      fromUserId: req.user!.id,
      toUserId: req.body.toUserId,
      message: req.body.message,
    });
    res.status(201).json({ success: true, data: request });
  } catch (err) { next(err); }
});

router.post('/:requestId/respond', requireAuth, validate(respondBody), async (req, res, next) => {
  try {
    const updated = await respondToConnection({
      requestId: req.params.requestId as string,
      userId: req.user!.id,
      status: req.body.status,
    });
    res.json({ success: true, data: updated });
  } catch (err) { next(err); }
});

router.get('/', requireAuth, async (req, res, next) => {
  try {
    const connections = await getConnections(req.user!.id);
    res.json({ success: true, data: connections });
  } catch (err) { next(err); }
});

export default router;

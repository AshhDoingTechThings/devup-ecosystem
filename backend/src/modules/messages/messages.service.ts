import { prisma } from "../../lib/prisma";
import { AppError } from "../../middleware/errorHandler";

export const MAX_MESSAGE_LENGTH = 2000;
/** The chat window shows the latest messages; older history is not paged yet. */
const HISTORY_LIMIT = 500;

/**
 * Direct messages are for people who have agreed to connect.
 *
 * Previously any signed-in account could write to any user id, which made the
 * inbox an open channel for spam to every founder on the platform. An accepted
 * connection or co-founder request — in either direction — is now required.
 */
async function assertConnected(userId: string, contactId: string) {
  if (userId === contactId) throw new AppError(400, "You cannot message yourself", "INVALID_CONTACT");

  const between = {
    status: "ACCEPTED" as const,
    OR: [
      { fromUserId: userId, toUserId: contactId },
      { fromUserId: contactId, toUserId: userId },
    ],
  };
  const [connection, cofounder] = await Promise.all([
    prisma.connectionRequest.findFirst({ where: between, select: { id: true } }),
    prisma.cofounderRequest.findFirst({ where: between, select: { id: true } }),
  ]);
  if (!connection && !cofounder) {
    throw new AppError(403, "You can message people once they accept your connection request", "NOT_CONNECTED");
  }
}

export async function getMessages(userId: string, contactId: string) {
  // Only ever the caller's own conversation, so no connection check is needed
  // to read it: a stranger's id simply has no history.
  const latest = await prisma.message.findMany({
    where: {
      OR: [
        { senderId: userId, receiverId: contactId },
        { senderId: contactId, receiverId: userId }
      ]
    },
    orderBy: { createdAt: "desc" },
    take: HISTORY_LIMIT,
  });

  // Mark messages as read if the current user is the receiver
  await prisma.message.updateMany({
    where: {
      senderId: contactId,
      receiverId: userId,
      read: false
    },
    data: {
      read: true
    }
  });

  return latest.reverse();
}

export async function sendMessage(senderId: string, receiverId: string, content: string) {
  const text = typeof content === "string" ? content.trim() : "";
  if (!text) throw new AppError(400, "Message content cannot be empty");
  if (text.length > MAX_MESSAGE_LENGTH) {
    throw new AppError(400, `Keep messages under ${MAX_MESSAGE_LENGTH} characters`, "MESSAGE_TOO_LONG");
  }

  await assertConnected(senderId, receiverId);

  return prisma.message.create({
    data: { senderId, receiverId, content: text }
  });
}

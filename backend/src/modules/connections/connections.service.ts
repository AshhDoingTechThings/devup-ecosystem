import { prisma } from '../../lib/prisma';
import { AppError } from '../../middleware/errorHandler';
import { PUBLIC_USER_SELECT } from '../../lib/publicProfile';

/**
 * What each side of a request sees of the other.
 *
 * Someone who has only asked to connect gets the public profile, the same as
 * the founder directory shows. Once both have agreed, the email is shared too:
 * the connections page uses it to invite a connection onto a startup team.
 * Never phone, grades, resume, role or sign-in data — and never passwordHash,
 * which a plain `include` used to put in every row.
 */
const REQUESTER = { select: PUBLIC_USER_SELECT } as const;
const CONNECTED = { select: { ...PUBLIC_USER_SELECT, email: true } } as const;

export async function sendConnectionRequest(params: {
  fromUserId: string;
  toUserId: string;
  message: string;
}) {
  if (params.fromUserId === params.toUserId) {
    throw new AppError(400, "You cannot connect with yourself");
  }

  // Check role authorization
  const fromUser = await prisma.user.findUnique({
    where: { id: params.fromUserId },
    select: { role: true, profile: true },
  });

  const allowedRoles = ['FOUNDER', 'MENTOR', 'INVESTOR'];
  if (!allowedRoles.includes(fromUser?.role || '')) {
    throw new AppError(403, "Only verified roles can send connection requests");
  }

  const target = await prisma.user.findUnique({ where: { id: params.toUserId }, select: { id: true } });
  if (!target) throw new AppError(404, "That person could not be found", "USER_NOT_FOUND");

  const existing = await prisma.connectionRequest.findFirst({
    where: {
      OR: [
        { fromUserId: params.fromUserId, toUserId: params.toUserId },
        { fromUserId: params.toUserId, toUserId: params.fromUserId },
      ],
    },
  });

  if (existing) {
    if (existing.status === 'ACCEPTED') throw new AppError(400, "You are already connected");
    if (existing.status === 'PENDING') throw new AppError(400, "A request is already pending");
  }

  const request = await prisma.connectionRequest.create({
    data: {
      fromUserId: params.fromUserId,
      toUserId: params.toUserId,
      message: params.message,
      status: 'PENDING',
    },
  });

  await prisma.notification.create({
    data: {
      userId: params.toUserId,
      title: 'New Connection Request',
      message: `${fromUser?.profile?.name || 'Someone'} wants to connect.`,
      type: 'CONNECTION_REQUEST',
      link: '/dashboard/connections',
    },
  });

  return request;
}

export async function respondToConnection(params: {
  requestId: string;
  userId: string;
  status: 'ACCEPTED' | 'REJECTED';
}) {
  const { requestId, userId, status } = params;
  let request: any = await prisma.connectionRequest.findUnique({
    where: { id: requestId },
  });
  let isCofounder = false;

  if (!request) {
    request = await prisma.cofounderRequest.findUnique({
      where: { id: requestId }
    });
    isCofounder = true;
  }

  if (!request) throw new AppError(404, "Connection request not found");
  if (request.toUserId !== userId) throw new AppError(403, "Not authorized to respond to this request");
  if (request.status !== 'PENDING') throw new AppError(400, "Request already processed");

  let updated;
  if (isCofounder) {
    updated = await prisma.cofounderRequest.update({
      where: { id: requestId },
      data: { status }
    });
  } else {
    updated = await prisma.connectionRequest.update({
      where: { id: requestId },
      data: { status, respondedAt: new Date() },
    });
  }

  // Create notification for the sender
  if (status === 'ACCEPTED') {
    await prisma.notification.create({
      data: {
        userId: request.fromUserId,
        title: 'Connection Accepted',
        message: `Your connection request has been accepted.`,
        type: 'CONNECTION_ACCEPTED',
        link: '/dashboard/connections',
      },
    });
  }

  return updated;
}

export async function getConnections(userId: string) {
  const pendingConnections = await prisma.connectionRequest.findMany({
    where: { toUserId: userId, status: 'PENDING' },
    include: { fromUser: REQUESTER },
  });

  const pendingCofounder = await prisma.cofounderRequest.findMany({
    where: { toUserId: userId, status: 'PENDING' },
    include: { fromUser: REQUESTER },
  });

  const acceptedConnections = await prisma.connectionRequest.findMany({
    where: {
      status: 'ACCEPTED',
      OR: [{ fromUserId: userId }, { toUserId: userId }],
    },
    include: { fromUser: CONNECTED, toUser: CONNECTED },
  });

  const acceptedCofounder = await prisma.cofounderRequest.findMany({
    where: {
      status: 'ACCEPTED',
      OR: [{ fromUserId: userId }, { toUserId: userId }],
    },
    include: { fromUser: CONNECTED, toUser: CONNECTED },
  });

  return {
    pendingRequests: [...pendingConnections, ...pendingCofounder].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
    acceptedConnections: [...acceptedConnections, ...acceptedCofounder].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
  };
}

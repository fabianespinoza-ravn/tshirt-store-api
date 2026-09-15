import { OrderStatus, UserRole } from '@prisma/client';

/**
 * Why the role is a parameter here and not a CASL action.
 *
 * The contract exposes one route for every status change,
 * `PATCH /orders/{orderId}/status`, with the destination in the body. A
 * `@CheckPolicies` decorator is static and cannot know, at decoration time,
 * whether a request is a cancellation or a shipment, so the fine-grained
 * check has to happen after the body is read whichever way the ability is
 * modelled. Splitting `cancel` and `advance` into separate CASL actions
 * would therefore buy a vocabulary of five actions and no free 403.
 *
 * The consequence is that this function *is* the authorization for who may
 * move an order where. A bug here is not a workflow bug, it is an
 * authorization bug, and `casl-guard` will not catch it: that agent asks
 * whether a CLIENT can reach another user's row, which the ability's scope
 * answers. "A CLIENT ships their own order" is outside its question and
 * inside this one.
 *
 * If the contract ever splits the route — a `POST /orders/{id}/cancel` of
 * its own — separate actions become strictly better and the role should
 * move out of this signature.
 */
export enum TransitionVerdict {
  Allowed = 'ALLOWED',
  /** The role may never reach that destination. Answers 403. */
  ForbiddenForRole = 'FORBIDDEN_FOR_ROLE',
  /** The role may reach it, but not from where the order stands. Answers 409. */
  IllegalFromState = 'ILLEGAL_FROM_STATE',
}

interface Move {
  readonly role: UserRole;
  readonly to: OrderStatus;
  readonly from: readonly OrderStatus[];
}

/**
 * Every legal move, from docs/AUTHORIZATION-MATRIX.md.
 *
 * One deliberate departure from the contract, and it is temporary: the
 * matrix lets a CLIENT cancel anything "not yet shipped", which is PENDING,
 * PAID and PROCESSING. Only PENDING is here. Cancelling a PAID order owes
 * the client a refund, and no refund exists until Stripe lands — a cancelled
 * order with the money kept is worse than a route that refuses the case, so
 * the other two open when the refund does and this list is where they open.
 */
const MOVES: readonly Move[] = [
  {
    role: UserRole.MANAGER,
    to: OrderStatus.PROCESSING,
    from: [OrderStatus.PAID],
  },
  {
    role: UserRole.MANAGER,
    to: OrderStatus.SHIPPED,
    from: [OrderStatus.PROCESSING],
  },
  {
    role: UserRole.CLIENT,
    to: OrderStatus.CANCELLED,
    from: [OrderStatus.PENDING],
  },
  {
    role: UserRole.DELIVERY,
    to: OrderStatus.DELIVERED,
    from: [OrderStatus.SHIPPED],
  },
];

/**
 * The only place that decides whether a status change may happen.
 *
 * The two refusals are different answers and the difference is the point.
 * A role that can never reach a destination gets 403 — asking again from
 * another state will not help. A role that can reach it, but not from where
 * the order stands, gets 409 — the request is well formed and the order is
 * simply somewhere else. Collapsing them into one status tells a client to
 * retry something that will never work, or to give up on something that
 * would have worked a minute earlier.
 */
export function verdictFor(
  from: OrderStatus,
  to: OrderStatus,
  role: UserRole,
): TransitionVerdict {
  const reachable = MOVES.filter(
    (move) => move.role === role && move.to === to,
  );

  if (reachable.length === 0) return TransitionVerdict.ForbiddenForRole;

  return reachable.some((move) => move.from.includes(from))
    ? TransitionVerdict.Allowed
    : TransitionVerdict.IllegalFromState;
}

/**
 * The destinations a role can ever ask for, for the error text and for the
 * OpenAPI description. Derived from the same table, so a move added above
 * cannot be missing here.
 */
export function destinationsFor(role: UserRole): OrderStatus[] {
  return MOVES.filter((move) => move.role === role).map((move) => move.to);
}

/** Whether a move releases the stock the order was holding. */
export const releasesStock = (to: OrderStatus): boolean =>
  to === OrderStatus.CANCELLED;

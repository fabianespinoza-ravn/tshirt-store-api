import { OrderStatus, UserRole } from '@prisma/client';
import {
  destinationsFor,
  releasesStock,
  TransitionVerdict,
  verdictFor,
} from './order-state-machine';

/**
 * These are authorization tests, not workflow tests, and the difference
 * decides how much they are worth.
 *
 * Because the contract exposes one route with the destination in the body,
 * the role could not move into a CASL action — so this function, and nothing
 * else, decides who may take an order where. `casl-guard` will not cover it:
 * that agent asks whether a CLIENT can reach another user's row, which the
 * ability's scope answers. "A CLIENT ships their own order" is outside its
 * question and inside this table.
 *
 * Assert the verdict and not merely that something was refused. The two
 * refusals are different answers — `ForbiddenForRole` becomes 403 and
 * `IllegalFromState` becomes 409 — and a test that only checks "not allowed"
 * would pass with the two swapped, which tells a client to retry something
 * that will never work or to give up on something that would have worked a
 * minute earlier.
 */
describe('verdictFor', () => {
  describe('a manager', () => {
    it.todo('allows PAID to PROCESSING');
    it.todo('allows PROCESSING to SHIPPED');
    it.todo('refuses PAID to SHIPPED as illegal, because it skips a step');
    it.todo('refuses PENDING to PROCESSING as illegal, before payment');
    it.todo('refuses CANCELLED as forbidden: no manager move reaches it');
    it.todo(
      "refuses DELIVERED as forbidden: that destination is the courier's",
    );
  });

  describe('a client', () => {
    it.todo('allows PENDING to CANCELLED');
    it.todo(
      'refuses PAID to CANCELLED as illegal, which block 5 opens once a refund exists',
    );
    it.todo('refuses PROCESSING to CANCELLED as illegal, for the same reason');
    it.todo('refuses PROCESSING as forbidden: no client move reaches it');
    it.todo('refuses SHIPPED as forbidden');
  });

  describe('a courier', () => {
    it.todo('allows SHIPPED to DELIVERED');
    it.todo('refuses PAID to DELIVERED as illegal');
    it.todo('refuses SHIPPED as forbidden: only a manager ships');
  });

  describe('the states nothing leaves', () => {
    it.todo('refuses every move out of CANCELLED');
    it.todo('refuses every move out of DELIVERED');
    it.todo('refuses a move from a status to itself');
  });
});

describe('destinationsFor', () => {
  it.todo('lists PROCESSING and SHIPPED for a manager');
  it.todo('lists only CANCELLED for a client');
  it.todo('is derived from the same table, so it cannot omit a legal move');
});

describe('releasesStock', () => {
  it.todo('says a cancellation gives the units back');
  it.todo('says no other destination does');
});

void verdictFor;
void destinationsFor;
void releasesStock;
void TransitionVerdict;
void OrderStatus;
void UserRole;

import { getQueueToken } from '@nestjs/bullmq';
import { QueueName } from '../queue/queue.constants';
import { buildService, type ServiceHarness } from '../testing/build-service';
import { aProduct, aSku } from '../testing/factories';
import { LOW_STOCK_THRESHOLD } from './stock-threshold';
import {
  StockNotificationsService,
  type StockChange,
} from './stock-notifications.service';

/**
 * The double that stands in for `QueueName.StockNotification`.
 *
 * A real BullMQ queue would decide these cases by whether Redis happens to
 * be running. What is under test is *whether* a job is added and what
 * identifies it, so the queue is replaced at `getQueueToken` — the token
 * `@InjectQueue` would itself have resolved — and nothing else is.
 */
export const stockQueue = { add: jest.fn() };

/** A fresh service with the queue and the database replaced. */
export const buildStockNotificationsHarness = (): Promise<
  ServiceHarness<StockNotificationsService>
> =>
  buildService(StockNotificationsService, [
    {
      provide: getQueueToken(QueueName.StockNotification),
      useValue: stockQueue,
    },
  ]);

export const aLikedProduct = aProduct();

/** At the threshold, in its first cycle: the state a crossing lands on. */
export const aCrossedSku = aSku(aLikedProduct.id, {
  stock: LOW_STOCK_THRESHOLD,
  restockCycle: 0,
});

/**
 * A crossing, unless a case overrides one of the four numbers. Every stub
 * below is one override away from the fixture, which is the point: the case
 * name says which number moved.
 */
export const aStockChange = (
  overrides: Partial<StockChange> = {},
): StockChange => ({
  skuId: aCrossedSku.id,
  previousStock: LOW_STOCK_THRESHOLD + 1,
  newStock: LOW_STOCK_THRESHOLD,
  restockCycle: aCrossedSku.restockCycle,
  ...overrides,
});

/**
 * The producer, which is where the crossing is observed.
 *
 * Per CLAUDE.md the cases assert on the call this code makes — the `add`
 * with its name, its payload and its job id, and the `sku.update` performed
 * on the transaction client the caller supplied — never on what a double
 * returns.
 */
describe('StockNotificationsService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    stockQueue.add.mockResolvedValue({ id: aCrossedSku.id });
  });

  describe('observing a stock change', () => {
    it.todo(
      'enqueues one NotifyRestock job when the write took stock down to the threshold',
    );

    it.todo('puts the sku and the cycle in the payload, and nothing else');

    it.todo(
      'gives the job an id built from the sku and the cycle, so a repeated crossing collapses',
    );

    it.todo(
      'enqueues nothing when the stock was already at or below the threshold',
    );

    it.todo('enqueues nothing when the write raised the stock');

    it.todo('answers whether it enqueued, so the caller can log the crossing');

    it.todo(
      'lets a queue that refuses the job throw, rather than swallowing a lost notification',
    );

    it.todo(
      'writes nothing to the database, because the settlement transaction has already committed',
    );
  });

  describe('opening the next cycle on a restock', () => {
    it.todo(
      'increments the restockCycle when a restock lifts stock back above the threshold',
    );

    it.todo(
      'writes through the transaction client it was handed, not through its own connection',
    );

    it.todo('writes nothing when the restock stopped at the threshold');

    it.todo('writes nothing when the stock was already above the threshold');

    it.todo('writes nothing when the write lowered the stock');

    it.todo('answers whether the cycle advanced');
  });
});

import { getQueueToken } from '@nestjs/bullmq';
import { JobName, QueueName } from '../queue/queue.constants';
import { buildService, type ServiceHarness } from '../testing/build-service';
import { aProduct, aSku } from '../testing/factories';
import { createPrismaMock, type PrismaMock } from '../testing/prisma.mock';
import type { StockNotificationJobData } from './stock-notification.jobs';
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
export const stockQueue = {
  add: jest.fn<
    Promise<{ id: string }>,
    [name: string, data: StockNotificationJobData, options: { jobId: string }]
  >(),
};

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
export const aTransactionClient = (): PrismaMock => createPrismaMock();

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
  let h: ServiceHarness<StockNotificationsService>;

  beforeEach(async () => {
    jest.clearAllMocks();
    stockQueue.add.mockResolvedValue({ id: aCrossedSku.id });
    h = await buildStockNotificationsHarness();
  });

  describe('observing a stock change', () => {
    it('enqueues one NotifyLowStock job when the write took stock down to the threshold', async () => {
      await h.service.observeStockChange(aStockChange());

      expect(stockQueue.add).toHaveBeenCalledTimes(1);
      expect(stockQueue.add).toHaveBeenCalledWith(
        JobName.NotifyLowStock,
        expect.anything(),
        expect.anything(),
      );
    });

    it('puts the sku and the cycle in the payload, and nothing else', async () => {
      await h.service.observeStockChange(
        aStockChange({
          restockCycle: 4,
          previousStock: LOW_STOCK_THRESHOLD + 2,
        }),
      );

      // `toEqual` on the payload rather than `objectContaining`: the point of
      // the job data is what it leaves behind in Redis, so an extra field
      // must fail here.
      expect(stockQueue.add.mock.calls[0]?.[1]).toEqual({
        skuId: aCrossedSku.id,
        restockCycle: 4,
      });
    });

    it('gives the job an id built from the sku and the cycle, so a repeated crossing collapses', async () => {
      await h.service.observeStockChange(aStockChange({ restockCycle: 2 }));

      expect(stockQueue.add.mock.calls[0]?.[2]).toEqual({
        jobId: `${aCrossedSku.id}:2`,
      });
    });

    it('enqueues nothing when the stock was already at or below the threshold', async () => {
      await h.service.observeStockChange(
        aStockChange({
          previousStock: LOW_STOCK_THRESHOLD,
          newStock: LOW_STOCK_THRESHOLD - 1,
        }),
      );

      expect(stockQueue.add).not.toHaveBeenCalled();
    });

    it('enqueues nothing when the write raised the stock', async () => {
      await h.service.observeStockChange(
        aStockChange({
          previousStock: LOW_STOCK_THRESHOLD + 1,
          newStock: LOW_STOCK_THRESHOLD + 6,
        }),
      );

      expect(stockQueue.add).not.toHaveBeenCalled();
    });

    it('answers whether it enqueued, so the caller can log the crossing', async () => {
      await expect(h.service.observeStockChange(aStockChange())).resolves.toBe(
        true,
      );
      await expect(
        h.service.observeStockChange(
          aStockChange({ newStock: LOW_STOCK_THRESHOLD + 1 }),
        ),
      ).resolves.toBe(false);
    });

    it('lets a queue that refuses the job throw, rather than swallowing a lost notification', async () => {
      stockQueue.add.mockRejectedValue(new Error('Redis is away'));

      await expect(
        h.service.observeStockChange(aStockChange()),
      ).rejects.toThrow('Redis is away');
    });

    it('writes nothing to the database, because the settlement transaction has already committed', async () => {
      await h.service.observeStockChange(aStockChange());

      expect(h.prisma.$transaction).not.toHaveBeenCalled();
      expect(h.prisma.sku.update).not.toHaveBeenCalled();
      expect(h.prisma.stockNotification.create).not.toHaveBeenCalled();
    });
  });

  describe('opening the next cycle on a restock', () => {
    it('increments the restockCycle when a restock lifts stock back above the threshold', async () => {
      const tx = aTransactionClient();

      await h.service.openCycleOnRestock(
        tx,
        aCrossedSku.id,
        LOW_STOCK_THRESHOLD,
        LOW_STOCK_THRESHOLD + 1,
      );

      expect(tx.sku.update).toHaveBeenCalledWith({
        where: { id: aCrossedSku.id },
        data: { restockCycle: { increment: 1 } },
      });
    });

    it('writes through the transaction client it was handed, not through its own connection', async () => {
      const tx = aTransactionClient();

      await h.service.openCycleOnRestock(
        tx,
        aCrossedSku.id,
        LOW_STOCK_THRESHOLD,
        LOW_STOCK_THRESHOLD + 1,
      );

      expect(tx.sku.update).toHaveBeenCalledTimes(1);
      expect(h.prisma.sku.update).not.toHaveBeenCalled();
    });

    it('writes nothing when the restock stopped at the threshold', async () => {
      const tx = aTransactionClient();

      await h.service.openCycleOnRestock(
        tx,
        aCrossedSku.id,
        LOW_STOCK_THRESHOLD - 2,
        LOW_STOCK_THRESHOLD,
      );

      expect(tx.sku.update).not.toHaveBeenCalled();
    });

    it('writes nothing when the stock was already above the threshold', async () => {
      const tx = aTransactionClient();

      await h.service.openCycleOnRestock(
        tx,
        aCrossedSku.id,
        LOW_STOCK_THRESHOLD + 1,
        LOW_STOCK_THRESHOLD + 9,
      );

      expect(tx.sku.update).not.toHaveBeenCalled();
    });

    it('writes nothing when the write lowered the stock', async () => {
      const tx = aTransactionClient();

      await h.service.openCycleOnRestock(
        tx,
        aCrossedSku.id,
        LOW_STOCK_THRESHOLD + 1,
        LOW_STOCK_THRESHOLD,
      );

      expect(tx.sku.update).not.toHaveBeenCalled();
    });

    it('answers whether the cycle advanced', async () => {
      const tx = aTransactionClient();

      await expect(
        h.service.openCycleOnRestock(
          tx,
          aCrossedSku.id,
          LOW_STOCK_THRESHOLD,
          LOW_STOCK_THRESHOLD + 1,
        ),
      ).resolves.toBe(true);

      await expect(
        h.service.openCycleOnRestock(
          tx,
          aCrossedSku.id,
          LOW_STOCK_THRESHOLD - 1,
          LOW_STOCK_THRESHOLD,
        ),
      ).resolves.toBe(false);
    });
  });
});

import { Injectable } from '@nestjs/common';
import { NOT_DELETED } from '../catalog/query';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { newId } from '../common/ids';
import { loadOrThrow } from '../common/load-or-throw';
import { PrismaService } from '../prisma/prisma.service';
import type { ProductLikeView } from './dto/set-product-like.dto';

@Injectable()
export class LikesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Idempotent by construction: setting a like that is already set, or
   * clearing one that was never there, answers the same as the first call.
   * `uq_product_likes_user_product` is what makes the write safe under a
   * double click.
   *
   * No row scope is folded in here, and that is not an omission: the like
   * is addressed by `(userId, productId)` where `userId` comes from the
   * token, so no identifier in the request can name another client's row.
   * The 404 says only that the product does not exist.
   */
  async set(
    user: AuthenticatedUser,
    productId: string,
    liked: boolean,
  ): Promise<ProductLikeView> {
    await loadOrThrow(
      () =>
        this.prisma.product.findFirst({
          where: { id: productId, ...NOT_DELETED },
        }),
      'Product does not exist.',
    );

    if (liked) {
      await this.prisma.productLike.upsert({
        where: { userId_productId: { userId: user.id, productId } },
        create: { id: newId(), userId: user.id, productId },
        update: {},
      });
    } else {
      await this.prisma.productLike.deleteMany({
        where: { userId: user.id, productId },
      });
    }

    return { liked };
  }
}

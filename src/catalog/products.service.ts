import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { newId } from '../common/ids';
import { loadOrThrow } from '../common/load-or-throw';
import { paginate, type Paginated } from '../common/pagination';
import { Problems } from '../common/problem/problem.catalog';
import { ProblemException } from '../common/problem/problem.exception';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import type {
  CreateProductDto,
  ListProductsQueryDto,
  UpdateProductDto,
} from './dto/catalog.dto';
import {
  aggregate,
  coverOf,
  mapSkus,
  toCategoryViews,
  toManagerSku,
  toPublicSku,
  type ImageRow,
  type ImageView,
  type ManagerProductView,
  type ProductDetailView,
  type ProductSummaryView,
} from './product.mappers';

// Everything needed to project a product in either of the two shapes.
const FULL_INCLUDE = {
  categories: { include: { category: true } },
  images: { orderBy: { id: 'asc' } },
  skus: { orderBy: { id: 'asc' } },
} satisfies Prisma.ProductInclude;

type FullProduct = Prisma.ProductGetPayload<{ include: typeof FULL_INCLUDE }>;

// A live product: not soft-deleted. Shared with SkusService through the
// `product` relation, so both sides of the FK agree on what "live" means.
export const NOT_DELETED: Prisma.ProductWhereInput = { deletedAt: null };

// Published = active, not deleted, with at least one variant and one image;
// the image isn't cosmetic, F8 sends it in the restock email.
const PUBLISHED: Prisma.ProductWhereInput = {
  ...NOT_DELETED,
  isActive: true,
  skus: { some: {} },
  images: { some: {} },
};

const NOT_VISIBLE_DETAIL =
  'The requested product does not exist or is not visible to this caller.';

@Injectable()
export class ProductsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  // URLs are presigned, so resolving them is asynchronous and done in bulk.
  private async toImageViews(rows: ImageRow[]): Promise<ImageView[]> {
    return Promise.all(
      rows.map(async (i) => ({
        id: i.id,
        url: await this.storage.urlFor(i.s3Key),
      })),
    );
  }

  // ---------------------------------------------------------------- lectura

  async list(
    query: ListProductsQueryDto,
  ): Promise<Paginated<ProductSummaryView>> {
    const where: Prisma.ProductWhereInput = {
      ...PUBLISHED,
      ...(query.categoryId
        ? { categories: { some: { categoryId: query.categoryId } } }
        : {}),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.product.findMany({
        where,
        include: FULL_INCLUDE,
        // The id breaks ties because `products.name` is NOT unique: without
        // it, two same-named products at a page boundary get repeated or
        // skipped.
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        skip: query.offset,
        take: query.limit,
      }),
      this.prisma.product.count({ where }),
    ]);

    const data = await Promise.all(rows.map((p) => this.toSummary(p)));
    return paginate(data, total, query);
  }

  // Visibility is a condition on the row, not a permission: that's why this
  // route returns 404 and never 403 (a deactivated product is a 404 for
  // anyone who isn't a manager).
  async getOne(
    id: string,
    asManager: boolean,
  ): Promise<ProductDetailView | ManagerProductView> {
    const product = await loadOrThrow(
      () =>
        this.prisma.product.findFirst({
          where: asManager ? { id, ...NOT_DELETED } : { id, ...PUBLISHED },
          include: FULL_INCLUDE,
        }),
      NOT_VISIBLE_DETAIL,
    );

    return asManager ? this.toManager(product) : this.toDetail(product);
  }

  // --------------------------------------------------------------- escritura

  async create(dto: CreateProductDto): Promise<ManagerProductView> {
    await this.mustExistCategories(dto.categoryIds);

    const id = newId();
    await this.prisma.$transaction([
      this.prisma.product.create({
        data: { id, name: dto.name, description: dto.description },
      }),
      this.prisma.productCategory.createMany({
        data: dto.categoryIds.map((categoryId) => ({
          id: newId(),
          productId: id,
          categoryId,
        })),
      }),
    ]);

    return this.toManager(await this.loadForManager(id));
  }

  async update(id: string, dto: UpdateProductDto): Promise<ManagerProductView> {
    await this.loadForManager(id);
    if (dto.categoryIds) await this.mustExistCategories(dto.categoryIds);

    await this.prisma.$transaction(async (tx) => {
      await tx.product.update({
        where: { id },
        data: {
          ...(dto.name === undefined ? {} : { name: dto.name }),
          ...(dto.description === undefined
            ? {}
            : { description: dto.description }),
          ...(dto.isActive === undefined ? {} : { isActive: dto.isActive }),
        },
      });

      if (dto.categoryIds) {
        await tx.productCategory.deleteMany({ where: { productId: id } });
        await tx.productCategory.createMany({
          data: dto.categoryIds.map((categoryId) => ({
            id: newId(),
            productId: id,
            categoryId,
          })),
        });
      }
    });

    return this.toManager(await this.loadForManager(id));
  }

  // Soft and terminal delete: the row survives because order history
  // references it through the SKU; the 409 avoids leaving pending
  // reservations pointing at something no longer purchasable.
  async remove(id: string): Promise<void> {
    const product = await this.loadForManager(id);
    const held = product.skus.reduce((sum, s) => sum + s.reserved, 0);

    if (held > 0) {
      throw new ProblemException(
        Problems.conflict,
        `${held} unit(s) are still reserved by pending orders. Wait until they are paid or expire.`,
      );
    }

    await this.prisma.product.update({
      where: { id },
      data: { deletedAt: new Date(), isActive: false },
    });
  }

  // ------------------------------------------------------------------ apoyo

  // Load for a manager: any state except deleted.
  async loadForManager(id: string): Promise<FullProduct> {
    return loadOrThrow(
      () =>
        this.prisma.product.findFirst({
          where: { id, ...NOT_DELETED },
          include: FULL_INCLUDE,
        }),
      NOT_VISIBLE_DETAIL,
    );
  }

  async projectForManager(id: string): Promise<ManagerProductView> {
    return this.toManager(await this.loadForManager(id));
  }

  private async mustExistCategories(ids: string[]): Promise<void> {
    const found = await this.prisma.category.count({
      where: { id: { in: ids } },
    });
    if (found !== ids.length) {
      throw new ProblemException(
        Problems.notFound,
        'At least one of the supplied category ids does not exist.',
      );
    }
  }

  // ------------------------------------------------------------ proyecciones

  private async toSummary(p: FullProduct): Promise<ProductSummaryView> {
    const images = await this.toImageViews(p.images);
    const { priceFrom, inStock } = aggregate(p.skus);

    return {
      id: p.id,
      name: p.name,
      // The publication filter guarantees these exist; the `!` documents
      // that the guarantee comes from the query, not from the type's shape.
      priceFrom: priceFrom!,
      image: coverOf(images)!,
      categories: toCategoryViews(p.categories),
      inStock,
    };
  }

  private async toDetail(p: FullProduct): Promise<ProductDetailView> {
    const images = await this.toImageViews(p.images);

    return {
      ...(await this.toSummary(p)),
      description: p.description,
      images,
      skus: mapSkus(p.skus, images, toPublicSku),
    };
  }

  private async toManager(p: FullProduct): Promise<ManagerProductView> {
    const images = await this.toImageViews(p.images);
    const cover = coverOf(images);
    const { priceFrom } = aggregate(p.skus);

    return {
      id: p.id,
      name: p.name,
      description: p.description,
      isActive: p.isActive,
      priceFrom,
      ...(cover ? { image: cover } : {}),
      images,
      categories: toCategoryViews(p.categories),
      skus: mapSkus(p.skus, images, toManagerSku),
    };
  }
}

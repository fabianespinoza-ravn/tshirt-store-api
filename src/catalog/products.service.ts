import { Injectable } from '@nestjs/common';
import type { Prisma, Sku } from '@prisma/client';
import { newId } from '../common/ids';
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
  toCategoryViews,
  toManagerSku,
  toPublicSku,
  type ImageRow,
  type ImageView,
  type ManagerProductView,
  type ProductDetailView,
  type ProductSummaryView,
} from './product.mappers';

// Todo lo que hace falta para proyectar un producto en cualquiera de las dos formas.
const FULL_INCLUDE = {
  categories: { include: { category: true } },
  images: { orderBy: { id: 'asc' } },
  skus: { orderBy: { id: 'asc' } },
} satisfies Prisma.ProductInclude;

type FullProduct = Prisma.ProductGetPayload<{ include: typeof FULL_INCLUDE }>;

// Publicado = activo, no borrado, con al menos una variante y una imagen; la imagen no es cosmética, F8 la manda en el correo de reposición.
const PUBLISHED: Prisma.ProductWhereInput = {
  isActive: true,
  deletedAt: null,
  skus: { some: {} },
  images: { some: {} },
};

@Injectable()
export class ProductsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  // Las URL son prefirmadas, así que resolverlas es asíncrono y va en lote.
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
        // El id desempata porque `products.name` NO es único: sin él, dos
        // productos homónimos en el borde de página se repiten o se saltan.
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        skip: query.offset,
        take: query.limit,
      }),
      this.prisma.product.count({ where }),
    ]);

    const data = await Promise.all(rows.map((p) => this.toSummary(p)));
    return paginate(data, total, query);
  }

  // La visibilidad es una condición sobre la fila, no un permiso: por eso esta ruta devuelve 404 y nunca 403 (un producto desactivado es 404 para quien no es manager).
  async getOne(
    id: string,
    asManager: boolean,
  ): Promise<ProductDetailView | ManagerProductView> {
    const product = await this.prisma.product.findFirst({
      where: asManager ? { id, deletedAt: null } : { id, ...PUBLISHED },
      include: FULL_INCLUDE,
    });

    if (!product) throw this.notFound();

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

  // Borrado lógico y terminal: la fila sobrevive porque el historial de pedidos la referencia vía SKU; el 409 evita dejar reservas pendientes apuntando a algo ya no comprable.
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

  // Carga para un manager: cualquier estado salvo borrado.
  async loadForManager(id: string): Promise<FullProduct> {
    const product = await this.prisma.product.findFirst({
      where: { id, deletedAt: null },
      include: FULL_INCLUDE,
    });
    if (!product) throw this.notFound();
    return product;
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

  private notFound(): ProblemException {
    return new ProblemException(
      Problems.notFound,
      'The requested product does not exist or is not visible to this caller.',
    );
  }

  // ------------------------------------------------------------ proyecciones

  private async toSummary(p: FullProduct): Promise<ProductSummaryView> {
    const images = await this.toImageViews(p.images);
    const { priceFrom, inStock } = aggregate(p.skus);

    return {
      id: p.id,
      name: p.name,
      // El filtro de publicación garantiza que existen; el `!` documenta que la
      // garantía viene de la consulta y no de la forma del tipo.
      priceFrom: priceFrom!,
      image: coverOf(images)!,
      categories: toCategoryViews(p.categories),
      inStock,
    };
  }

  private async toDetail(p: FullProduct): Promise<ProductDetailView> {
    const images = await this.toImageViews(p.images);
    const byId = new Map(images.map((i) => [i.id, i]));

    return {
      ...(await this.toSummary(p)),
      description: p.description,
      images,
      skus: p.skus.map((s: Sku) =>
        toPublicSku(s, s.imageId ? byId.get(s.imageId) : undefined),
      ),
    };
  }

  private async toManager(p: FullProduct): Promise<ManagerProductView> {
    const images = await this.toImageViews(p.images);
    const byId = new Map(images.map((i) => [i.id, i]));
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
      skus: p.skus.map((s: Sku) =>
        toManagerSku(s, s.imageId ? byId.get(s.imageId) : undefined),
      ),
    };
  }
}

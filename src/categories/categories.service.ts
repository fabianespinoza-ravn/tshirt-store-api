import { Injectable } from '@nestjs/common';
import type { Category } from '@prisma/client';
import { newId } from '../common/ids';
import { loadOrThrow } from '../common/load-or-throw';
import {
  paginate,
  type Paginated,
  type PaginationQueryDto,
} from '../common/pagination';
import { Problems } from '../common/problem/problem.catalog';
import { ProblemException } from '../common/problem/problem.exception';
import { PrismaService } from '../prisma/prisma.service';

export interface CategoryView {
  id: string;
  name: string;
}

const view = (c: Category): CategoryView => ({ id: c.id, name: c.name });

@Injectable()
export class CategoriesService {
  constructor(private readonly prisma: PrismaService) {}

  // The name is unique in categories, so the order is total and paginating
  // doesn't repeat or skip rows (in products it isn't, which is why there
  // the id has to break the tie).
  async list(query: PaginationQueryDto): Promise<Paginated<CategoryView>> {
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.category.findMany({
        orderBy: { name: 'asc' },
        skip: query.offset,
        take: query.limit,
      }),
      this.prisma.category.count(),
    ]);

    return paginate(rows.map(view), total, query);
  }

  // The name is checked by writing and letting the unique index reject it,
  // not by probing with findUnique first: a probe-then-write leaves a window
  // where two concurrent creates for the same name both pass the check and
  // only one survives the actual insert, unreported.
  //
  // The P2002 that comes back used to be caught and rewritten here. It is
  // now translated centrally, by the `Category:name` entry of
  // src/common/problem/translators/prisma.translator.ts, which serves the
  // same 409 with the same detail — the mapping lives next to every other
  // constraint the API is willing to explain, instead of once per service.
  async create(name: string): Promise<CategoryView> {
    return view(
      await this.prisma.category.create({ data: { id: newId(), name } }),
    );
  }

  async rename(id: string, name: string): Promise<CategoryView> {
    await this.mustExist(id);

    return view(
      await this.prisma.category.update({ where: { id }, data: { name } }),
    );
  }

  // Hard delete, not soft: a category doesn't appear in any historical
  // record (unlike a product), so deleting it is safe.
  async remove(id: string): Promise<void> {
    await this.mustExist(id);

    const assigned = await this.prisma.productCategory.count({
      where: { categoryId: id },
    });

    if (assigned > 0) {
      throw new ProblemException(
        Problems.conflict,
        `The category still has ${assigned} product(s) assigned. Move them to another category first.`,
      );
    }

    await this.prisma.category.delete({ where: { id } });
  }

  private async mustExist(id: string): Promise<Category> {
    return loadOrThrow(
      () => this.prisma.category.findUnique({ where: { id } }),
      'Category does not exist.',
    );
  }
}

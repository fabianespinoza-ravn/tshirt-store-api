import { Injectable } from '@nestjs/common';
import { Prisma, type Category } from '@prisma/client';
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

  // The name is checked by writing and catching the unique index (P2002), not
  // by probing with findUnique first: a probe-then-write leaves a window where
  // two concurrent creates for the same name both pass the check and only one
  // survives the actual insert, unreported.
  async create(name: string): Promise<CategoryView> {
    try {
      return view(
        await this.prisma.category.create({ data: { id: newId(), name } }),
      );
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      throw this.nameTaken();
    }
  }

  async rename(id: string, name: string): Promise<CategoryView> {
    await this.mustExist(id);

    try {
      return view(
        await this.prisma.category.update({ where: { id }, data: { name } }),
      );
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      throw this.nameTaken();
    }
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

  private nameTaken(): ProblemException {
    return new ProblemException(
      Problems.conflict,
      'Another category already uses that name.',
    );
  }
}

function isUniqueViolation(
  error: unknown,
): error is Prisma.PrismaClientKnownRequestError {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}

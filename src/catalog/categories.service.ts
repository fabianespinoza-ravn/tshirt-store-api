import { Injectable } from '@nestjs/common';
import type { Category } from '@prisma/client';
import { newId } from '../common/ids';
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

  // El nombre es único en categories, así que el orden es total y paginar no repite ni salta filas (en products no lo es, por eso allí hace falta desempatar con el id).
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

  async create(name: string): Promise<CategoryView> {
    if (await this.prisma.category.findUnique({ where: { name } })) {
      throw this.nameTaken();
    }
    return view(
      await this.prisma.category.create({ data: { id: newId(), name } }),
    );
  }

  async rename(id: string, name: string): Promise<CategoryView> {
    await this.mustExist(id);

    const other = await this.prisma.category.findUnique({ where: { name } });
    if (other && other.id !== id) throw this.nameTaken();

    return view(
      await this.prisma.category.update({ where: { id }, data: { name } }),
    );
  }

  // Borrado físico, no lógico: una categoría no aparece en ningún registro histórico (a diferencia de un producto), así que borrarla es seguro.
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

  private async mustExist(id: string): Promise<void> {
    const found = await this.prisma.category.findUnique({ where: { id } });
    if (!found) {
      throw new ProblemException(Problems.notFound, 'Category does not exist.');
    }
  }

  private nameTaken(): ProblemException {
    return new ProblemException(
      Problems.conflict,
      'Another category already uses that name.',
    );
  }
}

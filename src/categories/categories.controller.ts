import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CheckPolicies } from '../auth/casl/check-policies.decorator';
import { PoliciesGuard } from '../auth/guards/policies.guard';
import { Public } from '../common/decorators/public.decorator';
import { PaginationQueryDto, type Paginated } from '../common/pagination';
import { Problems } from '../common/problem/problem.catalog';
import { ApiProblems } from '../common/swagger';
import { CategoriesService, type CategoryView } from './categories.service';
import { CreateCategoryDto } from './dto/create-category.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';

// Alias to shorten the signatures: every route id is validated as a UUID.
const uuid = ParseUUIDPipe;

@ApiTags('Catalog')
@Controller()
export class CategoriesController {
  constructor(private readonly categories: CategoriesService) {}

  @Public()
  @ApiOperation({ summary: 'List categories' })
  @ApiResponse({ status: 200, description: 'A page of categories' })
  @ApiProblems(Problems.validation, Problems.internalError)
  @Get('categories')
  listCategories(
    @Query() query: PaginationQueryDto,
  ): Promise<Paginated<CategoryView>> {
    return this.categories.list(query);
  }

  @UseGuards(PoliciesGuard)
  @CheckPolicies({ action: 'create', subject: 'Category' })
  @ApiBearerAuth('bearerAuth')
  @ApiOperation({ summary: 'Create a category' })
  @ApiResponse({ status: 201, description: 'Category created' })
  @ApiProblems(
    Problems.validation,
    Problems.unauthorized,
    Problems.forbidden,
    Problems.conflict,
    Problems.internalError,
  )
  @Post('categories')
  @HttpCode(HttpStatus.CREATED)
  createCategory(@Body() dto: CreateCategoryDto): Promise<CategoryView> {
    return this.categories.create(dto.name);
  }

  @UseGuards(PoliciesGuard)
  @CheckPolicies({ action: 'update', subject: 'Category' })
  @ApiBearerAuth('bearerAuth')
  @ApiOperation({ summary: 'Rename a category' })
  @ApiResponse({ status: 200, description: 'Category updated' })
  @ApiProblems(
    Problems.validation,
    Problems.unauthorized,
    Problems.forbidden,
    Problems.notFound,
    Problems.conflict,
    Problems.internalError,
  )
  @Patch('categories/:categoryId')
  updateCategory(
    @Param('categoryId', uuid) categoryId: string,
    @Body() dto: UpdateCategoryDto,
  ): Promise<CategoryView> {
    return this.categories.rename(categoryId, dto.name);
  }

  @UseGuards(PoliciesGuard)
  @CheckPolicies({ action: 'delete', subject: 'Category' })
  @ApiBearerAuth('bearerAuth')
  @ApiOperation({ summary: 'Delete a category' })
  @ApiResponse({ status: 204, description: 'Category deleted' })
  @ApiProblems(
    Problems.unauthorized,
    Problems.forbidden,
    Problems.notFound,
    Problems.conflict,
    Problems.internalError,
  )
  @Delete('categories/:categoryId')
  @HttpCode(HttpStatus.NO_CONTENT)
  deleteCategory(@Param('categoryId', uuid) categoryId: string): Promise<void> {
    return this.categories.remove(categoryId);
  }
}

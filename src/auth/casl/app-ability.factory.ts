import { Injectable } from '@nestjs/common';
import {
  type Cart,
  type CartItem,
  type Category,
  type Order,
  type PaymentLink,
  type Product,
  type ProductImage,
  type ProductLike,
  type PromoCode,
  type Sku,
  UserRole,
} from '@prisma/client';
import { AbilityBuilder } from '@casl/ability';
import {
  createPrismaAbility,
  type PrismaAbility,
  type PrismaQuery,
  type Subjects,
} from '@casl/prisma';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';

export type AppAction = 'create' | 'read' | 'update' | 'delete';

/** Nombres estáticos que pueden aparecer en @CheckPolicies. */
export type AppSubjectName =
  | 'Category'
  | 'Product'
  | 'ProductImage'
  | 'Sku'
  | 'ProductLike'
  | 'Cart'
  | 'CartItem'
  | 'Order'
  | 'PaymentLink'
  | 'PromoCode';

export type AppSubjects = Subjects<{
  Category: Category;
  Product: Product;
  ProductImage: ProductImage;
  Sku: Sku;
  ProductLike: ProductLike;
  Cart: Cart;
  CartItem: CartItem;
  Order: Order;
  PaymentLink: PaymentLink;
  PromoCode: PromoCode;
}>;

export type AppAbility = PrismaAbility<[AppAction, AppSubjects], PrismaQuery>;

@Injectable()
export class AppAbilityFactory {
  createForUser(user: AuthenticatedUser | undefined): AppAbility {
    const { can, build } = new AbilityBuilder<AppAbility>(createPrismaAbility);

    if (user?.role === UserRole.MANAGER) {
      can(['create', 'update', 'delete'], 'Category');
      can(['create', 'update', 'delete'], 'Product');
      can(['create', 'delete'], 'ProductImage');
      can(['create', 'update'], 'Sku');
    }

    return build();
  }
}

import { UserRole } from '@prisma/client';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { LikesController } from './likes.controller';
import type { LikesService } from './likes.service';

const client: AuthenticatedUser = {
  id: 'client-1',
  email: 'client@example.test',
  role: UserRole.CLIENT,
};

describe('LikesController', () => {
  it('passes the caller, product and requested state to the service', async () => {
    const likes = { set: jest.fn().mockResolvedValue({ liked: true }) };
    const controller = new LikesController(likes as unknown as LikesService);

    await expect(
      controller.setProductLike(client, 'product-1', { liked: true }),
    ).resolves.toEqual({ liked: true });
    expect(likes.set).toHaveBeenCalledWith(client, 'product-1', true);
  });
});

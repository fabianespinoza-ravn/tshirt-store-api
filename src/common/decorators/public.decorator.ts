import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

// Marca una operación como accesible sin token para que el guard JWT pueda ser global; la lista va aquí y no en el guard para no desincronizarse del contrato si alguien mueve un path.
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

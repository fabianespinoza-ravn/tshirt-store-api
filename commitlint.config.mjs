// El historial ya sigue Conventional Commits desde el primer commit. Esto sólo
// lo hace obligatorio, y va en CI y no en un hook local: `core.hooksPath` de
// esta máquina apunta fuera del repo y un hook aquí lo desplazaría.
export default {
  extends: ['@commitlint/config-conventional'],
};

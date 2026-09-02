// El historial ya sigue Conventional Commits desde el primer commit. Esto sólo
// lo hace obligatorio, y va en CI y no en un hook local: `core.hooksPath` de
// esta máquina apunta fuera del repo y un hook aquí lo desplazaría.
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    // Un cuerpo lleva enlaces, y un enlace no se parte por la mitad. Dependabot
    // firma cada commit con las URLs del changelog, todas por encima de los 100
    // caracteres que exige el preset, así que la regla rechazaría cada
    // actualización de dependencia. Lo que de verdad importa —el tipo, el
    // ámbito y el asunto, que son los que hacen legible el historial— sigue
    // siendo obligatorio.
    'body-max-line-length': [0, 'always'],
  },
};

# Flujos en PlantUML

Once diagramas de secuencia, uno por flujo, escritos contra `../../W2-API/openapi.yaml`
y `../ARQUITECTURA.md`. Entre los once cubren **las 38 operaciones del contrato**.

**No forman parte del entregable de una página.** `ARQUITECTURA.md` es lo que se
envía; esto es material para la defensa oral y para el README del repo.

## Cómo renderizarlos

Cada `.puml` es un diagrama completo. Abre [planttext.com](https://www.planttext.com),
pega el contenido de **un** fichero y pulsa Refresh. PlantText renderiza un diagrama
por vez, así que no los pegues juntos.

Alternativa sin copiar y pegar: el servidor público acepta la fuente en la URL, y
las extensiones de PlantUML de VS Code y de los JetBrains previsualizan el fichero
directamente al abrirlo.

## Qué cubre cada uno

| Fichero | Operaciones del contrato |
|---|---|
| `01-auth-registro.puml` | `signUp`, `resendEmailVerification`, `confirmEmailVerification` |
| `02-auth-sesion.puml` | `signIn`, `refreshSession`, `signOut` |
| `03-auth-contrasenas.puml` | `forgotPassword`, `resetPassword`, `changePassword` |
| `04-catalogo-lectura.puml` | `listCategories`, `listProducts`, `getProduct` |
| `05-catalogo-gestion.puml` | `createCategory`, `updateCategory`, `deleteCategory`, `createProduct`, `updateProduct`, `deleteProduct`, `uploadProductImage`, `deleteProductImage`, `createSku`, `updateSku` |
| `06-like-y-notificacion-stock.puml` | `setProductLike` y la cola que dispara |
| `07-carrito.puml` | `getCart`, `addCartItem`, `updateCartItem`, `removeCartItem` |
| `08-checkout-y-pago.puml` | `checkout`, `receiveStripeEvent` |
| `09-payment-link-invitado.puml` | `createPaymentLink`, `getGuestOrder` |
| `10-pedidos-historial-estados.puml` | `listOrders`, `getOrder`, `updateOrderStatus` |
| `11-promo-codes.puml` | `createPromoCode`, `listPromoCodes`, `updatePromoCode`, `validatePromoCode` |

## Las notas en rojo

Las cajas `#ffe0e0` no son decoración: marcan los seis sitios donde el diseño puede
morderte, y son las preguntas que conviene llegar sabiendo contestar.

| Diagrama | Lo que marca |
|---|---|
| `04` | `anyOf` valida si **alguna** rama valida: el contrato no detecta una proyección por rol equivocada en ninguna dirección |
| `07` | `cartItemId` desnudo en la ruta: si el servicio no comprueba de quién es la línea, es un BOLA |
| `08` | El 200 del webhook es acuse, no liquidación; y hay que cancelar en Stripe **antes** de soltar el stock |
| `09` | Sin recogida de dirección el webhook no puede rellenar columnas NOT NULL: se cobra y no se registra el pedido. Y poseer la URL de un pedido de invitado **es** la credencial |
| `10` | 404 y nunca 403 fuera de alcance, para que el código no sirva de enumerador |
| `11` | Validar un cupón no retiene nada: el checkout vuelve a comprobarlo |

## Verificación pendiente

Ninguno se ha renderizado: no hay PlantUML en el proyecto. Antes de usarlos en
la defensa, pásalos por PlantText.

# Flows in PlantUML

Eleven sequence diagrams, one per flow, written against `../../W2-API/openapi.yaml`
and `../ARQUITECTURA.md`. Between the eleven they cover **all 38 operations of the contract**.

**They are not part of the one-page deliverable.** `ARQUITECTURA.md` is what gets
submitted; this is material for the oral defense and for the repo's README.

## How to render them

Each `.puml` is a complete diagram. Open [planttext.com](https://www.planttext.com),
paste the contents of **one** file and hit Refresh. PlantText renders one diagram
at a time, so don't paste them together.

Alternative without copy-pasting: the public server accepts the source in the URL, and
the PlantUML extensions for VS Code and JetBrains preview the file
directly when you open it.

## What each one covers

| File | Contract operations |
|---|---|
| `01-auth-registro.puml` | `signUp`, `resendEmailVerification`, `confirmEmailVerification` |
| `02-auth-sesion.puml` | `signIn`, `refreshSession`, `signOut` |
| `03-auth-contrasenas.puml` | `forgotPassword`, `resetPassword`, `changePassword` |
| `04-catalogo-lectura.puml` | `listCategories`, `listProducts`, `getProduct` |
| `05-catalogo-gestion.puml` | `createCategory`, `updateCategory`, `deleteCategory`, `createProduct`, `updateProduct`, `deleteProduct`, `uploadProductImage`, `deleteProductImage`, `createSku`, `updateSku` |
| `06-like-y-notificacion-stock.puml` | `setProductLike` and the queue it triggers |
| `07-carrito.puml` | `getCart`, `addCartItem`, `updateCartItem`, `removeCartItem` |
| `08-checkout-y-pago.puml` | `checkout`, `receiveStripeEvent` |
| `09-payment-link-invitado.puml` | `createPaymentLink`, `getGuestOrder` |
| `10-pedidos-historial-estados.puml` | `listOrders`, `getOrder`, `updateOrderStatus` |
| `11-promo-codes.puml` | `createPromoCode`, `listPromoCodes`, `updatePromoCode`, `validatePromoCode` |

## The notes in red

The `#ffe0e0` boxes are not decoration: they mark the six spots where the design can
bite you, and they're the questions worth arriving with an answer for.

| Diagram | What it marks |
|---|---|
| `04` | `anyOf` validates if **any** branch validates: the contract can't detect a wrong-role projection in either direction |
| `07` | A bare `cartItemId` in the route: if the service doesn't check whose line it is, that's a BOLA |
| `08` | The webhook's 200 is an acknowledgment, not settlement; and you have to cancel in Stripe **before** releasing the stock |
| `09` | Without address collection the webhook can't fill NOT NULL columns: the charge goes through and the order never gets recorded. And possessing the URL of a guest order **is** the credential |
| `10` | 404 and never 403 outside of scope, so the status code can't be used as an enumerator |
| `11` | Validating a coupon doesn't hold anything: checkout re-checks it |

## Pending verification

None of them has been rendered: there is no PlantUML in the project. Before using
them in the defense, run them through PlantText.

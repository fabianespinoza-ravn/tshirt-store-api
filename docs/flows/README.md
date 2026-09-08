# Request and worker flows

These eleven sequence diagrams cover all 38 operations in the API contract.
The `.puml` files are the editable PlantUML sources; the matching SVG files in
[`rendered/`](rendered/) are committed so GitHub and other Markdown viewers
show diagrams rather than source code.

| Flow                              | Source                                                                       | Rendered diagram                                                                    |
| --------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Sign-up and verification          | [`01-auth-signup.puml`](01-auth-signup.puml)                                 | [`01-auth-signup.svg`](rendered/01-auth-signup.svg)                                 |
| Sign-in and refresh rotation      | [`02-auth-session.puml`](02-auth-session.puml)                               | [`02-auth-session.svg`](rendered/02-auth-session.svg)                               |
| Password recovery and change      | [`03-auth-passwords.puml`](03-auth-passwords.puml)                           | [`03-auth-passwords.svg`](rendered/03-auth-passwords.svg)                           |
| Public catalog reads              | [`04-catalog-read.puml`](04-catalog-read.puml)                               | [`04-catalog-read.svg`](rendered/04-catalog-read.svg)                               |
| Catalog management                | [`05-catalog-management.puml`](05-catalog-management.puml)                   | [`05-catalog-management.svg`](rendered/05-catalog-management.svg)                   |
| Likes and low-stock notifications | [`06-like-and-stock-notification.puml`](06-like-and-stock-notification.puml) | [`06-like-and-stock-notification.svg`](rendered/06-like-and-stock-notification.svg) |
| Cart operations                   | [`07-cart.puml`](07-cart.puml)                                               | [`07-cart.svg`](rendered/07-cart.svg)                                               |
| Checkout and payment settlement   | [`08-checkout-and-payment.puml`](08-checkout-and-payment.puml)               | [`08-checkout-and-payment.svg`](rendered/08-checkout-and-payment.svg)               |
| Payment Links and guest orders    | [`09-payment-link-guest.puml`](09-payment-link-guest.puml)                   | [`09-payment-link-guest.svg`](rendered/09-payment-link-guest.svg)                   |
| Orders and status history         | [`10-orders-history-statuses.puml`](10-orders-history-statuses.puml)         | [`10-orders-history-statuses.svg`](rendered/10-orders-history-statuses.svg)         |
| Promo-code lifecycle              | [`11-promo-codes.puml`](11-promo-codes.puml)                                 | [`11-promo-codes.svg`](rendered/11-promo-codes.svg)                                 |

## Diagrams

<details open>
<summary>01 · Sign-up and verification</summary>

![Sign-up and verification sequence](rendered/01-auth-signup.svg)
</details>

<details>
<summary>02 · Sign-in and refresh rotation</summary>

![Sign-in and refresh rotation sequence](rendered/02-auth-session.svg)
</details>

<details>
<summary>03 · Password recovery and change</summary>

![Password recovery and change sequence](rendered/03-auth-passwords.svg)
</details>

<details>
<summary>04 · Public catalog reads</summary>

![Public catalog sequence](rendered/04-catalog-read.svg)
</details>

<details>
<summary>05 · Catalog management</summary>

![Catalog management sequence](rendered/05-catalog-management.svg)
</details>

<details>
<summary>06 · Likes and low-stock notifications</summary>

![Likes and low-stock notification sequence](rendered/06-like-and-stock-notification.svg)
</details>

<details>
<summary>07 · Cart operations</summary>

![Cart sequence](rendered/07-cart.svg)
</details>

<details>
<summary>08 · Checkout and payment settlement</summary>

![Checkout and payment settlement sequence](rendered/08-checkout-and-payment.svg)
</details>

<details>
<summary>09 · Payment Links and guest orders</summary>

![Payment Links and guest order sequence](rendered/09-payment-link-guest.svg)
</details>

<details>
<summary>10 · Orders and status history</summary>

![Orders and status history sequence](rendered/10-orders-history-statuses.svg)
</details>

<details>
<summary>11 · Promo-code lifecycle</summary>

![Promo-code sequence](rendered/11-promo-codes.svg)
</details>

## Maintaining the diagrams

Update the `.puml` source first, render it locally to SVG and commit both files.
Do not depend on a public PlantUML server from the README: a checked-in image is
available offline, does not disclose source during rendering and cannot break
when an external service is unavailable.

With a local PlantUML CLI, run this directory's sources with SVG output directed
to `rendered/`. The checked-in files were generated locally with PlantUML's
official JavaScript engine.

Red note boxes identify security boundaries or non-obvious contracts worth
preserving: ownership checks, asynchronous webhook acknowledgement, Stripe
cancellation before releasing reservations, guest-link possession as a
credential, scoped 404 responses and promo-code revalidation at checkout.
